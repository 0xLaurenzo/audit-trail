import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { piInstaller, selectInstallers } from "../src/install/installers.ts";

function piPaths(home: string) {
	const agentDir = join(home, ".pi", "agent");
	return {
		agentDir,
		settingsPath: join(agentDir, "settings.json"),
		recordPath: join(agentDir, "audit-trail", "installed.json"),
	};
}

async function assertMissing(path: string): Promise<void> {
	await assert.rejects(() => readFile(path), (error: any) => error?.code === "ENOENT");
}

test("pi installer minimally edits JSONC, preserves comments and trailing commas, and is idempotent", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const packageRoot = "/opt/audit-trail";
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	const original = `{
  // Keep this provider comment and formatting exactly.
  "defaultProvider": "openai",
  "extensions": [
    "/other/ext.ts", // unrelated extension
  ],
  "theme": "dark", // unrelated trailing comment
}
`;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, original, "utf8");

		const first = await piInstaller.install({ home, packageRoot });
		assert.equal(first.changed, true);
		const updated = await readFile(settingsPath, "utf8");
		assert.equal(updated, `{
  // Keep this provider comment and formatting exactly.
  "defaultProvider": "openai",
  "extensions": [
    "/other/ext.ts", // unrelated extension
    "/opt/audit-trail/src/adapters/pi.ts",
  ],
  "theme": "dark", // unrelated trailing comment
}
`);
		assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
			version: 1,
			managedEntries: [join(packageRoot, "src", "adapters", "pi.ts")],
		});

		const second = await piInstaller.install({ home, packageRoot });
		assert.equal(second.changed, false);
		assert.match(second.message, /already registered/);
		assert.equal(await readFile(settingsPath, "utf8"), updated, "idempotent install changes no settings bytes");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer never claims similarly named pre-sidecar entries", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath } = piPaths(home);
	const foreign = [
		"/work/fork-audit-trail/index.ts",
		"/tmp/pi-audit-trail-experiment/src/adapters/pi.ts",
	];
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ extensions: ["/other/ext.ts", ...foreign] }), "utf8");
		await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(settings.extensions, ["/other/ext.ts", ...foreign, "/opt/audit-trail/src/adapters/pi.ts"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer replaces only exact sidecar-recorded paths and retains the ownership history", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	const oldEntry = "/nix/store/old/share/pi-audit-trail/src/adapters/pi.ts";
	const newEntry = "/nix/store/new/share/pi-audit-trail/src/adapters/pi.ts";
	try {
		await mkdir(dirname(recordPath), { recursive: true });
		await writeFile(settingsPath, `{
  "extensions": [
    "/other/ext.ts",
    "${oldEntry}" // retain this comment while replacing only the string
  ]
}
`, "utf8");
		await writeFile(recordPath, `${JSON.stringify({ version: 1, managedEntries: [oldEntry] }, null, 2)}\n`, "utf8");

		const result = await piInstaller.install({ home, packageRoot: "/nix/store/new/share/pi-audit-trail" });
		assert.equal(result.changed, true);
		assert.match(result.message, /replacing recorded/);
		const updated = await readFile(settingsPath, "utf8");
		assert.ok(updated.includes(`"${newEntry}" // retain this comment`));
		assert.ok(!updated.includes(oldEntry));
		assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
			version: 1,
			managedEntries: [oldEntry, newEntry],
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer adopts an exact existing registration without changing settings bytes", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	const content = "{\"extensions\":[\"/opt/audit-trail/src/adapters/pi.ts\"]}";
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, content, "utf8");
		const result = await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(result.changed, true, "creating the ownership record is an installation change");
		assert.match(result.message, /recorded ownership/);
		assert.equal(await readFile(settingsPath, "utf8"), content);
		assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")).managedEntries, [
			"/opt/audit-trail/src/adapters/pi.ts",
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer preflights invalid settings before creating ownership state", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, "{\n  \"extensions\": [1,]\n}\n", "utf8");
		await assert.rejects(
			() => piInstaller.install({ home, packageRoot: "/opt/audit-trail" }),
			/extensions.*array of strings.*Add .* manually/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), "{\n  \"extensions\": [1,]\n}\n");
		await assertMissing(recordPath);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer rejects declaratively managed settings symlinks without mutation", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	const declaration = join(home, "declared-settings.json");
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(declaration, "{\"extensions\":[]}", "utf8");
		await symlink(declaration, settingsPath);
		await assert.rejects(
			() => piInstaller.install({ home, packageRoot: "/opt/audit-trail" }),
			/symlink.*declaratively managed.*Add .* manually/,
		);
		assert.equal(await readFile(declaration, "utf8"), "{\"extensions\":[]}");
		await assertMissing(recordPath);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer rejects malformed ownership records before changing settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	try {
		await mkdir(dirname(recordPath), { recursive: true });
		await writeFile(settingsPath, "{\"extensions\":[]}", "utf8");
		await writeFile(recordPath, "{not-json", "utf8");
		await assert.rejects(
			() => piInstaller.install({ home, packageRoot: "/opt/audit-trail" }),
			/malformed Pi installer ownership record.*move or remove/i,
		);
		assert.equal(await readFile(settingsPath, "utf8"), "{\"extensions\":[]}");
		assert.equal(await readFile(recordPath, "utf8"), "{not-json");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer rejects an ownership-directory collision before changing settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	const { agentDir, settingsPath, recordPath } = piPaths(home);
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, "{\"extensions\":[]}", "utf8");
		await writeFile(dirname(recordPath), "unrelated user file", "utf8");
		await assert.rejects(
			() => piInstaller.install({ home, packageRoot: "/opt/audit-trail" }),
			/ownership directory.*not an installer-owned regular directory/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), "{\"extensions\":[]}");
		assert.equal(await readFile(dirname(recordPath), "utf8"), "unrelated user file");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("pi installer creates settings and ownership state from scratch", async () => {
	const home = await mkdtemp(join(tmpdir(), "audit-install-test-"));
	try {
		const result = await piInstaller.install({ home, packageRoot: "/opt/audit-trail" });
		assert.equal(result.changed, true);
		const { settingsPath, recordPath } = piPaths(home);
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(settings.extensions, [join("/opt/audit-trail", "src", "adapters", "pi.ts")]);
		assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")).managedEntries, [
			join("/opt/audit-trail", "src", "adapters", "pi.ts"),
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("harness registry resolves shipped targets and rejects unknown ones", () => {
	assert.deepEqual(
		selectInstallers("all").map((installer) => installer.harness),
		["pi", "claude", "codex", "opencode"],
	);
	assert.equal(selectInstallers("claude")[0].harness, "claude");
	assert.equal(selectInstallers("codex")[0].planned, undefined, "Codex is a shipped installer, not a placeholder");
	assert.throws(() => selectInstallers("zed"), /Unknown harness: zed/);
});
