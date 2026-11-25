import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCli } from "../src/cli/main.ts";
import { readActiveAudit } from "../src/core/active-state.ts";
import { openTaskAudit, TASK_AUDIT_ENV } from "../src/core/task-audit.ts";
import { HARNESS_CAPABILITIES, SHIPPED_HARNESSES } from "../src/harness/capabilities.ts";
import { CONFORMANCE_DRIVERS } from "./helpers/harness-drivers.ts";
import { buildReviewOutputFixture } from "./helpers/review-output.ts";

const exec = promisify(execFile);
const model = "openai/gpt-6.2-sol";
const args = ["decision", "--phase", "cli", "--origin", "user requirement", "--decision", "CLI decision", "--why", "Record an alternative", "--evidence", "repo-a@1234", "--confidence", "high", "--result", "verified"];
const noGit = { exec: async () => ({ code: 1, stdout: "", stderr: "no Git" }) };

for (const harness of SHIPPED_HARNESSES) test(`${harness}: task audits share state with the CLI across checkouts`, {
	skip: !HARNESS_CAPABILITIES[harness].taskAuditSelection && `${harness} does not support explicit task audit selection`,
}, async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "task-audit-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const home = join(tmp, "home");
	const first = join(tmp, "first");
	const second = join(tmp, "second");
	await Promise.all([home, first, second].map((path) => mkdir(path)));
	await exec("git", ["-C", first, "init", "-b", "one"]);
	await exec("git", ["-C", second, "init", "-b", "two"]);
	await exec("git", ["-C", second, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
	await exec("git", ["-C", second, "remote", "add", "origin", "https://github.com/example/second.git"]);
	const originalHome = process.env.HOME;
	const originalId = process.env[TASK_AUDIT_ENV];
	t.after(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalId === undefined) delete process.env[TASK_AUDIT_ENV];
		else process.env[TASK_AUDIT_ENV] = originalId;
	});
	process.env.HOME = home;
	delete process.env[TASK_AUDIT_ENV];
	const invoke = async (cwd: string, ...input: string[]) => {
		const stdout: string[] = [], stderr: string[] = [];
		const code = await runCli(["-C", cwd, ...input], { out: (s) => stdout.push(s), err: (s) => stderr.push(s) });
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	};
	assert.equal((await invoke(second, "start", "Unrelated worktree task")).code, 0);
	const started = await invoke(first, "task-start", "Shared task");
	assert.equal(started.code, 0, started.stderr);
	const id = started.stdout;
	assert.match(id, /^[0-9a-f-]{36}$/);
	process.env[TASK_AUDIT_ENV] = id;
	const solo = await CONFORMANCE_DRIVERS[harness](second);
	const workflow = await openTaskAudit(id, noGit);
	assert.equal((await stat(workflow.root)).mode & 0o777, 0o700);
	const state = (await workflow.active())!;
	assert.equal(state.auditId, id);
	assert.equal(await readActiveAudit(first), undefined);
	assert.equal((await readActiveAudit(second))?.taskName, "Unrelated worktree task");
	assert.equal((await invoke(first, "start", "Wrong audit")).code, 1);
	await assert.rejects(openTaskAudit("../outside", noGit), /task audit UUID/);

	// Separate processes must allocate decision IDs under the same storage lock.
	const [, cliResult] = await Promise.all([
		solo.decide({ decision: "Pi decision" }),
		exec(process.execPath, ["--experimental-strip-types", "src/cli/bin.ts", "-C", first, ...args]),
	]);
	assert.match(cliResult.stdout, /Logged D000[12]/);
	const rows = await workflow.rows(state);
	assert.deepEqual(rows.map(({ id }) => id), ["D0001", "D0002"]);
	assert.deepEqual(rows.map(({ decision }) => decision).sort(), ["CLI decision", "Pi decision"]);
	assert.match(await solo.status(), new RegExp(`Task audit: ${id}`));

	const stdout: string[] = [], stderr: string[] = [];
	const io = { out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) };
	const check = ["-C", second, "review", model, "--mode", "same-model"];
	const cwd = await realpath(second);
	let racing = true;
	const reviewer = { createReviewer: () => ({ review: async (request: { prompt: string; workingDirectory: string }) => {
		assert.equal(request.workingDirectory, cwd);
		assert.ok(request.prompt.includes(state.logPath));
		assert.match(request.prompt, /the current checkout and original audit creation commit are not the task's source-review target/);
		if (racing) await solo.decide({ decision: "New evidence during review" });
		return buildReviewOutputFixture({ verdict: "approve" });
	} }) };
	assert.equal(await runCli(check, io, reviewer), 1);
	assert.match(stderr.join("\n"), /audit gained new decisions/i);
	racing = false;
	assert.equal(await runCli(check, io, reviewer), 0, stderr.join("\n"));
	assert.equal((await invoke(first, "close")).code, 0);
	await assert.rejects(solo.decide(), /No audit is active/);
	assert.equal((await invoke(second, "reopen", "Shared task")).code, 0);
	assert.equal((await workflow.active())?.auditId, id);
	assert.equal((await workflow.active())?.provenance, undefined, "the second checkout must not become the creation origin");
	process.env[TASK_AUDIT_ENV] = "00000000-0000-4000-8000-000000000000";
	const missing = await invoke(second, "status");
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /Unknown task audit/);
	assert.equal((await readActiveAudit(second))?.taskName, "Unrelated worktree task");
});
