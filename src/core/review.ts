import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath } from "./paths.ts";
import { directMutationQueue, type MutationQueue } from "./ports.ts";

export interface ReviewPromptInput {
	logPath: string;
	transcriptPath: string;
	workingDirectory: string;
	harnessName?: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	const harness = input.harnessName ?? "pi";
	return `You are an independent decision-trail reviewer. Do not redo a general line-by-line code review. Read the append-only TSV decision log and the ${harness} JSONL session transcript, then report only what a human should scrutinize. Check that logged rows map to real actions, evidence supports claims, consequential forks or pivots were not omitted, verification was not overstated, and choices are general rather than merely sufficient for the observed case. Flag weak evidence, skipped verification, symptom patches, unjustified assumptions, scope creep, and unresolved uncertainty. Point to exact decision IDs and transcript moments. A concise "No flags" is valid. Never modify files.\n\nAudit log: ${input.logPath}\n${harness === "pi" ? "Pi session" : `${harness} session`}: ${input.transcriptPath}\nWorking directory: ${input.workingDirectory}`;
}

export interface ReviewDocumentInput {
	model: string;
	logPath: string;
	transcriptPath: string;
	workingDirectory: string;
	rowCount: number;
	output: string;
	harnessName?: string;
}

export function buildReviewDocument(input: ReviewDocumentInput): string {
	const sessionLabel = input.harnessName === undefined || input.harnessName === "pi" ? "Pi session" : `${input.harnessName} session`;
	return `# Decision audit review\n\n- Reviewed by: ${input.model}\n- Audit log: ${displayPath(input.logPath, input.workingDirectory)}\n- ${sessionLabel}: ${input.transcriptPath}\n- Decision rows reviewed: ${input.rowCount}\n\n${input.output.trim()}\n`;
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
