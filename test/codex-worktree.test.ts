import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { handleCodexHook } from "../src/adapters/codex-hook.ts";
import { createCodexMcpHandler } from "../src/adapters/codex-mcp.ts";
import { processRunner } from "../src/cli/main.ts";
import { readActiveAudit, sha256Hex } from "../src/core/active-state.ts";
import { buildReviewOutputFixture } from "./helpers/review-output.ts";

const exec = promisify(execFile);

test("a Codex thread bound to A refuses B; the scoped CLI audits B without touching A", async () => {
	const tmp = await realpath(await mkdtemp(join(tmpdir(), "audit-linked-")));
	const a = join(tmp, "a"), b = join(tmp, "b");
	const env = { ...process.env, XDG_STATE_HOME: tmp, PATH: `${tmp}:${process.env.PATH}` };
	const bin = join(import.meta.dirname, "../bin/audit-trail");
	const cli = (...args: string[]) => exec(bin, ["-C", b, ...args], { cwd: a, env });
	try {
		await exec("git", ["init", "-b", "a", a]);
		await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], { cwd: a });
		await exec("git", ["remote", "add", "origin", "https://github.com/example/test.git"], { cwd: a });
		await exec("git", ["worktree", "add", "-b", "b", b], { cwd: a });
		await handleCodexHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-a", cwd: a }), processRunner, env);
		const server = createCodexMcpHandler(a, processRunner, env);
		const call = async (name: string, args: object) => {
			const response: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { threadId: "session-a" } } });
			return response.result.content[0].text as string;
		};
		assert.ok((await call("audit_status", {})).includes(`worktree: ${a}\nrepository: ${a}/.git\nbranch: a`));
		const listed: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		for (const tool of listed.result.tools) {
			assert.match(await call(tool.name, { task: "linked", expectedWorktree: b }), /MCP cannot retarget/);
			if (tool.name === "audit_status") continue;
			assert.ok(tool.inputSchema.required.includes("expectedWorktree"));
			assert.match(await call(tool.name, { task: "linked" }), /expectedWorktree/);
		}
		assert.ok((await cli("status")).stdout.includes(`worktree: ${b}\nrepository: ${a}/.git\nbranch: b`));
		await cli("start", "Linked Task");
		await assert.rejects(cli("resume", "linked-task"));
		await cli("resume", "Linked Task");
		const decide = () => cli("decision", "--phase", "implementation", "--origin", "user requirement", "--decision", "Use B", "--why", "Isolate worktrees", "--confidence", "high", "--result", "verified", "--evidence", "test");
		await decide();
		const state = (await readActiveAudit(b))!;
		const log = join(b, state.logPath);
		const initial = await readFile(log, "utf8");
		assert.match(initial, /D0001\t[^\t]+\tcli\//);
		await assert.rejects(cli("close"), /independent review not run/);
		// Exercise the real CLI reviewer adapter, stubbing only the external binaries.
		const report = buildReviewOutputFixture({ verdict: "approve" });
		const stream = [ { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: report }] } }, { type: "agent_settled" } ].map(e => JSON.stringify(e)).join("\n");
		await writeFile(join(tmp, "pi"), `#!/bin/sh\n[ "$1" = --version ] && exit 0\n[ "$PWD" = "$EXPECTED_ROOT" ] && [ "$6" = openai-codex/gpt-6.2-sol ] || exit 1\nprintf '%s\\n' "$REVIEW_STREAM"\n`, { mode: 0o700 });
		Object.assign(env, { EXPECTED_ROOT: b, REVIEW_STREAM: stream });
		const review = () => cli("review", "openai-codex/gpt-6.2-sol", "--mode", "same-model");
		await review();
		const checkpoint = (await readActiveAudit(b))!.review!;
		assert.equal(checkpoint.model, "openai-codex/gpt-6.2-sol");
		assert.equal(checkpoint.mode, "same-model");
		assert.equal(checkpoint.sha256, sha256Hex(initial));
		await writeFile(join(tmp, "gh"), `#!/bin/sh\n[ "$1 $2" = 'pr view' ] || exit 1\necho '{"number":42,"headRefName":"b","headRefOid":"wrong","headRepository":{"nameWithOwner":"example/test"}}'\n`, { mode: 0o700 });
		await assert.rejects(cli("publish", "42"), /does not match current checkout/);
		await decide();
		assert.ok((await readFile(log, "utf8")).startsWith(initial));
		await assert.rejects(cli("publish", "42"), /review/i);
		await assert.rejects(cli("close"), /review/i);
		await review();
		await cli("close");
		assert.equal(await readActiveAudit(b), undefined);
		await rm(join(a, ".git"), { recursive: true });
		assert.match(await call("audit_start", { task: "lost checkout", expectedWorktree: a }), /no longer resolves/);
		await assert.rejects(lstat(join(a, ".audit")), { code: "ENOENT" });
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
