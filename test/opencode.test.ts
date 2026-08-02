import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	AuditTrailPlugin,
	listOpencodeModels,
	selectOpencodeReviewerCandidates,
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
		await assert.rejects(
			() => hooks.tool.audit_start.execute({ task: "opencode-adapter" }, toolContext),
			/Task name collision/,
		);
		const resumed = await hooks.tool.audit_resume.execute({ task: "OpenCode Adapter!" }, toolContext);
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
		assert.match(status, /OpenCode Adapter!: 1 rows \(1 active\)/);

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

test("reviewer candidates cover cross-provider, then cross-model, then the working model", () => {
	const working: ReviewModelRef = { provider: "anthropic", id: "claude-opus-4-8" };
	const catalog: ReviewModelRef[] = [
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "zai", id: "glm-5" },
	];

	// Automatic selection returns the full tier ordering so runtime failures
	// can fall through every candidate.
	assert.deepEqual(selectOpencodeReviewerCandidates(catalog, working), [
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
		{ model: "zai/glm-5", mode: "cross-provider" },
		{ model: "anthropic/claude-fable-5", mode: "cross-model" },
		{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
	]);

	assert.deepEqual(
		selectOpencodeReviewerCandidates(
			catalog.filter((model) => model.provider === "anthropic"),
			working,
		),
		[
			{ model: "anthropic/claude-fable-5", mode: "cross-model" },
			{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
		],
	);

	// Empty catalog falls back to the working model itself. Missing working
	// metadata must fail instead of inventing an independence mode.
	assert.deepEqual(selectOpencodeReviewerCandidates([], working), [
		{ model: "anthropic/claude-opus-4-8", mode: "same-model" },
	]);
	assert.throws(() => selectOpencodeReviewerCandidates([], undefined), /Working model metadata is unavailable/);
	assert.throws(() => selectOpencodeReviewerCandidates(catalog, undefined), /Working model metadata is unavailable/);
	assert.throws(
		() => selectOpencodeReviewerCandidates(catalog, undefined, "openai/gpt-5.6-sol"),
		/Working model metadata is unavailable/,
	);

	// Explicit requests stay pinned to a single candidate: honored when known,
	// rejected when the catalog disagrees, trusted verbatim without a catalog.
	assert.deepEqual(selectOpencodeReviewerCandidates(catalog, working, "openai/gpt-5.6-sol"), [
		{ model: "openai/gpt-5.6-sol", mode: "cross-provider" },
	]);
	assert.throws(() => selectOpencodeReviewerCandidates(catalog, working, "mistral/large-3"), /unavailable/);
	assert.deepEqual(selectOpencodeReviewerCandidates([], working, "zai/glm-5"), [
		{ model: "zai/glm-5", mode: "cross-provider" },
	]);
	assert.throws(() => selectOpencodeReviewerCandidates(catalog, working, "not-a-model"), /provider\/model/);
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
		assert.match(shim, /audit-trail-managed:v1/);
		assert.match(shim, /export \{ AuditTrailPlugin \} from "\/opt\/audit-trail\/src\/adapters\/opencode\.ts"/);
		for (const name of ["audit-start", "audit-resume", "audit-reopen", "audit-status", "audit-review", "audit-publish", "audit-close"]) {
			const command = await readFile(join(configDir, "commands", `${name}.md`), "utf8");
			assert.match(command, /^---\ndescription: /, `${name} has frontmatter`);
			assert.match(command, /audit-trail-managed:v1/, `${name} has an ownership marker`);
			assert.match(command, new RegExp(`${name.replace("-", "_")} tool`), `${name} instructs its tool`);
		}

		// Unrelated user files survive reinstallation.
		await writeFile(join(configDir, "commands", "my-command.md"), "mine\n", "utf8");
		await writeFile(join(configDir, "plugins", "other-plugin.ts"), "export {}\n", "utf8");

		const second = await opencodeInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(second.changed, false);
		assert.match(second.message, /already installed/);

		// A managed shim from an older packageRoot is regenerated.
		const third = await opencodeInstaller.install({ home, packageRoot: "/new/audit-trail" });
		assert.equal(third.changed, true);
		assert.match(
			await readFile(join(configDir, "plugins", "audit-trail.ts"), "utf8"),
			/export \{ AuditTrailPlugin \} from "\/new\/audit-trail\/src\/adapters\/opencode\.ts"/,
		);
		const fourth = await opencodeInstaller.install({ home, packageRoot: "/new/audit-trail" });
		assert.equal(fourth.changed, false);

		assert.equal(await readFile(join(configDir, "commands", "my-command.md"), "utf8"), "mine\n");
		assert.equal(await readFile(join(configDir, "plugins", "other-plugin.ts"), "utf8"), "export {}\n");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("opencode installer rejects unowned same-name collisions before writing anything", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-opencode-collision-"));
	try {
		const configDir = join(home, ".config", "opencode");
		const pluginPath = join(configDir, "plugins", "audit-trail.ts");
		const commandPath = join(configDir, "commands", "audit-review.md");
		await mkdir(join(configDir, "plugins"), { recursive: true });
		await mkdir(join(configDir, "commands"), { recursive: true });
		await writeFile(pluginPath, "export const MyAuditTrail = {}\n", "utf8");
		await writeFile(commandPath, "---\ndescription: My command\n---\nDo something else.\n", "utf8");

		await assert.rejects(
			() => opencodeInstaller.install({ home, packageRoot: "/opt/audit-trail" }),
			(error: Error) =>
				/unmanaged|not managed/.test(error.message) &&
				error.message.includes(pluginPath) &&
				error.message.includes(commandPath),
		);
		assert.equal(await readFile(pluginPath, "utf8"), "export const MyAuditTrail = {}\n");
		assert.equal(await readFile(commandPath, "utf8"), "---\ndescription: My command\n---\nDo something else.\n");
		await assert.rejects(() => readFile(join(configDir, "commands", "audit-start.md"), "utf8"), /ENOENT/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("opencode installer migrates exact pre-marker files emitted by the initial adapter", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-opencode-legacy-"));
	try {
		const configDir = join(home, ".config", "opencode");
		const pluginPath = join(configDir, "plugins", "audit-trail.ts");
		await mkdir(join(configDir, "plugins"), { recursive: true });
		await mkdir(join(configDir, "commands"), { recursive: true });
		await writeFile(
			pluginPath,
			'// Managed by `audit-trail install opencode`; edits are overwritten on reinstall.\nexport { AuditTrailPlugin } from "/old/src/adapters/opencode.ts";\n',
			"utf8",
		);
		await writeFile(
			join(configDir, "commands", "audit-status.md"),
			"---\ndescription: Show decision-audit status and unresolved decision IDs\n---\nCall the audit_status tool with no arguments and report its output verbatim.\n",
			"utf8",
		);
		const result = await opencodeInstaller.install({ home, packageRoot: "/new/audit-trail" });
		assert.equal(result.changed, true);
		assert.match(await readFile(pluginPath, "utf8"), /audit-trail-managed:v1/);
		assert.match(await readFile(join(configDir, "commands", "audit-status.md"), "utf8"), /audit-trail-managed:v1/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("installed-version smoke test resolves the adapter from a staged artifact, not checkout node_modules", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-opencode-smoke-"));
	const worktree = await mkdtemp(join(tmpdir(), "audit-opencode-smoke-wt-"));
	const packageRoot = await mkdtemp(join(tmpdir(), "audit-opencode-installed-"));
	try {
		const checkout = join(import.meta.dirname, "..");
		// Match the runtime shape shipped by Nix: package sources plus only the
		// adapter's declared runtime dependency graph. Because packageRoot is a
		// sibling under /tmp, module resolution cannot fall back to checkout
		// node_modules and hide a missing installed dependency.
		await cp(join(checkout, "src"), join(packageRoot, "src"), { recursive: true });
		await cp(join(checkout, "package.json"), join(packageRoot, "package.json"));
		await mkdir(join(packageRoot, "node_modules", "@opencode-ai"), { recursive: true });
		await cp(
			join(checkout, "node_modules", "@opencode-ai", "plugin"),
			join(packageRoot, "node_modules", "@opencode-ai", "plugin"),
			{ recursive: true },
		);
		await cp(join(checkout, "node_modules", "zod"), join(packageRoot, "node_modules", "zod"), { recursive: true });
		await cp(join(checkout, "node_modules", "jsonc-parser"), join(packageRoot, "node_modules", "jsonc-parser"), {
			recursive: true,
		});
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
		await rm(packageRoot, { recursive: true, force: true });
	}
});
