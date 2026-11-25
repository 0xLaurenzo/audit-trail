import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner, SessionIdentity } from "./ports.ts";
import { AuditWorkflow, type AuditLifecycleResult } from "./workflow.ts";

export const TASK_AUDIT_ENV = "AUDIT_TRAIL_ID";

function taskRoot(id: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
		throw new Error(`${TASK_AUDIT_ENV} must be a task audit UUID from audit-trail task-start`);
	}
	return join(homedir(), ".local", "state", "audit-trail", "tasks", id);
}

/** The caller's runner is independent of the canonical audit and lock location. */
export async function openTaskAudit(id: string, runner: CommandRunner): Promise<AuditWorkflow> {
	const root = taskRoot(id);
	const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		throw new Error(`Unknown task audit ${id}`);
	});
	if (!stat.isDirectory()) throw new Error(`Task audit ${id} is not a directory`);
	return new AuditWorkflow(root, runner, undefined, undefined, id);
}

export async function startTaskAudit(task: string, runner: CommandRunner, session: SessionIdentity): Promise<AuditLifecycleResult> {
	if (!task.trim()) throw new Error("Task name must not be empty");
	const id = randomUUID();
	const root = taskRoot(id);
	await mkdir(dirname(root), { recursive: true, mode: 0o700 });
	await mkdir(root, { mode: 0o700 });
	return (await openTaskAudit(id, runner)).start(task, session);
}
