import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AuditStore,
	ORIGIN_VALUES,
	buildReviewDocument,
	buildReviewPrompt,
	closeBlockers,
	displayPath,
	ensureProvenance,
	publishRawAudit,
	safeSlug,
	summarize,
	writeReviewArtifact,
	type AuditRow,
	type AuditState,
	type CommandRunner,
	type GitProvenance,
} from "../core/index.ts";

const ENTRY_TYPE = "audit-trail-control";
/// Reviewer preference, most advanced first. The Anthropic entries only apply
/// when the working model is from another provider (e.g. OpenAI); the
/// different-provider constraint filters them out otherwise. The Codex entry
/// covers Anthropic working models, where the alphabetically-first eligible
/// model may be unusable on the configured account.
const REVIEW_MODEL_PREFERENCE = [/fable/i, /opus-4-8/i, /gpt-5\.6-sol/i];

const Origin = StringEnum(ORIGIN_VALUES, {
	description:
		"What caused this decision to be considered: user requirement, user correction, source invariant, failing test, code review, external specification, or implementation discovery",
});
const Confidence = StringEnum(["high", "medium", "low"] as const);
const Result = StringEnum(["open", "verified", "reverted", "inconclusive"] as const);

const AuditDecisionParams = Type.Object({
	phase: Type.String({ description: "Short workstream or phase name" }),
	origin: Origin,
	decision: Type.String({
		description:
			"The reviewer-relevant product or engineering choice, assumption, pivot, or revert—not a workflow action or verification step",
	}),
	why: Type.String({
		description: "Technical reason the option is correct, including the consequence or invariant it protects",
	}),
	alternatives: Type.Optional(
		Type.String({ description: "Alternatives considered and why they were not selected; use 'none' if none" }),
	),
	confidence: Confidence,
	evidence: Type.String({
		description: "A concise evidence pointer such as file:line, commit SHA, test command, trace, or artifact path",
	}),
	result: Result,
	supersedes: Type.Optional(Type.String({ description: "Prior decision ID replaced by this row, such as D0003" })),
});

type ControlData =
	| {
			action: "start";
			task: string;
			logPath: string;
			provenancePath?: string;
			provenance?: GitProvenance;
	  }
	| { action: "review"; task: string; logPath: string; reviewPath: string; reviewedCount: number }
	| { action: "close"; task: string; logPath: string };

function updateStatus(ctx: ExtensionContext, state: AuditState | undefined, rows: AuditRow[] = []): void {
	if (!state) {
		ctx.ui.setStatus("audit-trail", undefined);
		return;
	}
	const stats = summarize(rows);
	const flags = stats.unresolved.length + stats.lowConfidence.length;
	ctx.ui.setStatus("audit-trail", `audit: ${stats.total} decisions${flags ? ` · ${flags} flags` : ""}`);
}

function reconstructState(ctx: ExtensionContext): AuditState | undefined {
	let state: AuditState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as ControlData | undefined;
		if (!data) continue;
		if (data.action === "start") {
			state = {
				task: data.task,
				logPath: data.logPath,
				provenancePath: data.provenancePath,
				provenance: data.provenance,
			};
		}
		if (data.action === "review" && state?.logPath === data.logPath) {
			state.reviewPath = data.reviewPath;
			state.reviewedCount = data.reviewedCount;
		}
		if (data.action === "close" && state?.logPath === data.logPath) state = undefined;
	}
	return state;
}

