import { randomUUID } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	abandonActiveAudit,
	abandonedStatePath,
	closeActiveAudit,
	closedStatePath,
	readAbandonedAudit,
	readActiveAudit,
	readClosedAudit,
	reopenAbandonedAudit,
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
	AbandonmentRecord,
	AuditRow,
	AuditState,
	GitProvenance,
	NewAuditRow,
	ReviewMode,
	ReviewSnapshot,
	ReviewVerdict,
	RolloverLink,
} from "./types.ts";
import { closeBlockers, summarize } from "./validation.ts";

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

export interface AbandonResult {
	/** The archived audit's state at abandonment. */
	state: AuditState;
	record: AbandonmentRecord;
	/** Terminal artifact holding the abandonment record. */
	abandonedPath: string;
}

export interface AbandonedAuditSummary {
	task: string;
	taskName?: string;
	/** Timestamp of the most recent abandonment record. */
	at?: string;
}

export interface RolloverResult extends AuditLifecycleResult {
	/** Slug of the archived predecessor audit. */
	abandonedTask: string;
	/** Terminal artifact holding the predecessor's abandonment record. */
	abandonedPath: string;
	link: RolloverLink;
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
			auditId: file.auditId,
			logPath: this.absolute(file.logPath),
			review: file.review,
			rolloverFrom: file.rolloverFrom,
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

	private collisionError(taskName: string, existingName: string, task: string): Error {
		return new Error(
			`Task name collision: ${JSON.stringify(taskName)} and ${JSON.stringify(existingName)} both map to ${task}.`,
		);
	}

	private assertTaskIdentity(file: ActiveAuditFile, task: string, taskName: string, operation: string): void {
		if (file.task !== task) {
			throw new Error(`Cannot ${operation} ${taskName}: the audit task is ${file.taskName ?? file.task}.`);
		}
		if (!file.taskName) {
			throw new Error(`Cannot ${operation} legacy audit ${file.task}: its original task name was not recorded.`);
		}
		if (file.taskName !== taskName) throw this.collisionError(taskName, file.taskName, task);
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
				if (existing.task === task && existing.taskName === taskName) {
					throw new Error(`Audit ${JSON.stringify(taskName)} is already active. Use resume instead of start.`);
				}
				if (existing.task === task && existing.taskName) {
					throw this.collisionError(taskName, existing.taskName, task);
				}
				throw new Error(
					`Another audit is already active in this worktree: ${existing.taskName ?? existing.task}. Close it before starting ${taskName}.`,
				);
			}

