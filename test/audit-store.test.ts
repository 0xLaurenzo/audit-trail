import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditStore, parseRows } from "../src/core/audit-store.ts";
import { AUDIT_HEADER, type NewAuditRow } from "../src/core/types.ts";
import { activeRows, closeBlockers, summarize } from "../src/core/validation.ts";

const baseRow: NewAuditRow = {
	session: "session-1",
	entry: "entry-1",
	phase: "API",
	origin: "user requirement",
	decision: "Keep the schema",
	why: "Existing readers depend on it",
	alternatives: "Migrate the schema",
	confidence: "high",
	evidence: "src/schema.ts:1",
	result: "verified",
	supersedes: "",
};

test("AuditStore creates the canonical header and appends compatible rows", async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-store-test-"));
	try {
		const path = join(dir, "audit.tsv");
		const store = new AuditStore(undefined, () => new Date("2026-01-02T03:04:05.000Z"));
		await store.ensureLog(path);
		const first = await store.appendRow(path, { ...baseRow, decision: "=unsafe\tvalue\ncontinued" });
		const second = await store.appendRow(path, { ...baseRow, decision: "Replacement", supersedes: first.id });

		assert.equal(first.id, "D0001");
		assert.equal(second.id, "D0002");
		const raw = await readFile(path, "utf8");
		assert.ok(raw.startsWith(`${AUDIT_HEADER}\n`));
		assert.ok(raw.endsWith("\n"));
		const rows = parseRows(raw, path);
		assert.equal(rows[0].decision, "'=unsafe value continued");
		assert.deepEqual(activeRows(rows).map((row) => row.id), ["D0002"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AuditStore rejects malformed headers and unknown superseded IDs", async () => {
	assert.throws(() => parseRows("wrong\n", "fixture.tsv"), /Unexpected audit header/);
	const dir = await mkdtemp(join(tmpdir(), "audit-store-test-"));
	try {
		const path = join(dir, "audit.tsv");
		const store = new AuditStore();
		await assert.rejects(() => store.appendRow(path, { ...baseRow, supersedes: "D9999" }), /unknown decision/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("summary and close blockers ignore superseded decisions", () => {
	const old = { ...baseRow, id: "D0001", ts: "2026-01-01T00:00:00.000Z", result: "open" as const };
	const replacement = {
		...baseRow,
		id: "D0002",
		ts: "2026-01-01T00:01:00.000Z",
		supersedes: "D0001",
	};
	const rows = [old, replacement];
	assert.deepEqual(summarize(rows), {
		total: 2,
		active: 1,
		unresolved: [],
		lowConfidence: [],
		missingEvidence: [],
	});
	const review = {
		path: ".audit/task.review.md",
		sha256: "hash-1",
		mode: "cross-provider" as const,
		model: "other/reviewer",
		at: "2026-01-01T00:02:00.000Z",
	};
	assert.deepEqual(closeBlockers({ task: "task", logPath: "/tmp/audit.tsv", review }, rows, "hash-1"), []);
	assert.deepEqual(closeBlockers({ task: "task", logPath: "/tmp/audit.tsv" }, rows, "hash-1"), [
		"independent review not run",
	]);
	assert.deepEqual(closeBlockers({ task: "task", logPath: "/tmp/audit.tsv", review }, rows, "hash-2"), [
		"the audit changed after the last review",
	]);
});
