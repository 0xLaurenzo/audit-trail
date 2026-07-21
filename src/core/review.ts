import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath } from "./paths.ts";
import { directMutationQueue, type MutationQueue } from "./ports.ts";
import type { ReviewMode } from "./types.ts";

export interface ReviewPromptInput {
	logPath: string;
	/** Optional: some harnesses have no stable transcript format. */
	transcriptPath?: string;
	workingDirectory: string;
	harnessName?: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	const harness = input.harnessName ?? "pi";
	const sources = input.transcriptPath
		? `the append-only TSV decision log and the ${harness} JSONL session transcript`
		: "the append-only TSV decision log, the Git diff against the audit's starting commit, and the repository";
	const evidenceAnchor = input.transcriptPath ? "transcript moments" : "repository evidence";
	const sessionLine = input.transcriptPath
		? `\n${harness === "pi" ? "Pi session" : `${harness} session`}: ${input.transcriptPath}`
		: "";
	return `You are an independent decision-trail reviewer. Do not redo a general line-by-line code review. Read ${sources}, then report only what a human should scrutinize. Check that logged rows map to real actions, evidence supports claims, consequential forks or pivots were not omitted, verification was not overstated, and choices are general rather than merely sufficient for the observed case. Flag weak evidence, skipped verification, symptom patches, unjustified assumptions, scope creep, and unresolved uncertainty. Point to exact decision IDs and ${evidenceAnchor}. A concise "No flags" is valid. Never modify files.\n\nAudit log: ${input.logPath}${sessionLine}\nWorking directory: ${input.workingDirectory}`;
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
}

export function buildReviewDocument(input: ReviewDocumentInput): string {
	const sessionLabel = input.harnessName === undefined || input.harnessName === "pi" ? "Pi session" : `${input.harnessName} session`;
	const modeLine = input.reviewMode ? `\n- Review mode: ${input.reviewMode}` : "";
	const sessionLine = input.transcriptPath ? `\n- ${sessionLabel}: ${input.transcriptPath}` : "";
	return `# Decision audit review\n\n- Reviewed by: ${input.model}${modeLine}\n- Audit log: ${displayPath(input.logPath, input.workingDirectory)}${sessionLine}\n- Decision rows reviewed: ${input.rowCount}\n\n${input.output.trim()}\n`;
}

/** Extract the final assistant text from a `pi --mode json` stdout stream. */
export function extractFinalAssistantOutput(stdout: string): { output: string; error?: string } {
	let output = "";
	let error: string | undefined;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			if (event.message.stopReason === "error") {
				error = event.message.errorMessage || "assistant message ended with an error";
			}
			const text = (event.message.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			if (text) output = text;
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return { output, error };
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