function extractFinalAssistantOutput(stdout: string): { output: string; error?: string } {
	let output = "";
	let error: string | undefined;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			if (event.message.stopReason === "error") {
				error = event.message.errorMessage || "assistant message ended with an error";
			}
			const text = (event.message.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			if (text) output = text;
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return { output, error };
}

export default function auditTrailExtension(pi: ExtensionAPI) {
	let state: AuditState | undefined;
	const store = new AuditStore(withFileMutationQueue);
	const runner: CommandRunner = {
		exec: (command, args, options) => pi.exec(command, args, options),
	};

	const refresh = async (ctx: ExtensionContext) => {
		state = reconstructState(ctx);
		const rows = state ? await store.readRows(state.logPath).catch(() => []) : [];
		updateStatus(ctx, state, rows);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!state) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Active decision audit\n` +
				`An append-only decision audit is active at ${state.logPath}. ` +
				`Use audit_decision only for reviewer-relevant product or engineering choices where a reasonable alternative would materially change behavior or code. ` +
				`Log compatibility and migration policy, public API or schema behavior, architecture and meaningful implementation trade-offs, security or correctness invariants, ambiguous requirement interpretations, user corrections, and consequential pivots or reverts. ` +
				`Do not log branches, commits, pushes, pull requests, audit publication, routine verification, commands or tool usage, straightforward implementation steps, formatting, or documentation/version updates that do not change compatibility. ` +
				`Record what caused each choice in origin separately from the technical rationale in why; use user correction when a user changes or clarifies prior direction. ` +
				`Log choices introduced by underspecified requirements before implementing them, and state the plausible alternative and the behavior, compatibility guarantee, or invariant protected. ` +
				`Mark narrowly tailored choices, untested assumptions, and uncertainty honestly with medium/low confidence or an open/inconclusive result. ` +
				`When correcting a prior choice, append a row using supersedes; never rewrite history. ` +
				`Do not declare the audited task complete while active decisions remain open, inconclusive, low-confidence, or unsupported by evidence.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const input = event.input as { path?: unknown };
		const inputPath = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : undefined;
		const protectedPaths = [state.logPath, state.provenancePath].filter((path): path is string => Boolean(path));
		if (inputPath && protectedPaths.some((path) => inputPath === resolve(path))) {
			return {
				block: true,
				reason: "Audit logs and Git provenance are extension-managed; use audit_decision for corrections.",
			};
		}
	});

	pi.registerTool({
		name: "audit_decision",
		label: "Audit decision",
		description:
			"Append one reviewer-relevant product or engineering decision whose alternative would materially change behavior or code. Excludes delivery operations and routine verification.",
		promptSnippet: "Append a reviewer-relevant product or engineering choice to the active decision audit",
		promptGuidelines: [
			"Use audit_decision for compatibility or migration policy, public API or schema behavior, architecture or meaningful implementation trade-offs, correctness or security invariants, ambiguous requirement interpretations, user corrections, and consequential pivots or reverts.",
			"Use it only when a reasonable alternative would materially change the resulting behavior or code; state that alternative and the guarantee or invariant protected.",
			"Do not log branches, commits, pushes, pull requests, audit publication, routine verification, commands or tool usage, straightforward implementation steps, formatting, or non-compatibility documentation/version updates.",
			"Choose origin for what triggered consideration of the decision; reserve why for its technical rationale and protected consequence or invariant.",
			"Use user correction when a user changes or clarifies prior direction so attribution survives beyond the session transcript.",
		],
		parameters: AuditDecisionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) throw new Error("No audit is active. Ask the user to run /audit-start <task>.");
			const row = await store.appendRow(state.logPath, {
				session: ctx.sessionManager.getSessionId(),
				entry: ctx.sessionManager.getLeafId() ?? "none",
				phase: params.phase,
				origin: params.origin,
				decision: params.decision,
				why: params.why,
				alternatives: params.alternatives ?? "none",
				confidence: params.confidence,
				evidence: params.evidence,
				result: params.result,
				supersedes: params.supersedes ?? "",
			});
			const rows = await store.readRows(state.logPath);
			updateStatus(ctx, state, rows);
			return {
				content: [{ type: "text", text: `Logged ${row.id}: ${row.decision}` }],
				details: { row, logPath: state.logPath, rows },
			};
		},
	});

	pi.registerCommand("audit-start", {
		description: "Start or resume an append-only decision audit: /audit-start <task>",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify("Usage: /audit-start <task>", "error");
				return;
			}
			if (state) {
				ctx.ui.notify(`Audit already active: ${state.task} (${displayPath(state.logPath, ctx.cwd)})`, "warning");
				return;
			}
			const task = safeSlug(requested);
			const logPath = resolve(ctx.cwd, ".audit", `${task}.tsv`);
			const provenancePath = resolve(ctx.cwd, ".audit", `${task}.provenance.json`);
			let provenance: GitProvenance | undefined;
			try {
				provenance = await ensureProvenance(
					runner,
					task,
					ctx.sessionManager.getSessionId(),
					provenancePath,
					withFileMutationQueue,
				);
			} catch (error: any) {
				ctx.ui.notify(
					`Audit will remain local because GitHub provenance could not be captured: ${error?.message ?? error}`,
					"warning",
				);
			}
			await store.ensureLog(logPath);
			state = { task, logPath, provenancePath: provenance ? provenancePath : undefined, provenance };
			pi.appendEntry(ENTRY_TYPE, {
				action: "start",
				task,
				logPath,
				provenancePath: provenance ? provenancePath : undefined,
				provenance,
			} satisfies ControlData);
			const rows = await store.readRows(logPath);
			updateStatus(ctx, state, rows);
			ctx.ui.notify(
				`Decision audit active: ${displayPath(logPath, ctx.cwd)}${provenance ? `\nGitHub: ${provenance.repository}@${provenance.branch}` : ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("audit-status", {
		description: "Show active decision-audit status and unresolved decision IDs",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "info");
				return;
			}
			const rows = await store.readRows(state.logPath);
			const stats = summarize(rows);
			updateStatus(ctx, state, rows);
			const unresolved = stats.unresolved.map((row) => row.id).join(", ") || "none";
			const low = stats.lowConfidence.map((row) => row.id).join(", ") || "none";
			const missing = stats.missingEvidence.map((row) => row.id).join(", ") || "none";
			ctx.ui.notify(
				[
					`${state.task}: ${stats.total} rows (${stats.active} active)`,
					`unresolved: ${unresolved}`,
					`low confidence: ${low}`,
					`missing evidence: ${missing}`,
					`log: ${displayPath(state.logPath, ctx.cwd)}`,
					state.provenance
						? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
						: "origin: unavailable (legacy audit)",
					state.reviewPath ? `review: ${displayPath(state.reviewPath, ctx.cwd)}` : "review: not run",
				].join("\n"),
				stats.unresolved.length || stats.lowConfidence.length || stats.missingEvidence.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("audit-review", {
		description: "Review the active trail with a different model: /audit-review [provider/model]",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("Independent review requires a persisted pi session", "error");
				return;
			}
			const requested = args.trim();
			const available = await ctx.modelRegistry.getAvailable();
			const currentProvider = ctx.model?.provider;
			const eligible = available.filter((model) => model.provider !== currentProvider);
			const reviewModel = requested
				? available.find((model) => `${model.provider}/${model.id}` === requested)
				: (REVIEW_MODEL_PREFERENCE.map((pattern) => eligible.find((model) => pattern.test(model.id))).find(Boolean) ??
					eligible[0]);
			if (!reviewModel) {
				ctx.ui.notify(
					requested
						? `Review model unavailable: ${requested}`
						: "No model from a different provider is available; pass /audit-review provider/model after configuring one",
					"error",
				);
				return;
			}
			if (reviewModel.provider === currentProvider) {
				ctx.ui.notify("The reviewer must use a different model provider from the working model", "error");
				return;
			}

			const rows = await store.readRows(state.logPath);
			const tempDir = await mkdtemp(join(tmpdir(), "pi-audit-review-"));
			const promptPath = join(tempDir, "reviewer.md");
			const reviewerPrompt = buildReviewPrompt({
				logPath: state.logPath,
				transcriptPath: sessionPath,
				workingDirectory: ctx.cwd,
				harnessName: "pi",
			});
			await writeFile(promptPath, reviewerPrompt, { encoding: "utf8", mode: 0o600 });
			ctx.ui.notify(`Reviewing with ${reviewModel.provider}/${reviewModel.id}...`, "info");
			try {
				const invocation = await pi.exec(
					"pi",
					[
						"--mode",
						"json",
						"-p",
						"--no-session",
						"--model",
						`${reviewModel.provider}/${reviewModel.id}`,
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
				const reviewPath = resolve(ctx.cwd, ".audit", `${state.task}.review.${stamp}.md`);
				const reviewDocument = buildReviewDocument({
					model: `${reviewModel.provider}/${reviewModel.id}`,
					logPath: state.logPath,
					transcriptPath: sessionPath,
					workingDirectory: ctx.cwd,
					rowCount: rows.length,
					output,
					harnessName: "pi",
				});
				await writeReviewArtifact(reviewPath, reviewDocument, withFileMutationQueue);
				state.reviewPath = reviewPath;
				state.reviewedCount = rows.length;
				pi.appendEntry(ENTRY_TYPE, {
					action: "review",
					task: state.task,
					logPath: state.logPath,
					reviewPath,
					reviewedCount: rows.length,
				} satisfies ControlData);
				ctx.ui.notify(`Review saved: ${displayPath(reviewPath, ctx.cwd)}`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Audit review failed: ${error?.message ?? error}`, "error");
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	});

	pi.registerCommand("audit-publish", {
		description: "Create or update raw audit TSV comments on the branch PR: /audit-publish [number-or-url]",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "error");
				return;
			}
			if (!state.provenance) {
				ctx.ui.notify("This legacy audit has no Git provenance; start a new audit before publishing", "error");
				return;
			}
			const rows = await store.readRows(state.logPath);
			if (!state.reviewPath || state.reviewedCount !== rows.length) {
				ctx.ui.notify("Run /audit-review after the latest decision before publishing", "error");
				return;
			}
			const provenance = state.provenance;
			const selector = args.trim() || (provenance.branch !== "DETACHED" ? provenance.branch : "");
			if (!selector) {
				ctx.ui.notify("Detached audits require /audit-publish <pr-number-or-url>", "error");
				return;
			}
			ctx.ui.notify(`Resolving PR for ${provenance.repository}@${provenance.branch}...`, "info");
			try {
				const result = await publishRawAudit({
					runner,
					state,
					rows,
					rawTsv: await readFile(state.logPath, "utf8"),
					selector,
				});
				ctx.ui.notify(
					`Published raw audit TSV in ${result.commentCount} comment${result.commentCount === 1 ? "" : "s"} on PR #${result.prNumber}: ${result.commentUrl}`,
					"info",
				);
			} catch (error: any) {
				ctx.ui.notify(`Audit publish failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-close", {
		description: "Close the active audit after all choices are resolved and independently reviewed",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "info");
				return;
			}
			const rows = await store.readRows(state.logPath);
			const blockers = closeBlockers(state, rows);
			if (blockers.length) {
				ctx.ui.notify(`Cannot close audit:\n${blockers.map((item) => `- ${item}`).join("\n")}`, "error");
				return;
			}
			const closing = state;
			pi.appendEntry(ENTRY_TYPE, {
				action: "close",
				task: closing.task,
				logPath: closing.logPath,
			} satisfies ControlData);
			state = undefined;
			updateStatus(ctx, undefined);
			ctx.ui.notify(`Audit closed: ${displayPath(closing.logPath, ctx.cwd)}`, "info");
		},
	});
}
