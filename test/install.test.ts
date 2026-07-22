import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piInstaller, selectInstallers } from "../src/install/installers.ts";

test("pi installer registers the extension idempotently and preserves settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const packageRoot = "/opt/audit-trail";
	try {
		const settingsPath = join(home, ".pi", "agent", "settings.json");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ defaultProvider: "openai", extensions: ["/other/ext.ts"] }), "utf8");

		const first = await piInstaller.install({ home, packageRoot });
		assert.equal(first.changed, true);
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(settings.defaultProvider, "openai", "unrelated settings preserved");
		assert.deepEqual(settings.extensions, ["/other/ext.ts", join(packageRoot, "src", "adapters", "pi.ts")]);

		const second = await piInstaller.install({ home, packageRoot });
		assert.equal(second.changed, false);
		assert.match(second.message, /already registered/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer replaces stale audit-trail entries instead of duplicating them", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	try {
		const settingsPath = join(home, ".pi", "agent", "settings.json");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			settingsPath,
			JSON.stringify({
				extensions: [
					"/other/ext.ts",
					"/nix/store/abc-pi-audit-trail-0.3.0/share/pi-audit-trail/index.ts",
					"/nix/store/def-pi-audit-trail-0.3.0/share/pi-audit-trail/src/adapters/pi.ts",
				],
			}),
			"utf8",
		);
		const result = await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(result.changed, true);
		assert.match(result.message, /replacing stale/);
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(settings.extensions, ["/other/ext.ts", join("/opt/audit-trail", "src", "adapters", "pi.ts")]);

		const again = await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(again.changed, false);
		assert.match(again.message, /already registered/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer creates settings from scratch", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	try {
		const result = await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(result.changed, true);
		const settings = JSON.parse(await readFile(join(home, ".pi", "agent", "settings.json"), "utf8"));
		assert.deepEqual(settings.extensions, [join("/opt/audit-trail", "src", "adapters", "pi.ts")]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("harness registry resolves targets and rejects unknown ones", async () => {
	assert.deepEqual(
		selectInstallers("all").map((installer) => installer.harness),
		["pi", "claude", "codex", "opencode"],
	);
	assert.equal(selectInstallers("codex")[0].harness, "codex");
	const planned = await selectInstallers("claude")[0].install({ home: "/none", packageRoot: "/none" });
	assert.equal(planned.changed, false);
	assert.match(planned.message, /issue #6/);
	assert.throws(() => selectInstallers("zed"), /Unknown harness: zed/);
});
