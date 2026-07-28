import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	AuditTrailPlugin,
	listOpencodeModels,
	selectOpencodeReviewer,
	type ReviewModelRef,
} from "../src/adapters/opencode.ts";
import { opencodeInstaller } from "../src/install/installers.ts";

const stubClient = {
	config: {
		providers: async () => ({
			data: {
				providers: [
					{ id: "anthropic", models: { "claude-opus-4-8": {}, "claude-fable-5": {} } },
					{ id: "openai", models: { "gpt-5.6-sol": {} } },
				],
			},
		}),
	},
};

const toolContext = { sessionID: "ses_test1", messageID: "msg_0001" };

test("opencode plugin lifecycle: start, decision attribution, status, guidance, and guard", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-opencode-test-"));
	try {
		const hooks: any = await AuditTrailPlugin({ client: stubClient, directory: root });

		// No active audit: the system transform stays silent.
		const silent = { system: [] as string[] };
		await hooks["experimental.chat.system.transform"]({}, silent);
		assert.deepEqual(silent.system, []);

		const started = await hooks.tool.audit_start.execute({ task: "OpenCode Adapter!" }, toolContext);
		assert.match(started, /Started decision audit: .*opencode-adapter\.tsv/);
		const resumed = await hooks.tool.audit_start.execute({ task: "opencode-adapter" }, toolContext);
		assert.match(resumed, /Resumed decision audit/);

		const logged = await hooks.tool.audit_decision.execute(
			{
				phase: "adapter",
				origin: "implementation discovery",
				decision: "Use native plugin tools",
				why: "Because attribution",
				confidence: "high",
				evidence: "src/adapters/opencode.ts:1",
				result: "verified",
			},
			toolContext,
		);
		assert.match(logged, /Logged D0001/);
		const tsv = await readFile(join(root, ".audit", "opencode-adapter.tsv"), "utf8");
		const row = tsv.trim().split("\n").at(-1)!.split("\t");
		assert.equal(row[2], "opencode/ses_test1", "harness-qualified session cell");
		assert.equal(row[3], "msg_0001", "entry records the message ID");

		const status = await hooks.tool.audit_status.execute({}, toolContext);
		assert.match(status, /opencode-adapter: 1 rows \(1 active\)/);

		// Active audit: guidance is injected into the system prompt.
		const output = { system: [] as string[] };
		await hooks["experimental.chat.system.transform"]({}, output);
		assert.equal(output.system.length, 1);
		assert.match(output.system[0], /Active decision audit/);
		assert.match(output.system[0], /audit_decision/);

		// Extension-managed audit files are write-protected; other files are not.
		await assert.rejects(
			() =>
				hooks["tool.execute.before"](
					{ tool: "write", sessionID: "ses_test1", callID: "call1" },
					{ args: { filePath: join(root, ".audit", "opencode-adapter.tsv"), content: "tamper" } },
				),
			/extension-managed/,
		);
		await assert.rejects(
			() =>
				hooks["tool.execute.before"](
					{ tool: "edit", sessionID: "ses_test1", callID: "call2" },
					{ args: { filePath: join(root, ".audit", "active.json") } },
				),
			/extension-managed/,
		);
		await hooks["tool.execute.before"](
			{ tool: "write", sessionID: "ses_test1", callID: "call3" },
			{ args: { filePath: join(root, "src", "other.ts"), content: "fine" } },
		);
		await hooks["tool.execute.before"](
			{ tool: "read", sessionID: "ses_test1", callID: "call4" },
			{ args: { filePath: join(root, ".audit", "opencode-adapter.tsv") } },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unreadable active state fails closed for .audit writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-opencode-test-"));
	try {
		const hooks: any = await AuditTrailPlugin({ client: stubClient, directory: root });
		await hooks.tool.audit_start.execute({ task: "guarded" }, toolContext);
		await writeFile(join(root, ".audit", "active.json"), "{corrupt", "utf8");
		await assert.rejects(
			() =>
				hooks["tool.execute.before"](
					{ tool: "write", sessionID: "s", callID: "c" },
					{ args: { filePath: join(root, ".audit", "anything.tsv") } },
				),
			/unreadable/,
		);
		// Non-.audit writes stay allowed even with unreadable state.
		await hooks["tool.execute.before"](
			{ tool: "write", sessionID: "s", callID: "c" },
			{ args: { filePath: join(root, "src", "ok.ts") } },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewer selection prefers cross-provider, then cross-model, then the working model", () => {
	const working: ReviewModelRef = { provider: "anthropic", id: "claude-opus-4-8" };
	const catalog: ReviewModelRef[] = [
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.6-sol" },
	];

	const cross = selectOpencodeReviewer(catalog, working);
	assert.deepEqual(cross, { model: { provider: "openai", id: "gpt-5.6-sol" }, mode: "cross-provider" });

	const sameProvider = selectOpencodeReviewer(
		catalog.filter((model) => model.provider === "anthropic"),
		working,
	);
	assert.deepEqual(sameProvider, { model: { provider: "anthropic", id: "claude-fable-5" }, mode: "cross-model" });

	const onlyWorking = selectOpencodeReviewer([working], working);
	assert.deepEqual(onlyWorking, { model: working, mode: "same-model" });

	// Empty catalog falls back to the working model itself.
	assert.deepEqual(selectOpencodeReviewer([], working), { model: working, mode: "same-model" });
	assert.throws(() => selectOpencodeReviewer([], undefined), /No model is available/);

	// Explicit requests: honored when known, rejected when the catalog disagrees,
	// trusted verbatim when no catalog is available.
	assert.deepEqual(selectOpencodeReviewer(catalog, working, "openai/gpt-5.6-sol"), {
		model: { provider: "openai", id: "gpt-5.6-sol" },
		mode: "cross-provider",
	});
	assert.throws(() => selectOpencodeReviewer(catalog, working, "zai/glm-5"), /unavailable/);
	assert.deepEqual(selectOpencodeReviewer([], working, "zai/glm-5"), {
		model: { provider: "zai", id: "glm-5" },
		mode: "cross-provider",
	});
	assert.throws(() => selectOpencodeReviewer(catalog, working, "not-a-model"), /provider\/model/);
});

test("model listing tolerates SDK data envelopes and bare payloads", async () => {
	const wrapped = await listOpencodeModels(stubClient);
	assert.deepEqual(wrapped, [
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.6-sol" },
	]);
	const bare = await listOpencodeModels({
		config: { providers: async () => ({ providers: [{ id: "openai", models: { "gpt-5.6-sol": {} } }] }) },
	});
	assert.deepEqual(bare, [{ provider: "openai", id: "gpt-5.6-sol" }]);
	const broken = await listOpencodeModels({ config: { providers: async () => "nonsense" } });
	assert.deepEqual(broken, []);
});

test("opencode installer writes shim and commands idempotently without touching unrelated files", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-opencode-install-"));
	try {
		const configDir = join(home, ".config", "opencode");
		const first = await opencodeInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(first.changed, true);

		const shim = await readFile(join(configDir, "plugins", "audit-trail.ts"), "utf8");
		assert.match(shim, /export \{ AuditTrailPlugin \} from "\/opt\/audit-trail\/src\/adapters\/opencode\.ts"/);
		for (const name of ["audit-start", "audit-status", "audit-review", "audit-publish", "audit-close"]) {
			const command = await readFile(join(configDir, "commands", `${name}.md`), "utf8");
			assert.match(command, /^---\ndescription: /, `${name} has frontmatter`);
			assert.match(command, new RegExp(`${name.replace("-", "_")} tool`), `${name} instructs its tool`);
		}

		// Unrelated user files survive reinstallation.
		await writeFile(join(configDir, "commands", "my-command.md"), "mine\n", "utf8");
		await writeFile(join(configDir, "plugins", "other-plugin.ts"), "export {}\n", "utf8");

		const second = await opencodeInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(second.changed, false);
		assert.match(second.message, /already installed/);

		// A stale shim (older packageRoot) or edited command is regenerated.
		await writeFile(join(configDir, "plugins", "audit-trail.ts"), "stale\n", "utf8");
		const third = await opencodeInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(third.changed, true);
		assert.equal(await readFile(join(configDir, "plugins", "audit-trail.ts"), "utf8"), shim);

		assert.equal(await readFile(join(configDir, "commands", "my-command.md"), "utf8"), "mine\n");
		assert.equal(await readFile(join(configDir, "plugins", "other-plugin.ts"), "utf8"), "export {}\n");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("installed shim smoke test: the shim resolves the adapter and serves tool calls", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-opencode-smoke-"));
	const worktree = await mkdtemp(join(tmpdir(), "audit-opencode-smoke-wt-"));
	try {
		// Install against this checkout as the "installed" package root.
		const packageRoot = join(import.meta.dirname, "..");
		await opencodeInstaller.install({ home, packageRoot });
		const shimPath = join(home, ".config", "opencode", "plugins", "audit-trail.ts");
		const module: any = await import(pathToFileURL(shimPath).href);
		assert.equal(typeof module.AuditTrailPlugin, "function");
		const hooks = await module.AuditTrailPlugin({ client: stubClient, directory: worktree });
		const started = await hooks.tool.audit_start.execute({ task: "smoke" }, toolContext);
		assert.match(started, /Started decision audit/);
		const status = await hooks.tool.audit_status.execute({}, toolContext);
		assert.match(status, /smoke: 0 rows/);
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(worktree, { recursive: true, force: true });
	}
});
