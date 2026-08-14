import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	hookSessionStateDirectory,
	hookSessionStatePath,
	readHookSessionState,
	writeHookSessionState,
	type HookSessionState,
} from "./hook-session.ts";

export type CodexSessionState = HookSessionState;

export function codexSessionStatePath(worktreeRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	return hookSessionStatePath("codex", worktreeRoot, env);
}

export function writeCodexSessionState(
	state: CodexSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	return writeHookSessionState("codex", state, env);
}

export function readCodexSessionState(
	worktreeRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexSessionState | undefined> {
	return readHookSessionState("codex", worktreeRoot, env);
}

/** Find the worktree state whose SessionStart ID matches Codex MCP `_meta.threadId`. */
export async function findCodexSessionState(
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexSessionState | undefined> {
	let files: string[];
	try {
		files = await readdir(hookSessionStateDirectory("codex", env));
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	// ponytail: linear scan is enough for per-worktree state; add a session index only if lookup becomes measurable.
	const matches: CodexSessionState[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(await readFile(join(hookSessionStateDirectory("codex", env), file), "utf8"));
			if (typeof parsed?.worktree !== "string") continue;
			if (basename(codexSessionStatePath(parsed.worktree, env)) !== file) continue;
			const state = await readCodexSessionState(parsed.worktree, env);
			if (state?.sessionId === sessionId) matches.push(state);
		} catch {
			// Ignore unrelated stale or malformed state files.
		}
	}
	if (matches.length > 1) throw new Error("Codex SessionStart state is ambiguous for this thread");
	return matches[0];
}
