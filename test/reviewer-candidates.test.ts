import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewModel } from "../src/core/ports.ts";
import {
	REVIEW_MODEL_ALLOWLIST_TEXT,
	assertAllowedReviewModel,
	buildReviewerCandidates,
	isAllowedReviewModel,
} from "../src/core/reviewer-candidates.ts";

const working: ReviewModel = { provider: "anthropic", id: "claude-opus-5" };

test("automatic candidates contain only allowed models in truthful tier and policy order", () => {
	const catalog: ReviewModel[] = [
		working,
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai-codex", id: "gpt-6-astra" },
		{ provider: "zai", id: "glm-5" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai-codex/gpt-6-astra", mode: "cross-provider" },
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
		{ model: "anthropic/claude-fable-5", mode: "cross-model" },
		{ model: "anthropic/claude-opus-5", mode: "same-model" },
	]);
});

test("the allowlist admits deliberate variants and provider aliases, not lookalikes", () => {
	for (const model of [
		"anthropic/claude-fable-5",
		"anthropic/claude-opus-5-fast",
		"openai/gpt-6-astra",
		"openai-codex/gpt-6-astra-fast",
		"openai/gpt-5.6-sol",
	]) {
		assert.equal(isAllowedReviewModel(model), true, model);
	}
	for (const model of [
		"anthropic/claude-opus-4-8",
		"anthropic/claude-fable-50",
		"acme/claude-fable-5",
		"openai/gpt-5.4",
		"zai/gpt-6-astra",
	]) {
		assert.equal(isAllowedReviewModel(model), false, model);
	}
	assert.throws(
		() => assertAllowedReviewModel("openai/gpt-5.4"),
		new RegExp(`Unsupported review model.*${REVIEW_MODEL_ALLOWLIST_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
	);
});

test("OpenAI runtime aliases never create false cross-provider modes", () => {
	const openaiWorking = { provider: "openai-codex", id: "gpt-5.6-sol" };
	assert.deepEqual(
		buildReviewerCandidates([
			{ provider: "openai", id: "gpt-6-astra" },
			{ provider: "anthropic", id: "claude-fable-5" },
		], openaiWorking),
		[
			{ model: "anthropic/claude-fable-5", mode: "cross-provider" },
			{ model: "openai/gpt-6-astra", mode: "cross-model" },
			{ model: "openai-codex/gpt-5.6-sol", mode: "same-model" },
		],
	);
});

test("the working model is a same-model fallback only when allowlisted", () => {
	assert.deepEqual(buildReviewerCandidates([], working), [
		{ model: "anthropic/claude-opus-5", mode: "same-model" },
	]);
	assert.deepEqual(
		buildReviewerCandidates([], { provider: "anthropic", id: "claude-opus-4-8" }),
		[],
	);
});

test("duplicate catalog entries are attempted at most once", () => {
	const catalog: ReviewModel[] = [
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai", id: "gpt-5.6-sol" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
		{ model: "anthropic/claude-opus-5", mode: "same-model" },
	]);
});

test("candidate ordering is deterministic across calls", () => {
	const catalog: ReviewModel[] = [
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai", id: "gpt-6-astra" },
		{ provider: "anthropic", id: "claude-fable-5" },
	];
	const once = buildReviewerCandidates(catalog, working);
	assert.deepEqual(buildReviewerCandidates(catalog, working), once);
});
