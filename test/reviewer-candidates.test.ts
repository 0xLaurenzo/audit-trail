import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewModel } from "../src/core/ports.ts";
import {
	REVIEW_MODEL_ALLOWLIST_TEXT,
	assertAllowedReviewModel,
	buildReviewerCandidates,
	isAllowedReviewModel,
} from "../src/core/reviewer-candidates.ts";

const working: ReviewModel = { provider: "anthropic", id: "claude-opus-5-5" };

test("preferred models lead each independence tier regardless of catalog order", () => {
	const anthropic = ["claude-fable-5-2", "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"];
	const openai = ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-astra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"];
	const catalog = [
		...anthropic.map((id) => ({ provider: "anthropic", id })),
		...openai.map((id) => ({ provider: "openai", id })),
	].reverse();
	for (const model of catalog) {
		for (const suffix of ["", "-fast", "-20260801", "-fast-20260801"]) {
			assert.equal(isAllowedReviewModel(`${model.provider}/${model.id}${suffix}`), true);
		}
	}
	catalog.push({ provider: "openai", id: "gpt-5.6-sol" }, { provider: "anthropic", id: "claude-opus-5" });
	assert.deepEqual(
		buildReviewerCandidates(catalog, { provider: "anthropic", id: "claude-opus-5" }),
		[
			...openai.map((id) => ({ model: `openai/${id}`, mode: "cross-provider" })),
			...anthropic.map((id) => ({ model: `anthropic/${id}`, mode: "cross-model" })),
		],
	);
	assert.deepEqual(
		buildReviewerCandidates(catalog, { provider: "openai", id: "gpt-5.6-sol" }),
		[
			...anthropic.map((id) => ({ model: `anthropic/${id}`, mode: "cross-provider" })),
			...openai.map((id) => ({ model: `openai/${id}`, mode: "cross-model" })),
		],
	);
});

test("automatic candidates contain only allowed models in truthful tier and policy order", () => {
	const catalog: ReviewModel[] = [
		working,
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-6.2-sol" },
		{ provider: "openai-codex", id: "gpt-6.2-astra" },
		{ provider: "zai", id: "glm-5" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai-codex/gpt-6.2-astra", mode: "cross-provider" },
		{ model: "openai/gpt-6.2-sol", mode: "cross-provider" },
		{ model: "anthropic/claude-fable-5", mode: "cross-model" },
		{ model: "anthropic/claude-opus-5-5", mode: "same-model" },
	]);
});

test("the allowlist admits deliberate variants and provider aliases, not lookalikes", () => {
	for (const model of [
		"anthropic/claude-fable-5",
		"anthropic/claude-opus-5-5-fast",
		"openai/gpt-6.2-astra",
		"openai-codex/gpt-6.2-astra-fast",
		"openai/gpt-6.2-sol",
		"anthropic/claude-fable-5-2",
		"anthropic/claude-opus-5-5-20260801",
		"openai/gpt-6.2-astra-fast-20260801",
		"anthropic/claude-fable-5-1",
		"openai/gpt-6-astra",
		"openai/gpt-6-sol",
		"openai/gpt-6.1-astra",
		"openai/gpt-6.1-sol",
	]) {
		assert.equal(isAllowedReviewModel(model), true, model);
	}
	for (const model of [
		"anthropic/claude-opus-4-8",
		"anthropic/claude-opus-5",
		"anthropic/claude-opus-5-fast",
		"openai/gpt-5.6-sol",
		"openai-codex/gpt-5.6-sol-fast",
		"anthropic/claude-fable-5-3",
		"anthropic/claude-opus-5-6",
		"openai/gpt-6.3-astra",
		"openai/gpt-6.2-astra-2-fast-20260801",
		"anthropic/claude-fable-50",
		"acme/claude-fable-5",
		"openai/gpt-5.4",
		"zai/gpt-6.2-astra",
		"openai/gpt-6.2-astra-mini",
		"openai/gpt-6.2-astra-nano",
		"anthropic/claude-opus-5-5-haiku",
		"openai/gpt-6.2-astra-",
		"openai/gpt-6.2-astra-fast-fast",
		"openai/gpt-6.2-astra-20260801-fast",
		"openai/gpt-6.2-astra-123",
		"openai/gpt-6.2-astra-2-3",
		"openai/gpt-6.2-astra[1m]",
	]) {
		assert.equal(isAllowedReviewModel(model), false, model);
	}
	assert.throws(
		() => assertAllowedReviewModel("openai/gpt-5.4"),
		new RegExp(`Unsupported review model.*${REVIEW_MODEL_ALLOWLIST_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
	);
});

test("serving variants of the working model are same-model, after cross-model", () => {
	assert.deepEqual(
		buildReviewerCandidates([
			{ provider: "openai", id: "gpt-6.2-astra-fast" },
			{ provider: "openai", id: "gpt-6.2-sol" },
		], { provider: "openai-codex", id: "gpt-6.2-astra" }),
		[
			{ model: "openai/gpt-6.2-sol", mode: "cross-model" },
			{ model: "openai/gpt-6.2-astra-fast", mode: "same-model" },
			{ model: "openai-codex/gpt-6.2-astra", mode: "same-model" },
		],
	);
});

test("OpenAI runtime aliases never create false cross-provider modes", () => {
	const openaiWorking = { provider: "openai-codex", id: "gpt-6.2-sol" };
	assert.deepEqual(
		buildReviewerCandidates([
			{ provider: "openai", id: "gpt-6.2-astra" },
			{ provider: "anthropic", id: "claude-fable-5" },
		], openaiWorking),
		[
			{ model: "anthropic/claude-fable-5", mode: "cross-provider" },
			{ model: "openai/gpt-6.2-astra", mode: "cross-model" },
			{ model: "openai-codex/gpt-6.2-sol", mode: "same-model" },
		],
	);
});

test("the working model is a same-model fallback only when allowlisted", () => {
	assert.deepEqual(buildReviewerCandidates([], working), [
		{ model: "anthropic/claude-opus-5-5", mode: "same-model" },
	]);
	assert.deepEqual(
		buildReviewerCandidates([], { provider: "anthropic", id: "claude-opus-4-8" }),
		[],
	);
});

test("duplicate catalog entries are attempted at most once", () => {
	const catalog: ReviewModel[] = [
		{ provider: "openai", id: "gpt-6.2-sol" },
		{ provider: "openai", id: "gpt-6.2-sol" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai/gpt-6.2-sol", mode: "cross-provider" },
		{ model: "anthropic/claude-opus-5-5", mode: "same-model" },
	]);
});

test("candidate ordering is deterministic across calls", () => {
	const catalog: ReviewModel[] = [
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-6.2-sol" },
		{ provider: "openai", id: "gpt-6.2-astra" },
		{ provider: "anthropic", id: "claude-fable-5" },
	];
	const once = buildReviewerCandidates(catalog, working);
	assert.deepEqual(buildReviewerCandidates(catalog, working), once);
});
