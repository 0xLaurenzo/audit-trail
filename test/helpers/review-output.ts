import { REVIEW_OUTPUT_CONTRACT } from "../../src/core/review-output.ts";
import type { ReviewVerdict } from "../../src/core/types.ts";

export interface ReviewOutputFixtureInput {
	findings?: string;
	designFriction?: string;
	verdict: ReviewVerdict;
}

/** Build valid reviewer output from the shipped output-contract metadata. */
export function buildReviewOutputFixture(input: ReviewOutputFixtureInput): string {
	const findings = input.findings ?? "No flags";
	const designFriction = input.designFriction ?? "None identified.";
	const designSection = REVIEW_OUTPUT_CONTRACT.sections.find((section) => section.id === "designFriction");
	if (!designSection?.heading) throw new Error("Review output contract has no design-friction heading.");
	return `${findings}\n\n${designSection.heading}\n\n${designFriction}\n\n${REVIEW_OUTPUT_CONTRACT.verdict.prefix} ${input.verdict}\n`;
}
