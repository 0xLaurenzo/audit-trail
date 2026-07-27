import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export interface WorktreeLockOptions {
	/** Give up acquiring after this long. */
	timeoutMs?: number;
	/**
	 * A held lock older than this is considered abandoned. Keep this well above
	 * the longest expected hold: a live same-host owner is detected via its PID,
	 * but cross-host expiry relies on age alone.
	 */
	staleMs?: number;
	/** Poll interval while waiting. */
	pollMs?: number;
}

interface LockOwner {
	pid: number;
	hostname: string;
	acquiredAt: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code !== "ESRCH";
	}
}

export function worktreeLockPath(root: string): string {
	return join(root, ".audit", ".lock");
}

async function releaseOwnLock(lockDir: string): Promise<void> {
	let owner: LockOwner | undefined;
	try {
		owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as LockOwner;
	} catch {
		// Unreadable owner: do not risk deleting a lock another process may have
		// reclaimed and re-acquired. A leaked own lock is recovered via dead-PID
		// or age-based reclamation.
		return;
	}
	if (owner.pid === process.pid && owner.hostname === hostname()) {
		await rm(lockDir, { recursive: true, force: true });
	}
}

async function reclaimIfStale(lockDir: string, staleMs: number): Promise<boolean> {
	let owner: LockOwner | undefined;
	try {
		owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as LockOwner;
	} catch {
		// Missing or unreadable owner file: acquisition in flight or a crash
		// between mkdir and the owner write. Fall back to directory age below.
	}
	if (owner) {
		const sameHost = owner.hostname === hostname();
		const age = Date.now() - Date.parse(owner.acquiredAt);
		const dead = sameHost && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
		const expired = Number.isFinite(age) && age > staleMs;
		if (dead || expired) {
			await rm(lockDir, { recursive: true, force: true });
			return true;
		}
		return false;
	}
	try {
		const info = await stat(lockDir);
		if (Date.now() - info.mtimeMs > staleMs) {
			await rm(lockDir, { recursive: true, force: true });
			return true;
		}
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
	return false;
}

/**
 * Cross-process mutual exclusion for one Git worktree's `.audit/` state.
 * Acquisition is an atomic `mkdir`; abandoned locks (dead same-host owner or
 * expired age) are reclaimed so a crashed harness cannot wedge the audit.
 */
export async function withWorktreeLock<T>(
	root: string,
	operation: () => Promise<T>,
	options: WorktreeLockOptions = {},
): Promise<T> {
	const { timeoutMs = 10_000, staleMs = 300_000, pollMs = 50 } = options;
	const lockDir = worktreeLockPath(root);
	await mkdir(join(root, ".audit"), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await mkdir(lockDir);
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await reclaimIfStale(lockDir, staleMs)) continue;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for the audit lock at ${lockDir}`);
			}
			await sleep(pollMs);
		}
	}
	try {
		const owner: LockOwner = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() };
		await writeFile(join(lockDir, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
		return await operation();
	} finally {
		// Only remove the lock if we still own it; if this hold outlived staleMs
		// and another process reclaimed it, deleting the directory would let a
		// third process acquire alongside the current owner.
		await releaseOwnLock(lockDir);
	}
}
