import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runIndependentReview } from "../src/core/independent-review.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import { parseReviewVerdict } from "../src/core/review.ts";
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

test("parseReviewVerdict extracts the last explicit verdict, case-insensitively", () => {
	assert.equal(parseReviewVerdict("No flags\nVERDICT: approve\n"), "approve");
	assert.equal(parseReviewVerdict("findings...\nverdict: BLOCK"), "block");
	assert.equal(parseReviewVerdict("VERDICT: block\nreconsidered\nVERDICT: approve"), "approve", "last verdict wins");
	assert.equal(parseReviewVerdict("I would approve this"), undefined, "prose is not a verdict");
	assert.equal(parseReviewVerdict("no verdict at all"), undefined);
});

test("an approving review records the verdict and unblocks close", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning("No flags\nVERDICT: approve\n"),
			model: "provider/reviewer",
			mode: "cross-model",
			harnessName: "cli",
		});
		assert.equal(result.verdict, "approve");
		assert.equal(result.rowCount, 1);
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
			model: "provider/reviewer",
			mode: "cross-model",
			harnessName: "cli",
		});
		assert.equal(result.verdict, "block");
		const closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.match(closed.blockers.join("\n"), /the last review blocked this audit/);
		const state = await workflow.active();
		assert.ok(state);
		const status = formatStatusLines(state, await workflow.rows(state), await workflow.currentSha(state), root);
		assert.match(status.join("\n"), /blocked/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a review without an explicit verdict fails closed to block", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning("Looks fine to me.\n"),
			model: "provider/reviewer",
			mode: "same-model",
			harnessName: "mcp",
		});
		assert.equal(result.verdict, "block");
		const closed = await workflow.close();
		assert.equal(closed.closed, false);
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
			() => runIndependentReview({ workflow, reviewer, model: "provider/reviewer", mode: "cross-model", harnessName: "cli" }),
			/reviewer runtime but is unavailable/,
		);
		const state = await workflow.active();
		assert.equal(state?.review, undefined, "no checkpoint without a completed review");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
