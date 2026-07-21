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

export interface ReviewRequest {
	model: ReviewModel;
	promptPath: string;
	workingDirectory: string;
}

export interface ReviewerPort {
	review(request: ReviewRequest): Promise<string>;
}
