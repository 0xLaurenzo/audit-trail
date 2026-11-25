import {
	AuditWorkflow,
	buildActiveAuditGuidance,
	resolveWorktreeRoot,
	type AuditState,
	type CommandRunner,
} from "../core/index.ts";
import { writeCodexSessionState } from "./codex-session.ts";

export interface CodexHookResult {
	output?: string;
	error?: string;
	exitCode: number;
}

interface ActiveLookup {
	root: string;
	state?: AuditState;
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

/** Codex plugin hook entry point for session attribution and guidance. */
export async function handleCodexHook(
	rawInput: string,
	runnerFor: (cwd: string) => CommandRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexHookResult> {
	let input: any;
	try {
		input = JSON.parse(rawInput);
	} catch {
		return { error: "codex-hook expects a JSON hook payload on stdin", exitCode: 1 };
	}
	const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const runner = runnerFor(cwd);

	if (input?.hook_event_name === "SessionStart") {
		const sessionId = typeof input.session_id === "string" ? input.session_id : "";
		if (!sessionId) return { error: "SessionStart payload has no session_id", exitCode: 1 };
		const lookup = await lookupActive(runner, cwd);
		try {
			await writeCodexSessionState(
				{
					sessionId,
					transcriptPath:
						typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : undefined,
					model: typeof input.model === "string" && input.model ? input.model : undefined,
					worktree: lookup.root,
					updatedAt: new Date().toISOString(),
				},
				env,
			);
		} catch (error: any) {
			return { error: `audit-trail could not record Codex session state: ${error?.message ?? error}`, exitCode: 1 };
		}
		if (lookup.error) return { error: `audit-trail state is unreadable: ${lookup.error}`, exitCode: 1 };
		if (!lookup.state) return { exitCode: 0 };
		return {
			output: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: `${buildActiveAuditGuidance(lookup.state.logPath)}\nUse the audit_decision tool and other Codex MCP tools only for the SessionStart worktree. Pass the absolute implementation root as expectedWorktree; check audit_status first. If intentionally targeting a different linked worktree or MCP is unavailable, use audit-trail -C <target> for the whole workflow, including decisions. Report conflicting instructions; do not mix interfaces.`,
				},
			}),
			exitCode: 0,
		};
	}

	return { exitCode: 0 };
}
