import type { ReviewMode } from "./types.ts";

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export interface CommandRunner {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

export const directMutationQueue: MutationQueue = async (_path, operation) => operation();

export interface SessionIdentity {
	harness: string;
	id: string;
	entryId?: string;
	transcriptPath?: string;
}

export interface NotificationPort {
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface ReviewModel {
	provider: string;
	id: string;
}

export interface ModelSelectionPort {
	current(): ReviewModel | undefined;
	available(): Promise<ReviewModel[]>;
}

export interface ReviewerRequest {
	/** Full reviewer instructions, including the verdict contract. */
	prompt: string;
	/** Reviewer as `provider/model`. */
	model: string;
	/** Relationship between the reviewer and working model, recorded in the checkpoint. */
	mode: ReviewMode;
	workingDirectory: string;
	timeoutMs?: number;
}

/**
 * Runs one independent reviewer against the repository and returns its final
 * report. Implementations must not modify the worktree and should fail fast
 * with a clear message when their runtime is unavailable. Harness adapters
 * provide native implementations; `createPiSubprocessReviewer` in
 * src/adapters/pi-reviewer.ts is the subprocess fallback.
 */
export interface ReviewerPort {
	review(request: ReviewerRequest): Promise<string>;
}
