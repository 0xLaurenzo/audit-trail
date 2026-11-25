import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveAudit, sha256Hex } from "../src/core/active-state.ts";
import { readRows } from "../src/core/audit-store.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { runCli, type CliIo } from "../src/cli/main.ts";
import { buildReviewOutputFixture } from "./helpers/review-output.ts";

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

		assert.equal(await runCli(["-C", root, "start", "CLI Task"], io), 1);
		assert.match(io.stderr.at(-1)!, /Use resume instead of start/);
		assert.equal(await runCli(["-C", root, "resume", "CLI Task"], io), 0);
		assert.match(io.stdout.at(-1)!, /^Resumed decision audit/);

		assert.equal(await runCli(["-C", root, ...decisionArgs], io), 0);
		assert.match(io.stdout.at(-1)!, /^Logged D0001: Ship the CLI$/);
		const rows = await readRows(join(root, ".audit", "cli-task.tsv"));
		assert.equal(rows.length, 1);
		assert.match(rows[0].session, /^cli\/.+@.+$/);

		const statusIo = capture();
		assert.equal(await runCli(["-C", root, "status"], statusIo), 0);
		const status = statusIo.stdout.join("\n");
		assert.match(status, /CLI Task: 1 rows \(1 active\)/);
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

test("installer verbs reject extra targets before selecting an installer", async () => {
	for (const command of ["install", "uninstall"]) {
		const io = capture();
		assert.equal(await runCli([command, "not-a-harness", "--", "-C"], io), 1);
		assert.deepEqual(io.stderr, [`${command} requires exactly one target`]);
	}
});

