import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
	activeStatePath,
	closedStatePath,
	readActiveAudit,
	readClosedAudit,
	sha256Hex,
	writeActiveAudit,
} from "../src/core/active-state.ts";
import type { CommandRunner } from "../src/core/ports.ts";
import { AUDIT_HEADER, type NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow, resolveWorktreeRoot } from "../src/core/workflow.ts";

const run = promisify(execFile);
const noGit: CommandRunner = {
	exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }),
};
const decisionInput: Omit<NewAuditRow, "session" | "entry"> = {
	phase: "core",
	origin: "implementation discovery",
	decision: "A decision",
	why: "Because",
	alternatives: "none",
	confidence: "high",
	evidence: "src/core/workflow.ts:1",
	result: "verified",
	supersedes: "",
};

test("workflow start/resume/append/review/close over shared worktree state", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const workflow = new AuditWorkflow(root, noGit);
		const session = { harness: "pi", id: "session-1", entryId: "entry-9" };

		const started = await workflow.start("Portable State!", session);
		assert.equal(started.state.task, "portable-state");
		assert.equal(started.state.taskName, "Portable State!");
		assert.ok(started.provenanceError, "provenance capture fails without git");
		assert.ok(await readActiveAudit(root), "active.json exists");

		await assert.rejects(() => workflow.start("Portable State!", session), /Use resume instead of start/);
		await assert.rejects(() => workflow.resume("portable-state", session), /Task name collision/);
		const resumed = await workflow.resume("  Portable State!  ", session);
		assert.equal(resumed.state.taskName, "Portable State!");
		await assert.rejects(() => workflow.resume("другой task", session), /audit task is/);
		await assert.rejects(() => workflow.start("другой task", session), /already active/);

		const appended = await workflow.append(session, decisionInput);
		assert.equal(appended.row.id, "D0001");
		assert.equal(appended.row.session, "pi/session-1");
		assert.equal(appended.row.entry, "entry-9");

		let closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.deepEqual(closed.blockers, ["independent review not run"]);

		const reviewedSha = sha256Hex(await readFile(join(root, ".audit", "portable-state.tsv"), "utf8"));
		const snapshot = await workflow.recordReview({
			path: join(root, ".audit", "portable-state.review.md"),
			mode: "cross-model",
			model: "provider/reviewer",
			expectedSha256: reviewedSha,
			verdict: "approve",
		});
		assert.equal(snapshot.path, join(".audit", "portable-state.review.md"));
		assert.equal(snapshot.sha256, reviewedSha);

		await workflow.append(session, { ...decisionInput, decision: "Added after review" });
		closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.deepEqual(closed.blockers, ["the audit changed after the last review"]);

		// A checkpoint may only bless the bytes the reviewer actually read: a
		// hash captured before the newest append must be rejected.
		await assert.rejects(
			() =>
				workflow.recordReview({
					path: join(root, ".audit", "portable-state.review.md"),
					mode: "cross-model",
					model: "provider/reviewer",
					expectedSha256: reviewedSha,
					verdict: "approve",
				}),
			/gained new decisions while the review was running/,
		);

		await workflow.recordReview({
			path: join(root, ".audit", "portable-state.review.md"),
			mode: "cross-model",
			model: "provider/reviewer",
			expectedSha256: sha256Hex(await readFile(join(root, ".audit", "portable-state.tsv"), "utf8")),
			verdict: "approve",
		});
		closed = await workflow.close();
		assert.equal(closed.closed, true);
		assert.equal(await readActiveAudit(root), undefined);
		const closedFile = await readClosedAudit(root, "portable-state");
		assert.equal(closedFile?.taskName, "Portable State!");
		assert.ok(closedFile?.lastClosedAt);
		await assert.rejects(() => workflow.start("portable-state", session), /Task name collision/);
		await assert.rejects(() => workflow.start("Portable State!", session), /Use reopen instead of start/);
		await assert.rejects(() => workflow.reopen("portable-state", session), /Task name collision/);
		const reopened = await workflow.reopen("Portable State!", session);
		assert.equal(reopened.state.review?.sha256, closed.state.review?.sha256);
		assert.equal((await readActiveAudit(root))?.reopenCount, 1);
		assert.equal(await readClosedAudit(root, "portable-state"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("start refuses orphaned artifacts and reopen requires a closed lifecycle", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const workflow = new AuditWorkflow(root, noGit);
		const session = { harness: "pi", id: "session-1" };
		await assert.rejects(() => workflow.resume("task", session), /No audit is active/);
		await assert.rejects(() => workflow.reopen("task", session), /No closed audit/);
		await mkdir(join(root, ".audit"), { recursive: true });
		await writeFile(join(root, ".audit", "task.tsv"), "orphan", "utf8");
		await assert.rejects(() => workflow.start("task", session), /existing artifact has no lifecycle state/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy active state can finish but cannot be resumed or reopened by an inferred name", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		await mkdir(join(root, ".audit"), { recursive: true });
		const logPath = join(root, ".audit", "legacy-task.tsv");
		await writeFile(logPath, `${AUDIT_HEADER}\n`, "utf8");
		await writeActiveAudit(root, {
			version: 1,
			task: "legacy-task",
			logPath: join(".audit", "legacy-task.tsv"),
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		const workflow = new AuditWorkflow(root, noGit);
		const session = { harness: "pi", id: "session-1" };
		await assert.rejects(() => workflow.resume("legacy-task", session), /original task name was not recorded/);
		await workflow.append(session, decisionInput);
		await workflow.recordReview({
			path: join(root, ".audit", "legacy-task.review.md"),
			mode: "cross-model",
			model: "provider/model",
			expectedSha256: sha256Hex(await readFile(logPath, "utf8")),
			verdict: "approve",
		});
		assert.equal((await workflow.close()).closed, true);
		await assert.rejects(() => workflow.reopen("legacy-task", session), /original task name was not recorded/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent same-process appends never lose rows or duplicate IDs", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const workflow = new AuditWorkflow(root, noGit);
		const session = { harness: "pi", id: "session-1" };
		await workflow.start("task", session);
		await Promise.all(
			Array.from({ length: 8 }, (_item, index) =>
				workflow.append(session, { ...decisionInput, decision: `parallel ${index}` }),
			),
		);
		const state = await workflow.active();
		assert.ok(state);
		const rows = await workflow.rows(state);
		assert.equal(rows.length, 8);
		assert.equal(new Set(rows.map((row) => row.id)).size, 8);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("two processes append concurrently without lost updates or duplicate IDs", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const workflowUrl = pathToFileURL(new URL("../src/core/workflow.ts", import.meta.url).pathname).href;
		const script = `
const [root, count, tag] = process.argv.slice(2);
const { AuditWorkflow } = await import(${JSON.stringify(workflowUrl)});
const runner = { exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }) };
const workflow = new AuditWorkflow(root, runner);
for (let index = 0; index < Number(count); index++) {
	await workflow.append({ harness: "test", id: tag }, {
		phase: "core",
		origin: "implementation discovery",
		decision: "row " + tag + " " + index,
		why: "Because",
		alternatives: "none",
		confidence: "high",
		evidence: "test",
		result: "verified",
		supersedes: "",
	});
}
`;
		const scriptPath = join(root, "appender.mjs");
		await writeFile(scriptPath, script, "utf8");

		const parent = new AuditWorkflow(root, noGit);
		await parent.start("concurrency", { harness: "pi", id: "parent" });
		const count = 15;
		await Promise.all(
			["alpha", "beta"].map((tag) =>
				run(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", scriptPath, root, String(count), tag]),
			),
		);

		const state = await parent.active();
		assert.ok(state);
		const rows = await parent.rows(state);
		assert.equal(rows.length, 2 * count);
		assert.equal(new Set(rows.map((row) => row.id)).size, 2 * count);
		assert.equal(rows.filter((row) => row.session === "test/alpha").length, count);
		assert.equal(rows.filter((row) => row.session === "test/beta").length, count);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resume retries provenance capture once Git becomes available", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const session = { harness: "pi", id: "session-1" };
		const offline = new AuditWorkflow(root, noGit);
		const started = await offline.start("task", session);
		assert.ok(started.provenanceError);
		assert.equal(started.state.provenance, undefined);

		const git: CommandRunner = {
			async exec(_command, args) {
				const outputs: Record<string, string> = {
					"rev-parse --show-toplevel": root,
					"remote get-url origin": "git@github.com:owner/repo.git",
					"branch --show-current": "feature/task",
					"rev-parse HEAD": "abcdef1234567890",
					"status --porcelain": "",
				};
				const key = args.join(" ");
				return { code: key in outputs ? 0 : 1, stdout: outputs[key] ?? "", stderr: "" };
			},
		};
		const online = new AuditWorkflow(root, git);
		const resumed = await online.resume("task", session);
		assert.equal(resumed.provenanceError, undefined);
		assert.equal(resumed.state.provenance?.repository, "owner/repo");
		assert.equal(resumed.state.provenance?.sessionId, "pi/session-1");
		assert.ok((await readActiveAudit(root))?.provenancePath, "active.json records provenance after retry");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree root resolves to the Git toplevel with a cwd fallback", async () => {
	const git: CommandRunner = {
		exec: async () => ({ code: 0, stdout: "/repo/toplevel\n", stderr: "" }),
	};
	assert.equal(await resolveWorktreeRoot(git, "/repo/toplevel/packages/foo"), "/repo/toplevel");
	assert.equal(await resolveWorktreeRoot(noGit, "/somewhere"), "/somewhere");
	const throwing: CommandRunner = {
		exec: async () => {
			throw new Error("exec unavailable");
		},
	};
	assert.equal(await resolveWorktreeRoot(throwing, "/somewhere"), "/somewhere");
});

test("append fails cleanly when no audit is active", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		const workflow = new AuditWorkflow(root, noGit);
		await assert.rejects(() => workflow.append({ harness: "pi", id: "s" }, decisionInput), /No audit is active/);
		await assert.rejects(() => workflow.close(), /No audit is active/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("write and edit of active state stay extension-managed via path helper", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-workflow-test-"));
	try {
		await mkdir(join(root, ".audit"), { recursive: true });
		assert.equal(activeStatePath(root), join(root, ".audit", "active.json"));
		assert.equal(closedStatePath(root, "task"), join(root, ".audit", "task.closed.json"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
