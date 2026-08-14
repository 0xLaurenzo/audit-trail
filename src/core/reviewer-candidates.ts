import type { ReviewModel } from "./ports.ts";
import type { ReviewMode } from "./types.ts";

/// Reviewer preference, most advanced first. Applied to order every candidate
/// within each review tier (cross-provider, then cross-model, then the
/// working model itself). Patterns match the full provider/model reference.
export const REVIEW_MODEL_PREFERENCE = [
	/^anthropic\/claude-fable-5(?:-|$)/i,
	/^anthropic\/claude-opus-5(?:-|$)/i,
	/gpt-5\.6-sol/i,
];

/** One reviewer attempt: the model as `provider/id` and its truthful relation to the working model. */
export interface ReviewCandidate {
	model: string;
	mode: ReviewMode;
}

/**
 * Build the deterministic, deduplicated reviewer candidate order for
 * automatic selection: every cross-provider model first, then every
 * same-provider/different-model candidate, then the working model itself as
 * the final same-model fallback. Within each tier, models matching an earlier
 * preference pattern come first; unmatched models keep catalog order after
 * all matches. Each candidate appears at most once so runtime fallback
 * (issue #29) never retries a model that already failed.
 */
export function buildReviewerCandidates(
	available: ReviewModel[],
	working: ReviewModel,
	preference: RegExp[] = REVIEW_MODEL_PREFERENCE,
): ReviewCandidate[] {
	const rank = (model: ReviewModel) => {
		const index = preference.findIndex((pattern) => pattern.test(`${model.provider}/${model.id}`));
		return index === -1 ? preference.length : index;
	};
	const ordered = (models: ReviewModel[]) =>
		models
			.map((model, index) => ({ model, index }))
			.sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
			.map((entry) => entry.model);
	const seen = new Set<string>();
	const candidates: ReviewCandidate[] = [];
	const push = (model: ReviewModel, mode: ReviewMode) => {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ model: key, mode });
	};
	for (const model of ordered(available.filter((model) => model.provider !== working.provider))) {
		push(model, "cross-provider");
	}
	for (const model of ordered(
		available.filter((model) => model.provider === working.provider && model.id !== working.id),
	)) {
		push(model, "cross-model");
	}
	push(working, "same-model");
	return candidates;
}
