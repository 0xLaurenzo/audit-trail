import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "../core/active-state.ts";
import { hookSessionStateDirectory, type HookSessionState } from "./hook-session.ts";

export type CodexSessionState = HookSessionState;

export function codexSessionStatePath(root: string, threadId: string, env: NodeJS.ProcessEnv): string {
	return join(hookSessionStateDirectory("codex", env), `${sha256Hex(threadId)}.${sha256Hex(root)}.json`);
}

export async function writeCodexSessionState(state: CodexSessionState, env: NodeJS.ProcessEnv): Promise<void> {
	const worktree = await realpath(state.worktree);
	const path = codexSessionStatePath(worktree, state.sessionId, env);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, JSON.stringify({ ...state, worktree }), { flag: "wx", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

export async function removeCodexSessionState(root: string, threadId: string, env = process.env): Promise<void> {
	const canonical = await realpath(root).catch((error) => {
		if (error.code === "ENOENT") return root; // Original canonical path of a removed worktree.
		throw error;
	});
	await rm(codexSessionStatePath(canonical, threadId, env), { force: true });
}

/** Resolve only the exact calling thread; never pick a winner across worktrees. */
export async function findCodexSessionState(threadId: string, env = process.env): Promise<CodexSessionState | undefined> {
	const dir = hookSessionStateDirectory("codex", env);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	const prefix = `${sha256Hex(threadId)}.`;
	const matches = files.filter((file) => file.startsWith(prefix) && file.endsWith(".json"));
	if (!matches.length) return undefined;
	if (matches.length > 1) throw new Error("Codex SessionStart state is ambiguous for this thread");
	const path = join(dir, matches[0]);
	try {
		const state = JSON.parse(await readFile(path, "utf8"));
		if (state.sessionId === threadId && typeof state.worktree === "string" &&
			codexSessionStatePath(state.worktree, threadId, env) === path &&
			await realpath(state.worktree) === state.worktree && (await stat(state.worktree)).isDirectory() &&
			typeof state.updatedAt === "string" && Number.isFinite(Date.parse(state.updatedAt)) &&
			(state.model === undefined || typeof state.model === "string") &&
			(state.transcriptPath === undefined || typeof state.transcriptPath === "string")) return state;
	} catch {
		// Do not expose raw state or filesystem diagnostics to the MCP caller.
	}
	throw new Error("Codex SessionStart state is invalid for this thread; start a new trusted Codex session");
}
