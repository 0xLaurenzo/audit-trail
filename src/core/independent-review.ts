import { copyFile, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { sha256Hex } from "./active-state.ts";
import { parseRows } from "./audit-store.ts";
import type { ReviewerPort } from "./ports.ts";
import type { ReviewCandidate } from "./reviewer-candidates.ts";
import { parseReviewOutput } from "./review-output.ts";
import { buildReviewDocument, buildReviewPrompt, writeReviewArtifact } from "./review.ts";
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
	/** Full raw reviewer output; callers render a bounded findings excerpt. */
	report: string;
	/** Mandatory structured evaluation parsed from the completed report. */
	designFriction: string;
}

/**
 * Reduce arbitrary provider/runtime errors to safe diagnostic categories.
 * Reviewer ports may include raw stderr in thrown errors, so never copy the
 * original message into the aggregate where credentials, account metadata,
 * request IDs, or other sensitive provider details could be exposed.
 */
export function summarizeReviewerFailure(error: unknown): string {
	const message = String((error as any)?.message ?? error).toLowerCase();
	if (/rate[ -]?limit|too many requests|\b429\b/.test(message)) return "reviewer was rate limited";
	if (/quota|usage[ -]?limit|credit|billing|insufficient funds/.test(message)) return "reviewer usage or quota limit reached";
	if (/timed? ?out|timeout|deadline exceeded|\betimedout\b/.test(message)) return "reviewer timed out";
	if (/unauthori[sz]ed|forbidden|authentication|api[ _-]?key|credential|\b401\b|\b403\b/.test(message)) {
		return "reviewer authentication failed";
	}
	if (/enoent|not found|is required.*unavailable|cannot find/.test(message)) return "reviewer runtime is unavailable";
	if (/no (?:final assistant )?output|produced no output/.test(message)) return "reviewer produced no output";
	if (/before agent_settled|incomplete|truncated|unexpected end/.test(message)) return "reviewer terminal output was incomplete";
	if (/network|transport|connection|connect|socket|websocket|outage|unavailable|provider/.test(message)) {
		return "reviewer provider or transport failed";
	}
	const exitCode = /(?:exited|exit) with code (\d+)/.exec(message)?.[1];
	return exitCode ? `reviewer execution failed (exit ${exitCode})` : "reviewer execution failed";
}

/**
 * Independent review: the reviewer reads the TSV, the Git diff and repository
 * (or a harness transcript when one is supplied), and its explicit verdict is
 * recorded in the audit's review
 * checkpoint. Every completed report also contains a validated, non-empty
 * design-friction evaluation. A blocking verdict keeps publish and close gated
 * until findings are addressed and the audit is re-reviewed; a missing or
 * malformed evaluation or verdict is an invalid attempt that advances to the
 * next candidate.
 *
 * Candidates are attempted in order, at most once each. An attempt fails
 * when the reviewer runtime throws (quota/rate limits, provider or transport
 * errors, timeouts, empty or incomplete terminal output) or returns output
 * that violates the review-output contract; the next candidate is then tried,
 * and failed attempts write no artifact and record no checkpoint. A completed
 * review with an explicit verdict is terminal regardless of verdict:
 * `VERDICT: block` never triggers fallback. If every candidate fails, the
 * error summarizes each attempted model using a safe failure category.
 */
export async function runIndependentReview(input: IndependentReviewInput): Promise<IndependentReviewResult> {
	const { workflow, reviewer, candidates } = input;
	if (!candidates.length) throw new Error("No reviewer candidates are available.");
	const state = await workflow.active();
	if (!state) throw new Error("No audit is active. Start one with audit-trail start <task>.");
	// Snapshot the transcript like the TSV bytes: harness session files keep
	// growing while the reviewer runs, so the reviewer must read immutable
	// evidence. An unreadable transcript falls back to transcript-less review.
	let transcriptPath: string | undefined;
	if (input.transcriptPath) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const snapshot = resolve(workflow.root, ".audit", `${state.task}.review-transcript.${stamp}${extname(input.transcriptPath)}`);
		try {
			await copyFile(input.transcriptPath, snapshot);
			transcriptPath = snapshot;
		} catch {
			transcriptPath = undefined;
		}
	}
	const prompt = buildReviewPrompt({
		logPath: state.logPath,
		transcriptPath,
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
			const summary = summarizeReviewerFailure(error);
			failures.push({ candidate, error: summary });
			input.onAttemptFailure?.(candidate, summary);
			continue;
		}
		// Parse and validate the complete terminal-output contract once. Invalid
		// attempts fail closed and advance fallback without writing an artifact or
		// checkpoint; a valid block is terminal because the schema also requires
		// its audit-findings section to be non-empty.
		const parsed = parseReviewOutput(output);
		if (!parsed.ok) {
			failures.push({ candidate, error: parsed.failureSummary });
			input.onAttemptFailure?.(candidate, parsed.failureSummary);
			continue;
		}
		const { verdict, sections: { designFriction } } = parsed;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const reviewPath = resolve(workflow.root, ".audit", `${state.task}.review.${stamp}.md`);
		const document = buildReviewDocument({
			model,
			reviewMode: mode,
			logPath: state.logPath,
			transcriptPath,
			workingDirectory: workflow.root,
			rowCount: rows.length,
			output,
			harnessName: input.harnessName,
			verdict,
		});
		await writeReviewArtifact(reviewPath, document);
		await workflow.recordReview({ path: reviewPath, mode, model, expectedSha256: reviewedSha256, verdict });
		return { reviewPath, rowCount: rows.length, verdict, model, mode, report: output, designFriction };
	}
	throw new Error(
		`All reviewer candidates failed:\n${failures
			.map(({ candidate, error }) => `- ${candidate.model} (${candidate.mode}): ${error}`)
			.join("\n")}`,
	);
}
