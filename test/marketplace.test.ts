import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const checkout = join(import.meta.dirname, "..");

async function cliAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync(command, ["--version"], { timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

const hasCodex = await cliAvailable("codex");
const hasClaude = await cliAvailable("claude");

async function assertBarePluginRuns(cacheRoot: string): Promise<void> {
	await assert.rejects(() => readFile(join(cacheRoot, "node_modules", "jsonc-parser", "package.json")), "cache must be a bare clone");
	const bin = join(cacheRoot, "bin", "audit-trail");
	const help = await execFileAsync(bin, ["help"]);
	assert.match(help.stdout, /append-only decision auditing/);
	const worktree = await mkdtemp(join(tmpdir(), "audit-marketplace-wt-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-marketplace-state-"));
	try {
		for (const [command, payload] of [
			["claude-hook", { hook_event_name: "SessionStart", session_id: "mk-1", source: "startup", cwd: worktree }],
			["codex-hook", { hook_event_name: "SessionStart", session_id: "mk-2", cwd: worktree }],
		] as const) {
			await new Promise<void>((resolvePromise, reject) => {
				const child = execFile(bin, [command], { env: { ...process.env, XDG_STATE_HOME: stateHome } }, (error) =>
					error ? reject(new Error(`${command} failed: ${error.message}`)) : resolvePromise(),
				);
				child.stdin?.end(JSON.stringify(payload));
			});
		}
	} finally {
		await rm(worktree, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
}

/**
 * Marketplace installs (claude plugin marketplace add / codex plugin
 * marketplace add) produce bare git clones with no node_modules. Every plugin
 * surface — CLI, hooks, MCP — must run from such a clone unmodified; only the
 * `install` command may require declared dependencies, and it must say so.
 */
async function stageBareClone(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "audit-bare-clone-"));
	for (const path of ["src", "bin", "claude", "hooks", "skills", ".claude-plugin", ".codex-plugin", ".agents"]) {
		await cp(join(checkout, path), join(root, path), { recursive: true });
	}
	for (const file of ["package.json", ".mcp.json"]) await cp(join(checkout, file), join(root, file));
	// Git checkouts materialize the Codex marketplace plugin path as a symlink.
	await mkdir(join(root, "plugins"), { recursive: true });
	await symlink("..", join(root, "plugins", "audit-trail"), "dir");
	return root;
}

test("bare marketplace clone runs CLI, claude hook, and codex hook without node_modules", async () => {
	const root = await stageBareClone();
	const worktree = await mkdtemp(join(tmpdir(), "audit-bare-clone-wt-"));
	const stateHome = await mkdtemp(join(tmpdir(), "audit-bare-clone-state-"));
	const bin = join(root, "bin", "audit-trail");
	const env = { ...process.env, XDG_STATE_HOME: stateHome };
	try {
		const help = await execFileAsync(bin, ["help"]);
		assert.match(help.stdout, /append-only decision auditing/);

		for (const [command, payload] of [
			["claude-hook", { hook_event_name: "SessionStart", session_id: "bare-1", source: "startup", cwd: worktree }],
			["codex-hook", { hook_event_name: "SessionStart", session_id: "bare-2", cwd: worktree }],
		] as const) {
			await new Promise<void>((resolvePromise, reject) => {
				const child = execFile(bin, [command], { env }, (error) =>
					error ? reject(new Error(`${command} failed: ${error.message}`)) : resolvePromise(),
				);
				child.stdin?.end(JSON.stringify(payload));
			});
		}

		const start = await execFileAsync(bin, ["-C", worktree, "start", "bare-clone-smoke"]);
		assert.match(start.stdout, /Started decision audit/);

		// Only `install` needs declared dependencies; it must fail with guidance.
		await assert.rejects(
			() => execFileAsync(bin, ["install", "pi"]),
			(error: any) => /needs the package's declared dependencies/.test(error?.stderr ?? "") && error?.code === 1,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(worktree, { recursive: true, force: true });
		await rm(stateHome, { recursive: true, force: true });
	}
});

test("real codex CLI installs the plugin from the repository marketplace", { skip: !hasCodex && "codex CLI not installed" }, async () => {
	const root = await stageBareClone();
	const home = await mkdtemp(join(tmpdir(), "audit-codex-mkt-home-"));
	const env = { ...process.env, CODEX_HOME: home };
	try {
		await execFileAsync("codex", ["plugin", "marketplace", "add", root], { env, timeout: 60_000 });
		await execFileAsync("codex", ["plugin", "add", "audit-trail@audit-trail"], { env, timeout: 60_000 });
		const version = JSON.parse(await readFile(join(checkout, ".codex-plugin", "plugin.json"), "utf8")).version;
		await assertBarePluginRuns(join(home, "plugins", "cache", "audit-trail", "audit-trail", version));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("real claude CLI installs the plugin from the repository marketplace", { skip: !hasClaude && "claude CLI not installed" }, async () => {
	const root = await stageBareClone();
	const configDir = await mkdtemp(join(tmpdir(), "audit-claude-mkt-config-"));
	const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
	try {
		await execFileAsync("claude", ["plugin", "marketplace", "add", root], { env, timeout: 120_000 });
		await execFileAsync("claude", ["plugin", "install", "audit-trail@audit-trail"], { env, timeout: 120_000 });
		const version = JSON.parse(await readFile(join(checkout, ".claude-plugin", "plugin.json"), "utf8")).version;
		await assertBarePluginRuns(join(configDir, "plugins", "cache", "audit-trail", "audit-trail", version));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(configDir, { recursive: true, force: true });
	}
});

test("claude marketplace manifest exposes the repository root plugin", async () => {
	const marketplace = JSON.parse(await readFile(join(checkout, ".claude-plugin", "marketplace.json"), "utf8"));
	const plugin = JSON.parse(await readFile(join(checkout, ".claude-plugin", "plugin.json"), "utf8"));
	assert.equal(marketplace.name, "audit-trail", "marketplace name is the claude plugin install suffix");
	assert.equal(marketplace.plugins.length, 1);
	assert.equal(marketplace.plugins[0].name, plugin.name);
	assert.equal(marketplace.plugins[0].source, "./");
});

test("codex marketplace manifest resolves its plugin path to the repository root", async () => {
	const marketplace = JSON.parse(await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8"));
	const plugin = JSON.parse(await readFile(join(checkout, ".codex-plugin", "plugin.json"), "utf8"));
	assert.equal(marketplace.name, "audit-trail", "marketplace name is the codex plugin add suffix");
	assert.equal(marketplace.plugins.length, 1);
	const entry = marketplace.plugins[0];
	assert.equal(entry.name, plugin.name);
	assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
	// Codex requires the plugin below the marketplace root; the checked-in
	// symlink routes that subdirectory back to the repository root.
	assert.equal(entry.source.source, "local");
	const linkPath = join(checkout, entry.source.path);
	assert.equal(resolve(dirname(linkPath), await readlink(linkPath)), resolve(checkout));
});
