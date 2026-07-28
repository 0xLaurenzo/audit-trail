import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Hex } from "./active-state.ts";
import { parseRows } from "./audit-store.ts";
import type { ReviewerPort } from "./ports.ts";
import { buildReviewDocument, buildReviewPrompt, parseReviewVerdict, writeReviewArtifact } from "./review.ts";
import type { ReviewMode, ReviewVerdict } from "./types.ts";
import type { AuditWorkflow } from "./workflow.ts";

export interface IndependentReviewInput {
	workflow: AuditWorkflow;
	/** Reviewer runtime; harness-native or the Pi subprocess fallback. */
	reviewer: ReviewerPort;
	/** Reviewer as `provider/model`. */
	model: string;
	mode: ReviewMode;
	harnessName: string;
	/** Optional session transcript for the reviewer; omitted for transcript-less review. */
	transcriptPath?: string;
}

export interface IndependentReviewResult {
	reviewPath: string;
	rowCount: number;
	verdict: ReviewVerdict;
}

/**
 * Independent review: the reviewer reads the TSV, the Git diff and repository
 * (or a harness transcript when one is supplied), and its explicit verdict is
 * recorded in the audit's review
 * checkpoint. A blocking verdict (or a missing one, which fails closed to
 * block) keeps publish and close gated until findings are addressed and the
 * audit is re-reviewed.
 */
export async function runIndependentReview(input: IndependentReviewInput): Promise<IndependentReviewResult> {
	const { workflow, reviewer, model, mode } = input;
	const state = await workflow.active();
	if (!state) throw new Error("No audit is active. Start one with audit-trail start <task>.");
	// Snapshot the exact bytes under review before the reviewer starts; the
	// checkpoint is recorded against this hash so decisions appended while the
	// reviewer runs cannot be blessed by a review that never saw them.
	const reviewedTsv = await readFile(state.logPath, "utf8");
	const reviewedSha256 = sha256Hex(reviewedTsv);
	const rows = parseRows(reviewedTsv, state.logPath);
	const prompt = buildReviewPrompt({
		logPath: state.logPath,
		transcriptPath: input.transcriptPath,
		workingDirectory: workflow.root,
		harnessName: input.harnessName,
	});
	const output = await reviewer.review({ prompt, model, workingDirectory: workflow.root });
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
	return { reviewPath, rowCount: rows.length, verdict };
}
