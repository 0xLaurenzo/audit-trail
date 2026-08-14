import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveAudit, writeActiveAudit } from "../src/core/active-state.ts";
import { runIndependentReview, summarizeReviewerFailure } from "../src/core/independent-review.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import { parseReviewOutput, REVIEW_OUTPUT_CONTRACT } from "../src/core/review-output.ts";
import { formatBlockingReviewMessage, reviewFindingsExcerpt } from "../src/core/review.ts";
import { formatStatusLines } from "../src/core/status.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { buildReviewOutputFixture } from "./helpers/review-output.ts";

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

const designSection = REVIEW_OUTPUT_CONTRACT.sections.find((section) => section.id === "designFriction")!;
const designHeading = designSection.heading!;
const verdictPrefix = REVIEW_OUTPUT_CONTRACT.verdict.prefix;

function reviewerReturning(output: string): ReviewerPort {
	return { review: async () => output };
}

async function startedWorkflow(root: string): Promise<AuditWorkflow> {
	const workflow = new AuditWorkflow(root, noGit);
	await workflow.start("task", { harness: "pi", id: "session" });
	await workflow.append({ harness: "pi", id: "session" }, resolvedRow);
	return workflow;
}

test("a supplied transcript is snapshotted into .audit before the reviewer runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const live = join(root, "live.jsonl");
		await writeFile(live, '{"event":"one"}\n', "utf8");
		let promptSeen = "";
		const reviewer: ReviewerPort = {
			review: async ({ prompt }) => {
				promptSeen = prompt;
				// The live session file keeps growing while the reviewer runs.
				await appendFile(live, '{"event":"appended-during-review"}\n', "utf8");
				return buildReviewOutputFixture({ verdict: "approve" });
			},
		};
		await runIndependentReview({
			workflow,
			reviewer,
			candidates: [{ model: "provider/model", mode: "cross-provider" }],
			harnessName: "codex",
			transcriptPath: live,
		});
		const snapshot = promptSeen.match(/^codex session: (.+)$/m)?.[1];
		assert.ok(snapshot, "prompt references a transcript");
		assert.notEqual(snapshot, live, "prompt references the snapshot, not the live file");
		assert.ok(snapshot!.includes(join(".audit", "task.review-transcript.")));
		assert.ok(snapshot!.endsWith(".jsonl"), "snapshot keeps the source extension");
		assert.equal(
			await readFile(snapshot!, "utf8"),
			'{"event":"one"}\n',
			"the snapshot excludes events appended while the reviewer ran",
		);
		assert.match(promptSeen, /still running/, "transcript prompts carry the in-flight invariant");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an unreadable transcript falls back to transcript-less review", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		let promptSeen = "";
		const reviewer: ReviewerPort = {
			review: async ({ prompt }) => {
				promptSeen = prompt;
				return buildReviewOutputFixture({ verdict: "approve" });
			},
		};
		const result = await runIndependentReview({
			workflow,
			reviewer,
			candidates: [{ model: "provider/model", mode: "cross-provider" }],
			harnessName: "codex",
			transcriptPath: join(root, "missing.jsonl"),
		});
		assert.equal(result.verdict, "approve");
		assert.doesNotMatch(promptSeen, /codex session: /, "no transcript line for an unreadable file");
		assert.doesNotMatch(promptSeen, /still running/, "the in-flight clause is omitted transcript-less");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the review-output schema parses canonical output and accepts case-insensitive protocol markers", () => {
	const canonical = buildReviewOutputFixture({
		sections: {
			auditFindings: "No flags",
			designFriction: "- Challenge: centralize the contract.",
		},
		verdict: "approve",
	});
	const parsed = parseReviewOutput(canonical);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.verdict, "approve");
	assert.equal(parsed.sections.auditFindings, "No flags");
	assert.match(parsed.sections.designFriction, /centralize the contract/);

	const caseVariant = canonical
		.replace(designHeading, designHeading.toUpperCase())
		.replace(`${verdictPrefix} approve`, `${verdictPrefix.toLowerCase()} APPROVE`);
	const caseVariantParsed = parseReviewOutput(caseVariant);
	assert.equal(caseVariantParsed.ok, true, "heading and verdict markers are case-insensitive");
});

test("the review-output parser returns typed failures for every schema violation", () => {
	const malformed = [
		{
			output: "No flags",
			reason: "invalid-verdict",
			section: undefined,
		},
		{
			output: `No flags\n${verdictPrefix} approve`,
			reason: "missing-section",
			section: "designFriction",
		},
		{
			output: `No flags\n${designHeading}\n\n${verdictPrefix} approve`,
			reason: "empty-section",
			section: "designFriction",
		},
		{
			output: `${designHeading}\nNone.\n${designHeading.toUpperCase()}\nNone.\n${verdictPrefix} approve`,
			reason: "duplicate-section",
			section: "designFriction",
		},
		{
			output: `${designHeading}\nNone.\n## Later section\nText\n${verdictPrefix} approve`,
			reason: "non-final-section",
			section: "designFriction",
		},
		{
			output: `${designHeading}\nNone identified.\n${verdictPrefix} block`,
			reason: "empty-section",
			section: "auditFindings",
		},
	] as const;
	for (const expected of malformed) {
		const parsed = parseReviewOutput(expected.output);
		assert.equal(parsed.ok, false);
		if (parsed.ok) continue;
		assert.equal(parsed.reason, expected.reason);
		assert.equal(parsed.section, expected.section);
	}
});

