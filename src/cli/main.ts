import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256Hex } from "../core/active-state.ts";
import { publishRawAudit } from "../core/github-publisher.ts";
import { displayPath } from "../core/paths.ts";
import type { CommandRunner, SessionIdentity } from "../core/ports.ts";
import {
	buildReviewDocument,
	buildReviewPrompt,
	extractFinalAssistantOutput,
	writeReviewArtifact,
} from "../core/review.ts";
import {
	CONFIDENCE_VALUES,
	ORIGIN_VALUES,
	RESULT_VALUES,
	REVIEW_MODES,
	type AuditState,
	type NewAuditRow,
	type ReviewMode,
} from "../core/types.ts";
import { summarize } from "../core/validation.ts";
import { AuditWorkflow, resolveWorktreeRoot } from "../core/workflow.ts";

const HELP = `audit-trail — append-only decision auditing for one Git worktree

Usage: audit-trail [-C <dir>] <command> [options]

Commands:
  start <task>       Start or resume the worktree's decision audit
  decision           Append one decision row (see options below)
  status             Show audit status and unresolved decision IDs
  review <model>     Run an independent review with <provider/model>
  publish [pr]       Create or update raw audit TSV comments on the PR
  close              Close the audit once resolved and reviewed
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

async function commandStart(workflow: AuditWorkflow, task: string, io: CliIo): Promise<number> {
	if (!task) {
		io.err("Usage: audit-trail start <task>");
		return 1;
	}
	const result = await workflow.start(task, cliSession());
	if (result.provenanceError) {
		io.err(`Audit will remain local because GitHub provenance could not be captured: ${result.provenanceError}`);
	}
	const provenance = result.state.provenance;
	io.out(
		`${result.resumed ? "Resumed" : "Started"} decision audit: ${displayPath(result.state.logPath, workflow.root)}${provenance ? ` (${provenance.repository}@${provenance.branch})` : ""}`,
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
	const stats = summarize(rows);
	const currentSha = await workflow.currentSha(state);
	const list = (items: { id: string }[]) => items.map((item) => item.id).join(", ") || "none";
	io.out(`${state.task}: ${stats.total} rows (${stats.active} active)`);
	io.out(`unresolved: ${list(stats.unresolved)}`);
	io.out(`low confidence: ${list(stats.lowConfidence)}`);
	io.out(`missing evidence: ${list(stats.missingEvidence)}`);
	io.out(`log: ${displayPath(state.logPath, workflow.root)}`);
	io.out(
		state.provenance
			? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
			: "origin: unavailable (local audit)",
	);
	io.out(
		state.review
			? `review: ${state.review.path} (${state.review.mode}${state.review.sha256 === currentSha ? "" : ", stale"})`
			: "review: not run",
	);
	return 0;
}

async function commandReview(workflow: AuditWorkflow, args: string[], io: CliIo): Promise<number> {
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
	const state = await requireActive(workflow);
	const rows = await workflow.rows(state);
	const prompt = buildReviewPrompt({ logPath: state.logPath, workingDirectory: workflow.root, harnessName: "cli" });
	const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-review-"));
	try {
		const promptPath = join(tempDir, "reviewer.md");
		await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		io.out(`Reviewing with ${model} (${mode})...`);
		const runner = processRunner(workflow.root);
		const invocation = await runner.exec(
			"pi",
			[
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--model",
				model,
				"--tools",
				"read,grep,find,ls",
				"--append-system-prompt",
				promptPath,
				"Perform the independent audit review now.",
			],
			{ timeout: 10 * 60 * 1000 },
		);
		if (invocation.code !== 0) {
			throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
		}
		const { output, error } = extractFinalAssistantOutput(invocation.stdout);
		if (error) throw new Error(`reviewer model failed: ${error}`);
		if (!output) throw new Error("reviewer produced no final assistant output");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const reviewPath = resolve(workflow.root, ".audit", `${state.task}.review.${stamp}.md`);
		const document = buildReviewDocument({
			model,
			reviewMode: mode,
			logPath: state.logPath,
			workingDirectory: workflow.root,
			rowCount: rows.length,
			output,
			harnessName: "cli",
		});
		await writeReviewArtifact(reviewPath, document);
		await workflow.recordReview({ path: reviewPath, mode, model });
		io.out(`Review saved: ${displayPath(reviewPath, workflow.root)}`);
		return 0;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
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
	if (!state.review || state.review.sha256 !== sha256Hex(rawTsv)) {
		io.err("Run audit-trail review after the latest decision before publishing");
		return 1;
	}
	const selector = selectorArg || (state.provenance.branch !== "DETACHED" ? state.provenance.branch : "");
	if (!selector) {
		io.err("Detached audits require: audit-trail publish <pr-number-or-url>");
		return 1;
	}
	const result = await publishRawAudit({ runner: processRunner(workflow.root), state, rows, rawTsv, selector });
	io.out(
		`Published raw audit TSV in ${result.commentCount} comment${result.commentCount === 1 ? "" : "s"} on PR #${result.prNumber}: ${result.commentUrl}`,
	);
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

export async function runCli(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
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
	try {
		const runner = processRunner(directory);
		const root = await resolveWorktreeRoot(runner, directory);
		const workflow = new AuditWorkflow(root, runner);
		switch (command) {
			case "start":
				return await commandStart(workflow, args.join(" ").trim(), io);
			case "decision":
				return await commandDecision(workflow, args, io);
			case "status":
				return await commandStatus(workflow, io);
			case "review":
				return await commandReview(workflow, args, io);
			case "publish":
				return await commandPublish(workflow, (args[0] ?? "").trim(), io);
			case "close":
				return await commandClose(workflow, io);
			default:
				io.err(`Unknown command: ${command}\n\n${HELP}`);
				return 1;
		}
	} catch (error: any) {
		io.err(`Error: ${error?.message ?? error}`);
		return 1;
	}
}
