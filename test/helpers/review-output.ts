import {
	renderReviewOutput,
	REVIEW_OUTPUT_CONTRACT,
	type ReviewOutputSectionId,
} from "../../src/core/review-output.ts";
import type { ReviewVerdict } from "../../src/core/types.ts";

export interface ReviewOutputFixtureInput {
	sections?: Partial<Record<ReviewOutputSectionId, string>>;
	verdict: ReviewVerdict;
}

/** Build reviewer output through the shipped renderer with schema defaults. */
export function buildReviewOutputFixture(input: ReviewOutputFixtureInput): string {
	const sections = Object.fromEntries(
		REVIEW_OUTPUT_CONTRACT.sections.map((section) => [
			section.id,
			input.sections?.[section.id] ?? section.defaultBody,
		]),
	) as Record<ReviewOutputSectionId, string>;
	return renderReviewOutput({ sections, verdict: input.verdict });
}