test("blocking review feedback strips the verdict and makes truncation explicit", () => {
	const terminalBlock = `${verdictPrefix} block`;
	assert.deepEqual(reviewFindingsExcerpt(`First finding.\nSecond finding.\n${terminalBlock}\n`, 1_000), {
		text: "First finding.\nSecond finding.",
		truncated: false,
	});
	const message = formatBlockingReviewMessage(
		`First complete finding.\nSecond finding is beyond the bound.\n${terminalBlock}`,
		".audit/review.md",
		25,
	);
	assert.match(message, /First complete finding\./);
	assert.doesNotMatch(message, /Second finding|VERDICT:/);
	assert.match(message, /truncated; see the review artifact/);
	assert.match(message, /\.audit\/review\.md/);
	assert.throws(() => reviewFindingsExcerpt(`Finding\n${terminalBlock}`, 0), /positive integer/);
});

test("an approving review records the verdict and unblocks close", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning(buildReviewOutputFixture({
				sections: {
					auditFindings: "No flags",
					designFriction: "- Challenge: adapter fixtures duplicate the output contract.\n- Evidence: test/helpers/harness-drivers.ts.\n- Change: expose a shared fixture builder.\n- Benefit: future review fields change once.",
				},
				verdict: "approve",
			})),
			candidates: [{ model: "provider/reviewer", mode: "cross-model" }],
			harnessName: "cli",
		});
		assert.equal(result.verdict, "approve");
		assert.equal(result.rowCount, 1);
		assert.equal(result.model, "provider/reviewer");
		assert.equal(result.mode, "cross-model");
		assert.match(result.designFriction, /adapter fixtures duplicate the output contract/);
		const artifact = await readFile(result.reviewPath, "utf8");
		assert.ok(artifact.includes(designHeading));
		assert.match(artifact, /expose a shared fixture builder/);
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
		const report = buildReviewOutputFixture({
			sections: { auditFindings: "D0001 overstates verification." },
			verdict: "block",
		});
		const result = await runIndependentReview({
			workflow,
			reviewer: reviewerReturning(report),
			candidates: [{ model: "provider/reviewer", mode: "cross-model" }],
			harnessName: "cli",
		});
		assert.equal(result.verdict, "block");
		assert.equal(result.report, report);
		const artifact = await readFile(result.reviewPath, "utf8");
		assert.ok(artifact.includes(designHeading));
		assert.ok(artifact.endsWith(`${verdictPrefix} block\n`));
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
					return request.model === "provider/empty-block"
						? `${designHeading}\nNone identified.\n${verdictPrefix} block\n`
						: buildReviewOutputFixture({ verdict: "approve" });
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
		assert.deepEqual(failures, ["blocking reviewer output had no audit findings"]);
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
					return request.model === "provider/invalid" ? "Looks fine to me.\n" : buildReviewOutputFixture({ verdict: "approve" });
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

test("a review without the mandatory design-friction evaluation falls back without recording an artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-review-test-"));
	try {
		const workflow = await startedWorkflow(root);
		const failures: string[] = [];
		const result = await runIndependentReview({
			workflow,
			reviewer: {
				review: async (request) => request.model === "provider/missing-section"
					? `No flags\n${verdictPrefix} approve\n`
					: buildReviewOutputFixture({
						sections: { designFriction: "A shared review-result schema would simplify adapter fixtures." },
						verdict: "approve",
					}),
			},
			candidates: [
				{ model: "provider/missing-section", mode: "cross-model" },
				{ model: "provider/fallback", mode: "same-model" },
			],
			harnessName: "mcp",
			onAttemptFailure: (_candidate, error) => failures.push(error),
		});
		assert.deepEqual(failures, ["reviewer output had no valid design-friction evaluation"]);
		assert.equal(result.model, "provider/fallback");
		assert.match(result.designFriction, /shared review-result schema/);
		assert.equal((await readdir(join(root, ".audit"))).filter((name) => name.includes(".review.")).length, 1);
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
					reviewer: reviewerReturning(`${verdictPrefix} approve with caveats\n`),
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
				return buildReviewOutputFixture({ verdict: "approve" });
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
				return buildReviewOutputFixture({
					sections: { auditFindings: "D0001 overstates verification." },
					verdict: "block",
				});
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
				return buildReviewOutputFixture({ verdict: "approve" });
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
