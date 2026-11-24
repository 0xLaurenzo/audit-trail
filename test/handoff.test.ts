import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPiDriver } from "./helpers/harness-drivers.ts";

test("four adapter processes continue one Pi audit without losing rows", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-handoff-"));
	const driver = await createPiDriver(root);
	try {
		await driver.start("handoff");
		await driver.decide();
		const path = join(root, ".audit/handoff.tsv");
		const original = await readFile(path, "utf8");
		const harnesses = ["opencode", "claude", "codex", "pi"];
		const workers = await Promise.allSettled(harnesses.map(harness => promisify(execFile)(process.execPath, [
			"--experimental-strip-types", "--input-type=module", "-e", `
				import { CONFORMANCE_DRIVERS } from ${JSON.stringify(new URL("./helpers/harness-drivers.ts", import.meta.url).href)};
				const driver = await CONFORMANCE_DRIVERS[process.argv[1]](process.argv[2]);
				try {
					await driver.resume("handoff");
					for (let i = 0; i < 8; i++) await driver.decide({ decision: driver.harness + i });
				} finally { await driver.dispose(); }
			`, harness, root,
		])));
		for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
		assert.deepEqual((await readdir(join(root, ".audit"))).filter(name => name.endsWith(".tsv")), ["handoff.tsv"]);
		const tsv = await readFile(path, "utf8");
		assert.ok(tsv.startsWith(original));
		const rows = tsv.split("\n").slice(1, -1).map(line => line.split("\t"));
		assert.equal(rows.length, 33);
		rows.forEach((row, i) => {
			assert.equal(row.length, 13);
			assert.equal(row[0], "D" + String(i + 1).padStart(4, "0"));
		});
		for (const harness of harnesses) assert.equal(rows.slice(1).filter(row => row[2].startsWith(harness + "/")).length, 8);
	} finally {
		await driver.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
