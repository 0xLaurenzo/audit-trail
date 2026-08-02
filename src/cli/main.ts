import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256Hex } from "../core/active-state.ts";
import { publishRawAudit } from "../core/github-publisher.ts";
import { runIndependentReview } from "../core/independent-review.ts";
import { displayPath } from "../core/paths.ts";
import { formatBlockingReviewMessage } from "../core/review.ts";
import type { CommandRunner, ReviewerPort, SessionIdentity } from "../core/ports.ts";
import { formatStatusLines } from "../core/status.ts";
import { reviewBlocker } from "../core/validation.ts";
import {
	CONFIDENCE_VALUES,
	ORIGIN_VALUES,
	RESULT_VALUES,
	REVIEW_MODES,
	type AuditState,
	type NewAuditRow,
	type ReviewMode,
} from "../core/types.ts";
import { AuditWorkflow, resolveWorktreeRoot } from "../core/workflow.ts";
import { handleClaudeHook } from "../adapters/claude-hook.ts";
import { createClaudeSubprocessReviewer } from "../adapters/claude-reviewer.ts";
import { readClaudeSessionState } from "../adapters/claude-session.ts";
import { handleCodexHook } from "../adapters/codex-hook.ts";
import { codexMcpOptions } from "../adapters/codex-mcp.ts";
import { createPiSubprocessReviewer } from "../adapters/pi-reviewer.ts";
import { McpAuditServer, serveStdio, type McpServerOptions } from "../mcp/server.ts";

const HELP = `audit-trail — append-only decision auditing for one Git worktree

Usage: audit-trail [-C <dir>] <command> [options]

Commands:
  start <task>       Create a new worktree decision audit
  resume <task>      Explicitly join the matching active audit
  reopen <task>      Explicitly restore the matching closed audit
  decision           Append one decision row (see options below)
  status             Show audit status and unresolved decision IDs
  review <model>     Run an independent review with <provider/model>
  publish [pr]       Create or update readable audit comments with canonical TSV
  close              Close the audit once resolved and reviewed
  mcp                Serve the audit tools as a local MCP server on stdio
                     (--harness claude|codex uses that harness's hook state)
  claude-hook        Handle a Claude Code hook payload on stdin (plugin use)
  codex-hook         Handle a Codex hook payload on stdin (plugin use)
  install <target>   Configure a harness: pi | claude | codex | opencode | all
  help               Show this help

Decision options:
  --phase <text>          Short workstream or phase name
  --origin <value>        ${ORIGIN_VALUES.join(" | ")}
  --decision <text>       The reviewer-relevant choice
  --why <text>            Technical rationale and protected invariant
  --alternatives <text>   Alternatives considered (default: none)
  --confidence <value>    ${CONFIDENCE_VALUES.join(" | ")}
  --evidence <text>       Evidence pointer (file:line, commit, test, ...)
  --result <value>        ${RESULT_VALUES.join(" | ")}
  --supersedes <id>       Prior decision ID replaced by this row

Review options:
  --mode <value>          ${REVIEW_MODES.join(" | ")} (required: how the reviewer
                          relates to the working model; the CLI cannot infer this)`;

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
}

export interface CliDependencies {
	/** Construct the reviewer runtime for review and MCP commands. */
	createReviewer(runner: CommandRunner): ReviewerPort;
}

const defaultDependencies: CliDependencies = { createReviewer: createPiSubprocessReviewer };

export function processRunner(cwd?: string): CommandRunner {
	return {
		exec(command, args, options) {
			return new Promise((resolveExec) => {
				const child = execFile(
					command,
					args,
					{ cwd, timeout: options?.timeout, signal: options?.signal, maxBuffer: 64 * 1024 * 1024 },
					(error: any, stdout, stderr) => {
						const stderrText = String(stderr ?? "");
						resolveExec({
							stdout: String(stdout ?? ""),
							// Spawn failures (for example ENOENT for a missing binary) carry
							// no stderr; surface the error message instead of losing it.
							stderr: stderrText || (error ? String(error?.message ?? error) : ""),
							code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
							killed: Boolean(error?.killed),
						});
					},
				);
				child.on("error", () => {
					// execFile callback also fires; nothing extra to do.
				});
				// No spawned command takes piped input, but some (opencode run) wait
				// for EOF on an open stdin pipe and would hang until timeout.
				child.stdin?.end();
			});
		},
	};
}

