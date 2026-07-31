import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Hex } from "./active-state.ts";
import { parseRows } from "./audit-store.ts";
import type { ReviewerPort } from "./ports.ts";
import type { ReviewCandidate } from "./reviewer-candidates.ts";
import { buildReviewDocument, buildReviewPrompt, parseReviewVerdict, writeReviewArtifact } from "./review.ts";
import type { ReviewMode, ReviewVerdict } from "./types.ts";
import type { AuditWorkflow } from "./workflow.ts";

export interface IndependentReviewInput {
	workflow: AuditWorkflow;
	/** Reviewer runtime; harness-native or the Pi subprocess fallback. */
	reviewer: ReviewerPort;
	/**
	 * Ordered reviewer attempts. Explicit model requests pass exactly one
	 * candidate and therefore never fall back; automatic selection passes the
	 * full tier ordering from buildReviewerCandidates.
	 */
	candidates: ReviewCandidate[];
	harnessName: string;
	/** Optional session transcript for the reviewer; omitted for transcript-less review. */
	transcriptPath?: string;
	/** UI hook fired before each reviewer attempt. */
	onAttempt?: (candidate: ReviewCandidate) => void;
	/** UI hook fired when an attempt fails and fallback continues. */
	onAttemptFailure?: (candidate: ReviewCandidate, error: string) => void;
}

export interface IndependentReviewResult {
	reviewPath: string;
	rowCount: number;
	verdict: ReviewVerdict;
	/** The reviewer that actually completed the review, as `provider/model`. */
	model: string;
	/** The completed reviewer's truthful relation to the working model. */
	mode: ReviewMode;
}

/** Single-line, bounded failure summary; never includes environment or credentials. */
function sanitizeFailure(error: unknown): string {
	const message = String((error as any)?.message ?? error).replace(/\s+/g, " ").trim();
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Independent review: the reviewer reads the TSV, the Git diff and repository
 * (or a harness transcript when one is supplied), and its explicit verdict is
 * recorded in the audit's review
 * checkpoint. A blocking verdict (or a missing one, which fails closed to
 * block) keeps publish and close gated until findings are addressed and the
 * audit is re-reviewed.
 *
 * Candidates are attempted in order, at most once each. An attempt fails
 * exactly when the reviewer runtime throws (quota/rate limits, provider or
 * transport errors, timeouts, empty or incomplete terminal output — the
 * reviewer ports raise all of these); the next candidate is then tried, and
 * failed attempts write no artifact and record no checkpoint. A completed
 * review is terminal regardless of verdict: `VERDICT: block` never triggers
 * fallback. If every candidate fails, the error summarizes each attempted
 * model and its sanitized failure.
 */
export async function runIndependentReview(input: IndependentReviewInput): Promise<IndependentReviewResult> {
	const { workflow, reviewer, candidates } = input;
	if (!candidates.length) throw new Error("No reviewer candidates are available.");
	const state = await workflow.active();
	if (!state) throw new Error("No audit is active. Start one with audit-trail start <task>.");
	const prompt = buildReviewPrompt({
		logPath: state.logPath,
		transcriptPath: input.transcriptPath,
		workingDirectory: workflow.root,
		harnessName: input.harnessName,
	});
	const failures: { candidate: ReviewCandidate; error: string }[] = [];
	for (const candidate of candidates) {
		const { model, mode } = candidate;
		// Snapshot the exact bytes under review before each attempt starts; the
		// checkpoint is recorded against this hash so decisions appended while
		// the reviewer runs cannot be blessed by a review that never saw them.
		const reviewedTsv = await readFile(state.logPath, "utf8");
		const reviewedSha256 = sha256Hex(reviewedTsv);
		const rows = parseRows(reviewedTsv, state.logPath);
		input.onAttempt?.(candidate);
		let output: string;
		try {
			output = await reviewer.review({ prompt, model, mode, workingDirectory: workflow.root });
		} catch (error) {
			const sanitized = sanitizeFailure(error);
			failures.push({ candidate, error: sanitized });
			input.onAttemptFailure?.(candidate, sanitized);
			continue;
		}
		// Fail closed: a review without an explicit verdict certifies nothing.
		const verdict = parseReviewVerdict(output) ?? "block";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const reviewPath = resolve(workflow.root, ".audit", `${state.task}.review.${stamp}.md`);
		const document = buildReviewDocument({
			model,
			reviewMode: mode,
			logPath: state.logPath,
			transcriptPath: input.transcriptPath,
			workingDirectory: workflow.root,
			rowCount: rows.length,
			output,
			harnessName: input.harnessName,
			verdict,
		});
		await writeReviewArtifact(reviewPath, document);
		await workflow.recordReview({ path: reviewPath, mode, model, expectedSha256: reviewedSha256, verdict });
		return { reviewPath, rowCount: rows.length, verdict, model, mode };
	}
	throw new Error(
		`All reviewer candidates failed:\n${failures
			.map(({ candidate, error }) => `- ${candidate.model} (${candidate.mode}): ${error}`)
			.join("\n")}`,
	);
}