test("cli requires explicit reopen after close", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		assert.equal(await runCli(["-C", root, "start", "--", "Lifecycle Task"], capture()), 0);
		assert.equal(await runCli(["-C", root, "resume", "Lifecycle Task"], capture()), 0);
		assert.equal(await runCli(["-C", root, ...decisionArgs], capture()), 0);
		const reviewer: ReviewerPort = {
			review: async () => buildReviewOutputFixture({ sections: { auditFindings: "No flags." }, verdict: "approve" }),
		};
		assert.equal(
			await runCli(["-C", root, "review", "openai/gpt-6.2-sol", "--mode", "cross-model"], capture(), {
				createReviewer: () => reviewer,
			}),
			0,
		);
		const closeIo = capture();
		assert.equal(await runCli(["-C", root, "close", "--", "-C", "not-the-target"], closeIo), 1);
		assert.match(closeIo.stderr.join("\n"), /close takes no arguments/);
		assert.ok(await readActiveAudit(root), "an eligible audit was not silently closed");
		assert.equal(await runCli(["-C", root, "close", "--"], capture()), 0);
		const startIo = capture();
		assert.equal(await runCli(["-C", root, "start", "Lifecycle Task"], startIo), 1);
		assert.match(startIo.stderr.join("\n"), /Use reopen instead of start/);
		const reopenIo = capture();
		assert.equal(await runCli(["-C", root, "reopen", "Lifecycle Task"], reopenIo), 0);
		assert.match(reopenIo.stdout.join("\n"), /Reopened decision audit/);
		assert.equal((await readActiveAudit(root))?.reopenCount, 1);
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

		assert.equal(await runCli(["-C", root, "review", "openai/gpt-6.2-astra"], io), 1);
		assert.match(io.stderr.join("\n"), /Specify --mode/);

		assert.equal(await runCli(["-C", root, "review", "openai/gpt-6.2-astra", "--mode", "sideways"], io), 1);
		assert.match(io.stderr.join("\n"), /Invalid mode: sideways/);

		let unsupportedReviewerCalls = 0;
		assert.equal(
			await runCli(["-C", root, "review", "openai/gpt-5.4", "--mode", "cross-model"], io, {
				createReviewer: () => ({ review: async () => { unsupportedReviewerCalls += 1; return ""; } }),
			}),
			1,
		);
		assert.match(io.stderr.join("\n"), /Unsupported review model.*Allowed review model families/);
		assert.equal(unsupportedReviewerCalls, 0);

		assert.equal(await runCli(["-C", root, "publish"], io), 1);
		assert.match(io.stderr.join("\n"), /no Git provenance/);

		const badPublish = capture();
		assert.equal(await runCli(["-C", root, "publish", "1", "2"], badPublish), 1);
		assert.match(badPublish.stderr.join("\n"), /at most one PR/);
		assert.equal(await runCli(["-C", root, "publish", "--set"], badPublish), 1);
		assert.match(badPublish.stderr.join("\n"), /argument missing|requires an argument/i);

		assert.equal(await runCli(["-C", root, "unknown-command"], io), 1);
		assert.match(io.stderr.join("\n"), /Unknown command: unknown-command/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli abandon archives without review and status lists the terminal artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		assert.equal(await runCli(["-C", root, "start", "Stale Task"], capture()), 0);
		const io = capture();
		assert.equal(await runCli(["-C", root, "abandon"], io), 1);
		assert.match(io.stderr.join("\n"), /Usage: audit-trail abandon/);
		assert.equal(await runCli(["-C", root, "abandon", "Stale", "Task"], io), 1);
		assert.match(io.stderr.join("\n"), /non-empty reason/);

		const abandonIo = capture();
		assert.equal(await runCli(["-C", root, "abandon", "Stale", "Task", "--reason", "obsolete"], abandonIo), 0);
		assert.match(abandonIo.stdout.join("\n"), /does not imply review approval or publication/);
		assert.match(abandonIo.stdout.join("\n"), /review at abandonment: none/);

		const statusIo = capture();
		assert.equal(await runCli(["-C", root, "status"], statusIo), 0);
		assert.match(statusIo.stdout.join("\n"), /No audit is active in this worktree\./);
		assert.match(statusIo.stdout.join("\n"), /abandoned: Stale Task \(/);

		assert.equal(await runCli(["-C", root, "reopen", "Stale Task"], capture()), 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CLI review records a blocking verdict and exits 1", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		assert.equal(await runCli(["-C", root, "start", "task"], capture()), 0);
		assert.equal(await runCli(["-C", root, ...decisionArgs], capture()), 0);
		const reviewer: ReviewerPort = {
			review: async () => buildReviewOutputFixture({ sections: { auditFindings: "Finding." }, verdict: "block" }),
		};
		const io = capture();
		assert.equal(
			await runCli(["-C", root, "review", "openai/gpt-6.2-sol", "--mode", "cross-model"], io, {
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
			model: "openai/gpt-6.2-sol",
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
		assert.equal(await runCli(["start", "wrong-target", "-xC", root], io), 1);
		assert.match(io.stderr.at(-1)!, /must be a standalone option/);
		assert.equal(await readActiveAudit(root), undefined);
		for (const spelling of ["-xC", "--C", "--C=ignored", "-Cattached"]) {
			assert.equal(await runCli(["start", "wrong-target", spelling, "-C", root], io), 1);
			assert.match(io.stderr.at(-1)!, /standalone|only once|requires a directory/);
		}
		assert.equal(await readActiveAudit(root), undefined);
		assert.equal(await runCli(["start", "-C", root, "late-flag-task"], io), 0);
		assert.ok(await readActiveAudit(root), "audit landed in the -C directory");
		assert.match(io.stdout.join("\n"), /late-flag-task\.tsv/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a directory operand can start with a dash", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-dash-"));
	try {
		const target = join(root, "-work");
		await mkdir(target);
		const cli = join(process.cwd(), "bin/audit-trail");
		execFileSync(cli, ["-C", "-work", "start", "dash"], { cwd: root, stdio: "pipe" });
		execFileSync(cli, ["resume", "dash", "-C", "-work"], { cwd: root, stdio: "pipe" });
		assert.ok(await readActiveAudit(target));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent CLI invocations retain distinct attribution and literal -C values", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
	try {
		assert.equal(await runCli(["start", "literal", "-C", root], capture()), 0);
		const args = decisionArgs.map((arg) => arg === "Ship the CLI" ? "-C" : arg);
		const invocations = [["-C", root, ...args], [...args, "-C", root]];
		assert.deepEqual(await Promise.all(invocations.map((argv) => runCli(argv, capture()))), [0, 0]);
		const rows = await readRows(join(root, ".audit", "literal.tsv"));
		assert.deepEqual(rows.map((row) => row.decision), ["'-C", "'-C"]); // Canonical TSV formula escaping.
		assert.notEqual(rows[0].session, rows[1].session);
		assert.equal(await runCli(["-C", root, ...args, "-C", root], capture()), 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("generic MCP attribution groups one server's calls, not all servers on a host", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-id-"));
	try {
		assert.equal(await runCli(["-C", root, "start", "ids"], capture()), 0);
		const server = (label: string) => new Promise<void>((done, fail) => {
			const child = execFile(process.execPath, ["--experimental-strip-types", "src/cli/bin.ts", "-C", root, "mcp"],
				(error, stdout) => {
					if (error) return fail(error);
					try {
						for (const line of stdout.trim().split("\n")) assert.ok(!JSON.parse(line).result.isError, line);
						done();
					} catch (err) { fail(err); }
				});
			const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
				params: { name: "audit_decision", arguments: { phase: label, origin: "user requirement", decision: label,
					why: "test", confidence: "high", evidence: "test", result: "verified" } } });
			child.stdin!.end(request(1) + "\n" + request(2) + "\n");
		});
		await Promise.all([server("A"), server("B")]);
		const rows = await readRows(join(root, ".audit", "ids.tsv"));
		assert.equal(rows.length, 4);
		for (const label of ["A", "B"]) assert.equal(new Set(rows.filter(r => r.phase === label).map(r => r.session)).size, 1);
		assert.equal(new Set(rows.map(r => r.session)).size, 2);
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
