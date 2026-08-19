import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readRows } from "../src/core/audit-store.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";
import { McpAuditServer, serveStdio } from "../src/mcp/server.ts";
import { buildReviewOutputFixture } from "./helpers/review-output.ts";

const noGit: CommandRunner = {
	exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }),
};

const unusedReviewer: ReviewerPort = {
	review: async () => {
		throw new Error("reviewer must not run in this test");
	},
};

function makeServer(root: string, reviewer: ReviewerPort = unusedReviewer, runner: CommandRunner = noGit): McpAuditServer {
	return new McpAuditServer({
		workflow: new AuditWorkflow(root, runner),
		runner,
		reviewer,
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
		assert.equal(init.protocolVersion, "2024-11-05", "supported client version is echoed");
		assert.equal(init.serverInfo.name, "audit-trail");
		assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);

		const tools = resultOf(await server.handle(request(2, "tools/list"))).tools;
		assert.deepEqual(
			tools.map((tool: any) => tool.name),
			[
				"audit_start",
				"audit_resume",
				"audit_reopen",
				"audit_decision",
				"audit_status",
				"audit_review",
				"audit_rollover",
				"audit_publish",
				"audit_close",
			],
		);
		assert.equal(tools.find((tool: any) => tool.name === "audit_publish").inputSchema.properties.commentSetId.type, "string");
		const reviewModelDescription = tools.find((tool: any) => tool.name === "audit_review").inputSchema.properties.model.description;
		assert.ok(reviewModelDescription.indexOf("anthropic/claude-fable-5") < reviewModelDescription.indexOf("anthropic/claude-opus-5"));

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
		assert.match(textOf(status), /MCP Task: 1 rows \(1 active\)/);
		assert.match(textOf(status), /review: not run/);

		const close = resultOf(await server.handle(request(6, "tools/call", { name: "audit_close", arguments: {} })));
		assert.equal(close.isError, true);
		assert.match(textOf(close), /independent review not run/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP rollover requires provenance and full arguments", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		const server = makeServer(root);
		await server.call("audit_start", { task: "local task" });
		await assert.rejects(() => server.call("audit_rollover", { task: "local task" }), /Missing required argument: reason/);
		await assert.rejects(
			() => server.call("audit_rollover", { task: "local task", reason: "rebase" }),
			/no Git provenance/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP publish rejects a blocking review before invoking GitHub", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		let githubCalled = false;
		const git: CommandRunner = {
			exec: async (command, args) => {
				if (command === "gh") {
					githubCalled = true;
					return { code: 1, stdout: "", stderr: "GitHub must not run" };
				}
				const outputs: Record<string, string> = {
					"rev-parse --show-toplevel": root,
					"remote get-url origin": "git@github.com:owner/repo.git",
					"branch --show-current": "feature/task",
					"rev-parse HEAD": "abcdef1234567890",
					"status --porcelain": "",
				};
				const key = args.join(" ");
				return { code: key in outputs ? 0 : 1, stdout: outputs[key] ?? "", stderr: "" };
			},
		};
		const server = makeServer(
			root,
			{ review: async () => buildReviewOutputFixture({ sections: { auditFindings: "Finding." }, verdict: "block" }) },
			git,
		);
		await server.call("audit_start", { task: "task" });
		await server.call("audit_decision", {
			phase: "mcp", origin: "implementation discovery", decision: "decision", why: "because",
			confidence: "high", evidence: "test", result: "verified",
		});
		const review = await server.call("audit_review", { model: "provider/model", mode: "cross-model" });
		assert.match(review, /Review blocked the audit/);
		assert.match(review, /Reviewer findings:\nFinding\./);
		assert.match(review, /\.review\..*\.md/);
		assert.doesNotMatch(review, /VERDICT:/);
		await assert.rejects(() => server.call("audit_publish", { selector: "22" }), /last review did not approve/);
		assert.equal(githubCalled, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("initialize negotiates the protocol version", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		const server = makeServer(root);
		const echoed = resultOf(await server.handle(request(1, "initialize", { protocolVersion: "2025-06-18" })));
		assert.equal(echoed.protocolVersion, "2025-06-18");
		const unsupported = resultOf(await server.handle(request(2, "initialize", { protocolVersion: "1999-01-01" })));
		assert.equal(unsupported.protocolVersion, "2025-06-18", "falls back to the newest supported version");
		const missing = resultOf(await server.handle(request(3, "initialize")));
		assert.equal(missing.protocolVersion, "2025-06-18");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stdio transport frames responses and tolerates garbage lines", async () => {
	const root = await mkdtemp(join(tmpdir(), "audit-mcp-test-"));
	try {
		const server = makeServer(root);
		const input = new PassThrough();
		const output = new PassThrough();
		const served = serveStdio(server, input, output);
		input.write("not json at all\n");
		input.write("\n");
		input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
		input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
		input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
		input.end();
		await served;
		const lines = output
			.read()
			.toString()
			.split("\n")
			.filter(Boolean)
			.map((line: string) => JSON.parse(line));
		assert.equal(lines.length, 2, "garbage, blank, and notification lines produce no responses");
		assert.deepEqual(lines[0], { jsonrpc: "2.0", id: 1, result: {} });
		assert.equal(lines[1].id, 2);
		assert.equal(lines[1].result.tools.length, 9);
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

		const modelessReview = resultOf(
			await server.handle(
				request(7, "tools/call", { name: "audit_review", arguments: { model: "openai/gpt-5.2" } }),
			),
		);
		assert.equal(modelessReview.isError, true);
		assert.match(textOf(modelessReview), /Missing required argument: mode/);

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
