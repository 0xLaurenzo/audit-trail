import { readFile } from "node:fs/promises";
import { AuditWorkflow } from "../core/workflow.ts";
import type { CommandRunner } from "../core/ports.ts";
import {
	McpAuditServer,
	type JsonRpcMessage,
	type McpRequestHandler,
	type McpServerOptions,
} from "../mcp/server.ts";
import { providerReviewModels } from "../core/reviewer-candidates.ts";
import { createCodexSubprocessReviewer, selectCodexReviewCandidates } from "./codex-reviewer.ts";
import {
	findCodexSessionState,
	type CodexSessionState,
} from "./codex-session.ts";

const CODEX_REVIEW_MODELS = providerReviewModels("openai").join(", ");

const reviewTool = {
	description:
		`Run an independent Codex review. Omit model to try the fixed allowed order (${CODEX_REVIEW_MODELS}); review mode is derived against the captured working model.`,
	inputSchema: {
		type: "object",
		properties: {
			model: { type: "string", description: `Optional allowed OpenAI reviewer model ID: ${CODEX_REVIEW_MODELS}` },
		},
	},
};

type CodexMcpOptions = Pick<
	McpServerOptions,
	"session" | "reviewer" | "reviewTranscriptPath" | "reviewCandidates" | "reviewTool"
>;

function optionsForState(
	state: CodexSessionState,
	reviewerRunner: CommandRunner,
): CodexMcpOptions {
	return {
		session: async () => ({ harness: "codex", id: state.sessionId }),
		reviewer: createCodexSubprocessReviewer(reviewerRunner),
		reviewTranscriptPath: async () => {
			const transcript = state.transcriptPath;
			if (!transcript) return undefined;
			try {
				await readFile(transcript, "utf8");
				return transcript;
			} catch {
				return undefined;
			}
		},
		reviewCandidates: async (args) => {
			return selectCodexReviewCandidates(args.model, state.model);
		},
		reviewTool,
	};
}

function toolError(message: JsonRpcMessage, error: unknown): object {
	return {
		jsonrpc: "2.0",
		id: message.id,
		result: {
			content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
			isError: true,
		},
	};
}

/** Route Codex tool calls from the plugin launcher to their hook-recorded worktree. */
export function createCodexMcpHandler(
	launchRoot: string,
	runnerFor: (cwd: string) => CommandRunner,
	env: NodeJS.ProcessEnv = process.env,
): McpRequestHandler {
	const launchRunner = runnerFor(launchRoot);
	const schemaServer = new McpAuditServer({
		workflow: new AuditWorkflow(launchRoot, launchRunner),
		runner: launchRunner,
		reviewer: createCodexSubprocessReviewer(launchRunner),
		reviewTool,
		session: async () => { throw new Error("Codex schema server has no thread"); },
	});
	return {
		async handle(message) {
			if (message.method !== "tools/call" || message.id === undefined || message.id === null) {
				return schemaServer.handle(message);
			}
			try {
				const threadId = message.params?._meta?.threadId;
				if (typeof threadId !== "string" || !threadId) {
					throw new Error("Codex MCP call has no threadId metadata; start a new trusted Codex session");
				}
				const state = await findCodexSessionState(threadId, env);
				if (!state) {
					throw new Error("Codex SessionStart state was not found for this thread; start a new trusted Codex session");
				}
				const runner = runnerFor(state.worktree);
				return new McpAuditServer({
					workflow: new AuditWorkflow(state.worktree, runner),
					runner,
					...optionsForState(state, runner),
				}).handle(message);
			} catch (error) {
				return toolError(message, error);
			}
		},
	};
}