			return this.createAudit(task, taskName, session);
		});
	}

	/** Reject task slugs already owned by closed, abandoned, or orphaned artifacts. */
	private async assertTaskAvailable(task: string, taskName: string): Promise<void> {
		const closed = await readClosedAudit(this.root, task);
		if (closed) {
			this.assertTaskIdentity(closed, task, taskName, "start");
			throw new Error(`Audit ${JSON.stringify(taskName)} is closed. Use reopen instead of start.`);
		}
		const abandoned = await readAbandonedAudit(this.root, task);
		if (abandoned) {
			this.assertTaskIdentity(abandoned, task, taskName, "start");
			throw new Error(`Audit ${JSON.stringify(taskName)} is abandoned. Use reopen instead of start.`);
		}
		for (const artifact of [join(".audit", `${task}.tsv`), join(".audit", `${task}.provenance.json`)]) {
			try {
				await access(this.absolute(artifact));
				throw new Error(`Cannot start ${JSON.stringify(taskName)}: existing artifact has no lifecycle state: ${artifact}`);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
	}

	/** Shared creation body for start and rollover; must run under the lock. */
	private async createAudit(
		task: string,
		taskName: string,
		session: SessionIdentity,
		rolloverFrom?: RolloverLink,
	): Promise<AuditLifecycleResult> {
		await this.assertTaskAvailable(task, taskName);
		const logRel = join(".audit", `${task}.tsv`);
		const provenanceRel = join(".audit", `${task}.provenance.json`);
		let provenanceError: string | undefined;
		let hasProvenance = false;
		try {
			await ensureProvenance(this.runner, task, qualifiedSession(session), this.absolute(provenanceRel));
			hasProvenance = true;
		} catch (error: any) {
			provenanceError = String(error?.message ?? error);
		}
		// If a racing log appeared after the orphan check, createLog fails and
		// leaves both artifacts visible rather than attaching to them.
		await this.store.createLog(this.absolute(logRel));
		const file: ActiveAuditFile = {
			version: 2,
			task,
			taskName,
			auditId: randomUUID(),
			logPath: logRel,
			provenancePath: hasProvenance ? provenanceRel : undefined,
			startedAt: this.now().toISOString(),
			rolloverFrom,
		};
		await writeActiveAudit(this.root, file);
		return { state: await this.stateFrom(file), provenanceError };
	}

	/**
	 * True when the audit's immutable start commit is provably no longer an
	 * ancestor of the worktree HEAD (a rebase rewrote the range). Undefined when
	 * there is no provenance or Git cannot answer; callers must not treat
	 * undefined as diverged.
	 */
	async provenanceDiverged(state: AuditState): Promise<boolean | undefined> {
		if (!state.provenance) return undefined;
		try {
			const result = await this.runner.exec(
				"git",
				["merge-base", "--is-ancestor", state.provenance.startCommit, "HEAD"],
				{ timeout: 10_000 },
			);
			if (result.code === 0) return false;
			if (result.code === 1) return true;
			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Explicit rebase rollover: archive the ancestry-diverged active audit as an
	 * immutable abandoned segment and start a linked successor with fresh
	 * provenance at the current HEAD. Refuses while the start commit still
	 * descends into HEAD — a publishable audit must publish and close normally.
	 * Never rewrites the predecessor's TSV, provenance, or review artifacts.
	 */
	async rollover(
		taskInput: string,
		session: SessionIdentity,
		reason: string,
		successorInput?: string,
	): Promise<RolloverResult> {
		const { task, taskName } = this.taskIdentity(taskInput);
		const trimmedReason = reason.trim();
		if (!trimmedReason) throw new Error("Rollover requires a non-empty reason");
		const successor = this.taskIdentity(successorInput?.trim() || `${taskName} (rebased)`);
		if (successor.task === task) {
			throw new Error(`Successor task ${JSON.stringify(successor.taskName)} maps to the same slug as the audit being rolled over.`);
		}
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			this.assertTaskIdentity(file, task, taskName, "roll over");
			const state = await this.stateFrom(file);
			if (!state.provenance) {
				throw new Error("This audit has no Git provenance; rollover requires a recorded start commit.");
			}
			const diverged = await this.provenanceDiverged(state);
			if (diverged === false) {
				throw new Error(
					`Start commit ${state.provenance.startCommit.slice(0, 12)} is still an ancestor of HEAD; publish and close this audit normally instead of rolling over.`,
				);
			}
			if (diverged === undefined) {
				throw new Error(
					"Could not verify ancestry against HEAD (Git unavailable or start commit unknown); rollover refuses to archive a possibly publishable audit.",
				);
			}
			const record = await this.buildAbandonmentRecord(file, state, session, trimmedReason);
			const link: RolloverLink = {
				auditId: file.auditId,
				task: file.task,
				taskName: file.taskName,
				startCommit: state.provenance.startCommit,
				head: record.head ?? "unknown",
				abandonedAt: record.at,
			};
			// Verify the successor slug is claimable before archiving the
			// predecessor, so a name collision cannot strand the worktree between
			// audits. A later createAudit failure still leaves the predecessor
			// safely archived and the successor startable manually.
			await this.assertTaskAvailable(successor.task, successor.taskName);
			await abandonActiveAudit(this.root, file, record);
			const result = await this.createAudit(successor.task, successor.taskName, session, link);
			return {
				...result,
				abandonedTask: file.task,
				abandonedPath: abandonedStatePath(this.root, file.task),
				link,
			};
		});
	}

	/**
	 * Return the audit's stable identity, minting and persisting one for state
	 * created before identities existed. Runs under the worktree lock so two
	 * concurrent publishers agree on a single identity.
	 */
	async ensureAuditId(): Promise<string> {
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			if (file.auditId) return file.auditId;
			const auditId = randomUUID();
			await writeActiveAudit(this.root, { ...file, auditId });
			return auditId;
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
			const abandoned = closed ? undefined : await readAbandonedAudit(this.root, task);
			const terminal = closed ?? abandoned;
			if (!terminal) throw new Error(`No closed or abandoned audit found for ${JSON.stringify(taskName)}.`);
			this.assertTaskIdentity(terminal, task, taskName, "reopen");
			// Reopening from abandoned retains the append-only abandonment records.
			const reopened = closed
				? await reopenClosedAudit(this.root, closed, this.now().toISOString())
				: await reopenAbandonedAudit(this.root, abandoned!, this.now().toISOString());
			const result = await this.retryProvenance(reopened, session);
			return { state: await this.stateFrom(result.file), provenanceError: result.provenanceError };
		});
	}

	/** Best-effort worktree facts plus audit state for a truthful terminal record. */
	private async buildAbandonmentRecord(
		file: ActiveAuditFile,
		state: AuditState,
		session: SessionIdentity,
		reason: string,
	): Promise<AbandonmentRecord> {
		const headResult = await this.runner.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000 });
		const branchResult = await this.runner.exec("git", ["branch", "--show-current"], { timeout: 10_000 });
		const rows = await readRows(state.logPath);
		return {
			at: this.now().toISOString(),
			reason,
			session: qualifiedSession(session),
			branch: (branchResult.code === 0 && branchResult.stdout.trim()) || undefined,
			head: (headResult.code === 0 && headResult.stdout.trim()) || undefined,
			unresolvedIds: summarize(rows).unresolved.map((row) => row.id),
			review: file.review?.verdict ?? "none",
		};
	}

	/**
	 * Explicit terminal abandonment for an audit that cannot satisfy the normal
	 * review-and-publish path. No close blockers apply: the record truthfully
	 * states that review approval and publication did not complete. TSV,
	 * provenance, and review artifacts are preserved unchanged; reopen restores
	 * the audit while retaining every abandonment record.
	 */
	async abandon(taskInput: string, session: SessionIdentity, reason: string): Promise<AbandonResult> {
		const { task, taskName } = this.taskIdentity(taskInput);
		const trimmedReason = reason.trim();
		if (!trimmedReason) throw new Error("Abandon requires a non-empty reason");
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			this.assertTaskIdentity(file, task, taskName, "abandon");
			if (await readAbandonedAudit(this.root, file.task)) {
				throw new Error(`Abandoned lifecycle state already exists: ${abandonedStatePath(this.root, file.task)}`);
			}
			const state = await this.stateFrom(file);
			const record = await this.buildAbandonmentRecord(file, state, session, trimmedReason);
			await abandonActiveAudit(this.root, file, record);
			return { state, record, abandonedPath: abandonedStatePath(this.root, file.task) };
		});
	}

	/** Abandoned terminal artifacts in this worktree, newest record last. */
	async abandonedAudits(): Promise<AbandonedAuditSummary[]> {
		let entries: string[];
		try {
			entries = await readdir(join(this.root, ".audit"));
		} catch {
			return [];
		}
		const summaries: AbandonedAuditSummary[] = [];
		for (const name of entries.filter((entry) => entry.endsWith(".abandoned.json")).sort()) {
			try {
				const file = await readAbandonedAudit(this.root, name.slice(0, -".abandoned.json".length));
				if (file) summaries.push({ task: file.task, taskName: file.taskName, at: file.abandonments?.at(-1)?.at });
			} catch {
				// Unreadable terminal artifacts are skipped, not fatal to status.
			}
		}
		return summaries;
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
