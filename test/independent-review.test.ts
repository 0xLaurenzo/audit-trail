import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveAudit, writeActiveAudit } from "../src/core/active-state.ts";
import { runIndependentReview, summarizeReviewerFailure } from "../src/core/independent-review.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import { formatBlockingReviewMessage, parseReviewVerdict, reviewFindingsExcerpt } from "../src/core/review.ts";
import { formatStatusLines } from "../src/core/status.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";

const noGit: CommandRunner = {
	exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }),
};
const resolvedRow: Omit<NewAuditRow, "session" | "entry"> = {
	phase: "core",
	origin: "implementation discovery",
	decision: "A decision",
	why: "Because",
	alternatives: "none",
	confidence: "high",
	evidence: "src/core/workflow.ts:1",
	result: "verified",
	supersedes: "",
};

function reviewerReturning(output: string): ReviewerPort {
	return { review: async () => output };
}

async function startedWorkflow(root: string): Promise<AuditWorkflow> {
	const workflow = new AuditWorkflow(root, noGit);
	await workflow.start("task", { harness: "pi", id: "session" });
	await workflow.append({ harness: "pi", id: "session" }, resolvedRow);
	return workflow;
}

test("parseReviewVerdict accepts only an exact final-line verdict, case-insensitively", () => {
	assert.equal(parseReviewVerdict("No flags\nVERDICT: approve\n"), "approve");
	assert.equal(parseReviewVerdict("findings...\nverdict: BLOCK"), "block");
	assert.equal(parseReviewVerdict("VERDICT: block\nreconsidered"), undefined, "verdict is not the final line");
	assert.equal(parseReviewVerdict("VERDICT: approve with caveats"), undefined, "trailing text is ambiguous");
	assert.equal(parseReviewVerdict("I would approve this"), undefined, "prose is not a verdict");
	assert.equal(parseReviewVerdict("no verdict at all"), undefined);
});

test("blocking review feedback strips the verdict and makes truncation explicit", () => {
	assert.deepEqual(reviewFindingsExcerpt("First finding.\nSecond finding.\nVERDICT: block\n", 1_000), {
		text: "First finding.\nSecond finding.",
		truncated: false,
	});
	const message = formatBlockingReviewMessage(
		"First complete finding.\nSecond finding is beyond the bound.\nVERDICT: block",
		".audit/review.md",
		25,
	);
	assert.match(message, /First complete finding\./);
	assert.doesNotMatch(message, /Second finding|VERDICT:/);
	assert.match(message, /truncated; see the review artifact/);
	assert.match(message, /\.audit\/review\.md/);
	assert.throws(() => reviewFindingsExcerpt("Finding\nVERDICT: block", 0), /positive integer/);
});

