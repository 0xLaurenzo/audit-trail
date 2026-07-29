import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";

/**
 * ReviewerPort implementation that runs non-interactive Claude Code. Headless
 * `--tools` restricts built-ins to a read-only set, `--allowedTools`
 * pre-authorizes that set for headless use, and `--strict-mcp-config` (with no
 * --mcp-config) keeps the reviewer child from
 * connecting to MCP servers — including this package's own audit server.
 * Session persistence is disabled so reviews leave no session behind.
 *
 * The shared review contract addresses models as `provider/model`; the claude
 * CLI takes the bare model name, so the provider prefix is stripped here.
 */
export function createClaudeSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		async review(request: ReviewerRequest): Promise<string> {
			if (!request.model.startsWith("anthropic/") || request.model.length === "anthropic/".length) {
				throw new Error("Claude reviews require an anthropic/<model-id> model");
			}
			if (request.mode === "cross-provider") {
				throw new Error("Claude-run reviews cannot use cross-provider mode");
			}
			// Fail fast before any review work: a missing runtime should surface
			// immediately, not minutes into a review attempt.
			const probe = await runner.exec("claude", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error(
					`The claude CLI is required as the reviewer runtime but is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`,
				);
			}
			const model = request.model.slice("anthropic/".length);
			const invocation = await runner.exec(
				"claude",
				[
					"-p",
					"--model",
					model,
					"--tools",
					"Read,Grep,Glob",
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
