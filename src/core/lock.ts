import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
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
	/** Random per-acquisition identity; token equality is ownership. */
	token: string;
	pid: number;
	/** Diagnostic only; never used for ownership or reclamation. */
	hostname: string;
	/** PID-probe validity domain; kill(pid, 0) evidence counts only within it. */
	scope: string;
	acquiredAt: string;
}

let cachedScope: string | undefined;

/**
 * Identity of the space in which this process's PIDs are meaningful. On Linux
 * this is the kernel boot ID plus the PID-namespace ID, so two containers on
 * one host (same kernel, different namespaces) never treat each other's PIDs
 * as probe-able — a live foreign lock must age out via staleMs instead of
 * being reclaimed on false ESRCH evidence. Elsewhere PID namespaces do not
 * exist and the hostname preserves the previous same-host fast path.
 */
export function processScope(): string {
	if (cachedScope === undefined) {
		try {
			const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const pidNamespace = readlinkSync("/proc/self/ns/pid");
			cachedScope = `linux:${bootId}:${pidNamespace}`;
		} catch {
			cachedScope = `host:${hostname()}`;
		}
	}
	return cachedScope;
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

async function releaseOwnLock(lockDir: string, token: string): Promise<void> {
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
	// Token equality, never pid+hostname: a PID-coincident process in another
	// namespace (or after PID reuse) must not be able to release this lock.
	if (owner.token === token) {
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
		const age = Date.now() - Date.parse(owner.acquiredAt);
		// ESRCH is evidence of death only inside the owner's recorded PID scope:
		// across PID namespaces a live PID is invisible, and hostname alone
		// (e.g. two containers both named "localhost") must never qualify.
		// Outside the scope, and for recycled PIDs that merely look alive,
		// age-based expiry is the only reclamation path.
		const dead = owner.scope === processScope() && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
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
	const token = randomBytes(16).toString("hex");
	try {
		const owner: LockOwner = {
			token,
			pid: process.pid,
			hostname: hostname(),
			scope: processScope(),
			acquiredAt: new Date().toISOString(),
		};
		await writeFile(join(lockDir, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
		return await operation();
	} finally {
		// Only remove the lock if we still own it; if this hold outlived staleMs
		// and another process reclaimed it, deleting the directory would let a
		// third process acquire alongside the current owner.
		await releaseOwnLock(lockDir, token);
	}
}
