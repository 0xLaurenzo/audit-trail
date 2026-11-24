import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { selectInstallers } from "../src/install/installers.ts";

test("native Codex refreshes its cached release and retries interrupted uninstall in the owning profile", {
	skip: spawnSync("codex", ["--version"]).status !== 0 && "codex CLI not installed",
}, async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-codex-retry-"));
	const bin = join(import.meta.dirname, "../bin/audit-trail");
	const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") };
	const exec = promisify(execFile);
	try {
		await mkdir(env.CODEX_HOME);
		await exec(bin, ["install", "codex"], { cwd: home, env });
		const version = JSON.parse(await readFile(join(import.meta.dirname, "../.codex-plugin/plugin.json"), "utf8")).version;
		const cached = join(env.CODEX_HOME, "plugins/cache/personal/audit-trail", version, "bin/audit-trail");
		assert.match((await exec(cached, ["help"], { cwd: home, env })).stdout, /Usage: audit-trail/);
		await assert.rejects(exec(cached, ["release-id"], { cwd: home, env }), /Unknown command/);
		const otherHome = join(home, ".codex-other");
		await mkdir(otherHome);
		const receipt = join(home, ".local/state/audit-trail/codex.json");
		const saved = await readFile(receipt);
		for (const verb of ["uninstall", "install"]) {
			await assert.rejects(exec(bin, [verb, "codex"], { cwd: home, env: { ...env, CODEX_HOME: otherHome } }), /profile differs/);
			assert.deepEqual(await readFile(receipt), saved);
			assert.ok((await lstat(join(home, "plugins/audit-trail"))).isSymbolicLink());
		}
		// Upgrade at the same manifest version: a different link alone does not prove
		// Codex refreshed the executable it launches from its cache.
		const release = join(home, "release-b");
		const checkout = join(import.meta.dirname, "..");
		for (const path of ["src", "bin", ".codex-plugin", ".mcp.json", "hooks", "skills", "package.json", "node_modules/jsonc-parser"]) {
			await cp(join(checkout, path), join(release, path), { recursive: true });
		}
		const launcher = join(release, "bin/audit-trail");
		const source = await readFile(launcher, "utf8");
		await writeFile(launcher, source.replace("const here =", 'if (process.argv[2] === "release-id") { console.log("B"); process.exit(0); }\nconst here ='));
		await exec(launcher, ["install", "codex"], { cwd: home, env });
		assert.equal((await exec(cached, ["release-id"], { cwd: home, env })).stdout.trim(), "B");
		assert.match((await exec(cached, ["help"], { cwd: home, env })).stdout, /Usage: audit-trail/);
		// Simulate interruption immediately after the native removal succeeds.
		await exec("codex", ["plugin", "remove", "audit-trail@personal"], { cwd: home, env });
		await exec(bin, ["uninstall", "codex"], { cwd: home, env });
		await assert.rejects(lstat(join(home, ".local/state/audit-trail/codex.json")), /ENOENT/);
		await assert.rejects(lstat(join(home, "plugins/audit-trail")), /ENOENT/);
		assert.deepEqual(JSON.parse(await readFile(join(home, ".agents/plugins/marketplace.json"), "utf8")).plugins, []);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("all preflights late collisions; repair, relocate and uninstall preserve unrelated configuration", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-lifecycle-"));
	const root = join(import.meta.dirname, "..");
	const command = join(home, ".config/opencode/commands/audit-status.md");
	const settings = join(home, ".pi/agent/settings.json");
	const marketplace = join(home, ".agents/plugins/marketplace.json");
	const other = { name: "other", local: true };
	try {
		await mkdir(dirname(command), { recursive: true });
		await mkdir(dirname(settings), { recursive: true });
		await mkdir(dirname(marketplace), { recursive: true });
		await writeFile(settings, '{ "extensions": [ /* keep */ ], "theme":"light" }');
		const metadata = '"large" : 9007199254740993';
		await writeFile(marketplace, `{"name":"personal","plugins":[${JSON.stringify(other)}],${metadata}}`);
		await writeFile(join(home, "codex"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\n', {mode: 0o755});
		const env = { ...process.env, HOME: home, PATH: home + ":" + process.env.PATH };
		delete (env as NodeJS.ProcessEnv).CODEX_HOME;
		const run = (verb: string) => promisify(execFile)(join(root, "bin/audit-trail"), [verb, "all"], {
			cwd: home, env,
		});
		await symlink(settings, command);
		await assert.rejects(run("install"), /symlink/);
		assert.doesNotMatch(await readFile(settings, "utf8"), /adapters/);
		await assert.rejects(lstat(join(home, ".claude")), /ENOENT/);
		assert.doesNotMatch(await readFile(join(home, "calls"), "utf8"), /plugin add/);
		await rm(command);
		await rm(join(home, ".config"), { recursive: true });
		await mkdir(join(home, "redirected"));
		await symlink(join(home, "redirected"), join(home, ".config"));
		await assert.rejects(run("install"), /configuration directory/);
		await assert.rejects(lstat(join(home, "redirected/opencode")), /ENOENT/);
		await assert.rejects(lstat(join(home, ".claude")), /ENOENT/);
		await rm(join(home, ".config"));
		const before = await readFile(marketplace, "utf8");
		const ambiguous = before.replace('"plugins":', '"plugins":[],"plugins":');
		await writeFile(marketplace, ambiguous);
		await assert.rejects(run("install"), /duplicate keys/);
		assert.equal(await readFile(marketplace, "utf8"), ambiguous);
		await writeFile(marketplace, before);
		await symlink(join(home, "redirected"), join(home, ".codex"));
		await assert.rejects(run("install"), /default Codex profile/);
		assert.doesNotMatch(await readFile(join(home, "calls"), "utf8"), /plugin add/);
		await assert.rejects(lstat(join(home, ".claude")), /ENOENT/);
		await rm(join(home, ".codex"));
		const wrongProfile = join(home, "not-a-profile");
		await writeFile(wrongProfile, "unrelated");
		await symlink(wrongProfile, wrongProfile + "-link");
		for (const selected of [wrongProfile, wrongProfile + "-link"]) {
			await assert.rejects(promisify(execFile)(join(root, "bin/audit-trail"), ["install", "all"], {
				cwd: home, env: { ...env, CODEX_HOME: selected },
			}), /resolved Codex profile/);
			assert.doesNotMatch(await readFile(settings, "utf8"), /adapters/);
			await assert.rejects(lstat(join(home, ".claude")), /ENOENT/);
			await assert.rejects(lstat(join(home, ".local/state/audit-trail/codex.json")), /ENOENT/);
			assert.doesNotMatch(await readFile(join(home, "calls"), "utf8"), /plugin add/);
		}
		await run("install");
		assert.ok((await readFile(marketplace, "utf8")).includes(metadata));
		await run("install");
		await rm(command);
		await rm(join(home, ".claude/skills/audit-trail"));
		await run("install");
		assert.match(await readFile(command, "utf8"), /audit-trail-managed/);

		const packageRoot = join(home, "release");
		for (const dir of [".claude-plugin", ".codex-plugin"]) await cp(join(root, dir), join(packageRoot, dir), { recursive: true });
		for (const installer of selectInstallers("all")) await installer.install({ home, packageRoot, runner: {
			exec: async () => ({code: 0, stdout: "", stderr: ""}),
		} });
		for (const link of [".claude/skills/audit-trail", "plugins/audit-trail"]) assert.equal(await readlink(join(home, link)), packageRoot);
		assert.ok((await readFile(settings, "utf8")).includes(packageRoot));
		assert.ok((await readFile(command.replace("commands/audit-status.md", "plugins/audit-trail.ts"), "utf8")).includes(packageRoot));

		await run("uninstall");
		await run("uninstall");
		assert.equal((await readFile(join(home, "calls"), "utf8")).match(/plugin remove audit-trail@personal/g)?.length, 1);
		const remaining = await readFile(marketplace, "utf8");
		assert.ok(remaining.includes(metadata));
		assert.deepEqual(JSON.parse(remaining).plugins, [other]);
		assert.match(await readFile(settings, "utf8"), /\/\* keep \*\//);
		assert.doesNotMatch(await readFile(settings, "utf8"), /adapters/);
		for (const path of [command, join(home, ".claude/skills/audit-trail"), join(home, "plugins/audit-trail")]) await assert.rejects(lstat(path), /ENOENT/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
