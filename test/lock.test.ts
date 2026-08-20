import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processScope, withWorktreeLock, worktreeLockPath } from "../src/core/lock.ts";

interface PlantedOwner {
	pid: number;
	hostname: string;
	acquiredAt: string;
	token?: string;
	scope?: string;
}

async function plantLock(root: string, owner: PlantedOwner): Promise<void> {
	const lockDir = worktreeLockPath(root);
	await mkdir(lockDir, { recursive: true });
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ token: "planted-token", scope: processScope(), ...owner }), "utf8");
}

test("a lock held by a dead same-scope process is reclaimed", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		await plantLock(root, { pid: 999_999_999, hostname: hostname(), acquiredAt: new Date().toISOString() });
		const result = await withWorktreeLock(root, async () => "ran", { timeoutMs: 2_000 });
		assert.equal(result, "ran");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a dead-looking PID from another scope is never fast-reclaimed", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		// A live container twin: same hostname, unreachable PID (ESRCH here),
		// different PID scope. Before token/scope ownership this was instantly
		// stolen; now only staleMs expiry may reclaim it.
		await plantLock(root, {
			pid: 999_999_999,
			hostname: hostname(),
			scope: "linux:other-boot-id:pid:[4026531999]",
			acquiredAt: new Date().toISOString(),
		});
		await assert.rejects(
			() => withWorktreeLock(root, async () => "ran", { timeoutMs: 250, pollMs: 25 }),
			/Timed out waiting for the audit lock/,
		);
		const expired = await withWorktreeLock(root, async () => "expired", { timeoutMs: 1_000, staleMs: 1 });
		assert.equal(expired, "expired", "age-based expiry remains the cross-scope reclamation path");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("acquisition records a random token and the process scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		let owner: any;
		await withWorktreeLock(root, async () => {
			owner = JSON.parse(await readFile(join(worktreeLockPath(root), "owner.json"), "utf8"));
		});
		assert.match(owner.token, /^[0-9a-f]{32}$/);
		assert.equal(owner.scope, processScope());
		assert.equal(owner.pid, process.pid);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("release is token-scoped: a pid+hostname twin cannot be released", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		const lockDir = worktreeLockPath(root);
		await withWorktreeLock(root, async () => {
			// Simulate a reclaim-and-reacquire by a process with the same PID,
			// hostname, and scope (PID collision across namespaces or reuse).
			await writeFile(
				join(lockDir, "owner.json"),
				JSON.stringify({
					token: "a-different-acquisition",
					pid: process.pid,
					hostname: hostname(),
					scope: processScope(),
					acquiredAt: new Date().toISOString(),
				}),
				"utf8",
			);
		});
		assert.ok(existsSync(lockDir), "a twin's lock survives our release");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("release leaves a lock reclaimed by another owner intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		const lockDir = worktreeLockPath(root);
		await withWorktreeLock(root, async () => {
			// Simulate another process reclaiming a stale hold mid-operation.
			await writeFile(
				join(lockDir, "owner.json"),
				JSON.stringify({ pid: 999_999_999, hostname: "another-host", acquiredAt: new Date().toISOString() }),
				"utf8",
			);
		});
		assert.ok(existsSync(lockDir), "foreign-owned lock survives our release");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an expired lock from another host is reclaimed", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		await plantLock(root, {
			pid: process.pid,
			hostname: "another-host",
			acquiredAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const result = await withWorktreeLock(root, async () => "ran", { timeoutMs: 2_000, staleMs: 30_000 });
		assert.equal(result, "ran");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a live held lock times out instead of being stolen", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		await plantLock(root, { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() });
		await assert.rejects(
			() => withWorktreeLock(root, async () => "ran", { timeoutMs: 250, pollMs: 25 }),
			/Timed out waiting for the audit lock/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the lock is released after failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-lock-test-"));
	try {
		await assert.rejects(
			() =>
				withWorktreeLock(root, async () => {
					throw new Error("operation failed");
				}),
			/operation failed/,
		);
		const result = await withWorktreeLock(root, async () => "recovered", { timeoutMs: 1_000 });
		assert.equal(result, "recovered");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
