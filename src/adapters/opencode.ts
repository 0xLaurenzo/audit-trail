import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { processRunner } from "../cli/main.ts";
import {
	AuditWorkflow,
	CONFIDENCE_VALUES,
	ORIGIN_VALUES,
	RESULT_VALUES,
	activeStatePath,
	buildActiveAuditGuidance,
	resolveWorktreeRoot,
	runIndependentReview,
	type AuditState,
	type CommandRunner,
	type ReviewMode,
} from "../core/index.ts";
import { McpAuditServer } from "../mcp/server.ts";
import { createOpencodeSubprocessReviewer } from "./opencode-reviewer.ts";
import { buildReviewerCandidates, type ReviewCandidate } from "../core/reviewer-candidates.ts";

export interface ReviewModelRef {
	provider: string;
	id: string;
}

/**
 * Build the ordered reviewer candidate list with truthful modes. An explicit
 * request pins exactly one candidate (strict, no fallback); automatic
 * selection returns every cross-provider model, then every same-provider
 * different-model candidate, then the working model itself, so runtime
 * failures can advance through the tiers.
 */
export function selectOpencodeReviewerCandidates(
	available: ReviewModelRef[],
	working: ReviewModelRef | undefined,
	requested?: string,
): ReviewCandidate[] {
	// The checkpoint's mode is a durable independence claim. OpenCode declares
	// chat.message.model optional, so fail rather than comparing a reviewer to
	// undefined and falsely recording cross-provider.
	if (!working) {
		throw new Error("Working model metadata is unavailable; cannot determine a truthful review mode");
	}
	if (requested) {
		if (!requested.includes("/")) throw new Error(`Review model must be provider/model: ${requested}`);
		let model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === requested);
		if (!model) {
			// With a populated catalog an unknown model is a typo; without one
			// (offline/config failure) trust the explicit request.
			if (available.length) throw new Error(`Review model unavailable: ${requested}`);
			const slash = requested.indexOf("/");
			model = { provider: requested.slice(0, slash), id: requested.slice(slash + 1) };
		}
		const mode: ReviewMode =
			model.provider !== working.provider ? "cross-provider" : model.id !== working.id ? "cross-model" : "same-model";
		return [{ model: `${model.provider}/${model.id}`, mode }];
	}
	return buildReviewerCandidates(available, working);
}

export interface OpencodeClientLike {
	config: { providers(): Promise<unknown> };
}

/** Flatten OpenCode's configured provider catalog into provider/model refs. */
export async function listOpencodeModels(client: OpencodeClientLike): Promise<ReviewModelRef[]> {
	const response: any = await client.config.providers();
	// The SDK client wraps results in { data }; tolerate the bare shape too.
	const payload = response?.data ?? response;
	const providers = Array.isArray(payload?.providers) ? payload.providers : [];
	return providers.flatMap((provider: any) =>
		provider && typeof provider.id === "string"
			? Object.keys(provider.models ?? {}).map((id) => ({ provider: provider.id as string, id }))
			: [],
	);
}

/**
 * Export the OpenCode session transcript into `.audit/` so the review prompt
 * and artifact can reference a path that stays resolvable after the review.
 * Returns undefined when export is unavailable; the review then proceeds
 * transcript-less against the TSV, Git diff, and repository.
 */
