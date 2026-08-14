import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../core/active-state.ts";

export type HookHarness = "claude" | "codex";

/** Session metadata supplied to hook-based harnesses but not their MCP child. */
export interface HookSessionState {
	sessionId: string;
	/** Optional transcript path; hook transcript formats are not stable APIs. */
	transcriptPath?: string;
	/** Working model slug when the SessionStart payload supplies it. */
	model?: string;
	/** Canonical worktree root this state belongs to. */
	worktree: string;
	updatedAt: string;
}

export function hookSessionStateDirectory(
	harness: HookHarness,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const base = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state");
	return join(base, "audit-trail", harness);
}

export function hookSessionStatePath(
	harness: HookHarness,
	worktreeRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(hookSessionStateDirectory(harness, env), `${sha256Hex(worktreeRoot).slice(0, 32)}.json`);
}

export async function writeHookSessionState(
	harness: HookHarness,
	state: HookSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const path = hookSessionStatePath(harness, state.worktree, env);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

export async function readHookSessionState(
	harness: HookHarness,
	worktreeRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookSessionState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(hookSessionStatePath(harness, worktreeRoot, env), "utf8"));
		if (typeof parsed?.sessionId !== "string" || !parsed.sessionId) return undefined;
		if (parsed.worktree !== worktreeRoot) return undefined;
		return parsed as HookSessionState;
	} catch {
		// Missing or unreadable state degrades to fallback attribution.
		return undefined;
	}
}
