import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveAudit, sha256Hex } from "../src/core/active-state.ts";
import { readRows } from "../src/core/audit-store.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { runCli, type CliIo } from "../src/cli/main.ts";

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
	};
}

const decisionArgs = [
	"decision",
	"--phase",
	"cli",
	"--origin",
	"implementation discovery",
	"--decision",
	"Ship the CLI",
	"--why",
	"Because the workflow is shared",
	"--confidence",
	"high",
	"--evidence",
	"src/cli/main.ts:1",
	"--result",
	"verified",
];

test("cli start, decision, status, and close blockers share worktree state", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		const io = capture();
		assert.equal(await runCli(["-C", root, "start", "CLI Task"], io), 0);
		assert.match(io.stdout.join("\n"), /Started decision audit: .audit\/cli-task\.tsv/);
		assert.match(io.stderr.join("\n"), /provenance could not be captured/);

		assert.equal(await runCli(["-C", root, "start", "CLI Task"], io), 0);
		assert.match(io.stdout.at(-1)!, /^Resumed decision audit/);

		assert.equal(await runCli(["-C", root, ...decisionArgs], io), 0);
		assert.match(io.stdout.at(-1)!, /^Logged D0001: Ship the CLI$/);
		const rows = await readRows(join(root, ".audit", "cli-task.tsv"));
		assert.equal(rows.length, 1);
		assert.match(rows[0].session, /^cli\/.+@.+$/);

		const statusIo = capture();
		assert.equal(await runCli(["-C", root, "status"], statusIo), 0);
		const status = statusIo.stdout.join("\n");
		assert.match(status, /cli-task: 1 rows \(1 active\)/);
		assert.match(status, /review: not run/);
		assert.match(status, /origin: unavailable \(local audit\)/);

		const closeIo = capture();
		assert.equal(await runCli(["-C", root, "close"], closeIo), 1);
		assert.match(closeIo.stderr.join("\n"), /independent review not run/);
		assert.ok(await readActiveAudit(root), "close blockers keep the audit active");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli rejects invalid input with clear errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		const io = capture();
		assert.equal(await runCli(["-C", root, ...decisionArgs], io), 1);
		assert.match(io.stderr.join("\n"), /No audit is active/);

		assert.equal(await runCli(["-C", root, "start", "task"], capture()), 0);
		assert.equal(await runCli(["-C", root, "start", "other-task"], io), 1);
		assert.match(io.stderr.join("\n"), /already active/);

		const badOrigin = decisionArgs.map((arg) => (arg === "implementation discovery" ? "vibes" : arg));
		assert.equal(await runCli(["-C", root, ...badOrigin], io), 1);
		assert.match(io.stderr.join("\n"), /Invalid origin: vibes/);

		const missing = decisionArgs.slice(0, decisionArgs.indexOf("--why"));
		assert.equal(await runCli(["-C", root, ...missing], io), 1);
		assert.match(io.stderr.join("\n"), /Missing required option --why/);

		assert.equal(await runCli(["-C", root, "review", "not-a-model"], io), 1);
		assert.match(io.stderr.join("\n"), /Usage: audit-trail review/);

		assert.equal(await runCli(["-C", root, "review", "openai/gpt-5.2"], io), 1);
		assert.match(io.stderr.join("\n"), /Specify --mode/);

		assert.equal(await runCli(["-C", root, "review", "openai/gpt-5.2", "--mode", "sideways"], io), 1);
		assert.match(io.stderr.join("\n"), /Invalid mode: sideways/);

		assert.equal(await runCli(["-C", root, "publish"], io), 1);
		assert.match(io.stderr.join("\n"), /no Git provenance/);

		assert.equal(await runCli(["-C", root, "unknown-command"], io), 1);
		assert.match(io.stderr.join("\n"), /Unknown command: unknown-command/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CLI review records a blocking verdict and exits 1", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		assert.equal(await runCli(["-C", root, "start", "task"], capture()), 0);
		assert.equal(await runCli(["-C", root, ...decisionArgs], capture()), 0);
		const reviewer: ReviewerPort = { review: async () => "Finding.\nVERDICT: block\n" };
		const io = capture();
		assert.equal(
			await runCli(["-C", root, "review", "provider/model", "--mode", "cross-model"], io, {
				createReviewer: () => reviewer,
			}),
			1,
		);
		const feedback = io.stderr.join("\n");
		assert.match(feedback, /Review blocked the audit/);
		assert.match(feedback, /Reviewer findings:\nFinding\./);
		assert.match(feedback, /\.review\..*\.md/);
		assert.doesNotMatch(feedback, /VERDICT:/);
		assert.equal((await readActiveAudit(root))?.review?.verdict, "block");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CLI publish rejects a current blocking review before invoking GitHub", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		const git: CommandRunner = {
			exec: async (_command, args) => {
				const outputs: Record<string, string> = {
					"rev-parse --show-toplevel": root,
					"remote get-url origin": "git@github.com:owner/repo.git",
					"branch --show-current": "feature/task",
					"rev-parse HEAD": "abcdef1234567890",
					"status --porcelain": "",
				};
				const key = args.join(" ");
				return { code: key in outputs ? 0 : 1, stdout: outputs[key] ?? "", stderr: key.startsWith("gh") ? "GitHub must not run" : "" };
			},
		};
		const workflow = new AuditWorkflow(root, git);
		const state = (await workflow.start("task", { harness: "cli", id: "test" })).state;
		const row: Omit<NewAuditRow, "session" | "entry"> = {
			phase: "cli", origin: "implementation discovery", decision: "decision", why: "because", alternatives: "none",
			confidence: "high", evidence: "test", result: "verified", supersedes: "",
		};
		await workflow.append({ harness: "cli", id: "test" }, row);
		await workflow.recordReview({
			path: join(root, ".audit", "task.review.md"),
			mode: "cross-model",
			model: "provider/model",
			expectedSha256: sha256Hex(await readFile(state.logPath, "utf8")),
			verdict: "block",
		});
		const io = capture();
		assert.equal(await runCli(["-C", root, "publish", "22"], io), 1);
		assert.match(io.stderr.join("\n"), /last review did not approve/);
		assert.doesNotMatch(io.stderr.join("\n"), /GitHub must not run/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("-C is accepted after the command as well", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		const io = capture();
		assert.equal(await runCli(["start", "-C", root, "late-flag-task"], io), 0);
		assert.ok(await readActiveAudit(root), "audit landed in the -C directory");
		assert.match(io.stdout.join("\n"), /late-flag-task\.tsv/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli help prints usage without touching state", async () => {
	const io = capture();
	assert.equal(await runCli(["help"], io), 0);
	assert.match(io.stdout.join("\n"), /Usage: audit-trail/);
	assert.equal(await runCli([], io), 0);
});
