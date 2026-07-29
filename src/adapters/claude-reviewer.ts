import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";

/**
 * ReviewerPort implementation that runs non-interactive Claude Code. Headless
 * `-p` auto-denies tools outside the explicit read-only allowed list, and
 * `--strict-mcp-config` (with no --mcp-config) keeps the reviewer child from
 * connecting to MCP servers — including this package's own audit server.
 * Session persistence is disabled so reviews leave no session behind.
 *
 * The shared review contract addresses models as `provider/model`; the claude
 * CLI takes the bare model name, so the provider prefix is stripped here.
 */
export function createClaudeSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		async review(request: ReviewerRequest): Promise<string> {
			// Fail fast before any review work: a missing runtime should surface
			// immediately, not minutes into a review attempt.
			const probe = await runner.exec("claude", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error(
					`The claude CLI is required as the reviewer runtime but is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`,
				);
			}
			const model = request.model.includes("/") ? request.model.slice(request.model.indexOf("/") + 1) : request.model;
			const invocation = await runner.exec(
				"claude",
				[
					"-p",
					"--model",
					model,
					"--allowedTools",
					"Read",
					"Grep",
					"Glob",
					"--strict-mcp-config",
					"--no-session-persistence",
					`${request.prompt}\n\nPerform the independent audit review now.`,
				],
				{ timeout: request.timeoutMs ?? 10 * 60 * 1000 },
			);
			if (invocation.code !== 0) {
				throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
			}
			const output = invocation.stdout.trim();
			if (!output) throw new Error("reviewer produced no output");
			return output;
		},
	};
}
