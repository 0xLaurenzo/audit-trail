import {
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
