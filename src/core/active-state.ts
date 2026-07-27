import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewSnapshot } from "./types.ts";

/**
 * Authoritative active-audit state for one Git worktree. All harness sessions
 * (Pi, Claude Code, Codex, OpenCode) read and write this file instead of
 * keeping session-private state. Paths are relative to the worktree root.
 */
export interface ActiveAuditFile {
	version: 1;
	task: string;
	logPath: string;
	provenancePath?: string;
	startedAt: string;
	review?: ReviewSnapshot;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function activeStatePath(root: string): string {
	return join(root, ".audit", "active.json");
}

export async function readActiveAudit(root: string): Promise<ActiveAuditFile | undefined> {
	let raw: string;
	try {
		raw = await readFile(activeStatePath(root), "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = JSON.parse(raw) as ActiveAuditFile;
	if (parsed?.version !== 1 || typeof parsed.task !== "string" || typeof parsed.logPath !== "string") {
		throw new Error(`Unexpected active-audit state in ${activeStatePath(root)}`);
	}
	return parsed;
}

export async function writeActiveAudit(root: string, file: ActiveAuditFile): Promise<void> {
	const path = activeStatePath(root);
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temp, path);
}

export async function clearActiveAudit(root: string): Promise<void> {
	await rm(activeStatePath(root), { force: true });
}
