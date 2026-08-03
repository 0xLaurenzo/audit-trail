/**
 * Shared behavior contract for shipped harness adapters. Every harness runs
 * the same lifecycle, guard, review, and gating tests through its own driver;
 * capability-gated tests are skipped with a visible reason when a harness
 * truthfully declares a capability unsupported, never silently omitted.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveAudit } from "../../src/core/active-state.ts";
import type { HarnessCapabilities, ShippedHarness } from "../../src/harness/capabilities.ts";
import { SENSITIVE_STDERR, corruptActiveState, type DriverFactory, type HarnessDriver } from "./harness-drivers.ts";

const TASK = "contract";

async function withDriver(createDriver: DriverFactory, run: (driver: HarnessDriver, root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "audit-conformance-"));
	const driver = await createDriver(root);
	try {
		await run(driver, root);
	} finally {
		await driver.dispose();
		await rm(root, { recursive: true, force: true });
	}
}

async function tsvRows(root: string): Promise<string[]> {
	return (await readFile(join(root, ".audit", `${TASK}.tsv`), "utf8")).trim().split("\n");
}

async function reviewArtifacts(root: string): Promise<string[]> {
	return (await readdir(join(root, ".audit"))).filter((name) => name.includes(".review."));
}

async function checkpoint(root: string) {
	return (await readActiveAudit(root))?.review;
}

export interface ConformanceInput {
	harness: ShippedHarness;
	capabilities: HarnessCapabilities;
	createDriver: DriverFactory;
}

export function registerHarnessConformance({ harness, capabilities, createDriver }: ConformanceInput): void {
	const contract = (name: string, run: (driver: HarnessDriver, root: string) => Promise<void>) =>
		test(`${harness} conformance: ${name}`, () => withDriver(createDriver, run));
	const gated = (
		capability: keyof HarnessCapabilities,
		name: string,
		run: (driver: HarnessDriver, root: string) => Promise<void>,
	) => {
		if (!capabilities[capability]) {
			test(`${harness} conformance: ${name}`, { skip: `${harness} declares ${capability}: false` }, () => {});
			return;
		}
		contract(name, run);
	};

	contract("requires explicit exact-name resume and preserves rows", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		await assert.rejects(() => driver.start(TASK), /resume/i);
		await assert.rejects(() => driver.resume("Contract"), /collision/i);
		await driver.resume(TASK);
		const rows = await tsvRows(root);
		assert.equal(rows.length, 2, "resume must not truncate or duplicate rows");
	});

	contract("requires explicit reopen and preserves closed lifecycle state", async (driver, root) => {
		driver.github.enabled = true;
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		assert.equal((await driver.review(driver.explicitReviewModel)).completed, true);
		assert.equal((await driver.close()).completed, true);
		const closedPath = join(root, ".audit", `${TASK}.closed.json`);
		assert.ok(await readFile(closedPath, "utf8"));
		assert.equal((await driver.attemptWrite(closedPath)).blocked, true, "closed lifecycle state remains managed");
		await assert.rejects(() => driver.start(TASK), /reopen/i);
		await driver.reopen(TASK);
		const reopened = await readActiveAudit(root);
		assert.equal(reopened?.reopenCount, 1);
		assert.equal(reopened?.review?.verdict, "approve", "reopen preserves the review checkpoint");
		assert.ok(reopened?.provenancePath, "reopen preserves provenance metadata");
		assert.equal((await tsvRows(root)).length, 2, "reopen must preserve decision rows");
		await driver.decide({ decision: "Changed after reopen" });
		const staleClose = await driver.close();
		assert.equal(staleClose.completed, false);
		assert.match(staleClose.message, /changed after the last review|stale/i);
	});

	contract("rejects invalid decision enum values at the append boundary", async (driver, root) => {
		await driver.start(TASK);
		await assert.rejects(() => driver.decide({ origin: "vibes" }), /origin/i);
		await assert.rejects(() => driver.decide({ confidence: "certain" }), /confidence/i);
		await assert.rejects(() => driver.decide({ result: "done" }), /result/i);
		const rows = await tsvRows(root);
		assert.equal(rows.length, 1, "rejected decisions must not reach the TSV");
	});

	contract("attributes decisions to the harness session", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		const rows = await tsvRows(root);
		assert.ok(rows[1].split("\t")[2].startsWith(`${harness}/`), `session column names the ${harness} session`);
	});

	contract("reports status with the task and row count", async (driver) => {
		await driver.start(TASK);
		await driver.decide();
		assert.match(await driver.status(), new RegExp(`${TASK}: 1 rows`));
	});

	gated("systemPromptInjection", "injects guidance only while an audit is active", async (driver) => {
		assert.equal(await driver.guidance(), undefined, "no guidance before an audit starts");
		await driver.start(TASK);
		const guidance = await driver.guidance();
		assert.ok(guidance, "guidance appears once the audit is active");
		assert.match(guidance, /audit/i);
		assert.match(guidance, new RegExp(`${TASK}\\.tsv`));
	});

	gated("managedFileGuard", "blocks writes to managed audit files and allows others", async (driver, root) => {
		await driver.start(TASK);
		const managed = await driver.attemptWrite(join(root, ".audit", `${TASK}.tsv`));
		assert.equal(managed.blocked, true);
		assert.match(managed.reason ?? "", /extension-managed|audit_decision/);
		const state = await driver.attemptWrite(join(root, ".audit", "active.json"));
		assert.equal(state.blocked, true);
		const unrelated = await driver.attemptWrite(join(root, "src", "ok.ts"));
		assert.equal(unrelated.blocked, false);
	});

	gated("managedFileGuard", "fails closed over .audit when active state is unreadable", async (driver, root) => {
		await driver.start(TASK);
		await corruptActiveState(root);
		const guarded = await driver.attemptWrite(join(root, ".audit", "anything.tsv"));
		assert.equal(guarded.blocked, true);
		assert.match(guarded.reason ?? "", /unreadable/);
		const unrelated = await driver.attemptWrite(join(root, "src", "ok.ts"));
		assert.equal(unrelated.blocked, false, "unrelated writes stay allowed even with unreadable state");
	});

	contract("a failed explicit review records no artifact or checkpoint and never falls back", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "fail";
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, false);
		assert.deepEqual(driver.attemptedModels(), [driver.explicitReviewModel], "pinned review must not retry");
		assert.doesNotMatch(outcome.message, /sk-contract-secret|req-contract-private/, "diagnostics stay sanitized");
		assert.deepEqual(await reviewArtifacts(root), []);
		assert.equal(await checkpoint(root), undefined);
	});

	contract("reviewer output without a valid terminal verdict is a failed attempt", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "invalid-verdict";
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, false);
		assert.match(outcome.message, /no valid terminal verdict/);
		assert.deepEqual(await reviewArtifacts(root), []);
		assert.equal(await checkpoint(root), undefined);
	});

	contract("reviewer output without the mandatory design-friction evaluation is a failed attempt", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "missing-design-friction";
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, false);
		assert.match(outcome.message, /no valid design-friction evaluation/);
		assert.deepEqual(await reviewArtifacts(root), []);
		assert.equal(await checkpoint(root), undefined);
	});

	contract("a blocking verdict is recorded truthfully and gates close", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "block";
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, true, "a blocking review is a completed review, not a failure");
		assert.match(outcome.message, /D0001 overstates verification\./, "blocking findings must be surfaced inline");
		assert.match(outcome.message, /## Design-friction evaluation/, "the completed evaluation is surfaced with blocking findings");
		assert.doesNotMatch(outcome.message, /VERDICT:\s*block/i, "the redundant terminal verdict must be stripped");
		assert.match(outcome.message, /\.review\..*\.md/, "the canonical artifact path remains visible");
		const recorded = await checkpoint(root);
		assert.equal(recorded?.verdict, "block");
		assert.equal(recorded?.model, driver.explicitReviewModel);
		assert.equal((await reviewArtifacts(root)).length, 1);
		const close = await driver.close();
		assert.equal(close.completed, false, "close stays gated behind a blocking review");
	});

	contract("an approving review permits close", async (driver, root) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, true);
		assert.equal((await checkpoint(root))?.verdict, "approve");
		const [artifact] = await reviewArtifacts(root);
		assert.match(await readFile(join(root, ".audit", artifact), "utf8"), /## Design-friction evaluation\n\nNone identified\./);
		const close = await driver.close();
		assert.equal(close.completed, true, close.message);
	});

	contract("close is rejected when rows were appended after the last review", async (driver) => {
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		await driver.review(driver.explicitReviewModel);
		await driver.decide({ decision: "A decision the review never saw" });
		const close = await driver.close();
		assert.equal(close.completed, false, "rows appended after the review must gate close");
	});

	contract("close is rejected while decisions are unresolved", async (driver) => {
		await driver.start(TASK);
		await driver.decide({ result: "open", decision: "An unresolved decision" });
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		await driver.review(driver.explicitReviewModel);
		const close = await driver.close();
		assert.equal(close.completed, false, "unresolved decisions must gate close");
	});

	contract("publish is rejected without Git provenance", async (driver) => {
		await driver.start(TASK);
		await driver.decide();
		const outcome = await driver.publish();
		assert.equal(outcome.completed, false);
		assert.match(outcome.message, /provenance/i);
	});

	contract("publishes the reviewed audit to the matching branch PR", async (driver) => {
		driver.github.enabled = true;
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		const review = await driver.review(driver.explicitReviewModel);
		assert.equal(review.completed, true, review.message);
		const outcome = await driver.publish();
		assert.equal(outcome.completed, true, outcome.message);
		assert.match(outcome.message, /PR #7/);
	});

	contract("publish is rejected when rows were appended after the last review", async (driver) => {
		driver.github.enabled = true;
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		await driver.review(driver.explicitReviewModel);
		await driver.decide({ decision: "A decision the review never saw" });
		const outcome = await driver.publish();
		assert.equal(outcome.completed, false, "stale review bytes must gate publish");
		assert.match(outcome.message, /review/i);
	});

	contract("publish is rejected when the PR head does not match the checkout", async (driver) => {
		driver.github.enabled = true;
		await driver.start(TASK);
		await driver.decide();
		driver.reviewerScript[driver.explicitReviewModel] = "approve";
		await driver.review(driver.explicitReviewModel);
		driver.github.prHeadOid = "divergent-head";
		const outcome = await driver.publish();
		assert.equal(outcome.completed, false, "a diverged PR head must gate publish");
		assert.match(outcome.message, /does not match current checkout/);
	});
}

/**
 * Model-discovery contract for harnesses that declare catalog-driven
 * automatic reviewer selection: the full issue-#29 fallback semantics run
 * identically against each capable adapter boundary.
 */
