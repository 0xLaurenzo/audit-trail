import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	closeActiveAudit,
	closedStatePath,
	readActiveAudit,
	readClosedAudit,
	reopenClosedAudit,
	sha256Hex,
	writeActiveAudit,
	type ActiveAuditFile,
} from "./active-state.ts";
import { AuditStore, readRows } from "./audit-store.ts";
import { withWorktreeLock, type WorktreeLockOptions } from "./lock.ts";
import { safeSlug } from "./paths.ts";
import { directMutationQueue, type CommandRunner, type SessionIdentity } from "./ports.ts";
import { ensureProvenance } from "./provenance.ts";
import type {
	AuditRow,
	AuditState,
	GitProvenance,
	NewAuditRow,
	ReviewMode,
	ReviewSnapshot,
	ReviewVerdict,
} from "./types.ts";
import { closeBlockers } from "./validation.ts";

export function qualifiedSession(session: SessionIdentity): string {
	return `${session.harness}/${session.id}`;
}

/**
 * Resolve the Git worktree root so "one audit per worktree" holds regardless
 * of the directory a session was started in. Falls back to the given
 * directory outside a Git repository.
 */
export async function resolveWorktreeRoot(runner: CommandRunner, fallback: string): Promise<string> {
	try {
		const result = await runner.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 10_000 });
		const top = result.stdout.trim();
		if (result.code === 0 && top) return top;
	} catch {
		// Git unavailable: treat the fallback directory as the worktree root.
	}
	return fallback;
}

export interface AuditLifecycleResult {
	state: AuditState;
	provenanceError?: string;
}

export interface AppendResult {
	row: AuditRow;
	state: AuditState;
	rows: AuditRow[];
}

export interface CloseAuditResult {
	state: AuditState;
	blockers: string[];
	closed: boolean;
}

/**
 * Harness-neutral audit workflow over shared worktree state. Every mutation
 * (start/resume/reopen, append, review checkpoint, close) runs under the cross-process
 * worktree lock so concurrent harness sessions cannot lose rows, allocate
 * duplicate IDs, or race active-state transitions. CLI, MCP, and harness
 * adapters all drive this same class.
 */
export class AuditWorkflow {
	readonly root: string;
	private readonly runner: CommandRunner;
	private readonly now: () => Date;
	private readonly lockOptions?: WorktreeLockOptions;
	private readonly store: AuditStore;

	constructor(root: string, runner: CommandRunner, now: () => Date = () => new Date(), lockOptions?: WorktreeLockOptions) {
		this.root = root;
		this.runner = runner;
		this.now = now;
		this.lockOptions = lockOptions;
		this.store = new AuditStore(directMutationQueue, this.now);
	}

	private lock<T>(operation: () => Promise<T>): Promise<T> {
		return withWorktreeLock(this.root, operation, this.lockOptions);
	}

	private absolute(path: string): string {
		return isAbsolute(path) ? path : join(this.root, path);
	}

	private relativePath(path: string): string {
		const rel = relative(this.root, path);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
	}

	private async stateFrom(file: ActiveAuditFile): Promise<AuditState> {
		const state: AuditState = {
			task: file.task,
			taskName: file.taskName,
			logPath: this.absolute(file.logPath),
			review: file.review,
		};
		if (file.provenancePath) {
			state.provenancePath = this.absolute(file.provenancePath);
			try {
				const provenance = JSON.parse(await readFile(state.provenancePath, "utf8")) as GitProvenance;
				if (provenance.version === 1) state.provenance = provenance;
			} catch {
				// Unreadable provenance leaves state.provenance undefined.
			}
		}
		return state;
	}

	async active(): Promise<AuditState | undefined> {
		const file = await readActiveAudit(this.root);
		return file ? this.stateFrom(file) : undefined;
	}

	rows(state: AuditState): Promise<AuditRow[]> {
		return readRows(state.logPath);
	}