function cliSession(): SessionIdentity {
	let user = "unknown";
	try {
		user = userInfo().username;
	} catch {
		// Fall back to "unknown" on systems without user info.
	}
	return { harness: "cli", id: `${user}@${hostname()}` };
}

function oneOf<T extends readonly string[]>(values: T, value: string, label: string): T[number] {
	if (!values.includes(value)) {
		throw new Error(`Invalid ${label}: ${value}. Expected one of: ${values.join(", ")}`);
	}
	return value;
}

async function requireActive(workflow: AuditWorkflow): Promise<AuditState> {
	const state = await workflow.active();
	if (!state) throw new Error("No audit is active in this worktree. Start one with: audit-trail start <task>");
	return state;
}

async function commandLifecycle(
	workflow: AuditWorkflow,
	operation: "start" | "resume" | "reopen",
	task: string,
	io: CliIo,
): Promise<number> {
	if (!task) {
		io.err(`Usage: audit-trail ${operation} <task>`);
		return 1;
	}
	const result = await workflow[operation](task, cliSession());
	if (result.provenanceError) {
		io.err(`Audit will remain local because GitHub provenance could not be captured: ${result.provenanceError}`);
	}
	const provenance = result.state.provenance;
	const verb = operation === "start" ? "Started" : operation === "resume" ? "Resumed" : "Reopened";
	io.out(
		`${verb} decision audit: ${displayPath(result.state.logPath, workflow.root)}${provenance ? ` (${provenance.repository}@${provenance.branch})` : ""}`,
	);
	return 0;
}

async function commandDecision(workflow: AuditWorkflow, args: string[], io: CliIo): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			phase: { type: "string" },
			origin: { type: "string" },
			decision: { type: "string" },
			why: { type: "string" },
			alternatives: { type: "string" },
			confidence: { type: "string" },
			evidence: { type: "string" },
			result: { type: "string" },
			supersedes: { type: "string" },
		},
		strict: true,
	});
	for (const required of ["phase", "origin", "decision", "why", "confidence", "evidence", "result"] as const) {
		if (!values[required]) throw new Error(`Missing required option --${required}`);
	}
	const row: Omit<NewAuditRow, "session" | "entry"> = {
		phase: values.phase!,
		origin: oneOf(ORIGIN_VALUES, values.origin!, "origin"),
		decision: values.decision!,
		why: values.why!,
		alternatives: values.alternatives || "none",
		confidence: oneOf(CONFIDENCE_VALUES, values.confidence!, "confidence"),
		evidence: values.evidence!,
		result: oneOf(RESULT_VALUES, values.result!, "result"),
		supersedes: values.supersedes ?? "",
	};
	const appended = await workflow.append(cliSession(), row);
	io.out(`Logged ${appended.row.id}: ${appended.row.decision}`);
	return 0;
}

async function commandStatus(workflow: AuditWorkflow, io: CliIo): Promise<number> {
	const state = await requireActive(workflow);
	const rows = await workflow.rows(state);
	const currentSha = await workflow.currentSha(state);
	for (const line of formatStatusLines(state, rows, currentSha, workflow.root)) io.out(line);
	return 0;
}

