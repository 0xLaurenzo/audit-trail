import { realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import {
	AuditWorkflow,
	activeStatePath,
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

async function canonicalPath(path: string): Promise<string> {
	let current = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(current), ...missing.reverse());
		} catch (error: any) {
			if (error?.code !== "ENOENT") return resolve(path);
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			missing.push(basename(current));
			current = parent;
		}
	}
}

function patchTargets(input: any, cwd: string): string[] {
	const direct = input?.tool_input?.file_path;
	if (typeof direct === "string" && direct) return [resolve(cwd, direct)];
	const command = input?.tool_input?.command;
	if (typeof command !== "string") return [];
	const targets: string[] = [];
	for (const line of command.split(/\r?\n/)) {
		const match = /^(?:\*\*\* (?:Add|Update|Delete) File:|\*\*\* Move to:|\+\+\+|---)\s+(.+)$/.exec(line);
		if (!match) continue;
		let path = match[1].trim().replace(/^['"]|['"]$/g, "");
		if (path === "/dev/null") continue;
		path = path.replace(/^[ab]\//, "");
		targets.push(resolve(cwd, path));
	}
	return [...new Set(targets)];
}

function deny(reason: string): CodexHookResult {
	return {
		output: JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
		exitCode: 0,
	};
}

/** Codex plugin hook entry point for session attribution/guidance and direct-edit protection. */
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
					additionalContext: `${buildActiveAuditGuidance(lookup.state.logPath)}\nRecord decisions with the audit_decision tool from the audit-trail MCP server.`,
				},
			}),
			exitCode: 0,
		};
	}

	if (input?.hook_event_name === "PreToolUse") {
		if (!new Set(["apply_patch", "Write", "Edit"]).has(input.tool_name)) return { exitCode: 0 };
		const lookup = await lookupActive(runner, cwd);
		const rawCommand = typeof input?.tool_input?.command === "string" ? input.tool_input.command : "";
		const targets = await Promise.all(patchTargets(input, cwd).map(canonicalPath));
		const auditRoot = await canonicalPath(resolve(lookup.root, ".audit"));
		const mentionsAudit = /(?:^|[\\/])\.audit[\\/]/m.test(rawCommand);
		if (lookup.error) {
			if (mentionsAudit || targets.some((target) => target === auditRoot || target.startsWith(`${auditRoot}${sep}`))) {
				return deny(`Audit state is unreadable (${lookup.error}); refusing writes under .audit/.`);
			}
			return { exitCode: 0 };
		}
		if (!lookup.state) return { exitCode: 0 };
		const protectedPaths = [lookup.state.logPath, lookup.state.provenancePath, activeStatePath(lookup.root)].filter(
			(path): path is string => Boolean(path),
		);
		const canonicalProtected = await Promise.all(protectedPaths.map(canonicalPath));
		if (targets.some((target) => canonicalProtected.includes(target))) {
			return deny("Audit state and Git provenance are extension-managed; use the audit_decision tool for corrections.");
		}
		if (!targets.length && mentionsAudit) {
			return deny("Could not identify the audit patch target safely; use the audit_decision tool for audit changes.");
		}
	}

	return { exitCode: 0 };
}