async function exportTranscript(
	runner: CommandRunner,
	root: string,
	task: string,
	sessionID: string,
): Promise<string | undefined> {
	try {
		const result = await runner.exec("opencode", ["export", sessionID], { timeout: 60_000 });
		if (result.code !== 0 || !result.stdout.trim()) return undefined;
		const path = join(root, ".audit", `${task}.transcript.${sessionID}.json`);
		await mkdir(join(root, ".audit"), { recursive: true });
		await writeFile(path, result.stdout, { encoding: "utf8", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

const z = tool.schema;

interface OpencodePluginInput {
	client: OpencodeClientLike;
	directory: string;
	/**
	 * Command runner override. Production loads use the process runner;
	 * conformance tests inject a simulated runner so reviewer behavior can be
	 * exercised through the real plugin tool boundary without spawning the
	 * opencode CLI.
	 */
	runner?: CommandRunner;
}

interface OpencodeToolContext {
	sessionID: string;
	messageID?: string;
}

/**
 * OpenCode plugin over the shared audit workflow. Rows are attributed as
 * `opencode/<session-id>`; start/decision/status/publish/close delegate to the
 * transport-agnostic McpAuditServer so gating semantics cannot drift from the
 * CLI and MCP surfaces, while review adds OpenCode model discovery, transcript
 * export, and an `opencode run` reviewer runtime.
 */
export const AuditTrailPlugin = async ({ client, directory, runner: runnerOverride }: OpencodePluginInput) => {
	const runner = runnerOverride ?? processRunner(directory);
	let workflowPromise: Promise<AuditWorkflow> | undefined;
	const workflow = (): Promise<AuditWorkflow> => {
		workflowPromise ??= resolveWorktreeRoot(runner, directory).then((root) => new AuditWorkflow(root, runner));
		return workflowPromise;
	};
	const reviewer = createOpencodeSubprocessReviewer(runner);
	// Latest working model per session, recorded from chat.message; used to
	// derive a truthful review mode relative to the model doing the work.
	const workingModels = new Map<string, ReviewModelRef>();
	// One plugin instance serves many sessions, so tool calls carry their own
	// identity instead of pinning one session at load time.
	const server = async (context: OpencodeToolContext) =>
		new McpAuditServer({
			workflow: await workflow(),
			runner,
			reviewer,
			session: { harness: "opencode", id: context.sessionID, entryId: context.messageID },
		});

	interface ActiveLookup {
		wf: AuditWorkflow;
		state?: AuditState;
		/** Set when active-audit state exists but cannot be read. */
		error?: string;
	}
	const activeState = async (): Promise<ActiveLookup> => {
		const wf = await workflow();
		try {
			return { wf, state: await wf.active() };
		} catch (error: any) {
			return { wf, error: String(error?.message ?? error) };
		}
	};

	return {
		"chat.message": async (
			input: { sessionID?: string; model?: { providerID: string; modelID: string } },
			_output: unknown,
		) => {
			if (input.sessionID && input.model) {
				workingModels.set(input.sessionID, { provider: input.model.providerID, id: input.model.modelID });
			}
		},

		"experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
			const { state, error } = await activeState();
			if (error || !state) return;
			output.system.push(buildActiveAuditGuidance(state.logPath));
		},

		"tool.execute.before": async (input: { tool: string }, output: { args: any }) => {
			if (input.tool !== "write" && input.tool !== "edit") return;
			const filePath = output?.args?.filePath;
			if (typeof filePath !== "string" || !filePath) return;
			const target = resolve(directory, filePath);
			const { wf, state, error } = await activeState();
			if (error) {
				// Fail closed: with unreadable active-audit state, protect the whole
				// .audit directory instead of silently disabling the guard.
				if (target.startsWith(`${resolve(wf.root, ".audit")}/`)) {
					throw new Error(`Audit state is unreadable (${error}); refusing writes under .audit/.`);
				}
				return;
			}
			if (!state) return;
			const protectedPaths = [state.logPath, state.provenancePath, activeStatePath(wf.root)].filter(
				(path): path is string => Boolean(path),
			);
			if (protectedPaths.some((path) => target === resolve(path))) {
				throw new Error("Audit state and Git provenance are extension-managed; use audit_decision for corrections.");
			}
		},

		tool: {
			audit_start: tool({
				description: "Start or resume the append-only decision audit for this Git worktree.",
				args: { task: z.string().describe("Task name; slugged to .audit/<task>.tsv") },
				execute: async (args, context) => (await server(context)).call("audit_start", args),
			}),
			audit_decision: tool({
				description:
					"Append one reviewer-relevant product or engineering decision whose alternative would materially change behavior or code. Excludes delivery operations and routine verification.",
				args: {
					phase: z.string().describe("Short workstream or phase name"),
					origin: z
						.enum([...ORIGIN_VALUES] as [string, ...string[]])
						.describe(
							"What caused this decision to be considered: user requirement, user correction, source invariant, failing test, code review, external specification, or implementation discovery",
						),
					decision: z
						.string()
						.describe(
							"The reviewer-relevant product or engineering choice, assumption, pivot, or revert—not a workflow action or verification step",
						),
					why: z
						.string()
						.describe("Technical reason the option is correct, including the consequence or invariant it protects"),
					alternatives: z
						.string()
						.optional()
						.describe("Alternatives considered and why they were not selected; use 'none' if none"),
					confidence: z.enum([...CONFIDENCE_VALUES] as [string, ...string[]]),
					evidence: z
						.string()
						.describe("A concise evidence pointer such as file:line, commit SHA, test command, trace, or artifact path"),
					result: z.enum([...RESULT_VALUES] as [string, ...string[]]),
					supersedes: z.string().optional().describe("Prior decision ID replaced by this row, such as D0003"),
				},
				execute: async (args, context) => (await server(context)).call("audit_decision", args),
			}),
			audit_status: tool({
				description: "Show audit status: row counts, unresolved and low-confidence IDs, and review freshness.",
				args: {},
				execute: async (_args, context) => (await server(context)).call("audit_status", {}),
			}),
			audit_review: tool({
				description:
					"Run an independent review of the active decision audit and record the checkpoint. Prefers a cross-provider reviewer; may take several minutes.",
				args: {
					model: z
						.string()
						.optional()
						.describe("Reviewer as provider/model; omit to select a cross-provider model automatically"),
				},
				execute: async (args, context) => {
					const wf = await workflow();
					const state = await wf.active();
					if (!state) throw new Error("No audit is active in this worktree.");
					const available = await listOpencodeModels(client).catch(() => []);
					const candidates = selectOpencodeReviewerCandidates(available, workingModels.get(context.sessionID), args.model);
					const transcriptPath = await exportTranscript(runner, wf.root, state.task, context.sessionID);
					const review = await runIndependentReview({
						workflow: wf,
						reviewer,
						candidates,
						harnessName: "opencode",
						transcriptPath,
					});
					const lines = [
						`Review saved: ${review.reviewPath} (${review.model}, ${review.mode}; ${review.rowCount} rows reviewed, verdict: ${review.verdict})`,
					];
					if (review.verdict === "block") {
						lines.push(
							"The reviewer blocked this audit; publish and close stay gated until findings are addressed and it is re-reviewed.",
						);
					}
					return lines.join("\n");
				},
			}),
			audit_publish: tool({
				description:
					"Create or update readable audit comments with canonical TSV on the current checked-out branch's pull request.",
				args: {
					selector: z
						.string()
						.optional()
						.describe(
							"PR number or URL; defaults to the current branch. The PR must be in the provenance repository, match exact local HEAD, and descend from the audit start commit.",
						),
				},
				execute: async (args, context) => (await server(context)).call("audit_publish", args),
			}),
			audit_close: tool({
				description: "Close the audit; fails while decisions are unresolved or the latest bytes are unreviewed.",
				args: {},
				execute: async (_args, context) => (await server(context)).call("audit_close", {}),
			}),
		},
	};
};
