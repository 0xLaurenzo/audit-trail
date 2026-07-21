import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	clearActiveAudit,
	readActiveAudit,
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
} from "./types.ts";
import { closeBlockers } from "./validation.ts";

export function qualifiedSession(session: SessionIdentity): string {
	return `${session.harness}/${session.id}`;
}

export interface StartAuditResult {
	state: AuditState;
	resumed: boolean;
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
 * (start/resume, append, review checkpoint, close) runs under the cross-process
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
		const state: AuditState = { task: file.task, logPath: this.absolute(file.logPath), review: file.review };
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

	async start(taskInput: string, session: SessionIdentity): Promise<StartAuditResult> {
		const task = safeSlug(taskInput, this.now());
		return this.lock(async () => {
			const existing = await readActiveAudit(this.root);
			if (existing && existing.task !== task) {
				throw new Error(
					`Another audit is already active in this worktree: ${existing.task}. Close it before starting ${task}.`,
				);
			}
			if (existing) return { state: await this.stateFrom(existing), resumed: true };

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
			await this.store.ensureLog(this.absolute(logRel));
			const file: ActiveAuditFile = {
				version: 1,
				task,
				logPath: logRel,
				provenancePath: hasProvenance ? provenanceRel : undefined,
				startedAt: this.now().toISOString(),
			};
			await writeActiveAudit(this.root, file);
			return { state: await this.stateFrom(file), resumed: false, provenanceError };
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

	async recordReview(input: { path: string; mode: ReviewMode; model: string }): Promise<ReviewSnapshot> {
		return this.lock(async () => {
			const file = await readActiveAudit(this.root);
			if (!file) throw new Error("No audit is active.");
			const raw = await readFile(this.absolute(file.logPath), "utf8");
			const snapshot: ReviewSnapshot = {
				path: this.relativePath(input.path),
				sha256: sha256Hex(raw),
				mode: input.mode,
				model: input.model,
				at: this.now().toISOString(),
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
			await clearActiveAudit(this.root);
			return { state, blockers: [], closed: true };
		});
	}
}
