import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AuditWorkflow,
	ORIGIN_VALUES,
	activeStatePath,
	resolveWorktreeRoot,
	buildReviewDocument,
	buildReviewPrompt,
	displayPath,
	extractFinalAssistantOutput,
	publishRawAudit,
	sha256Hex,
	summarize,
	writeReviewArtifact,
	type AuditRow,
	type AuditState,
	type CommandRunner,
	type ReviewMode,
	type SessionIdentity,
} from "../core/index.ts";

/// Reviewer preference, most advanced first. Applied within each review tier
/// (cross-provider, then cross-model, then the working model itself).
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

function updateStatus(ctx: ExtensionContext, state: AuditState | undefined, rows: AuditRow[] = []): void {
	if (!state) {
		ctx.ui.setStatus("audit-trail", undefined);
		return;
	}
	const stats = summarize(rows);
	const flags = stats.unresolved.length + stats.lowConfidence.length;
	ctx.ui.setStatus("audit-trail", `audit: ${stats.total} decisions${flags ? ` · ${flags} flags` : ""}`);
}

export default function auditTrailExtension(pi: ExtensionAPI) {
	const runner: CommandRunner = {
		exec: (command, args, options) => pi.exec(command, args, options),
	};
	const workflows = new Map<string, Promise<AuditWorkflow>>();
	const workflow = (ctx: ExtensionContext): Promise<AuditWorkflow> => {
		let instance = workflows.get(ctx.cwd);
		if (!instance) {
			instance = resolveWorktreeRoot(runner, ctx.cwd).then((root) => new AuditWorkflow(root, runner));
			workflows.set(ctx.cwd, instance);
		}
		return instance;
	};
	const sessionIdentity = (ctx: ExtensionContext): SessionIdentity => ({
		harness: "pi",
		id: ctx.sessionManager.getSessionId(),
		entryId: ctx.sessionManager.getLeafId() ?? undefined,
	});
	interface ActiveLookup {
		wf: AuditWorkflow;
		state?: AuditState;
		/** Set when active-audit state exists but cannot be read. */
		error?: string;
	}
	const activeState = async (ctx: ExtensionContext): Promise<ActiveLookup> => {
		const wf = await workflow(ctx);
		try {
			return { wf, state: await wf.active() };
		} catch (error: any) {
			return { wf, error: String(error?.message ?? error) };
		}
	};

	const refresh = async (ctx: ExtensionContext) => {
		const { wf, state, error } = await activeState(ctx);
		if (error) {
			ctx.ui.setStatus("audit-trail", "audit: state unreadable");
			return;
		}
		const rows = state ? await wf.rows(state).catch(() => []) : [];
		updateStatus(ctx, state, rows);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		const { state } = await activeState(ctx);
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
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const { wf, state, error } = await activeState(ctx);
		const input = event.input as { path?: unknown };
		const inputPath = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : undefined;
		if (!inputPath) return;
		if (error) {
			// Fail closed: with unreadable active-audit state, protect the whole
			// .audit directory instead of silently disabling the guard.
			if (inputPath.startsWith(`${resolve(wf.root, ".audit")}/`)) {
				return { block: true, reason: `Audit state is unreadable (${error}); refusing writes under .audit/.` };
			}
			return;
		}
		if (!state) return;
		const protectedPaths = [state.logPath, state.provenancePath, activeStatePath(wf.root)].filter(
			(path): path is string => Boolean(path),
		);
		if (protectedPaths.some((path) => inputPath === resolve(path))) {
			return {
				block: true,
				reason: "Audit state and Git provenance are extension-managed; use audit_decision for corrections.",
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
			const wf = await workflow(ctx);
			const { row, state, rows } = await wf.append(sessionIdentity(ctx), {
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
			updateStatus(ctx, state, rows);
			return {
				content: [{ type: "text", text: `Logged ${row.id}: ${row.decision}` }],
				details: { row, logPath: state.logPath, rows },
			};
		},
	});

	pi.registerCommand("audit-start", {
		description: "Start or resume the worktree's decision audit: /audit-start <task>",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify("Usage: /audit-start <task>", "error");
				return;
			}
			try {
				const wf = await workflow(ctx);
				const result = await wf.start(requested, sessionIdentity(ctx));
				if (result.provenanceError) {
					ctx.ui.notify(
						`Audit will remain local because GitHub provenance could not be captured: ${result.provenanceError}`,
						"warning",
					);
				}
				const rows = await wf.rows(result.state);
				updateStatus(ctx, result.state, rows);
				const provenance = result.state.provenance;
				ctx.ui.notify(
					`${result.resumed ? "Resumed" : "Started"} decision audit: ${displayPath(result.state.logPath, ctx.cwd)}${provenance ? `\nGitHub: ${provenance.repository}@${provenance.branch}` : ""}`,
					"info",
				);
			} catch (error: any) {
				ctx.ui.notify(`Audit start failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-status", {
		description: "Show active decision-audit status and unresolved decision IDs",
		handler: async (_args, ctx) => {
			const { wf, state, error } = await activeState(ctx);
			if (error) {
				ctx.ui.notify(`Audit state is unreadable: ${error}`, "error");
				return;
			}
			if (!state) {
				ctx.ui.notify("No decision audit is active in this worktree", "info");
				return;
			}
			const rows = await wf.rows(state);
			const stats = summarize(rows);
			updateStatus(ctx, state, rows);
			const unresolved = stats.unresolved.map((row) => row.id).join(", ") || "none";
			const low = stats.lowConfidence.map((row) => row.id).join(", ") || "none";
			const missing = stats.missingEvidence.map((row) => row.id).join(", ") || "none";
			const currentSha = await wf.currentSha(state);
			const reviewLine = state.review
				? `review: ${state.review.path} (${state.review.mode}${state.review.sha256 === currentSha ? "" : ", stale"})`
				: "review: not run";
			ctx.ui.notify(
				[
					`${state.task}: ${stats.total} rows (${stats.active} active)`,
					`unresolved: ${unresolved}`,
					`low confidence: ${low}`,
					`missing evidence: ${missing}`,
					`log: ${displayPath(state.logPath, ctx.cwd)}`,
					state.provenance
						? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
						: "origin: unavailable (local audit)",
					reviewLine,
				].join("\n"),
				stats.unresolved.length || stats.lowConfidence.length || stats.missingEvidence.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("audit-review", {
		description: "Review the active trail, preferring a cross-provider model: /audit-review [provider/model]",
		handler: async (args, ctx) => {
			const { wf, state, error } = await activeState(ctx);
			if (error) {
				ctx.ui.notify(`Audit state is unreadable: ${error}`, "error");
				return;
			}
			if (!state) {
				ctx.ui.notify("No decision audit is active in this worktree", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("Independent review requires a persisted pi session", "error");
				return;
			}
			const requested = args.trim();
			const available = await ctx.modelRegistry.getAvailable();
			const current = ctx.model;
			const prefer = (models: typeof available) =>
				REVIEW_MODEL_PREFERENCE.map((pattern) => models.find((model) => pattern.test(model.id))).find(Boolean) ??
				models[0];

			let reviewModel: (typeof available)[number] | undefined;
			if (requested) {
				reviewModel = available.find((model) => `${model.provider}/${model.id}` === requested);
				if (!reviewModel) {
					ctx.ui.notify(`Review model unavailable: ${requested}`, "error");
					return;
				}
			} else {
				reviewModel =
					prefer(available.filter((model) => model.provider !== current?.provider)) ??
					prefer(available.filter((model) => model.provider === current?.provider && model.id !== current?.id)) ??
					(current ? available.find((model) => model.provider === current.provider && model.id === current.id) : undefined);
				if (!reviewModel) {
					ctx.ui.notify("No model is available for review; pass /audit-review provider/model", "error");
					return;
				}
			}
			const mode: ReviewMode =
				reviewModel.provider !== current?.provider
					? "cross-provider"
					: reviewModel.id !== current?.id
						? "cross-model"
						: "same-model";

			const rows = await wf.rows(state);
			const tempDir = await mkdtemp(join(tmpdir(), "pi-audit-review-"));
			const promptPath = join(tempDir, "reviewer.md");
			const reviewerPrompt = buildReviewPrompt({
				logPath: state.logPath,
				transcriptPath: sessionPath,
				workingDirectory: ctx.cwd,
				harnessName: "pi",
			});
			await writeFile(promptPath, reviewerPrompt, { encoding: "utf8", mode: 0o600 });
			ctx.ui.notify(`Reviewing with ${reviewModel.provider}/${reviewModel.id} (${mode})...`, "info");
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
					reviewMode: mode,
					logPath: state.logPath,
					transcriptPath: sessionPath,
					workingDirectory: ctx.cwd,
					rowCount: rows.length,
					output,
					harnessName: "pi",
				});
				await writeReviewArtifact(reviewPath, reviewDocument);
				await wf.recordReview({
					path: reviewPath,
					mode,
					model: `${reviewModel.provider}/${reviewModel.id}`,
				});
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
			const { wf, state, error } = await activeState(ctx);
			if (error) {
				ctx.ui.notify(`Audit state is unreadable: ${error}`, "error");
				return;
			}
			if (!state) {
				ctx.ui.notify("No decision audit is active in this worktree", "error");
				return;
			}
			if (!state.provenance) {
				ctx.ui.notify("This audit has no Git provenance; publishing requires a GitHub origin", "error");
				return;
			}
			const rows = await wf.rows(state);
			// Read once and gate on these exact bytes so a concurrent append between
			// check and publication cannot slip unreviewed rows into the PR comment.
			const rawTsv = await readFile(state.logPath, "utf8");
			if (!state.review || state.review.sha256 !== sha256Hex(rawTsv)) {
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
				const result = await publishRawAudit({ runner, state, rows, rawTsv, selector });
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
			try {
				const wf = await workflow(ctx);
				const result = await wf.close();
				if (!result.closed) {
					ctx.ui.notify(`Cannot close audit:\n${result.blockers.map((item) => `- ${item}`).join("\n")}`, "error");
					return;
				}
				updateStatus(ctx, undefined);
				ctx.ui.notify(`Audit closed: ${displayPath(result.state.logPath, ctx.cwd)}`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Audit close failed: ${error?.message ?? error}`, "error");
			}
		},
	});
}
