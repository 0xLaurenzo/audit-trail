import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";

/**
 * Extract the final assistant text from a `pi --mode json` stdout stream.
 * This parses Pi's event format and therefore lives with the Pi adapter, not
 * in the harness-neutral core.
 */
export function extractFinalAssistantOutput(stdout: string): { output: string; error?: string; incomplete?: boolean } {
	let output = "";
	let error: string | undefined;
	let settled = false;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "agent_settled") {
				// Settle only the current successful candidate. An earlier settled
				// event cannot certify a later stop, and a later assistant outcome
				// resets this flag below.
				if (output && !error) settled = true;
				continue;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			// Every assistant outcome supersedes the previous candidate; this
			// prevents `stop -> toolUse -> settled` from certifying stale output.
			settled = false;
			output = "";
			if (event.message.stopReason === "error") {
				error = event.message.errorMessage || "assistant message ended with an error";
				continue;
			}
			error = undefined;
			// `toolUse` and unknown stop reasons are intermediate/non-certifying;
			// only Pi's successful terminal `stop` may supply the final report.
			if (event.message.stopReason !== "stop") continue;
			const text = (event.message.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			if (text) {
				// Pi may emit an error assistant event and retry in the same stream.
				// A later successful terminal message supersedes that transient error.
				output = text;
			}
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	if (error) return { output: "", error };
	if (output && !settled) return { output: "", error: "reviewer stream ended before agent_settled", incomplete: true };
	return { output, error };
}

/**
 * ReviewerPort implementation that runs a no-session `pi` subprocess with
 * read-only tools. This is the fallback reviewer runtime for harnesses
 * without a native one (issues #6-#8 supply their own implementations).
 */
export function createPiSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		failureHints: {
			"reviewer could not resolve credentials": "Use /login in Pi with the reviewer's PI_CODING_AGENT_DIR (default ~/.pi/agent), or set the provider's supported credential variable in the launcher environment.",
			"reviewer authentication failed": "Check the reviewer's Pi login, provider account and model access in the same launcher environment; parent-session authentication is not forwarded.",
			"reviewer provider is not configured": "Check the provider configuration in the reviewer's Pi agent directory and run pi --list-models from the same environment.",
			"reviewer model is unavailable": "Run pi --list-models from the same environment and select an Audit Trail allowlisted model available to that provider account.",
		},
		async review(request: ReviewerRequest): Promise<string> {
			// Fail fast before any review work: a missing runtime should surface
			// immediately, not minutes into a review attempt.
			const probe = await runner.exec("pi", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error("The pi CLI is required as the reviewer runtime but is unavailable");
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
				const { output, error, incomplete } = extractFinalAssistantOutput(invocation.stdout);
				if (invocation.code !== 0) {
					// Pi can warn about an unknown model ID, then continue with that ID.
					// That warning is not the reason the request eventually failed.
					const stderr = invocation.stderr.replace(/Model "[^"\n]*" not found for provider "[^"\n]*"\. Using custom model id\./gi, "");
					throw new Error((!incomplete && error) || stderr.trim() || error || `reviewer exited with code ${invocation.code}`);
				}
				if (error) throw new Error(`reviewer model failed: ${error}`);
				if (!output) throw new Error("reviewer produced no final assistant output");
				return output;
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	};
}
