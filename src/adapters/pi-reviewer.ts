import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";

/**
 * Extract the final assistant text from a `pi --mode json` stdout stream.
 * This parses Pi's event format and therefore lives with the Pi adapter, not
 * in the harness-neutral core.
 */
export function extractFinalAssistantOutput(stdout: string): { output: string; error?: string } {
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

/**
 * ReviewerPort implementation that runs a no-session `pi` subprocess with
 * read-only tools. This is the fallback reviewer runtime for harnesses
 * without a native one (issues #6-#8 supply their own implementations).
 */
export function createPiSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		async review(request: ReviewerRequest): Promise<string> {
			// Fail fast before any review work: a missing runtime should surface
			// immediately, not minutes into a review attempt.
			const probe = await runner.exec("pi", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error(
					`The pi CLI is required as the reviewer runtime but is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`,
				);
			}
			const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-review-"));
			try {
				const promptPath = join(tempDir, "reviewer.md");
				await writeFile(promptPath, request.prompt, { encoding: "utf8", mode: 0o600 });
				const invocation = await runner.exec(
					"pi",
					[
						"--mode",
						"json",
						"-p",
						"--no-session",
						"--model",
						request.model,
						"--tools",
						"read,grep,find,ls",
						"--append-system-prompt",
						promptPath,
						"Perform the independent audit review now.",
					],
					{ timeout: request.timeoutMs ?? 10 * 60 * 1000 },
				);
				if (invocation.code !== 0) {
					throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
				}
				const { output, error } = extractFinalAssistantOutput(invocation.stdout);
				if (error) throw new Error(`reviewer model failed: ${error}`);
				if (!output) throw new Error("reviewer produced no final assistant output");
				return output;
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	};
}
