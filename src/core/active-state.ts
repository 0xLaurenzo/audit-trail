import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AbandonmentRecord, ReviewSnapshot, RolloverLink } from "./types.ts";

/**
 * Authoritative active-audit state for one Git worktree. All harness sessions
 * (Pi, Claude Code, Codex, OpenCode) read and write this file instead of
 * keeping session-private state. Paths are relative to the worktree root.
 */
interface AuditFileFields {
	/** Filesystem-safe task slug. */
	task: string;
	/**
	 * Stable per-audit identity minted at start (or on demand for state created
	 * before identities existed). Publication markers embed it so distinct
	 * audits of the same task name can never claim each other's comments.
	 */
	auditId?: string;
	logPath: string;
	provenancePath?: string;
	startedAt: string;
	lastClosedAt?: string;
	lastReopenedAt?: string;
	reopenCount?: number;
	review?: ReviewSnapshot;
	/** Append-only terminal records; present once the audit has been abandoned. */
	abandonments?: AbandonmentRecord[];
	/** Present on a successor audit created by a rebase rollover. */
	rolloverFrom?: RolloverLink;
}

/** Version 2 adds the exact user-facing task name and lifecycle metadata. */
export type ActiveAuditFile =
	| (AuditFileFields & { version: 1; taskName?: never })
	| (AuditFileFields & { version: 2; /** Trimmed original task name. */ taskName: string });

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function activeStatePath(root: string): string {
	return join(root, ".audit", "active.json");
}

export function closedStatePath(root: string, task: string): string {
	return join(root, ".audit", `${task}.closed.json`);
}

export function abandonedStatePath(root: string, task: string): string {
	return join(root, ".audit", `${task}.abandoned.json`);
}

export function isClosedStatePath(root: string, path: string): boolean {
	return resolve(dirname(path)) === resolve(root, ".audit") && basename(path).endsWith(".closed.json");
}

async function readAuditState(path: string): Promise<ActiveAuditFile | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = JSON.parse(raw) as ActiveAuditFile;
	const knownVersion = parsed?.version === 1 || parsed?.version === 2;
	const validTaskName = parsed?.version !== 2 || (typeof parsed.taskName === "string" && Boolean(parsed.taskName));
	if (!knownVersion || typeof parsed.task !== "string" || typeof parsed.logPath !== "string" || !validTaskName) {
		throw new Error(`Unexpected audit state in ${path}`);
	}
	return parsed;
}

async function writeAuditState(path: string, file: ActiveAuditFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temp, path);
}

export function readActiveAudit(root: string): Promise<ActiveAuditFile | undefined> {
	return readAuditState(activeStatePath(root));
}

export function readClosedAudit(root: string, task: string): Promise<ActiveAuditFile | undefined> {
	return readAuditState(closedStatePath(root, task));
}

export function readAbandonedAudit(root: string, task: string): Promise<ActiveAuditFile | undefined> {
	return readAuditState(abandonedStatePath(root, task));
}

export function writeActiveAudit(root: string, file: ActiveAuditFile): Promise<void> {
	return writeAuditState(activeStatePath(root), file);
}

/**
 * The same-directory rename is the authoritative active -> closed transition.
 * Metadata is written first under the workflow lock; if rename fails, the
 * audit remains active and a later close can retry safely.
 */
export async function closeActiveAudit(root: string, file: ActiveAuditFile, at: string): Promise<ActiveAuditFile> {
	const closed = { ...file, lastClosedAt: at };
	await writeActiveAudit(root, closed);
	await rename(activeStatePath(root), closedStatePath(root, file.task));
	return closed;
}

/**
 * Active -> abandoned transition: the audit terminates without review
 * approval or publication. Same metadata-first + rename pattern as close, so
 * a failed rename leaves the audit active for a safe retry. TSV, provenance,
 * and review artifacts are never touched.
 */
export async function abandonActiveAudit(
	root: string,
	file: ActiveAuditFile,
	record: AbandonmentRecord,
): Promise<ActiveAuditFile> {
	const abandoned = { ...file, abandonments: [...(file.abandonments ?? []), record] };
	await writeActiveAudit(root, abandoned);
	await rename(activeStatePath(root), abandonedStatePath(root, file.task));
	return abandoned;
}

/** Atomic inverse of closeActiveAudit for an explicitly requested reopen. */
export async function reopenClosedAudit(root: string, file: ActiveAuditFile, at: string): Promise<ActiveAuditFile> {
	const reopened = {
		...file,
		lastReopenedAt: at,
		reopenCount: (file.reopenCount ?? 0) + 1,
	};
	await writeAuditState(closedStatePath(root, file.task), reopened);
	await rename(closedStatePath(root, file.task), activeStatePath(root));
	return reopened;
}
