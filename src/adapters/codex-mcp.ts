import { readFile } from "node:fs/promises";
import { createCodexSubprocessReviewer, selectCodexReviewCandidates } from "./codex-reviewer.ts";
import { readCodexSessionState } from "./codex-session.ts";
import type { CommandRunner } from "../core/ports.ts";
import type { McpServerOptions } from "../mcp/server.ts";

/** Codex-specific MCP identity, transcript, reviewer, and truthful review schema. */
export function codexMcpOptions(
	worktreeRoot: string,
	reviewerRunner: CommandRunner,
	fallbackSessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Pick<
	McpServerOptions,
	"session" | "reviewer" | "reviewTranscriptPath" | "reviewCandidates" | "reviewTool"
> {
	return {
		session: async () => {
			const state = await readCodexSessionState(worktreeRoot, env);
			return { harness: "codex", id: state?.sessionId ?? fallbackSessionId };
		},
		reviewer: createCodexSubprocessReviewer(reviewerRunner),
		reviewTranscriptPath: async () => {
			const transcript = (await readCodexSessionState(worktreeRoot, env))?.transcriptPath;
			if (!transcript) return undefined;
			try {
				await readFile(transcript, "utf8");
				return transcript;
			} catch {
				return undefined;
			}
		},
		reviewCandidates: async (args) => {
			const state = await readCodexSessionState(worktreeRoot, env);
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
