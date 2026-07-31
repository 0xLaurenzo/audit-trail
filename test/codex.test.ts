import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { handleCodexHook } from "../src/adapters/codex-hook.ts";
import { codexMcpOptions } from "../src/adapters/codex-mcp.ts";
import { createCodexSubprocessReviewer, selectCodexReviewCandidates } from "../src/adapters/codex-reviewer.ts";
import { codexSessionStatePath, readCodexSessionState } from "../src/adapters/codex-session.ts";
import type { CommandRunner, ExecResult } from "../src/core/ports.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { codexInstaller } from "../src/install/installers.ts";
import { McpAuditServer } from "../src/mcp/server.ts";

const execFileAsync = promisify(execFile);
const noGit: CommandRunner = { exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }) };

async function callInstalledMcp(executable: string, cwd: string, worktree: string): Promise<string> {
	return new Promise((resolveCall, rejectCall) => {
		const child = spawn(executable, ["-C", worktree, "mcp", "--harness", "codex"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill();
			rejectCall(new Error(`installed MCP timed out: ${stderr}`));
		}, 5_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
				let message: any;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id !== 2) continue;
				clearTimeout(timeout);
				child.kill();
				resolveCall(message.result?.content?.[0]?.text ?? JSON.stringify(message));
				return;
			}
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			rejectCall(error);
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
		);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "audit_status", arguments: {} } })}\n`,
		);
	});
}

function codexCliRunner(calls: string[][] = []): CommandRunner {
	return {
		exec: async (command, args) => {
			calls.push([command, ...args]);
			if (command === "codex" && args[0] === "--version") return { code: 0, stdout: "codex-cli 0.133.0", stderr: "" };
			if (command === "codex" && args[0] === "plugin" && args[1] === "add") return { code: 0, stdout: "added", stderr: "" };
			return { code: 1, stdout: "", stderr: "unexpected command" };
		},
	};
}

test("Codex SessionStart records metadata and injects active-audit guidance", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-codex-hook-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-codex-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	const payload = {
		hook_event_name: "SessionStart",
		session_id: "codex-session-1",
		transcript_path: "/tmp/codex-transcript.jsonl",
		model: "gpt-5.6-sol",
		cwd: root,
		source: "startup",
	};
	try {
		const idle = await handleCodexHook(JSON.stringify(payload), () => noGit, env);
		assert.equal(idle.exitCode, 0);
		assert.equal(idle.output, undefined);
		const recorded = await readCodexSessionState(root, env);
		assert.equal(recorded?.sessionId, "codex-session-1");
		assert.equal(recorded?.model, "gpt-5.6-sol");
		assert.equal(recorded?.transcriptPath, "/tmp/codex-transcript.jsonl");
		assert.equal(codexSessionStatePath(root, env).startsWith(stateHome), true);

		await new AuditWorkflow(root, noGit).start("codex-hook", { harness: "pi", id: "earlier" });
		const active = await handleCodexHook(JSON.stringify(payload), () => noGit, env);
		const output = JSON.parse(active.output!);
		assert.match(output.hookSpecificOutput.additionalContext, /Active decision audit/);
		assert.match(output.hookSpecificOutput.additionalContext, /audit_decision tool/);
		assert.equal((await handleCodexHook("{bad", () => noGit, env)).exitCode, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("Codex PreToolUse protects managed files, symlink aliases, and unreadable audit state", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-codex-guard-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-codex-guard-state-"));
	const env = { XDG_STATE_HOME: stateHome };
	const hook = (path: string) =>
		handleCodexHook(
			JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "apply_patch",
				tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` },
				cwd: root,
			}),
			() => noGit,
			env,
		);
	try {
		const { state } = await new AuditWorkflow(root, noGit).start("guard", { harness: "codex", id: "s" });
		const denied = JSON.parse((await hook(state.logPath)).output!);
		assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		const alias = join(root, "audit.tsv");
		await symlink(state.logPath, alias);
		assert.equal(JSON.parse((await hook(alias)).output!).hookSpecificOutput.permissionDecision, "deny");
		assert.equal((await hook(join(root, "src", "ok.ts"))).output, undefined);

		await writeFile(join(root, ".audit", "active.json"), "{bad", "utf8");
		const failClosed = JSON.parse((await hook(join(root, ".audit", "other.tsv"))).output!);
		assert.match(failClosed.hookSpecificOutput.permissionDecisionReason, /unreadable/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("Codex MCP resumes another harness audit, attributes rows, and derives truthful review mode", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-codex-mcp-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-codex-mcp-state-"));
	const transcript = join(root, "transcript.jsonl");
	const env = { XDG_STATE_HOME: stateHome };
	const calls: string[][] = [];
	const codexRunner: CommandRunner = {
		exec: async (command, args): Promise<ExecResult> => {
			calls.push([command, ...args]);
			if (args[0] === "--version") return { code: 0, stdout: "codex-cli 0.133.0", stderr: "" };
			const outputPath = args[args.indexOf("--output-last-message") + 1];
			await writeFile(outputPath, "No flags\nVERDICT: approve\n", "utf8");
			return { code: 0, stdout: "progress ignored", stderr: "" };
		},
	};
	try {
		await writeFile(transcript, "{}\n", "utf8");
		const workflow = new AuditWorkflow(root, noGit);
		await workflow.start("shared", { harness: "pi", id: "pi-session" });
		await handleCodexHook(
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "codex-session-9",
				transcript_path: transcript,
				model: "gpt-working",
				cwd: root,
			}),
			() => noGit,
			env,
		);
		const server = new McpAuditServer({
			workflow,
			runner: noGit,
			...codexMcpOptions(root, codexRunner, "fallback", env),
		});
		assert.match(await server.call("audit_start", { task: "shared" }), /Resumed/);
		await server.call("audit_decision", {
			phase: "codex",
			origin: "implementation discovery",
			decision: "Codex joined the shared audit",
			why: "Cross-harness state is shared",
			confidence: "high",
			evidence: "test/codex.test.ts",
			result: "verified",
		});
		const row = (await workflow.rows((await workflow.active())!))[0];
		assert.equal(row.session, "codex/codex-session-9");
		await server.call("audit_review", { model: "gpt-reviewer" });
		const checkpoint = (await workflow.active())?.review;
		assert.equal(checkpoint?.model, "openai/gpt-reviewer");
		assert.equal(checkpoint?.mode, "cross-model");
		const invocation = calls.find((call) => call[1] === "exec")!;
		assert.ok(invocation.includes("--ignore-user-config"));
		assert.ok(invocation.includes("--ephemeral"));
		assert.ok(invocation.includes("read-only"));
		assert.match(invocation.at(-1)!, new RegExp(transcript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

		const listed: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const schema = listed.result.tools.find((tool: any) => tool.name === "audit_review").inputSchema;
		assert.equal(schema.required, undefined);
		assert.deepEqual(Object.keys(schema.properties), ["model"]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("Codex reviewer selection and subprocess enforce truthful isolated execution", async () => {
	assert.deepEqual(selectCodexReviewCandidates(undefined, "gpt-work"), [
		{ model: "openai/gpt-work", mode: "same-model" },
	]);
	assert.deepEqual(selectCodexReviewCandidates("openai/gpt-other", "gpt-work"), [
		{ model: "openai/gpt-other", mode: "cross-model" },
	]);
	assert.throws(() => selectCodexReviewCandidates("anthropic/claude", "gpt-work"), /OpenAI/);
	assert.throws(() => selectCodexReviewCandidates(undefined, undefined), /SessionStart/);

	const calls: string[][] = [];
	const runner: CommandRunner = {
		exec: async (command, args) => {
			calls.push([command, ...args]);
			if (args[0] === "--version") return { code: 0, stdout: "codex", stderr: "" };
			await writeFile(args[args.indexOf("--output-last-message") + 1], "Finding\nVERDICT: block\n", "utf8");
			return { code: 0, stdout: "untrusted progress", stderr: "" };
		},
	};
	const report = await createCodexSubprocessReviewer(runner).review({
		prompt: "Review",
		model: "openai/gpt-review",
		mode: "cross-model",
		workingDirectory: "/repo",
	});
	assert.match(report, /VERDICT: block/);
	const args = calls[1];
	assert.deepEqual(args.slice(0, 2), ["codex", "exec"]);
	assert.ok(args.includes("--ignore-user-config") && args.includes("--ephemeral"));
	assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
	assert.ok(!args.includes("openai/gpt-review"), "provider prefix is stripped");
	await assert.rejects(
		() => createCodexSubprocessReviewer(runner).review({ prompt: "x", model: "anthropic/x", mode: "cross-provider", workingDirectory: "/" }),
		/openai\/<model-id>/,
	);
});

test("Codex plugin bundle is internally consistent", async () => {
	const root = join(import.meta.dirname, "..");
	const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.equal(manifest.name, "audit-trail");
	assert.equal(manifest.version, pkg.version);
	assert.equal(manifest.skills, "./skills/");
	assert.equal(manifest.mcpServers, "./.mcp.json");
	const skill = await readFile(join(root, "skills", "audit-trail", "SKILL.md"), "utf8");
	assert.match(skill, /^---\nname: audit-trail\ndescription: .+\n---/);
	assert.match(skill, /audit_start/);
	const hooks = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8"));
	assert.match(hooks.hooks.SessionStart[0].matcher, /startup.*resume.*clear.*compact/);
	assert.equal(hooks.hooks.PreToolUse[0].matcher, "apply_patch|Edit|Write");
	for (const event of ["SessionStart", "PreToolUse"]) {
		assert.match(hooks.hooks[event][0].hooks[0].command, /\$\{PLUGIN_ROOT\}\/bin\/audit-trail.*codex-hook/);
	}
	const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
	assert.deepEqual(mcp.mcpServers["audit-trail"], {
		command: "./bin/audit-trail",
		args: ["mcp", "--harness", "codex"],
		cwd: ".",
	});
});

test("Codex installer is idempotent, preserves unrelated marketplace entries, and refuses collisions", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-codex-install-"));
	const calls: string[][] = [];
	const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
	try {
		await mkdir(join(home, ".agents", "plugins"), { recursive: true });
		await writeFile(
			marketplacePath,
			JSON.stringify({
				name: "personal-team",
				interface: { displayName: "My plugins" },
				plugins: [{ name: "other", source: { source: "local", path: "./plugins/other" } }],
			}),
			"utf8",
		);
		const ctx = { home, packageRoot: join(import.meta.dirname, ".."), runner: codexCliRunner(calls) };
		const first = await codexInstaller.install(ctx);
		assert.equal(first.changed, true);
		assert.match(first.message, /\/hooks/);
		assert.equal((await lstat(join(home, "plugins", "audit-trail"))).isSymbolicLink(), true);
		assert.equal(resolve(join(home, "plugins"), await readlink(join(home, "plugins", "audit-trail"))), resolve(ctx.packageRoot));
		const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
		assert.equal(marketplace.interface.displayName, "My plugins");
		assert.equal(marketplace.plugins[0].name, "other");
		assert.equal(marketplace.plugins[1].name, "audit-trail");
		const second = await codexInstaller.install(ctx);
		assert.equal(second.changed, false);
		assert.deepEqual(calls.filter((call) => call[1] === "plugin").map((call) => call.at(-1)), [
			"audit-trail@personal-team",
			"audit-trail@personal-team",
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	const collisionHome = await mkdtemp(join(tmpdir(), "audit-codex-collision-"));
	try {
		await mkdir(join(collisionHome, ".agents", "plugins"), { recursive: true });
		await writeFile(
			join(collisionHome, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({ name: "personal", plugins: [{ name: "audit-trail", source: { source: "git", url: "other" } }] }),
			"utf8",
		);
		await assert.rejects(
			() => codexInstaller.install({ home: collisionHome, packageRoot: join(import.meta.dirname, ".."), runner: codexCliRunner() }),
			/unrelated audit-trail entry/,
		);
		await assert.rejects(() => lstat(join(collisionHome, "plugins", "audit-trail")), /ENOENT/);
	} finally {
		await rm(collisionHome, { recursive: true, force: true });
	}
});

test("staged Codex plugin launches the installed audit-trail binary without checkout dependencies", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "audit-codex-installed-"));
	const home = await mkdtemp(join(tmpdir(), "audit-codex-installed-home-"));
	const worktree = await mkdtemp(join(tmpdir(), "audit-codex-installed-wt-"));
	try {
		const checkout = join(import.meta.dirname, "..");
		for (const path of ["src", "bin", ".codex-plugin", "hooks", "skills"]) {
			await cp(join(checkout, path), join(packageRoot, path), { recursive: true });
		}
		for (const file of ["package.json", ".mcp.json"]) await cp(join(checkout, file), join(packageRoot, file));
		await codexInstaller.install({ home, packageRoot, runner: codexCliRunner() });
		const linkedRoot = resolve(join(home, "plugins"), await readlink(join(home, "plugins", "audit-trail")));
		const mcp = JSON.parse(await readFile(join(linkedRoot, ".mcp.json"), "utf8"));
		const mcpRoot = resolve(linkedRoot, mcp.mcpServers["audit-trail"].cwd);
		const executable = resolve(mcpRoot, mcp.mcpServers["audit-trail"].command);
		assert.match(await callInstalledMcp(executable, mcpRoot, worktree), /No audit is active/);
		const { stdout } = await execFileAsync(executable, ["-C", worktree, "start", "installed-codex"]);
		assert.match(stdout, /Started decision audit/);
		assert.match(await readFile(join(worktree, ".audit", "installed-codex.tsv"), "utf8"), /^id\tts\tsession/);
	} finally {
		await rm(packageRoot, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		await rm(worktree, { recursive: true, force: true });
	}
});
