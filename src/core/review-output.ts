import { REVIEW_VERDICTS, type ReviewVerdict } from "./types.ts";

interface ReviewSectionSpec {
	id: string;
	label: string;
	heading: string | null;
	required: boolean;
	nonEmptyWhen: "always" | ReviewVerdict;
	finalSection: boolean;
	prompt: string;
	bodyPrompt?: string;
	failureSummary: string;
}

interface ReviewVerdictSpec {
	prefix: string;
	values: typeof REVIEW_VERDICTS;
	promptByValue: Record<ReviewVerdict, string>;
	failureSummary: string;
}

/**
 * The single ordered definition of the independent-review output protocol.
 * Prompt rendering, parsing, validation, and test fixtures all consume this
 * value rather than repeating headings, verdict syntax, or section rules.
 */
export const REVIEW_OUTPUT_CONTRACT = {
	sections: [
		{
			id: "auditFindings",
			label: "audit-findings",
			heading: null,
			required: true,
			nonEmptyWhen: "block",
			finalSection: false,
			prompt: "Report the audit findings first. A concise \"No flags\" is valid.",
			failureSummary: "blocking reviewer output had no audit findings",
		},
		{
			id: "designFriction",
			label: "design-friction",
			heading: "## Design-friction evaluation",
			required: true,
			nonEmptyWhen: "always",
			finalSection: true,
			prompt: "Perform a separate design-friction evaluation by asking: while reviewing this work, did you encounter concrete challenges or walls that would be substantially simplified by a design-level change? Report only concise, observable friction; do not reveal private chain-of-thought. If friction exists, identify the challenge, the evidence or decision IDs that expose it, the design-level change, and why it would materially simplify future work compared with a local patch. Design friction is not automatically blocking: block only when it reveals a current audit-integrity, correctness, unresolved-decision, or symptom-patch problem; otherwise preserve the suggestion and approve when the audit is trustworthy.",
			bodyPrompt: "either \"None identified.\" or the actionable design-friction items",
			failureSummary: "reviewer output had no valid design-friction evaluation",
		},
	] satisfies readonly ReviewSectionSpec[],
	verdict: {
		prefix: "VERDICT:",
		values: REVIEW_VERDICTS,
		promptByValue: {
			approve: "if the audit is trustworthy enough to publish and close",
			block: "if any finding must be addressed and re-reviewed first",
		},
		failureSummary: "reviewer output had no valid terminal verdict",
	} satisfies ReviewVerdictSpec,
} as const;

export type ReviewOutputSectionId = (typeof REVIEW_OUTPUT_CONTRACT.sections)[number]["id"];
export type ReviewOutputFailureReason =
	| "invalid-verdict"
	| "missing-section"
	| "duplicate-section"
	| "empty-section"
	| "non-final-section";

export interface ParsedReviewOutput {
	ok: true;
	verdict: ReviewVerdict;
	sections: Record<ReviewOutputSectionId, string>;
	/** Complete report body with only the terminal verdict removed. */
	reportBody: string;
}

export interface InvalidReviewOutput {
	ok: false;
	reason: ReviewOutputFailureReason;
	section?: ReviewOutputSectionId;
	/** Safe, stable fallback diagnostic derived from the contract. */
	failureSummary: string;
}

export type ReviewOutputParseResult = ParsedReviewOutput | InvalidReviewOutput;

type ContractSection = (typeof REVIEW_OUTPUT_CONTRACT.sections)[number];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verdictPattern(): RegExp {
	const { prefix, values } = REVIEW_OUTPUT_CONTRACT.verdict;
	return new RegExp(`^${escapeRegExp(prefix)}\\s*(${values.map(escapeRegExp).join("|")})$`, "i");
}

function splitTerminalVerdict(report: string): { bodyLines: string[]; verdict?: ReviewVerdict } {
	const lines = report.split(/\r?\n/);
	while (lines.length && !lines.at(-1)?.trim()) lines.pop();
	const match = verdictPattern().exec(lines.at(-1)?.trim() ?? "");
	if (!match) return { bodyLines: lines };
	lines.pop();
	return { bodyLines: lines, verdict: match[1].toLowerCase() as ReviewVerdict };
}

function sameHeading(line: string, heading: string): boolean {
	return line.trim().toLowerCase() === heading.toLowerCase();
}

