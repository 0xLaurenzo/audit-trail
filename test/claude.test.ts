import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../src/adapters/claude-hook.ts";
import { createClaudeSubprocessReviewer, selectClaudeReviewCandidates } from "../src/adapters/claude-reviewer.ts";
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

test("Claude reviewer selection is fixed to allowed Anthropic models", () => {
	assert.deepEqual(selectClaudeReviewCandidates(undefined, "claude-opus-5-5"), [
		{ model: "anthropic/claude-fable-5-2", mode: "cross-model" },
		{ model: "anthropic/claude-opus-5-5", mode: "same-model" },
		{ model: "anthropic/claude-fable-5-1", mode: "cross-model" },
		{ model: "anthropic/claude-fable-5", mode: "cross-model" },
	]);
	assert.deepEqual(selectClaudeReviewCandidates("claude-fable-5-fast", "claude-opus-5-5"), [
		{ model: "anthropic/claude-fable-5-fast", mode: "cross-model" },
	]);
	assert.throws(() => selectClaudeReviewCandidates("anthropic/claude-opus-4-8", "claude-opus-5-5"), /Unsupported review model/);
	assert.throws(() => selectClaudeReviewCandidates("openai/gpt-6.2-astra", "claude-opus-5-5"), /only anthropic/);
	// Serving variants of the working model must not be claimed as cross-model.
	for (const working of ["claude-opus-5-5-20260801", "claude-opus-5-5[1m]", "anthropic/claude-opus-5-5-fast"]) {
		assert.equal(selectClaudeReviewCandidates(undefined, working)[1].mode, "same-model", working);
	}
	assert.equal(selectClaudeReviewCandidates("claude-opus-5-5", "claude-opus-5")[0].mode, "cross-model", "a point release is a different model");
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
		model: "anthropic/claude-opus-5-5",
		mode: "cross-model",
		workingDirectory: "/repo",
	});
	assert.match(output, /VERDICT: approve/);
	assert.equal(calls.length, 2);
	const args = calls[1].args;
	assert.equal(calls[1].command, "claude");
	assert.equal(args[0], "-p");
	assert.deepEqual(args.slice(1, 3), ["--model", "claude-opus-5-5"], "provider prefix stripped for the claude CLI");
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

test("uninstall preserves a foreign link whose lossy UTF-8 decoding matches the receipt", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-claude-bytes-"));
	try {
		const packageRoot = join(home, "release-\uFFFD");
		await mkdir(join(packageRoot, ".claude-plugin"), { recursive: true });
		await writeFile(join(packageRoot, ".claude-plugin/plugin.json"), '{"name":"audit-trail"}');
		await claudeInstaller.install({ home, packageRoot });
		const link = join(home, ".claude/skills/audit-trail");
		await rm(link);
		const foreign = Buffer.concat([Buffer.from(join(home, "release-")), Buffer.from([0xff])]);
		await symlink(foreign, link);
		await assert.rejects(() => claudeInstaller.prepare({ home, packageRoot }, true), /ownership cannot be proven/);
		assert.deepEqual(await readlink(link, { encoding: "buffer" }), foreign);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
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

		// A recorded prior target can be upgraded without guessing ownership.
		const upgraded = await claudeInstaller.install({ home, packageRoot: packageB });
		assert.equal(upgraded.changed, true);
		assert.equal(await readlink(linkPath), packageB);

		// Normalizing this path before comparing would hide actual link drift.
		const alias = join(dirname(packageB), "alias-" + basename(home));
		const ambiguous = alias + "/../" + basename(packageB);
		await mkdir(join(home, "nested"));
		await mkdir(join(home, basename(packageB)));
		await symlink(join(home, "nested"), alias);
		try {
			await rm(linkPath);
			await symlink(ambiguous, linkPath);
			await assert.rejects(() => claudeInstaller.prepare({ home, packageRoot: packageB }, true), /ownership cannot be proven/);
			await rename(packageB, join(home, "offline"));
			await assert.rejects(() => claudeInstaller.prepare({ home, packageRoot: packageB }, true), /ownership cannot be proven/);
			await rename(join(home, "offline"), packageB);
			assert.equal(await readlink(linkPath), ambiguous);
		} finally {
			await rm(alias);
		}

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
	assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
	const hookCommands = hooks.hooks.SessionStart.flatMap((group: any) => group.hooks);
	assert.ok(hookCommands.length >= 1);
	for (const hook of hookCommands) {
		assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/audit-trail" claude-hook$/);
	}

	const mcp = JSON.parse(await readFile(join(packageRoot, manifest.mcpServers), "utf8"));
	assert.equal(mcp.mcpServers["audit-trail"].command, "${CLAUDE_PLUGIN_ROOT}/bin/audit-trail");
	assert.deepEqual(mcp.mcpServers["audit-trail"].args, ["mcp", "--harness", "claude"]);

	for (const name of ["audit-start", "audit-resume", "audit-reopen", "audit-status", "audit-review", "audit-abandon", "audit-publish", "audit-close"]) {
		const command = await readFile(join(packageRoot, manifest.commands, `${name}.md`), "utf8");
		assert.match(command, /^---\ndescription: /, `${name} has frontmatter`);
		assert.match(command, new RegExp(`${name.replace("-", "_")} tool`), `${name} instructs its tool`);
		if (name === "audit-review") {
			assert.ok(command.indexOf("anthropic/claude-fable-5") < command.indexOf("anthropic/claude-opus-5-5"));
			assert.match(command, /never supply or infer the mode yourself/i);
		}
	}
	// The launcher referenced by hooks and MCP config exists in the checkout.
	await lstat(join(packageRoot, "bin", "audit-trail"));
});