	async currentSha(state: AuditState): Promise<string | undefined> {
		try {
			return sha256Hex(await readFile(state.logPath, "utf8"));
		} catch (error: any) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private taskIdentity(taskInput: string): { task: string; taskName: string } {
		const taskName = taskInput.trim();
		if (!taskName) throw new Error("Task name must not be empty");
		return { task: safeSlug(taskName, this.now()), taskName };
	}

	private assertTaskIdentity(file: ActiveAuditFile, task: string, taskName: string, operation: string): void {
		if (file.task !== task) {
			throw new Error(`Cannot ${operation} ${taskName}: the audit task is ${file.taskName ?? file.task}.`);
		}
		if (!file.taskName) {
			throw new Error(`Cannot ${operation} legacy audit ${file.task}: its original task name was not recorded.`);
		}
		if (file.taskName !== taskName) {
			throw new Error(
				`Task name collision: ${JSON.stringify(taskName)} and ${JSON.stringify(file.taskName)} both map to ${task}.`,
			);
		}
	}

	private async retryProvenance(
		file: ActiveAuditFile,
		session: SessionIdentity,
	): Promise<{ file: ActiveAuditFile; provenanceError?: string }> {
		if (file.provenancePath) return { file };
		const provenanceRel = join(".audit", `${file.task}.provenance.json`);
		try {
			await ensureProvenance(this.runner, file.task, qualifiedSession(session), this.absolute(provenanceRel));
			const updated = { ...file, provenancePath: provenanceRel };
			await writeActiveAudit(this.root, updated);
			return { file: updated };
		} catch (error: any) {
			return { file, provenanceError: String(error?.message ?? error) };
		}
	}

	async start(taskInput: string, session: SessionIdentity): Promise<AuditLifecycleResult> {
		const { task, taskName } = this.taskIdentity(taskInput);
		return this.lock(async () => {
			const existing = await readActiveAudit(this.root);
			if (existing) {
				if (existing.task === task && existing.taskName && existing.taskName !== taskName) {
					this.assertTaskIdentity(existing, task, taskName, "start");
				}
				throw new Error(
					existing.task === task && existing.taskName === taskName
						? `Audit ${JSON.stringify(taskName)} is already active. Use resume instead of start.`
						: `Another audit is already active in this worktree: ${existing.taskName ?? existing.task}. Close it before starting ${taskName}.`,
				);
			}

			const closed = await readClosedAudit(this.root, task);
			if (closed) {
				this.assertTaskIdentity(closed, task, taskName, "start");
				throw new Error(`Audit ${JSON.stringify(taskName)} is closed. Use reopen instead of start.`);
			}

			const logRel = join(".audit", `${task}.tsv`);
			const provenanceRel = join(".audit", `${task}.provenance.json`);
			for (const artifact of [logRel, provenanceRel]) {
				try {
					await access(this.absolute(artifact));
					throw new Error(`Cannot start ${JSON.stringify(taskName)}: existing artifact has no lifecycle state: ${artifact}`);
				} catch (error: any) {
					if (error?.code !== "ENOENT") throw error;
				}
			}

			let provenanceError: string | undefined;
			let hasProvenance = false;
			try {
				await ensureProvenance(this.runner, task, qualifiedSession(session), this.absolute(provenanceRel));
				hasProvenance = true;
			} catch (error: any) {
				provenanceError = String(error?.message ?? error);
			}
			try {
				await this.store.createLog(this.absolute(logRel));
			} catch (error) {
				// Provenance may have been captured immediately before a racing log
				// appeared. Leave both artifacts visible and fail rather than attach.
				throw error;
			}
			const file: ActiveAuditFile = {
				version: 2,
				task,
				taskName,
				logPath: logRel,
				provenancePath: hasProvenance ? provenanceRel : undefined,
				startedAt: this.now().toISOString(),
			};
			await writeActiveAudit(this.root, file);
			return { state: await this.stateFrom(file), provenanceError };
		});
	}

	async resume(taskInput: string, session: SessionIdentity): Promise<AuditLifecycleResult> {
		const { task, taskName } = this.taskIdentity(taskInput);
		return this.lock(async () => {
			const existing = await readActiveAudit(this.root);
			if (!existing) throw new Error(`No audit is active. Start ${JSON.stringify(taskName)} instead.`);
			this.assertTaskIdentity(existing, task, taskName, "resume");
			const result = await this.retryProvenance(existing, session);
			return { state: await this.stateFrom(result.file), provenanceError: result.provenanceError };
		});
	}

	async reopen(taskInput: string, session: SessionIdentity): Promise<AuditLifecycleResult> {
		const { task, taskName } = this.taskIdentity(taskInput);
		return this.lock(async () => {
			const active = await readActiveAudit(this.root);
			if (active) {
				throw new Error(`Cannot reopen ${JSON.stringify(taskName)} while ${active.taskName ?? active.task} is active.`);
			}
			const closed = await readClosedAudit(this.root, task);
			if (!closed) throw new Error(`No closed audit found for ${JSON.stringify(taskName)}.`);
			this.assertTaskIdentity(closed, task, taskName, "reopen");
			const reopened = await reopenClosedAudit(this.root, closed, this.now().toISOString());
			const result = await this.retryProvenance(reopened, session);
			return { state: await this.stateFrom(result.file), provenanceError: result.provenanceError };
		});
	}

	async append(session: SessionIdentity, input: Omit<NewAuditRow, "session" | "entry">): Promise<AppendResult> {
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active. Start one with audit-start <task>.");
			const state = await this.stateFrom(file);
			const row = await this.store.appendRow(state.logPath, {
				...input,
				session: qualifiedSession(session),
				entry: session.entryId ?? "none",
			});
			return { row, state, rows: await readRows(state.logPath) };
		});
	}

	async recordReview(input: {
		path: string;
		mode: ReviewMode;
		model: string;
		/** SHA-256 of the exact TSV bytes the reviewer was given. */
		expectedSha256: string;
		/** Reviewer's explicit conclusion; only "approve" unblocks publish/close. */
		verdict: ReviewVerdict;
	}): Promise<ReviewSnapshot> {
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			const raw = await readFile(this.absolute(file.logPath), "utf8");
			// Compare-and-swap: the checkpoint may only bless the bytes the
			// reviewer actually read. A concurrent append while the reviewer was
			// running must invalidate this review, not be blessed by it.
			if (sha256Hex(raw) !== input.expectedSha256) {
				throw new Error("The audit gained new decisions while the review was running. Re-run the review.");
			}
			const snapshot: ReviewSnapshot = {
				path: this.relativePath(input.path),
				sha256: input.expectedSha256,
				mode: input.mode,
				model: input.model,
				at: this.now().toISOString(),
				verdict: input.verdict,
			};
			await writeActiveAudit(this.root, { ...file, review: snapshot });
			return snapshot;
		});
	}

	async close(): Promise<CloseAuditResult> {
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			const state = await this.stateFrom(file);
			const rows = await readRows(state.logPath);
			const blockers = closeBlockers(state, rows, await this.currentSha(state));
			if (blockers.length) return { state, blockers, closed: false };
			if (await readClosedAudit(this.root, file.task)) {
				throw new Error(`Closed lifecycle state already exists: ${closedStatePath(this.root, file.task)}`);
			}
			await closeActiveAudit(this.root, file, this.now().toISOString());
			return { state, blockers: [], closed: true };
		});
	}
}
