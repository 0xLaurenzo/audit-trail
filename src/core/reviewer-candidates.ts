import type { ReviewModel } from "./ports.ts";
import type { ReviewMode } from "./types.ts";

/** Maintainer-owned review policy, in preference order. */
export const REVIEW_MODEL_ALLOWLIST = [
	{ family: "anthropic/claude-fable-5-2", providers: ["anthropic"], model: "claude-fable-5-2" },
	{ family: "anthropic/claude-opus-5-5", providers: ["anthropic"], model: "claude-opus-5-5" },
	{ family: "anthropic/claude-fable-5-1", providers: ["anthropic"], model: "claude-fable-5-1" },
	{ family: "anthropic/claude-fable-5", providers: ["anthropic"], model: "claude-fable-5" },
	{ family: "openai/gpt-6.2-astra", providers: ["openai", "openai-codex"], model: "gpt-6.2-astra" },
	{ family: "openai/gpt-6.2-sol", providers: ["openai", "openai-codex"], model: "gpt-6.2-sol" },
	{ family: "openai/gpt-6.1-astra", providers: ["openai", "openai-codex"], model: "gpt-6.1-astra" },
	{ family: "openai/gpt-6.1-sol", providers: ["openai", "openai-codex"], model: "gpt-6.1-sol" },
	{ family: "openai/gpt-6-astra", providers: ["openai", "openai-codex"], model: "gpt-6-astra" },
	{ family: "openai/gpt-6-sol", providers: ["openai", "openai-codex"], model: "gpt-6-sol" },
] as const;

export const REVIEW_MODEL_ALLOWLIST_TEXT = REVIEW_MODEL_ALLOWLIST.map(({ family }) => family).join(", ");

// Only serving decorations are variants; numeric releases require an explicit allowlist entry.
const SERVING_VARIANT = "(?:-fast)?(?:-\\d{8})?";
const ALLOWED_VARIANT = new RegExp(`^${SERVING_VARIANT}$`);
// Working-model IDs may also carry Claude Code's `[1m]` context-window tag.
const SERVING_SUFFIX = new RegExp(`${SERVING_VARIANT}(?:\\[1m\\])?$`);

/** Exact family or one of the deliberate variants above, from an approved provider. */
export function reviewModelRank(reference: string): number | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = reference.slice(0, slash).toLowerCase();
	const model = reference.slice(slash + 1).toLowerCase();
	const rank = REVIEW_MODEL_ALLOWLIST.findIndex(
		(entry) => entry.providers.some((allowed) => allowed === provider)
			&& model.startsWith(entry.model) && ALLOWED_VARIANT.test(model.slice(entry.model.length)),
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

/**
 * Truthful relation of a reviewer to the working model. Serving variants of
 * one model (`-fast`, dated snapshots) are the same model, never cross-model.
 */
export function reviewModeFor(reviewer: ReviewModel, working: ReviewModel): ReviewMode {
	if (!sameReviewProvider(reviewer.provider, working.provider)) return "cross-provider";
	const identity = (id: string) => id.toLowerCase().replace(SERVING_SUFFIX, "");
	return identity(reviewer.id) === identity(working.id) ? "same-model" : "cross-model";
}

/** Allowlisted model IDs a provider-bound runtime may run, in preference order. */
export function providerReviewModels(provider: string): string[] {
	return REVIEW_MODEL_ALLOWLIST
		.filter((entry) => entry.providers.some((allowed) => allowed === provider))
		.map(({ model }) => model);
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
 * Candidates for a runtime bound to one provider and without a catalog: a
 * pinned request, or that provider's allowlist order. `working` is the
 * hook-captured model ID, with or without a provider prefix.
 */
export function providerBoundReviewCandidates(provider: string, requested: unknown, working: string): ReviewCandidate[] {
	const id = (reference: string) => reference.slice(reference.indexOf("/") + 1);
	const candidate = (model: string): ReviewCandidate => ({
		model: `${provider}/${model}`,
		mode: reviewModeFor({ provider, id: model }, { provider, id: id(working) }),
	});
	const requestedText = typeof requested === "string" ? requested.trim() : "";
	if (!requestedText) return providerReviewModels(provider).map(candidate);
	const reference = requestedText.includes("/") ? requestedText : `${provider}/${requestedText}`;
	assertAllowedReviewModel(reference);
	if (!sameReviewProvider(reference.slice(0, reference.indexOf("/")), provider)) {
		throw new Error(`This harness runs only ${provider} review models, not ${reference}`);
	}
	return [candidate(id(reference))];
}

/**
 * Build the deterministic, deduplicated reviewer candidate order for
 * automatic selection: allowed cross-provider models first, then allowed
 * same-provider/different-model candidates, then same-model candidates,
 * ending with the working model only when it is allowed. Within each tier
 * the canonical allowlist defines preference.
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
	for (const mode of ["cross-provider", "cross-model", "same-model"] as const) {
		for (const model of ordered(supported.filter((model) => reviewModeFor(model, working) === mode))) push(model, mode);
	}
	if (isAllowedReviewModel(reference(working))) push(working, "same-model");
	return candidates;
}