async function commandReview(
	workflow: AuditWorkflow,
	args: string[],
	io: CliIo,
	dependencies: CliDependencies,
): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { mode: { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	const model = positionals[0];
	if (!model || !model.includes("/")) {
		io.err("Usage: audit-trail review <provider/model> --mode cross-provider|cross-model|same-model");
		return 1;
	}
	if (!values.mode) {
		// The CLI has no working model to compare against, so it must not guess:
		// a defaulted mode would record unverifiable independence claims in the
		// review checkpoint. The invoker states the relation explicitly.
		io.err("Specify --mode: how the reviewer relates to the working model (cross-provider|cross-model|same-model)");
		return 1;
	}
	const mode = oneOf(REVIEW_MODES, values.mode, "mode") as ReviewMode;
	await requireActive(workflow);
	io.out(`Reviewing with ${model} (${mode})...`);
	const review = await runIndependentReview({
		workflow,
		reviewer: dependencies.createReviewer(processRunner(workflow.root)),
		// The CLI pins the explicitly requested model: no fallback candidates.
		candidates: [{ model, mode }],
		harnessName: "cli",
	});
	const reviewPath = displayPath(review.reviewPath, workflow.root);
	if (review.verdict === "block") {
		io.err(formatBlockingReviewMessage(review.report, reviewPath, 6_000));
		return 1;
	}
	io.out(`Review saved: ${reviewPath} (verdict: approve)`);
	return 0;
}



async function commandMcp(
	workflow: AuditWorkflow,
	args: string[],
	io: CliIo,
	dependencies: CliDependencies,
): Promise<number> {
	const { values } = parseArgs({ args, options: { harness: { type: "string" } }, strict: true });
	const harness = values.harness ?? "mcp";
	const runner = processRunner(workflow.root);
	let options: Pick<
		McpServerOptions,
		"session" | "reviewer" | "reviewTranscriptPath" | "reviewCandidates" | "reviewTool"
	>;
	if (harness === "claude") {
		// Claude Code passes session metadata only to hooks; the SessionStart
		// hook records it and this long-lived server re-reads it per call so a
		// successful resume/clear refresh changes attribution without a restart.
		options = {
			session: async () => {
				const state = await readClaudeSessionState(workflow.root);
				return { harness: "claude", id: state?.sessionId ?? cliSession().id };
			},
			reviewer: createClaudeSubprocessReviewer(runner),
			reviewTranscriptPath: async () => {
				const transcript = (await readClaudeSessionState(workflow.root))?.transcriptPath;
				if (!transcript) return undefined;
				try {
					await readFile(transcript, "utf8");
					return transcript;
				} catch {
					// A stale or unreadable transcript falls back to transcript-less review.
					return undefined;
				}
			},
		};
	} else if (harness === "codex") {
		options = codexMcpOptions(workflow.root, runner, cliSession().id);
	} else if (harness === "mcp") {
		options = {
			session: { harness: "mcp", id: cliSession().id },
			reviewer: dependencies.createReviewer(runner),
		};
	} else {
		io.err(`Unknown --harness: ${harness}. Expected one of: mcp, claude, codex`);
		return 1;
	}
	const server = new McpAuditServer({ workflow, runner, ...options });
	io.err(`audit-trail MCP server on stdio for ${workflow.root} (harness: ${harness})`);
	await serveStdio(server);
	return 0;
}

async function commandHook(harness: "claude" | "codex", io: CliIo): Promise<number> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = Buffer.concat(chunks).toString("utf8");
	const result =
		harness === "claude" ? await handleClaudeHook(input, processRunner) : await handleCodexHook(input, processRunner);
	if (result.output) io.out(result.output);
	if (result.error) io.err(result.error);
	return result.exitCode;
}

async function commandInstall(target: string, io: CliIo): Promise<number> {
	if (!target) {
		io.err("Usage: audit-trail install <pi|claude|codex|opencode|all>");
		return 1;
	}
	// Loaded lazily: the installer module needs jsonc-parser, which is absent
	// in bare marketplace clones. Hooks, MCP, and every other CLI command must
	// keep a dependency-free import graph so those installs work unmodified.
	let installerModule: typeof import("../install/installers.ts");
	try {
		installerModule = await import("../install/installers.ts");
	} catch (error: any) {
		io.err(
			`The install command needs the package's declared dependencies (${error?.message ?? error}). ` +
			"Run `npm install --omit=dev` in the package root, or use a Nix-installed audit-trail. " +
			"Marketplace-managed plugin installs do not need this command.",
		);
		return 1;
	}
	const { packageRootFromModule, selectInstallers } = installerModule;
	const ctx = { home: homedir(), packageRoot: packageRootFromModule(import.meta.url), runner: processRunner() };
	let failed = false;
	for (const installer of selectInstallers(target)) {
		try {
			const result = await installer.install(ctx);
			io.out(`${result.harness}: ${result.message}`);
		} catch (error: any) {
			failed = true;
			io.err(`${installer.harness}: install failed: ${error?.message ?? error}`);
		}
	}
	return failed ? 1 : 0;
}

