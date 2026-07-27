import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

function gravePath(lockDir: string): string {
	return `${lockDir}.grave-${process.pid}-${randomBytes(6).toString("hex")}`;
}

async function readOwnerRaw(dir: string): Promise<string | undefined> {
	try {
		return await readFile(join(dir, "owner.json"), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Remove a lock directory only if its owner file still matches `expectedRaw`.
 * Deletion is rename-then-verify-then-delete: the atomic rename means at most
 * one remover wins, and re-reading the owner after the rename catches a lock
 * that was reclaimed and re-acquired between the caller's check and the
 * rename (check-then-delete race). A displaced fresh lock is renamed back.
 */
async function removeLockIfOwnerMatches(lockDir: string, expectedRaw: string | undefined): Promise<boolean> {
	const grave = gravePath(lockDir);
	try {
		await rename(lockDir, grave);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true; // another remover won
		throw error;
	}
	const actualRaw = await readOwnerRaw(grave);
	if (actualRaw !== expectedRaw) {
		// The lock changed hands between the check and the rename: this is a
		// freshly acquired lock, not the one judged removable. Restore it.
		try {
			await rename(grave, lockDir);
		} catch {
			// A third process acquired the name meanwhile; drop the displaced
			// copy. Its owner's release is ownership-checked and will no-op.
			await rm(grave, { recursive: true, force: true });
		}
		return false;
	}
	await rm(grave, { recursive: true, force: true });
	return true;
}

async function releaseOwnLock(lockDir: string): Promise<void> {
	const raw = await readOwnerRaw(lockDir);
	if (raw === undefined) return;
	let owner: LockOwner | undefined;
	try {
		owner = JSON.parse(raw) as LockOwner;
	} catch {
		// Unreadable owner: do not risk deleting a lock another process may have
		// reclaimed and re-acquired. A leaked own lock is recovered via dead-PID
		// or age-based reclamation.
		return;
	}
	if (owner.pid === process.pid && owner.hostname === hostname()) {
		await removeLockIfOwnerMatches(lockDir, raw);
	}
}

async function reclaimIfStale(lockDir: string, staleMs: number): Promise<boolean> {
	const raw = await readOwnerRaw(lockDir);
	let owner: LockOwner | undefined;
	if (raw !== undefined) {
		try {
			owner = JSON.parse(raw) as LockOwner;
		} catch {
			// Unreadable owner file: fall back to directory age below.
		}
	}
	if (owner) {
		const sameHost = owner.hostname === hostname();
		const age = Date.now() - Date.parse(owner.acquiredAt);
		const dead = sameHost && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
		const expired = Number.isFinite(age) && age > staleMs;
		if (dead || expired) return removeLockIfOwnerMatches(lockDir, raw);
		return false;
	}
	// Missing or unreadable owner file: acquisition in flight or a crash
	// between mkdir and the owner write. Judge by directory age.
	try {
		const info = await stat(lockDir);
		if (Date.now() - info.mtimeMs > staleMs) return removeLockIfOwnerMatches(lockDir, raw);
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
