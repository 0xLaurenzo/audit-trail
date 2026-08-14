import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath } from "./paths.ts";
import { directMutationQueue, type MutationQueue } from "./ports.ts";
import { buildReviewOutputInstructions, reviewBodyWithoutVerdict } from "./review-output.ts";
import type { ReviewMode, ReviewVerdict } from "./types.ts";

export interface ReviewPromptInput {
	logPath: string;
	/** Optional: some harnesses have no stable transcript format. */
	transcriptPath?: string;
	workingDirectory: string;
	harnessName?: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	const harness = input.harnessName ?? "pi";
	const sources = `the append-only TSV decision log, the Git diff against the audit's starting commit, and the repository${
		input.transcriptPath ? `, using the ${harness} JSONL session transcript as supplementary evidence` : ""
	}`;
	const evidenceAnchor = input.transcriptPath ? "repository evidence and transcript moments" : "repository evidence";
	const sessionLine = input.transcriptPath
		? `\n${harness === "pi" ? "Pi session" : `${harness} session`}: ${input.transcriptPath}`
		: "";
	// Self-reference invariant: the reviewer's own invocation is necessarily
	// visible in its evidence without a completion result, and prior blocked
	// review artifacts stay visible after their findings are addressed. Without
	// this clause reviewers block on their own reflection in a loop (issue #47).
	const selfReference = `You are the re-review: a prior blocked review artifact whose findings have since been addressed is not itself a blocking finding, because the required follow-up review is the one you are performing now. Judge the current audit rows, diff, and repository state.${
		input.transcriptPath
			? " The session transcript may end with the audit_review invocation that launched you still running, followed by polling or wait events. That is expected \u2014 you are producing that invocation's verdict \u2014 so the current invocation's missing completion result is never evidence of an incomplete review lifecycle."
			: ""
	}`;
	return `You are an independent decision-trail reviewer. Do not redo a general line-by-line code review. Read ${sources}, then report only what a human should scrutinize. Check that logged rows map to real actions, evidence supports claims, consequential forks or pivots were not omitted, verification was not overstated, and choices are general rather than merely sufficient for the observed case. Flag weak evidence, skipped verification, symptom patches, unjustified assumptions, scope creep, and unresolved uncertainty. Point to exact decision IDs and ${evidenceAnchor}. Never modify files.\n\n${selfReference}\n\n${buildReviewOutputInstructions()}\n\nAudit log: ${input.logPath}${sessionLine}\nWorking directory: ${input.workingDirectory}`;
}

export interface ReviewDocumentInput {
	model: string;
	reviewMode?: ReviewMode;
	logPath: string;
	transcriptPath?: string;
	workingDirectory: string;
	rowCount: number;
	output: string;
	harnessName?: string;
	verdict?: ReviewVerdict;
}

export function buildReviewDocument(input: ReviewDocumentInput): string {
	const sessionLabel = input.harnessName === undefined || input.harnessName === "pi" ? "Pi session" : `${input.harnessName} session`;
	const modeLine = input.reviewMode ? `\n- Review mode: ${input.reviewMode}` : "";
	const sessionLine = input.transcriptPath ? `\n- ${sessionLabel}: ${input.transcriptPath}` : "";
	const verdictLine = input.verdict ? `\n- Verdict: ${input.verdict}` : "";
	return `# Decision audit review\n\n- Reviewed by: ${input.model}${modeLine}${verdictLine}\n- Audit log: ${displayPath(input.logPath, input.workingDirectory)}${sessionLine}\n- Decision rows reviewed: ${input.rowCount}\n\n${input.output.trim()}\n`;
}

export interface ReviewFindingsExcerpt {
	text: string;
	truncated: boolean;
}

/** Strip the redundant terminal verdict without altering artifact content. */
export function reviewFindingsBody(report: string): string {
	return reviewBodyWithoutVerdict(report);
}

/**
 * Render the reviewer's report body for inline feedback. The terminal verdict
 * is already represented by the surrounding result and is deliberately
 * excluded. Truncation prefers a line boundary; an exceptionally long first
 * line is cut only to enforce the bound and is always accompanied by an
 * explicit truncation notice from formatBlockingReviewMessage.
 */
export function reviewFindingsExcerpt(report: string, maxChars: number): ReviewFindingsExcerpt {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
	const findings = reviewFindingsBody(report);
	if (findings.length <= maxChars) return { text: findings, truncated: false };
	const boundary = findings.lastIndexOf("\n", maxChars);
	const end = boundary > 0 ? boundary : maxChars;
	return { text: findings.slice(0, end).trimEnd(), truncated: true };
}

export function formatBlockingReviewMessage(report: string, reviewPath: string, maxChars: number): string {
	const excerpt = reviewFindingsExcerpt(report, maxChars);
	const findings = excerpt.text || "(The reviewer supplied no findings text.)";
	const trailer = excerpt.truncated ? "\n\nInline findings were truncated; see the review artifact for the full report." : "";
	return `Review blocked the audit: ${reviewPath} — publish and close stay gated until findings are addressed and it is re-reviewed.\n\nReviewer findings:\n${findings}${trailer}`;
}

export function writeReviewArtifact(
	reviewPath: string,
	document: string,
	mutationQueue: MutationQueue = directMutationQueue,
): Promise<void> {
	return mutationQueue(reviewPath, async () => {
		await mkdir(dirname(reviewPath), { recursive: true });
		await writeFile(reviewPath, document, { encoding: "utf8", mode: 0o600 });
	});
}
