import type { ReviewModel } from "./ports.ts";
import type { ReviewMode } from "./types.ts";

/** Maintainer-owned review policy, in preference order. */
export const REVIEW_MODEL_ALLOWLIST = [
	{ family: "anthropic/claude-fable-5", providers: ["anthropic"], model: "claude-fable-5" },
	{ family: "anthropic/claude-opus-5", providers: ["anthropic"], model: "claude-opus-5" },
	{ family: "openai/gpt-6-astra", providers: ["openai", "openai-codex"], model: "gpt-6-astra" },
	{ family: "openai/gpt-5.6-sol", providers: ["openai", "openai-codex"], model: "gpt-5.6-sol" },
] as const;

export const REVIEW_MODEL_ALLOWLIST_TEXT = REVIEW_MODEL_ALLOWLIST.map(({ family }) => family).join(", ");

/** Exact family or a deliberate hyphen-suffixed variant from an approved provider. */
export function reviewModelRank(reference: string): number | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = reference.slice(0, slash).toLowerCase();
	const model = reference.slice(slash + 1).toLowerCase();
	const rank = REVIEW_MODEL_ALLOWLIST.findIndex(
		(entry) => entry.providers.some((allowed) => allowed === provider)
			&& (model === entry.model || model.startsWith(`${entry.model}-`)),
	);
	return rank === -1 ? undefined : rank;
}

export function isAllowedReviewModel(reference: string): boolean {
	return reviewModelRank(reference) !== undefined;
}

/** Provider identity used for review-independence claims, not runtime routing. */
export function sameReviewProvider(left: string, right: string): boolean {
	const normalize = (provider: string) => provider.toLowerCase().replace(/^openai-codex$/, "openai");
	return normalize(left) === normalize(right);
}

export function assertAllowedReviewModel(reference: string): void {
	if (!isAllowedReviewModel(reference)) {
		throw new Error(`Unsupported review model ${JSON.stringify(reference)}. Allowed review model families: ${REVIEW_MODEL_ALLOWLIST_TEXT}`);
	}
}

export function noAllowedReviewModelsError(): Error {
	return new Error(`No allowed review model is available. Allowed review model families: ${REVIEW_MODEL_ALLOWLIST_TEXT}`);
}

/** One reviewer attempt: the model as `provider/id` and its truthful relation to the working model. */
export interface ReviewCandidate {
	model: string;
	mode: ReviewMode;
}

/**
 * Build the deterministic, deduplicated reviewer candidate order for
 * automatic selection: allowed cross-provider models first, then allowed
 * same-provider/different-model candidates, then the working model only when
 * it is allowed. Within each tier the canonical allowlist defines preference.
 */
export function buildReviewerCandidates(available: ReviewModel[], working: ReviewModel): ReviewCandidate[] {
	const reference = (model: ReviewModel) => `${model.provider}/${model.id}`;
	const supported = available.filter((model) => isAllowedReviewModel(reference(model)));
	const ordered = (models: ReviewModel[]) =>
		models
			.map((model, index) => ({ model, index, rank: reviewModelRank(reference(model))! }))
			.sort((a, b) => a.rank - b.rank || a.index - b.index)
			.map((entry) => entry.model);
	const seen = new Set<string>();
	const candidates: ReviewCandidate[] = [];
	const push = (model: ReviewModel, mode: ReviewMode) => {
		const key = reference(model);
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ model: key, mode });
	};
	for (const model of ordered(supported.filter((model) => !sameReviewProvider(model.provider, working.provider)))) {
		push(model, "cross-provider");
	}
	for (const model of ordered(
		supported.filter((model) => sameReviewProvider(model.provider, working.provider) && model.id !== working.id),
	)) {
		push(model, "cross-model");
	}
	if (isAllowedReviewModel(reference(working))) push(working, "same-model");
	return candidates;
}
