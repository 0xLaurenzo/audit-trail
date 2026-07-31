import {
	hookSessionStatePath,
	readHookSessionState,
	writeHookSessionState,
	type HookSessionState,
} from "./hook-session.ts";

/**
 * Claude Code passes session metadata only to hooks, never to MCP server
 * processes. These wrappers retain the Claude-specific API while sharing the
 * per-worktree state implementation with Codex.
 */
export type ClaudeSessionState = HookSessionState;

export function claudeSessionStatePath(worktreeRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	return hookSessionStatePath("claude", worktreeRoot, env);
}

export function writeClaudeSessionState(
	state: ClaudeSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	return writeHookSessionState("claude", state, env);
}

export function readClaudeSessionState(
	worktreeRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeSessionState | undefined> {
	return readHookSessionState("claude", worktreeRoot, env);
}
