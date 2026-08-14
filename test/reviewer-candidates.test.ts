import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewModel } from "../src/core/ports.ts";
import { buildReviewerCandidates } from "../src/core/reviewer-candidates.ts";

const working: ReviewModel = { provider: "anthropic", id: "claude-opus-4-8" };

test("candidates cover every tier in order: cross-provider, cross-model, then the working model", () => {
	const catalog: ReviewModel[] = [
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-opus-5" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "zai", id: "glm-5" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
		{ model: "zai/glm-5", mode: "cross-provider" },
		{ model: "anthropic/claude-fable-5", mode: "cross-model" },
		{ model: "anthropic/claude-opus-5", mode: "cross-model" },
		{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
	]);
});

test("preference ordering names exact model families, with catalog order as tiebreak", () => {
	const openaiWorking: ReviewModel = { provider: "openai", id: "gpt-5.5" };
	const catalog: ReviewModel[] = [
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "acme", id: "claude-fable-5" },
		{ provider: "anthropic", id: "claude-opus-5-fast" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "anthropic", id: "claude-fable-50" },
	];
	assert.deepEqual(
		buildReviewerCandidates(catalog, openaiWorking).map((candidate) => candidate.model),
		[
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-5-fast",
			"anthropic/claude-opus-4-8",
			"acme/claude-fable-5",
			"anthropic/claude-fable-50",
			"openai/gpt-5.5",
		],
	);
});

test("the working model is always the final same-model fallback, exactly once", () => {
	// Working model present in the catalog: deduplicated into the final slot.
	const withWorking = buildReviewerCandidates([working], working);
	assert.deepEqual(withWorking, [{ model: "anthropic/claude-opus-4-8", mode: "same-model" }]);
	// Empty catalog: the working model itself is still a candidate.
	assert.deepEqual(buildReviewerCandidates([], working), [{ model: "anthropic/claude-opus-4-8", mode: "same-model" }]);
});

test("duplicate catalog entries are attempted at most once", () => {
	const catalog: ReviewModel[] = [
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai", id: "gpt-5.6-sol" },
	];
	assert.deepEqual(buildReviewerCandidates(catalog, working), [
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
		{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
	]);
});

test("candidate ordering is deterministic across calls", () => {
	const catalog: ReviewModel[] = [
		{ provider: "zai", id: "glm-5" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "anthropic", id: "claude-fable-5" },
	];
	const once = buildReviewerCandidates(catalog, working);
	assert.deepEqual(buildReviewerCandidates(catalog, working), once);
});
