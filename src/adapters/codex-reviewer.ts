import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";
import type { ReviewCandidate } from "../core/reviewer-candidates.ts";

/** Derive truthful Codex review provenance from a hook-captured working model. */
export function selectCodexReviewCandidates(requested: unknown, working: string | undefined): ReviewCandidate[] {
	if (!working) {
		throw new Error("Codex SessionStart did not provide a working model; start a new trusted Codex session before review");
	}
	const requestedText = typeof requested === "string" ? requested.trim() : "";
	if (requestedText.includes("/") && !requestedText.startsWith("openai/")) {
		throw new Error("Codex reviews require an OpenAI model ID or openai/<model-id>");
	}
	const workingModel = working.replace(/^openai\//, "");
	const model = requestedText.replace(/^openai\//, "") || workingModel;
	if (!model) throw new Error("Codex reviews require an OpenAI model ID or openai/<model-id>");
	return [{ model: `openai/${model}`, mode: model === workingModel ? "same-model" : "cross-model" }];
}

/** Run an isolated, ephemeral, read-only Codex child for independent review. */
export function createCodexSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		async review(request: ReviewerRequest): Promise<string> {
			if (!request.model.startsWith("openai/") || request.model.length === "openai/".length) {
				throw new Error("Codex reviews require an openai/<model-id> model");
			}
			if (request.mode === "cross-provider") {
				throw new Error("Codex-run reviews cannot use cross-provider mode");
			}
			const probe = await runner.exec("codex", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error(
					`The codex CLI is required as the reviewer runtime but is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`,
				);
			}
			const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-codex-review-"));
			const outputPath = join(tempDir, "last-message.txt");
			try {
				const invocation = await runner.exec(
					"codex",
					[
						"exec",
						"--ignore-user-config",
						"--ephemeral",
						"--sandbox",
						"read-only",
						"--skip-git-repo-check",
						"-C",
						request.workingDirectory,
						"--model",
						request.model.slice("openai/".length),
						"--output-last-message",
						outputPath,
						`${request.prompt}\n\nPerform the independent audit review now.`,
					],
					{ timeout: request.timeoutMs ?? 10 * 60 * 1000 },
				);
				if (invocation.code !== 0) {
					throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
				}
				const output = (await readFile(outputPath, "utf8").catch(() => "")).trim();
				if (!output) throw new Error("reviewer produced no output");
				return output;
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	};
}