function sectionFailure(section: ContractSection, reason: ReviewOutputFailureReason): InvalidReviewOutput {
	return { ok: false, reason, section: section.id, failureSummary: section.failureSummary };
}

/** Render the output-format portion of the independent-review prompt. */
export function buildReviewOutputInstructions(): string {
	const sections = REVIEW_OUTPUT_CONTRACT.sections;
	const finalSection = sections.find((section) => section.finalSection);
	if (!finalSection?.heading || !finalSection.bodyPrompt) {
		throw new Error("Review output contract has no renderable final section.");
	}
	const verdict = REVIEW_OUTPUT_CONTRACT.verdict;
	const verdictForms = verdict.values
		.map((value) => `"${verdict.prefix} ${value}" ${verdict.promptByValue[value]}`)
		.join(", or ");
	const requirement = finalSection.required ? "mandatory" : "optional";
	const contentRule = finalSection.nonEmptyWhen === "always" ? "must be non-empty" : `must be non-empty for ${finalSection.nonEmptyWhen}`;
	return `${sections.map((section) => section.prompt).join("\n\n")}\n\nImmediately before the verdict, include the exact heading "${finalSection.heading}" followed by ${finalSection.bodyPrompt}. This section is ${requirement} and ${contentRule}. Then end your report with a verdict on its own final line: ${verdictForms}. A missing or malformed ${finalSection.label} section or verdict makes this review attempt invalid and causes another reviewer to be tried when fallback candidates are available.`;
}

/**
 * Parse and validate the complete ordered review-output protocol in one operation.
 * Canonical headings are rendered with their schema spelling but accepted
 * case-insensitively, as are verdict values.
 */
export function parseReviewOutput(output: string): ReviewOutputParseResult {
	const split = splitTerminalVerdict(output);
	if (!split.verdict) {
		return {
			ok: false,
			reason: "invalid-verdict",
			failureSummary: REVIEW_OUTPUT_CONTRACT.verdict.failureSummary,
		};
	}

	const headedSections = REVIEW_OUTPUT_CONTRACT.sections.filter(
		(section): section is ContractSection & { heading: string } => section.heading !== null,
	);
	const headingIndexes = new Map<ReviewOutputSectionId, number>();
	for (const section of headedSections) {
		const matches = split.bodyLines.flatMap((line, index) => sameHeading(line, section.heading) ? [index] : []);
		if (matches.length === 0 && section.required) return sectionFailure(section, "missing-section");
		if (matches.length > 1) return sectionFailure(section, "duplicate-section");
		if (matches.length === 1) headingIndexes.set(section.id, matches[0]);
	}

	let previousHeadingIndex = -1;
	for (const section of headedSections) {
		const index = headingIndexes.get(section.id);
		if (index === undefined) continue;
		if (index <= previousHeadingIndex) return sectionFailure(section, "non-final-section");
		previousHeadingIndex = index;
	}

	const parsed = {} as Record<ReviewOutputSectionId, string>;
	for (const [sectionIndex, section] of REVIEW_OUTPUT_CONTRACT.sections.entries()) {
		const headingIndex = section.heading === null ? -1 : headingIndexes.get(section.id);
		if (headingIndex === undefined) {
			parsed[section.id] = "";
			continue;
		}
		const nextSection = REVIEW_OUTPUT_CONTRACT.sections.slice(sectionIndex + 1)
			.find((candidate) => candidate.heading !== null && headingIndexes.has(candidate.id));
		if (section.finalSection && nextSection) return sectionFailure(section, "non-final-section");
		const end = nextSection ? headingIndexes.get(nextSection.id)! : split.bodyLines.length;
		const bodyLines = split.bodyLines.slice(headingIndex + 1, end);
		if (section.finalSection && bodyLines.some((line) => /^##(?:\s|$)/.test(line.trim()))) {
			return sectionFailure(section, "non-final-section");
		}
		const body = bodyLines.join("\n").trim();
		parsed[section.id] = body;
		if (!body && (section.nonEmptyWhen === "always" || section.nonEmptyWhen === split.verdict)) {
			return sectionFailure(section, "empty-section");
		}
	}

	return {
		ok: true,
		verdict: split.verdict,
		sections: parsed,
		reportBody: split.bodyLines.join("\n").trim(),
	};
}

/** Strip a recognized terminal verdict using the contract's verdict grammar. */
export function reviewBodyWithoutVerdict(report: string): string {
	return splitTerminalVerdict(report).bodyLines.join("\n").trim();
}
