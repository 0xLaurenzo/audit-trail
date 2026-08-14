import { readFile } from "node:fs/promises";
import { AuditWorkflow } from "../core/workflow.ts";
import type { CommandRunner } from "../core/ports.ts";
import {
	McpAuditServer,
	type JsonRpcMessage,
	type McpRequestHandler,
	type McpServerOptions,
} from "../mcp/server.ts";
import { createCodexSubprocessReviewer, selectCodexReviewCandidates } from "./codex-reviewer.ts";
import {
	findCodexSessionState,
	readCodexSessionState,
	type CodexSessionState,
} from "./codex-session.ts";

type CodexMcpOptions = Pick<
	McpServerOptions,
	"session" | "reviewer" | "reviewTranscriptPath" | "reviewCandidates" | "reviewTool"
>;

function optionsForState(
	stateSource: () => Promise<CodexSessionState | undefined>,
	reviewerRunner: CommandRunner,
	fallbackSessionId: string,
): CodexMcpOptions {
	return {
		session: async () => {
			const state = await stateSource();
			return { harness: "codex", id: state?.sessionId ?? fallbackSessionId };
		},
		reviewer: createCodexSubprocessReviewer(reviewerRunner),
		reviewTranscriptPath: async () => {
			const transcript = (await stateSource())?.transcriptPath;
			if (!transcript) return undefined;
			try {
				await readFile(transcript, "utf8");
				return transcript;
			} catch {
				return undefined;
			}
		},
		reviewCandidates: async (args) => {
			const state = await stateSource();
			return selectCodexReviewCandidates(args.model, state?.model);
		},
		reviewTool: {
			description:
				"Run an independent Codex review. Omit model to use the captured working model; a different OpenAI model is recorded as cross-model.",
			inputSchema: {
				type: "object",
				properties: { model: { type: "string", description: "Optional OpenAI reviewer model ID" } },
			},
		},
	};
}

/** Codex-specific MCP identity, transcript, reviewer, and truthful review schema. */
export function codexMcpOptions(
	worktreeRoot: string,
	reviewerRunner: CommandRunner,
	fallbackSessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): CodexMcpOptions {
	return optionsForState(() => readCodexSessionState(worktreeRoot, env), reviewerRunner, fallbackSessionId);
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
	fallbackSessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): McpRequestHandler {
	const launchRunner = runnerFor(launchRoot);
	const schemaServer = new McpAuditServer({
		workflow: new AuditWorkflow(launchRoot, launchRunner),
		runner: launchRunner,
		...codexMcpOptions(launchRoot, launchRunner, fallbackSessionId, env),
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
					...optionsForState(async () => state, runner, fallbackSessionId),
				}).handle(message);
			} catch (error) {
				return toolError(message, error);
			}
		},
	};
}