async function commandPublish(workflow: AuditWorkflow, selectorArg: string, io: CliIo): Promise<number> {
	const state = await requireActive(workflow);
	if (!state.provenance) {
		io.err("This audit has no Git provenance; publishing requires a GitHub origin");
		return 1;
	}
	const rows = await workflow.rows(state);
	// Read once and gate on these exact bytes so a concurrent append between
	// check and publication cannot slip unreviewed rows into the PR comment.
	const rawTsv = await readFile(state.logPath, "utf8");
	const blocker = reviewBlocker(state, sha256Hex(rawTsv));
	if (blocker) {
		io.err(`${blocker}. Run audit-trail review before publishing`);
		return 1;
	}
	const result = await publishRawAudit({
		runner: processRunner(workflow.root),
		state: { ...state, auditId: await workflow.ensureAuditId() },
		rows,
		rawTsv,
		selector: selectorArg || undefined,
	});
	io.out(
		`Published audit in ${result.commentCount} readable comment${result.commentCount === 1 ? "" : "s"} with canonical TSV on PR #${result.prNumber}: ${result.commentUrl}`,
	);
	if (result.foreignCommentCount) {
		io.err(
			`Warning: ${result.foreignCommentCount} same-task audit comment${result.foreignCommentCount === 1 ? "" : "s"} from a different audit exist on this PR and were left untouched; remove them manually if unwanted.`,
		);
	}
	return 0;
}

async function commandClose(workflow: AuditWorkflow, io: CliIo): Promise<number> {
	const result = await workflow.close();
	if (!result.closed) {
		io.err("Cannot close audit:");
		for (const blocker of result.blockers) io.err(`- ${blocker}`);
		return 1;
	}
	io.out(`Audit closed: ${displayPath(result.state.logPath, workflow.root)}`);
	return 0;
}

export async function runCli(
	argv: string[],
	io: CliIo = { out: console.log, err: console.error },
	dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
	const args = [...argv];
	let directory = process.cwd();
	const dirFlag = args.indexOf("-C");
	if (dirFlag !== -1) {
		const target = args[dirFlag + 1];
		if (!target) {
			io.err("-C requires a directory");
			return 1;
		}
		directory = resolve(target);
		args.splice(dirFlag, 2);
	}
	const command = args.shift() ?? "help";
	if (command === "help" || command === "--help" || command === "-h") {
		io.out(HELP);
		return 0;
	}
	if (command === "claude-hook" || command === "codex-hook") {
		// Hooks must not require an existing workflow; they run in any repo.
		try {
			return await commandHook(command === "claude-hook" ? "claude" : "codex", io);
		} catch (error: any) {
			io.err(`Error: ${error?.message ?? error}`);
			return 1;
		}
	}
	try {
		const runner = processRunner(directory);
		const root = await resolveWorktreeRoot(runner, directory);
		const workflow = new AuditWorkflow(root, runner);
		switch (command) {
			case "start":
			case "resume":
			case "reopen":
				return await commandLifecycle(workflow, command, args.join(" ").trim(), io);
			case "decision":
				return await commandDecision(workflow, args, io);
			case "status":
				return await commandStatus(workflow, io);
			case "review":
				return await commandReview(workflow, args, io, dependencies);
			case "publish":
				return await commandPublish(workflow, (args[0] ?? "").trim(), io);
			case "close":
				return await commandClose(workflow, io);
			case "mcp":
				return await commandMcp(workflow, args, io, dependencies);
			case "install":
				return await commandInstall((args[0] ?? "").trim(), io);
			default:
				io.err(`Unknown command: ${command}\n\n${HELP}`);
				return 1;
		}
	} catch (error: any) {
		io.err(`Error: ${error?.message ?? error}`);
		return 1;
	}
}
