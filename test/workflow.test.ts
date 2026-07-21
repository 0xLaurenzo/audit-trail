import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { activeStatePath, readActiveAudit, sha256Hex } from "../src/core/active-state.ts";
import type { CommandRunner } from "../src/core/ports.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";

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
		assert.equal(started.resumed, false);
		assert.equal(started.state.task, "portable-state");
		assert.ok(started.provenanceError, "provenance capture fails without git");
		assert.ok(await readActiveAudit(root), "active.json exists");

		const resumed = await workflow.start("portable-state", session);
		assert.equal(resumed.resumed, true);
		await assert.rejects(() => workflow.start("другой task", session), /already active/);

		const appended = await workflow.append(session, decisionInput);
		assert.equal(appended.row.id, "D0001");
		assert.equal(appended.row.session, "pi/session-1");
		assert.equal(appended.row.entry, "entry-9");

		let closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.deepEqual(closed.blockers, ["independent review not run"]);

		const snapshot = await workflow.recordReview({
			path: join(root, ".audit", "portable-state.review.md"),
			mode: "cross-model",
			model: "provider/reviewer",
		});
		assert.equal(snapshot.path, join(".audit", "portable-state.review.md"));
		assert.equal(snapshot.sha256, sha256Hex(await readFile(join(root, ".audit", "portable-state.tsv"), "utf8")));

		await workflow.append(session, { ...decisionInput, decision: "Added after review" });
		closed = await workflow.close();
		assert.equal(closed.closed, false);
		assert.deepEqual(closed.blockers, ["the audit changed after the last review"]);

		await workflow.recordReview({
			path: join(root, ".audit", "portable-state.review.md"),
			mode: "cross-model",
			model: "provider/reviewer",
		});
		closed = await workflow.close();
		assert.equal(closed.closed, true);
		assert.equal(await readActiveAudit(root), undefined);
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
