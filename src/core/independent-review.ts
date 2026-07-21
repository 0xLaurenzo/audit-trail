import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandRunner } from "./ports.ts";
import {
	buildReviewDocument,
	buildReviewPrompt,
	extractFinalAssistantOutput,
	writeReviewArtifact,
} from "./review.ts";
import type { ReviewMode } from "./types.ts";
import type { AuditWorkflow } from "./workflow.ts";

export interface IndependentReviewInput {
	workflow: AuditWorkflow;
	runner: CommandRunner;
	/** Reviewer as `provider/model`. */
	model: string;
	mode: ReviewMode;
	harnessName: string;
}

export interface IndependentReviewResult {
	reviewPath: string;
	rowCount: number;
}

/**
 * Transcript-less independent review: a no-session `pi` subprocess reads the
 * TSV, Git diff, and repository with read-only tools, and the outcome is
 * recorded as the audit's review checkpoint.
 */
export async function runIndependentReview(input: IndependentReviewInput): Promise<IndependentReviewResult> {
	const { workflow, runner, model, mode } = input;
	const state = await workflow.active();
	if (!state) throw new Error("No audit is active. Start one with audit-trail start <task>.");
	const rows = await workflow.rows(state);
	const prompt = buildReviewPrompt({
		logPath: state.logPath,
		workingDirectory: workflow.root,
		harnessName: input.harnessName,
	});
	const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-review-"));
	try {
		const promptPath = join(tempDir, "reviewer.md");
		await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		const invocation = await runner.exec(
			"pi",
			[
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--model",
				model,
				"--tools",
				"read,grep,find,ls",
				"--append-system-prompt",
				promptPath,
				"Perform the independent audit review now.",
			],
			{ timeout: 10 * 60 * 1000 },
		);
		if (invocation.code !== 0) {
			throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
		}
		const { output, error } = extractFinalAssistantOutput(invocation.stdout);
		if (error) throw new Error(`reviewer model failed: ${error}`);
		if (!output) throw new Error("reviewer produced no final assistant output");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const reviewPath = resolve(workflow.root, ".audit", `${state.task}.review.${stamp}.md`);
		const document = buildReviewDocument({
			model,
			reviewMode: mode,
			logPath: state.logPath,
			workingDirectory: workflow.root,
			rowCount: rows.length,
			output,
			harnessName: input.harnessName,
		});
		await writeReviewArtifact(reviewPath, document);
		await workflow.recordReview({ path: reviewPath, mode, model });
		return { reviewPath, rowCount: rows.length };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}
