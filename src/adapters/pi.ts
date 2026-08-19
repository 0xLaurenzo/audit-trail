import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AuditWorkflow,
	ORIGIN_VALUES,
	activeStatePath,
	buildActiveAuditGuidance,
	buildReviewerCandidates,
	resolveWorktreeRoot,
	displayPath,
	formatBlockingReviewMessage,
	formatStatusLines,
	isTerminalStatePath,
	publishRawAudit,
	runIndependentReview,
	sha256Hex,
	summarize,
	type AuditRow,
	type AuditState,
	type CommandRunner,
	type ReviewCandidate,
	type ReviewMode,
	type ReviewModel,
	reviewBlocker,
	type SessionIdentity,
} from "../core/index.ts";
import { createPiSubprocessReviewer } from "./pi-reviewer.ts";

/**
 * Build Pi's reviewer candidates. Explicit requests stay pinned to one known
 * model, but still require working-model metadata so the durable independence
 * mode is truthful.
 */
export function selectPiReviewerCandidates(
	available: ReviewModel[],
	working: ReviewModel | undefined,
	requested?: string,
): ReviewCandidate[] {
	if (!working) throw new Error("Working model metadata is unavailable; cannot determine a truthful review mode");
	if (!requested) return buildReviewerCandidates(available, working);
	const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === requested);
	if (!model) throw new Error(`Review model unavailable: ${requested}`);
	const mode: ReviewMode =
		model.provider !== working.provider ? "cross-provider" : model.id !== working.id ? "cross-model" : "same-model";
	return [{ model: requested, mode }];
}

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
		return { systemPrompt: `${event.systemPrompt}\n\n${buildActiveAuditGuidance(state.logPath)}` };
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
		if (isTerminalStatePath(wf.root, inputPath)) {
			return { block: true, reason: "Terminal audit lifecycle state (closed or abandoned) is extension-managed; use audit_reopen." };
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

	for (const operation of ["start", "resume", "reopen"] as const) {
		const commandName = `audit-${operation}`;
		pi.registerCommand(commandName, {
			description: `${operation === "start" ? "Create" : operation === "resume" ? "Join" : "Restore"} the matching worktree decision audit: /${commandName} <task>`,
			handler: async (args, ctx) => {
				const requested = args.trim();
				if (!requested) {
					ctx.ui.notify(`Usage: /${commandName} <task>`, "error");
					return;
				}
				try {
					const wf = await workflow(ctx);
					const result = await wf[operation](requested, sessionIdentity(ctx));
					if (result.provenanceError) {
						ctx.ui.notify(
							`Audit will remain local because GitHub provenance could not be captured: ${result.provenanceError}`,
							"warning",
						);
					}
					const rows = await wf.rows(result.state);
					updateStatus(ctx, result.state, rows);
					const provenance = result.state.provenance;
					const verb = operation === "start" ? "Started" : operation === "resume" ? "Resumed" : "Reopened";
					ctx.ui.notify(
						`${verb} decision audit: ${displayPath(result.state.logPath, ctx.cwd)}${provenance ? `\nGitHub: ${provenance.repository}@${provenance.branch}` : ""}`,
						"info",
					);
				} catch (error: any) {
					ctx.ui.notify(`Audit ${operation} failed: ${error?.message ?? error}`, "error");
				}
			},
		});
	}

	pi.registerCommand("audit-status", {
		description: "Show active decision-audit status and unresolved decision IDs",
		handler: async (_args, ctx) => {
			const { wf, state, error } = await activeState(ctx);
			if (error) {
				ctx.ui.notify(`Audit state is unreadable: ${error}`, "error");
				return;
			}
			if (!state) {
				const abandoned = await wf.abandonedAudits();
				ctx.ui.notify(
					[
						"No decision audit is active in this worktree",
						...abandoned.map((entry) => `abandoned: ${entry.taskName ?? entry.task}${entry.at ? ` (${entry.at})` : ""}`),
					].join("\n"),
					"info",
				);
				return;
			}
			const rows = await wf.rows(state);
			const stats = summarize(rows);
			updateStatus(ctx, state, rows);
			const currentSha = await wf.currentSha(state);
			const diverged = await wf.provenanceDiverged(state);
			ctx.ui.notify(
				formatStatusLines(state, rows, currentSha, wf.root, diverged).join("\n"),
				stats.unresolved.length || stats.lowConfidence.length || stats.missingEvidence.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("audit-abandon", {
		description: "Archive an unpublishable audit as abandoned: /audit-abandon <exact-task> --reason <text>",
		handler: async (args, ctx) => {
			let parsed: ReturnType<typeof parseArgs>;
			try {
				parsed = parseArgs({
					args: args.trim() ? args.trim().split(/\s+/) : [],
					options: { reason: { type: "string" } },
					allowPositionals: true,
					strict: true,
				});
			} catch (error: any) {
				ctx.ui.notify(`Invalid abandon arguments: ${error?.message ?? error}`, "error");
				return;
			}
			try {
				const wf = await workflow(ctx);
				const result = await wf.abandon(
					parsed.positionals.join(" ").trim(),
					sessionIdentity(ctx),
					String(parsed.values.reason ?? ""),
				);
				ctx.ui.notify(
					[
						`Abandoned ${result.state.taskName ?? result.state.task} without review approval or publication`,
						...(result.record.unresolvedIds.length ? [`unresolved at abandonment: ${result.record.unresolvedIds.join(", ")}`] : []),
						"Reopen restores it with the abandonment record retained.",
					].join("\n"),
					"info",
				);
			} catch (error: any) {
				ctx.ui.notify(`Audit abandon failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-rollover", {
		description: "Archive a rebase-diverged audit and start a linked successor: /audit-rollover <exact-task> --reason <text> [--name <successor>]",
		handler: async (args, ctx) => {
			let parsed: ReturnType<typeof parseArgs>;
			try {
				parsed = parseArgs({
					args: args.trim() ? args.trim().split(/\s+/) : [],
					options: { reason: { type: "string" }, name: { type: "string" } },
					allowPositionals: true,
					strict: true,
				});
			} catch (error: any) {
				ctx.ui.notify(`Invalid rollover arguments: ${error?.message ?? error}`, "error");
				return;
			}
			try {
				const wf = await workflow(ctx);
				const result = await wf.rollover(
					parsed.positionals.join(" ").trim(),
					sessionIdentity(ctx),
					String(parsed.values.reason ?? ""),
					typeof parsed.values.name === "string" ? parsed.values.name : undefined,
				);
				ctx.ui.notify(
					[
						`Archived ${result.abandonedTask} as abandoned (no review approval or publication)`,
						`Started linked audit: ${displayPath(result.state.logPath, wf.root)}`,
						`Record one decision citing git range-diff ${result.link.startCommit.slice(0, 12)}..${result.link.head.slice(0, 12)} evidence for the rebase.`,
					].join("\n"),
					"info",
				);
				if (result.provenanceError) ctx.ui.notify(`Provenance unavailable: ${result.provenanceError}`, "warning");
			} catch (error: any) {
				ctx.ui.notify(`Audit rollover failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-review", {
		description: "Review the trail; for Anthropic cross-provider review prefer claude-fable-5, then claude-opus-5: /audit-review [provider/model]",
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

			let candidates: ReviewCandidate[];
			try {
				candidates = selectPiReviewerCandidates(
					available,
					current ? { provider: current.provider, id: current.id } : undefined,
					requested || undefined,
				);
			} catch (selectionError: any) {
				ctx.ui.notify(selectionError?.message ?? String(selectionError), "error");
				return;
			}

			const reviewer = createPiSubprocessReviewer({ exec: (command, cmdArgs, options) => pi.exec(command, cmdArgs, options) });
			try {
				const review = await runIndependentReview({
					workflow: wf,
					reviewer,
					candidates,
					harnessName: "pi",
					transcriptPath: sessionPath,
					onAttempt: (candidate) => ctx.ui.notify(`Reviewing with ${candidate.model} (${candidate.mode})...`, "info"),
					onAttemptFailure: (candidate, failure) =>
						ctx.ui.notify(`Reviewer ${candidate.model} failed: ${failure} — trying the next candidate`, "warning"),
				});
				if (review.verdict === "block") {
					ctx.ui.notify(
						formatBlockingReviewMessage(review.report, displayPath(review.reviewPath, ctx.cwd), 2_000),
						"warning",
					);
				} else {
					ctx.ui.notify(
						`Review saved: ${displayPath(review.reviewPath, ctx.cwd)} (${review.model}, ${review.mode}; verdict: approve)`,
						"info",
					);
				}
			} catch (error: any) {
				ctx.ui.notify(`Audit review failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-publish", {
		description: "Create/update an aggregate audit set: /audit-publish [number-or-url] [--set set-id]",
		handler: async (args, ctx) => {
			let publishArgs: ReturnType<typeof parseArgs>;
			try {
				publishArgs = parseArgs({
					args: args.trim() ? args.trim().split(/\s+/) : [],
					options: { set: { type: "string" } },
					allowPositionals: true,
					strict: true,
				});
				if (publishArgs.positionals.length > 1) throw new Error("expected at most one PR number or URL");
			} catch (error: any) {
				ctx.ui.notify(`Invalid publish arguments: ${error?.message ?? error}`, "error");
				return;
			}
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
			const blocker = reviewBlocker(state, sha256Hex(rawTsv));
			if (blocker) {
				ctx.ui.notify(`${blocker}. Run /audit-review before publishing`, "error");
				return;
			}
			const provenance = state.provenance;
			ctx.ui.notify(`Resolving PR for the current branch in ${provenance.repository}...`, "info");
			try {
				const result = await publishRawAudit({
					runner,
					state: { ...state, auditId: await wf.ensureAuditId() },
					rows,
					rawTsv,
					selector: publishArgs.positionals[0]?.trim() || undefined,
					commentSetId: typeof publishArgs.values.set === "string" ? publishArgs.values.set.trim() || undefined : undefined,
				});
				ctx.ui.notify(
					`Published audit to set ${result.commentSetId} (${result.componentCount} audit${result.componentCount === 1 ? "" : "s"} in ${result.commentCount} comment${result.commentCount === 1 ? "" : "s"}) on PR #${result.prNumber}: ${result.commentUrl}`,
					"info",
				);
				if (result.legacyCommentCount) {
					ctx.ui.notify(
						`Warning: ${result.legacyCommentCount} legacy audit comment${result.legacyCommentCount === 1 ? " was" : "s were"} left untouched.`,
						"warning",
					);
				}
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
