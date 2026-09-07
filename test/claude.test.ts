import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../src/adapters/claude-hook.ts";
import { createClaudeSubprocessReviewer } from "../src/adapters/claude-reviewer.ts";
import {
	claudeSessionStatePath,
	readClaudeSessionState,
	writeClaudeSessionState,
} from "../src/adapters/claude-session.ts";
import type { CommandRunner, ExecResult, SessionIdentity } from "../src/core/ports.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { claudeInstaller } from "../src/install/installers.ts";
import { McpAuditServer } from "../src/mcp/server.ts";

const noGit: CommandRunner = {
	exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }),
};

const failingReviewer = {
	review: async () => {
		throw new Error("reviewer must not run in this test");
	},
};

test("claude session state round-trips and rejects mismatched worktrees", async () => {
	const stateHome = await mkdtemp(join(tmpdir(), "audit-claude-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	try {
		assert.equal(await readClaudeSessionState("/repo/a", env), undefined);
		const path = await writeClaudeSessionState(
			{ sessionId: "ses-1", transcriptPath: "/t/x.jsonl", model: "claude-opus-4-8", worktree: "/repo/a", updatedAt: "now" },
			env,
		);
		assert.equal(path, claudeSessionStatePath("/repo/a", env));
		const state = await readClaudeSessionState("/repo/a", env);
		assert.equal(state?.sessionId, "ses-1");
		assert.equal(state?.model, "claude-opus-4-8");
		// A state file whose recorded worktree differs (hash collision or
		// tampering) must not attribute rows to the wrong session.
		await writeFile(claudeSessionStatePath("/repo/b", env), JSON.stringify({ sessionId: "x", worktree: "/other" }), "utf8");
		assert.equal(await readClaudeSessionState("/repo/b", env), undefined);
	} finally {
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("SessionStart hook records state and injects guidance only while an audit is active", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-claude-hook-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-claude-hook-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	try {
		const payload = {
			hook_event_name: "SessionStart",
			session_id: "ses-hook-1",
			transcript_path: "/transcripts/ses-hook-1.jsonl",
			model: { id: "claude-opus-4-8", display_name: "Opus" },
			cwd: root,
			source: "startup",
		};
		// The Git worktree must resolve from the payload cwd, not this process's
		// cwd: hooks for other projects would otherwise bind to the wrong repo.
		const runnerCwds: string[] = [];
		const idle = await handleClaudeHook(JSON.stringify(payload), (cwd) => {
			runnerCwds.push(cwd);
			return noGit;
		}, env);
		assert.deepEqual([...new Set(runnerCwds)], [root]);
		assert.equal(idle.exitCode, 0);
		assert.equal(idle.output, undefined, "no guidance without an active audit");
		const recorded = await readClaudeSessionState(root, env);
		assert.equal(recorded?.sessionId, "ses-hook-1");
		assert.equal(recorded?.transcriptPath, "/transcripts/ses-hook-1.jsonl");
		assert.equal(recorded?.model, "claude-opus-4-8");

		await new AuditWorkflow(root, noGit).start("claude adapter", { harness: "claude", id: "ses-hook-1" });
		const active = await handleClaudeHook(JSON.stringify(payload), () => noGit, env);
		assert.equal(active.exitCode, 0);
		const parsed = JSON.parse(active.output!);
		assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
		assert.match(parsed.hookSpecificOutput.additionalContext, /Active decision audit/);
		assert.match(parsed.hookSpecificOutput.additionalContext, /audit_decision tool/);

		const garbage = await handleClaudeHook("{not json", () => noGit, env);
		assert.equal(garbage.exitCode, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("PreToolUse hook denies audit-managed files and fails closed on unreadable state", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-claude-guard-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-claude-guard-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	const guard = (tool: string, filePath: string) =>
		handleClaudeHook(
			JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: filePath }, cwd: root }),
			() => noGit,
			env,
		);
	try {
		const { state } = await new AuditWorkflow(root, noGit).start("guarded", { harness: "claude", id: "s" });

		const denied = await guard("Write", state.logPath);
		assert.equal(denied.exitCode, 0);
		assert.equal(JSON.parse(denied.output!).hookSpecificOutput.permissionDecision, "deny");
		const deniedActive = await guard("Edit", join(root, ".audit", "active.json"));
		assert.equal(JSON.parse(deniedActive.output!).hookSpecificOutput.permissionDecision, "deny");
		const fileAlias = join(root, "audit-log-alias.tsv");
		await symlink(state.logPath, fileAlias);
		const deniedAlias = await guard("Edit", fileAlias);
		assert.equal(JSON.parse(deniedAlias.output!).hookSpecificOutput.permissionDecision, "deny", "symlink alias denied");

		const allowed = await guard("Write", join(root, "src", "main.ts"));
		assert.equal(allowed.output, undefined);
		const read = await handleClaudeHook(
			JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: state.logPath }, cwd: root }),
			() => noGit,
			env,
		);
		assert.equal(read.output, undefined, "non-mutating tools are not guarded");

		const auditDirAlias = join(root, "audit-dir-alias");
		await symlink(join(root, ".audit"), auditDirAlias);
		await writeFile(join(root, ".audit", "active.json"), "{corrupt", "utf8");
		const failClosed = await guard("Write", join(root, ".audit", "anything.tsv"));
		assert.match(JSON.parse(failClosed.output!).hookSpecificOutput.permissionDecisionReason, /unreadable/);
		const failClosedAlias = await guard("Write", join(auditDirAlias, "new.tsv"));
		assert.match(JSON.parse(failClosedAlias.output!).hookSpecificOutput.permissionDecisionReason, /unreadable/);
		const outsideAudit = await guard("Write", join(root, "src", "ok.ts"));
		assert.equal(outsideAudit.output, undefined, "unreadable state only locks .audit/");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("claude-harness MCP attribution resolves the hook state per call with a fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-claude-mcp-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-claude-mcp-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	try {
		const workflow = new AuditWorkflow(root, noGit);
		// Mirrors commandMcp's claude wiring: identity re-read on every call.
		const session = async (): Promise<SessionIdentity> => {
			const state = await readClaudeSessionState(root, env);
			return { harness: "claude", id: state?.sessionId ?? "fallback@host" };
		};
		const server = new McpAuditServer({ workflow, runner: noGit, reviewer: failingReviewer, session });

		await server.call("audit_start", { task: "claude mcp" });
		await server.call("audit_decision", {
			phase: "adapter",
			origin: "implementation discovery",
			decision: "fallback attribution",
			why: "hook state missing",
			confidence: "high",
			evidence: "test/claude.test.ts",
			result: "verified",
		});
		await handleClaudeHook(
			JSON.stringify({ hook_event_name: "SessionStart", session_id: "ses-mcp-9", cwd: root }),
			() => noGit,
			env,
		);
		await server.call("audit_decision", {
			phase: "adapter",
			origin: "implementation discovery",
			decision: "hook attribution",
			why: "hook state present",
			confidence: "high",
			evidence: "test/claude.test.ts",
			result: "verified",
		});
		const rows = (await readFile(join(root, ".audit", "claude-mcp.tsv"), "utf8")).trim().split("\n");
		assert.equal(rows[1].split("\t")[2], "claude/fallback@host");
		assert.equal(rows[2].split("\t")[2], "claude/ses-mcp-9");

		const status = await server.call("audit_status", {});
		assert.match(status, /claude mcp: 2 rows/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("claude reviewer validates provenance and runs headless read-only", async () => {
	const calls: { command: string; args: string[] }[] = [];
	const runner: CommandRunner = {
		exec: async (command, args): Promise<ExecResult> => {
			calls.push({ command, args });
			if (args[0] === "--version") return { code: 0, stdout: "2.1.215", stderr: "" };
			return { code: 0, stdout: "Report body\n\nVERDICT: approve\n", stderr: "" };
		},
	};
	const output = await createClaudeSubprocessReviewer(runner).review({
		prompt: "Review the audit.",
		model: "anthropic/claude-opus-4-8",
		mode: "cross-model",
		workingDirectory: "/repo",
	});
	assert.match(output, /VERDICT: approve/);
	assert.equal(calls.length, 2);
	const args = calls[1].args;
	assert.equal(calls[1].command, "claude");
	assert.equal(args[0], "-p");
	assert.deepEqual(args.slice(1, 3), ["--model", "claude-opus-4-8"], "provider prefix stripped for the claude CLI");
	assert.deepEqual(
		args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
		["--tools", "Read,Grep,Glob"],
		"available built-ins are structurally restricted to read-only tools",
	);
	assert.ok(args.includes("--allowedTools") && args.includes("Read") && args.includes("Grep") && args.includes("Glob"));
	assert.ok(args.includes("--strict-mcp-config"), "reviewer must not connect to MCP servers");
	assert.ok(args.includes("--no-session-persistence"));
	assert.ok(!args.includes("Write") && !args.includes("Edit") && !args.includes("Bash"), "read-only tool list");

	for (const request of [
		{ prompt: "x", model: "openai/claude-opus-4-8", mode: "cross-provider" as const, workingDirectory: "/" },
		{ prompt: "x", model: "anthropic/claude-opus-4-8", mode: "cross-provider" as const, workingDirectory: "/" },
	]) {
		await assert.rejects(
			() => createClaudeSubprocessReviewer(runner).review(request),
			/anthropic\/<model-id>|cannot use cross-provider/,
		);
	}
	assert.equal(calls.length, 2, "invalid provenance must fail before probing or invoking Claude");

	const missing: CommandRunner = { exec: async () => ({ code: 127, stdout: "", stderr: "not found" }) };
	await assert.rejects(
		() =>
			createClaudeSubprocessReviewer(missing).review({
				prompt: "x",
				model: "anthropic/m",
				mode: "same-model",
				workingDirectory: "/",
			}),
		/claude CLI is required/,
	);
});

test("claude installer manages one collision-safe skills-dir symlink", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-claude-install-"));
	const packageA = await mkdtemp(join(tmpdir(), "audit-claude-pkg-a-"));
	const packageB = await mkdtemp(join(tmpdir(), "audit-claude-pkg-b-"));
	const foreign = await mkdtemp(join(tmpdir(), "audit-claude-foreign-"));
	const manifestless = await mkdtemp(join(tmpdir(), "audit-claude-skill-"));
	const malformed = await mkdtemp(join(tmpdir(), "audit-claude-malformed-"));
	const linkPath = join(home, ".claude", "skills", "audit-trail");
	try {
		for (const pkg of [packageA, packageB]) {
			await mkdir(join(pkg, ".claude-plugin"), { recursive: true });
			await writeFile(join(pkg, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "audit-trail" }), "utf8");
		}

		const first = await claudeInstaller.install({ home, packageRoot: packageA });
		assert.equal(first.changed, true);
		assert.equal(await readlink(linkPath), packageA);

		const second = await claudeInstaller.install({ home, packageRoot: packageA });
		assert.equal(second.changed, false);
		assert.match(second.message, /already linked/);

		// A different target is never inferred to be installer-owned, even when it
		// contains the same plugin manifest. Upgrades require explicit removal.
		await assert.rejects(() => claudeInstaller.install({ home, packageRoot: packageB }), /ownership cannot be proven/);
		assert.equal(await readlink(linkPath), packageA);
		await rm(linkPath);
		const upgraded = await claudeInstaller.install({ home, packageRoot: packageB });
		assert.equal(upgraded.changed, true);
		assert.equal(await readlink(linkPath), packageB);

		// A dangling target is equally unprovable and must be preserved.
		await rm(linkPath);
		await symlink(packageA, linkPath, "dir");
		await rm(packageA, { recursive: true, force: true });
		await assert.rejects(() => claudeInstaller.install({ home, packageRoot: packageB }), /ownership cannot be proven/);
		assert.equal(await readlink(linkPath), packageA);

		// Live manifest-less and malformed skill targets are unowned collisions.
		await writeFile(join(manifestless, "SKILL.md"), "user-managed skill\n", "utf8");
		await mkdir(join(malformed, ".claude-plugin"), { recursive: true });
		await writeFile(join(malformed, ".claude-plugin", "plugin.json"), "{malformed", "utf8");
		for (const target of [manifestless, malformed]) {
			await rm(linkPath);
			await symlink(target, linkPath, "dir");
			await assert.rejects(() => claudeInstaller.install({ home, packageRoot: packageB }), /ownership cannot be proven/);
			assert.equal(await readlink(linkPath), target, "unowned skill link preserved");
		}

		// A foreign plugin behind the same name is a collision, not an upgrade.
		await mkdir(join(foreign, ".claude-plugin"), { recursive: true });
		await writeFile(join(foreign, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "other-plugin" }), "utf8");
		await rm(linkPath);
		await symlink(foreign, linkPath, "dir");
		await assert.rejects(() => claudeInstaller.install({ home, packageRoot: packageB }), /ownership cannot be proven/);
		assert.equal(await readlink(linkPath), foreign, "foreign link preserved");

		// A real directory is never replaced.
		await rm(linkPath);
		await mkdir(linkPath, { recursive: true });
		await assert.rejects(() => claudeInstaller.install({ home, packageRoot: packageB }), /not a symlink/);
		assert.ok((await lstat(linkPath)).isDirectory());

		// A package without a manifest cannot be installed as a plugin.
		await rm(linkPath, { recursive: true, force: true });
		await assert.rejects(() => claudeInstaller.install({ home, packageRoot: foreign }), /Unexpected plugin name/);
	} finally {
		for (const dir of [home, packageA, packageB, foreign, manifestless, malformed]) {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("the shipped plugin manifest, hooks, MCP config, and commands are consistent", async () => {
	const packageRoot = join(import.meta.dirname, "..");
	const manifest = JSON.parse(await readFile(join(packageRoot, ".claude-plugin", "plugin.json"), "utf8"));
	assert.equal(manifest.name, "audit-trail");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.version, pkg.version, "Claude manifest version must track package.json");

	const hooks = JSON.parse(await readFile(join(packageRoot, manifest.hooks), "utf8"));
	const hookCommands = [
		...hooks.hooks.SessionStart.flatMap((group: any) => group.hooks),
		...hooks.hooks.PreToolUse.flatMap((group: any) => group.hooks),
	];
	assert.ok(hookCommands.length >= 2);
	for (const hook of hookCommands) {
		assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/audit-trail" claude-hook$/);
	}
	assert.match(hooks.hooks.PreToolUse[0].matcher, /Write\|Edit/);

	const mcp = JSON.parse(await readFile(join(packageRoot, manifest.mcpServers), "utf8"));
	assert.equal(mcp.mcpServers["audit-trail"].command, "${CLAUDE_PLUGIN_ROOT}/bin/audit-trail");
	assert.deepEqual(mcp.mcpServers["audit-trail"].args, ["mcp", "--harness", "claude"]);

	for (const name of ["audit-start", "audit-resume", "audit-reopen", "audit-status", "audit-review", "audit-abandon", "audit-rollover", "audit-publish", "audit-close"]) {
		const command = await readFile(join(packageRoot, manifest.commands, `${name}.md`), "utf8");
		assert.match(command, /^---\ndescription: /, `${name} has frontmatter`);
		assert.match(command, new RegExp(`${name.replace("-", "_")} tool`), `${name} instructs its tool`);
	}
	// The launcher referenced by hooks and MCP config exists in the checkout.
	await lstat(join(packageRoot, "bin", "audit-trail"));
});
