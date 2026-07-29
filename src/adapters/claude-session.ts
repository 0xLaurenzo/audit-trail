import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../core/active-state.ts";

/**
 * Claude Code passes session metadata (session ID, transcript path, model)
 * only to hooks, never to MCP server processes. The SessionStart hook writes
 * this per-worktree state file and the claude-harness MCP server reads it at
 * each tool call to attribute rows as claude/<session-id>.
 *
 * The file lives under XDG state (not inside the worktree) so opening a repo
 * in Claude Code never creates .audit/ in projects that have no audit.
 * Concurrent Claude sessions in one worktree are last-writer-wins.
 */
export interface ClaudeSessionState {
	sessionId: string;
	/** JSONL conversation transcript, when Claude Code provided one. */
	transcriptPath?: string;
	/** Working model when present; SessionStart does not guarantee it. */
	model?: string;
	/** Worktree root this state belongs to; guards against hash collisions. */
	worktree: string;
	updatedAt: string;
}

export function claudeSessionStatePath(worktreeRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state");
	return join(base, "audit-trail", "claude", `${sha256Hex(worktreeRoot).slice(0, 32)}.json`);
}

export async function writeClaudeSessionState(
	state: ClaudeSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const path = claudeSessionStatePath(state.worktree, env);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

export async function readClaudeSessionState(
	worktreeRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeSessionState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(claudeSessionStatePath(worktreeRoot, env), "utf8"));
		if (typeof parsed?.sessionId !== "string" || !parsed.sessionId) return undefined;
		if (parsed.worktree !== worktreeRoot) return undefined;
		return parsed as ClaudeSessionState;
	} catch {
		// Missing or unreadable state degrades to fallback attribution.
		return undefined;
	}
}
