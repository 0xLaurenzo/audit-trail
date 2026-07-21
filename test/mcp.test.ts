import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRows } from "../src/core/audit-store.ts";
import type { CommandRunner } from "../src/core/ports.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { McpAuditServer } from "../src/mcp/server.ts";

const noGit: CommandRunner = {
	exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }),
};

function makeServer(root: string): McpAuditServer {
	return new McpAuditServer({
		workflow: new AuditWorkflow(root, noGit),
		runner: noGit,
		session: { harness: "mcp", id: "tester@host" },
		version: "test",
	});
}

function request(id: number, method: string, params?: object) {
	return { jsonrpc: "2.0" as const, id, method, params };
}

function resultOf(response: any): any {
	assert.ok(response, "response present");
	assert.equal(response.jsonrpc, "2.0");
	assert.equal(response.error, undefined);
	return response.result;
}

function textOf(result: any): string {
	return result.content.map((part: any) => part.text).join("\n");
}

test("mcp server initializes, lists tools, and drives the audit workflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		const server = makeServer(root);

		const init = resultOf(await server.handle(request(1, "initialize", { protocolVersion: "2024-11-05" })));
		assert.equal(init.protocolVersion, "2024-11-05");
		assert.equal(init.serverInfo.name, "audit-trail");
		assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);

		const tools = resultOf(await server.handle(request(2, "tools/list"))).tools;
		assert.deepEqual(
			tools.map((tool: any) => tool.name),
			["audit_start", "audit_decision", "audit_status", "audit_review", "audit_publish", "audit_close"],
		);

		const started = resultOf(
			await server.handle(request(3, "tools/call", { name: "audit_start", arguments: { task: "MCP Task" } })),
		);
		assert.match(textOf(started), /Started decision audit: .*mcp-task\.tsv/);

		const logged = resultOf(
			await server.handle(
				request(4, "tools/call", {
					name: "audit_decision",
					arguments: {
						phase: "mcp",
						origin: "implementation discovery",
						decision: "Serve MCP",
						why: "Deterministic tools over the shared workflow",
						confidence: "high",
						evidence: "src/mcp/server.ts:1",
						result: "verified",
					},
				}),
			),
		);
		assert.match(textOf(logged), /^Logged D0001: Serve MCP$/);
		const rows = await readRows(join(root, ".audit", "mcp-task.tsv"));
		assert.equal(rows[0].session, "mcp/tester@host");

		const status = resultOf(await server.handle(request(5, "tools/call", { name: "audit_status", arguments: {} })));
		assert.match(textOf(status), /mcp-task: 1 rows \(1 active\)/);
		assert.match(textOf(status), /review: not run/);

		const close = resultOf(await server.handle(request(6, "tools/call", { name: "audit_close", arguments: {} })));
		assert.equal(close.isError, true);
		assert.match(textOf(close), /independent review not run/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("mcp server reports tool errors in-band and protocol errors as JSON-RPC errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		const server = makeServer(root);

		const badOrigin = resultOf(
			await server.handle(
				request(1, "tools/call", {
					name: "audit_decision",
					arguments: { phase: "x", origin: "vibes", decision: "d", why: "w", confidence: "high", evidence: "e", result: "open" },
				}),
			),
		);
		assert.equal(badOrigin.isError, true);
		assert.match(textOf(badOrigin), /No audit is active|Invalid origin/);

		const publish = resultOf(await server.handle(request(2, "tools/call", { name: "audit_publish", arguments: {} })));
		assert.equal(publish.isError, true);

		const unknownTool = resultOf(await server.handle(request(3, "tools/call", { name: "nope", arguments: {} })));
		assert.equal(unknownTool.isError, true);
		assert.match(textOf(unknownTool), /Unknown tool: nope/);

		const unknownMethod: any = await server.handle(request(4, "bogus/method"));
		assert.equal(unknownMethod.error.code, -32601);

		const missingName: any = await server.handle(request(5, "tools/call", {}));
		assert.equal(missingName.error.code, -32602);

		assert.equal(await server.handle({ jsonrpc: "1.0" } as any), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
