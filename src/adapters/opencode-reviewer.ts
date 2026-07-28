import type { CommandRunner, ReviewerPort, ReviewerRequest } from "../core/ports.ts";

/**
 * ReviewerPort implementation that runs a fresh non-interactive `opencode run`
 * subprocess. The built-in read-only `plan` agent denies edits, and `--pure`
 * keeps the reviewer child from loading external plugins — including this
 * one — so the reviewer cannot call audit tools or mutate the worktree.
 * The formatted stdout is the reviewer report; the verdict contract requires
 * the final non-empty line to be `VERDICT: approve|block`, which survives the
 * default output format.
 */
export function createOpencodeSubprocessReviewer(runner: CommandRunner): ReviewerPort {
	return {
		async review(request: ReviewerRequest): Promise<string> {
			// Fail fast before any review work: a missing runtime should surface
			// immediately, not minutes into a review attempt.
			const probe = await runner.exec("opencode", ["--version"], { timeout: 15_000 });
			if (probe.code !== 0) {
				throw new Error(
					`The opencode CLI is required as the reviewer runtime but is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`,
				);
			}
			const invocation = await runner.exec(
				"opencode",
				[
					"run",
					"--pure",
					"--agent",
					"plan",
					"-m",
					request.model,
					"--dir",
					request.workingDirectory,
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
