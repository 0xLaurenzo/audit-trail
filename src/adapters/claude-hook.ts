import { resolve } from "node:path";
import {
	AuditWorkflow,
	activeStatePath,
	buildActiveAuditGuidance,
	resolveWorktreeRoot,
	type AuditState,
	type CommandRunner,
} from "../core/index.ts";
import { writeClaudeSessionState } from "./claude-session.ts";

export interface ClaudeHookResult {
	/** JSON printed to stdout for Claude Code to interpret (exit 0 only). */
	output?: string;
	/** Diagnostic for stderr; non-blocking for the events this hook serves. */
	error?: string;
	exitCode: number;
}

interface ActiveLookup {
	root: string;
	state?: AuditState;
	/** Set when active-audit state exists but cannot be read. */
	error?: string;
}

async function lookupActive(runner: CommandRunner, cwd: string): Promise<ActiveLookup> {
	const root = await resolveWorktreeRoot(runner, cwd);
	try {
		return { root, state: await new AuditWorkflow(root, runner).active() };
	} catch (error: any) {
		return { root, error: String(error?.message ?? error) };
	}
}

function modelId(model: unknown): string | undefined {
	if (typeof model === "string" && model) return model;
	if (model && typeof model === "object") {
		const candidate = (model as any).id ?? (model as any).display_name;
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return undefined;
}

/**
 * Single entry point for the plugin's Claude Code hooks, dispatching on
 * hook_event_name from the stdin payload:
 *
 * - SessionStart: record the session handoff state for the MCP server and
 *   inject active-audit guidance via additionalContext.
 * - PreToolUse (Write|Edit): deny edits to extension-managed audit files,
 *   failing closed over .audit/ when active state is unreadable.
 *
 * SessionStart failures never block the session (exit 1 is non-blocking);
 * the guard communicates denial through hookSpecificOutput on exit 0.
 */
export async function handleClaudeHook(
	rawInput: string,
	// The payload cwd names the session's project directory, which may differ
	// from this process's cwd; the Git worktree must resolve from the former.
	runnerFor: (cwd: string) => CommandRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeHookResult> {
	let input: any;
	try {
		input = JSON.parse(rawInput);
	} catch {
		return { error: "claude-hook expects a JSON hook payload on stdin", exitCode: 1 };
	}
	const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const runner = runnerFor(cwd);

	if (input?.hook_event_name === "SessionStart") {
		const sessionId = typeof input.session_id === "string" ? input.session_id : "";
		if (!sessionId) return { error: "SessionStart payload has no session_id", exitCode: 1 };
		const lookup = await lookupActive(runner, cwd);
		try {
			await writeClaudeSessionState(
				{
					sessionId,
					transcriptPath: typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : undefined,
					model: modelId(input.model),
					worktree: lookup.root,
					updatedAt: new Date().toISOString(),
				},
				env,
			);
		} catch (error: any) {
			// Attribution degrades to the fallback identity; the session proceeds.
			return { error: `audit-trail could not record Claude session state: ${error?.message ?? error}`, exitCode: 1 };
		}
		if (lookup.error) {
			return { error: `audit-trail state is unreadable: ${lookup.error}`, exitCode: 1 };
		}
		if (!lookup.state) return { exitCode: 0 };
		return {
			output: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: `${buildActiveAuditGuidance(lookup.state.logPath)}\nRecord decisions with the audit_decision tool from the audit-trail MCP server.`,
				},
			}),
			exitCode: 0,
		};
	}

	if (input?.hook_event_name === "PreToolUse") {
		if (input.tool_name !== "Write" && input.tool_name !== "Edit") return { exitCode: 0 };
		const filePath = input.tool_input?.file_path;
		if (typeof filePath !== "string" || !filePath) return { exitCode: 0 };
		const target = resolve(cwd, filePath);
		const deny = (reason: string): ClaudeHookResult => ({
			output: JSON.stringify({
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
			}),
			exitCode: 0,
		});
		const lookup = await lookupActive(runner, cwd);
		if (lookup.error) {
			// Fail closed: with unreadable active-audit state, protect the whole
			// .audit directory instead of silently disabling the guard.
			if (target.startsWith(`${resolve(lookup.root, ".audit")}/`)) {
				return deny(`Audit state is unreadable (${lookup.error}); refusing writes under .audit/.`);
			}
			return { exitCode: 0 };
		}
		if (!lookup.state) return { exitCode: 0 };
		const protectedPaths = [lookup.state.logPath, lookup.state.provenancePath, activeStatePath(lookup.root)].filter(
			(path): path is string => Boolean(path),
		);
		if (protectedPaths.some((path) => target === resolve(path))) {
			return deny("Audit state and Git provenance are extension-managed; use the audit_decision tool for corrections.");
		}
		return { exitCode: 0 };
	}

	// Unknown events are ignored so hook config changes stay forward-compatible.
	return { exitCode: 0 };
}