test("an approving review records the verdict and unblocks close", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning("No flags\nVERDICT: approve\n"),
			candidates: [{ model: "provider/reviewer", mode: "cross-model" }],
			harnessName: "cli",
		});
		assert.equal(result.verdict, "approve");
		assert.equal(result.rowCount, 1);
		assert.equal(result.model, "provider/reviewer");
		assert.equal(result.mode, "cross-model");
		assert.match(await readFile(result.reviewPath, "utf8"), /- Verdict: approve/);
		const closed = await workflow.close();
		assert.equal(closed.closed, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a blocking review keeps close gated and is visible in status", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning("D0001 overstates verification.\nVERDICT: block\n"),
			candidates: [{ model: "provider/reviewer", mode: "cross-model" }],
			harnessName: "cli",
		});
		assert.equal(result.verdict, "block");
		assert.equal(result.report, "D0001 overstates verification.\nVERDICT: block\n");
		const artifact = await readFile(result.reviewPath, "utf8");
		assert.match(artifact, /D0001 overstates verification\.\nVERDICT: block\n$/);
		const closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.match(closed.blockers.join("\n"), /the last review did not approve this audit/);
		const state = await workflow.active();
		assert.ok(state);
		const status = formatStatusLines(state, await workflow.rows(state), await workflow.currentSha(state), root);
		assert.match(status.join("\n"), /blocked/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an empty blocking report is invalid and falls back without recording the empty block", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const attempted: string[] = [];
		const failures: string[] = [];
		const result = await runIndependentReview({
			workflow,
			reviewer: {
				review: async (request) => {
					attempted.push(request.model);
					return request.model === "provider/empty-block" ? "\nVERDICT: block\n" : "No flags\nVERDICT: approve\n";
				},
			},
			candidates: [
				{ model: "provider/empty-block", mode: "cross-model" },
				{ model: "provider/fallback", mode: "same-model" },
			],
			harnessName: "mcp",
			onAttemptFailure: (_candidate, error) => failures.push(error),
		});
		assert.deepEqual(attempted, ["provider/empty-block", "provider/fallback"]);
		assert.deepEqual(failures, ["blocking reviewer output had no findings"]);
		assert.equal(result.verdict, "approve");
		assert.equal((await readdir(join(root, ".audit"))).filter((name) => name.includes(".review.")).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a review without an explicit verdict falls back without recording an artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const attempted: string[] = [];
		const result = await runIndependentReview({
			workflow,
			reviewer: {
				review: async (request) => {
					attempted.push(request.model);
					return request.model === "provider/invalid" ? "Looks fine to me.\n" : "No flags\nVERDICT: approve\n";
				},
			},
			candidates: [
				{ model: "provider/invalid", mode: "cross-model" },
				{ model: "provider/fallback", mode: "same-model" },
			],
			harnessName: "mcp",
		});
		assert.deepEqual(attempted, ["provider/invalid", "provider/fallback"]);
		assert.equal(result.model, "provider/fallback");
		assert.equal(result.verdict, "approve");
		const artifacts = (await readdir(join(root, ".audit"))).filter((name) => name.includes(".review."));
		assert.equal(artifacts.length, 1, "only the completed fallback writes an artifact");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a pinned review with an invalid verdict fails directly and records nothing", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		await assert.rejects(
			() =>
				runIndependentReview({
					workflow,
					reviewer: reviewerReturning("VERDICT: approve with caveats\n"),
					candidates: [{ model: "provider/pinned", mode: "cross-provider" }],
					harnessName: "cli",
				}),
			/no valid terminal verdict/,
		);
		const state = await workflow.active();
		assert.equal(state?.review, undefined);
		const artifacts = (await readdir(join(root, ".audit"))).filter((name) => name.includes(".review."));
		assert.deepEqual(artifacts, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("review failure summaries classify errors without copying credentials or provider metadata", () => {
	const raw = "401 Unauthorized api_key=sk-secret request_id=req_private account=acct_private";
	const summary = summarizeReviewerFailure(new Error(raw));
	assert.equal(summary, "reviewer authentication failed");
	for (const secret of ["sk-secret", "req_private", "acct_private"]) assert.doesNotMatch(summary, new RegExp(secret));
	assert.equal(summarizeReviewerFailure(new Error("429 request req_private")), "reviewer was rate limited");
	assert.equal(summarizeReviewerFailure(new Error("unknown detail token=secret")), "reviewer execution failed");
});

test("a legacy verdict-less snapshot fails closed and requires re-review", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const file = await readActiveAudit(root);
		assert.ok(file);
		const state = await workflow.active();
		assert.ok(state);
		const sha256 = await workflow.currentSha(state);
		assert.ok(sha256);
		await writeActiveAudit(root, {
			...file,
			review: {
				path: ".audit/legacy.review.md",
				sha256,
				mode: "cross-model",
				model: "provider/reviewer",
				at: new Date().toISOString(),
				// Deliberately no verdict: pre-verdict snapshot.
			},
		});
		const closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.match(closed.blockers.join("\n"), /did not approve this audit/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a failing reviewer runtime records no checkpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const reviewer: ReviewerPort = {
			review: async () => {
				throw new Error("The pi CLI is required as the reviewer runtime but is unavailable");
			},
		};
		await assert.rejects(
			() =>
				runIndependentReview({
					workflow,
					reviewer,
					candidates: [{ model: "provider/reviewer", mode: "cross-model" }],
					harnessName: "cli",
				}),
			/reviewer runtime is unavailable/,
		);
		const state = await workflow.active();
		assert.equal(state?.review, undefined, "no checkpoint without a completed review");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a failed candidate falls back to the next one, which records truthful model and mode", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const attempted: string[] = [];
		const reviewer: ReviewerPort = {
			review: async (request) => {
				attempted.push(request.model);
				if (request.model === "openai/gpt-5.6-sol") throw new Error("usage limit reached");
				return "No flags\nVERDICT: approve\n";
			},
		};
		const failures: string[] = [];
		const result = await runIndependentReview({
			workflow,
			reviewer,
			candidates: [
				{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
				{ model: "anthropic/claude-fable-5", mode: "cross-model" },
			],
			harnessName: "cli",
			onAttemptFailure: (candidate, error) => failures.push(`${candidate.model}: ${error}`),
		});
		assert.deepEqual(attempted, ["openai/gpt-5.6-sol", "anthropic/claude-fable-5"]);
		assert.deepEqual(failures, ["openai/gpt-5.6-sol: reviewer usage or quota limit reached"]);
		assert.equal(result.model, "anthropic/claude-fable-5");
		assert.equal(result.mode, "cross-model");
		const artifact = await readFile(result.reviewPath, "utf8");
		assert.match(artifact, /anthropic\/claude-fable-5/);
		assert.match(artifact, /cross-model/);
		const state = await workflow.active();
		assert.equal(state?.review?.model, "anthropic/claude-fable-5");
		assert.equal(state?.review?.mode, "cross-model");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a blocking verdict is terminal and never triggers fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const attempted: string[] = [];
		const reviewer: ReviewerPort = {
			review: async (request) => {
				attempted.push(request.model);
				return "D0001 overstates verification.\nVERDICT: block\n";
			},
		};
		const result = await runIndependentReview({
			workflow,
			reviewer,
			candidates: [
				{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
				{ model: "anthropic/claude-fable-5", mode: "cross-model" },
			],
			harnessName: "cli",
		});
		assert.deepEqual(attempted, ["openai/gpt-5.6-sol"], "a completed blocking review must not retry");
		assert.equal(result.verdict, "block");
		assert.equal(result.model, "openai/gpt-5.6-sol");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("when every candidate fails, the error names each attempt and nothing is written", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const reviewer: ReviewerPort = {
			review: async (request) => {
				throw new Error(request.model === "openai/gpt-5.6-sol" ? "usage limit reached" : "rate limited");
			},
		};
		await assert.rejects(
			() =>
				runIndependentReview({
					workflow,
					reviewer,
					candidates: [
						{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
						{ model: "anthropic/claude-fable-5", mode: "cross-model" },
						{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
					],
					harnessName: "cli",
				}),
			(error: Error) => {
				assert.match(error.message, /All reviewer candidates failed/);
				assert.match(error.message, /openai\/gpt-5\.6-sol \(cross-provider\): reviewer usage or quota limit reached/);
				assert.match(error.message, /anthropic\/claude-fable-5 \(cross-model\): reviewer was rate limited/);
				assert.match(error.message, /anthropic\/claude-opus-4-8 \(same-model\): reviewer was rate limited/);
				return true;
			},
		);
		const state = await workflow.active();
		assert.equal(state?.review, undefined, "no checkpoint when every candidate fails");
		const artifacts = (await readdir(join(root, ".audit"))).filter((name) => name.includes(".review."));
		assert.deepEqual(artifacts, [], "failed attempts must not create review artifacts");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the checkpoint hash reflects the bytes the successful attempt saw, not the first attempt's", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		let first = true;
		const reviewer: ReviewerPort = {
			review: async () => {
				if (first) {
					first = false;
					// A row lands while the first reviewer is running, then that reviewer fails.
					await workflow.append({ harness: "pi", id: "session" }, resolvedRow);
					throw new Error("provider outage");
				}
				return "No flags\nVERDICT: approve\n";
			},
		};
		const result = await runIndependentReview({
			workflow,
			reviewer,
			candidates: [
				{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
				{ model: "anthropic/claude-fable-5", mode: "cross-model" },
			],
			harnessName: "cli",
		});
		assert.equal(result.rowCount, 2, "the second attempt reviews the appended row too");
		const closed = await workflow.close();
		assert.equal(closed.closed, true, "the checkpoint covers the exact bytes the successful reviewer saw");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