export function registerModelDiscoveryConformance({ harness, capabilities, createDriver }: ConformanceInput): void {
	if (!capabilities.automaticReviewerSelection || !capabilities.modelDiscovery) {
		test(
			`${harness} model discovery: catalog-driven reviewer fallback`,
			{ skip: `${harness} declares automaticReviewerSelection: ${capabilities.automaticReviewerSelection}, modelDiscovery: ${capabilities.modelDiscovery}` },
			() => {},
		);
		return;
	}
	const contract = (name: string, run: (driver: HarnessDriver, root: string) => Promise<void>) =>
		test(`${harness} model discovery: ${name}`, () =>
			withDriver(createDriver, async (driver, root) => {
				await driver.start(TASK);
				await driver.decide();
				await run(driver, root);
			}));

	// With DEFAULT_CATALOG and the anthropic working model, the deterministic
	// candidate order is: openai/fable-5, openai/gpt-5.6-sol (cross-provider),
	// anthropic/claude-fable-5 (cross-model), anthropic/claude-opus-4-8
	// (same-model).
	const [firstCross, secondCross, crossModel, sameModel] = [
		"openai/fable-5",
		"openai/gpt-5.6-sol",
		"anthropic/claude-fable-5",
		"anthropic/claude-opus-4-8",
	];

	contract("retries within the cross-provider tier", async (driver, root) => {
		driver.reviewerScript[secondCross] = "approve";
		const outcome = await driver.review();
		assert.equal(outcome.completed, true, outcome.message);
		assert.deepEqual(driver.attemptedModels(), [firstCross, secondCross]);
		const recorded = await checkpoint(root);
		assert.equal(recorded?.model, secondCross);
		assert.equal(recorded?.mode, "cross-provider");
	});

	contract("progresses into the cross-model tier when every cross-provider candidate fails", async (driver, root) => {
		driver.reviewerScript[crossModel] = "approve";
		const outcome = await driver.review();
		assert.equal(outcome.completed, true, outcome.message);
		assert.deepEqual(driver.attemptedModels(), [firstCross, secondCross, crossModel]);
		const recorded = await checkpoint(root);
		assert.equal(recorded?.model, crossModel);
		assert.equal(recorded?.mode, "cross-model");
	});

	contract("falls back to the working model itself as the final same-model candidate", async (driver, root) => {
		driver.reviewerScript[sameModel] = "approve";
		const outcome = await driver.review();
		assert.equal(outcome.completed, true, outcome.message);
		assert.deepEqual(driver.attemptedModels(), [firstCross, secondCross, crossModel, sameModel]);
		const recorded = await checkpoint(root);
		assert.equal(recorded?.model, sameModel);
		assert.equal(recorded?.mode, "same-model");
	});

	contract("a blocking verdict stops fallback immediately", async (driver, root) => {
		driver.reviewerScript[firstCross] = "block";
		const outcome = await driver.review();
		assert.equal(outcome.completed, true, "a blocking review completes the fallback loop");
		assert.deepEqual(driver.attemptedModels(), [firstCross]);
		assert.equal((await checkpoint(root))?.verdict, "block");
	});

	contract("an invalid terminal verdict advances to the next candidate", async (driver, root) => {
		driver.reviewerScript[firstCross] = "invalid-verdict";
		driver.reviewerScript[secondCross] = "approve";
		const outcome = await driver.review();
		assert.equal(outcome.completed, true, outcome.message);
		assert.deepEqual(driver.attemptedModels(), [firstCross, secondCross]);
		assert.equal((await checkpoint(root))?.model, secondCross);
	});

	contract("total failure attempts each candidate once and reports safe diagnostics", async (driver, root) => {
		const outcome = await driver.review();
		assert.equal(outcome.completed, false);
		const attempts = driver.attemptedModels();
		assert.deepEqual(attempts, [firstCross, secondCross, crossModel, sameModel]);
		assert.equal(new Set(attempts).size, attempts.length, "each candidate is attempted at most once");
		for (const model of attempts) {
			assert.ok(outcome.message.includes(model), `diagnostics name ${model}`);
		}
		assert.doesNotMatch(outcome.message, /sk-contract-secret|req-contract-private/, "no raw stderr in diagnostics");
		assert.ok(!outcome.message.includes(SENSITIVE_STDERR));
		assert.deepEqual(await reviewArtifacts(root), []);
		assert.equal(await checkpoint(root), undefined);
	});

	contract("explicit selection stays pinned even when fallback candidates exist", async (driver) => {
		const outcome = await driver.review(driver.explicitReviewModel);
		assert.equal(outcome.completed, false);
		assert.deepEqual(driver.attemptedModels(), [driver.explicitReviewModel], "explicit requests never fall back");
	});
}
