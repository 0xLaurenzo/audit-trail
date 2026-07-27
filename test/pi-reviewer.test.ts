import assert from "node:assert/strict";
import test from "node:test";
import { createPiSubprocessReviewer, extractFinalAssistantOutput } from "../src/adapters/pi-reviewer.ts";
import type { CommandRunner } from "../src/core/ports.ts";

test("Pi reviewer fails fast when the runtime is unavailable", async () => {
	const calls: string[][] = [];
	const runner: CommandRunner = {
		exec: async (_command, args) => {
			calls.push(args);
			return { code: 1, stdout: "", stderr: "spawn pi ENOENT" };
		},
	};
	await assert.rejects(
		() =>
			createPiSubprocessReviewer(runner).review({
				prompt: "review",
				model: "provider/model",
				workingDirectory: "/repo",
			}),
		/pi CLI is required.*spawn pi ENOENT/,
	);
	assert.deepEqual(calls, [["--version"]], "no review subprocess after failed preflight");
});

test("Pi reviewer preflights, invokes read-only no-session mode, and returns final output", async () => {
	const calls: string[][] = [];
	const runner: CommandRunner = {
		exec: async (_command, args) => {
			calls.push(args);
			if (args[0] === "--version") return { code: 0, stdout: "0.82.1", stderr: "" };
			return {
				code: 0,
				stdout: [
					JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No flags\nVERDICT: approve" }] } }),
					JSON.stringify({ type: "agent_settled" }),
				].join("\n"),
				stderr: "",
			};
		},
	};
	const output = await createPiSubprocessReviewer(runner).review({
		prompt: "review instructions",
		model: "provider/model",
		workingDirectory: "/repo",
	});
	assert.equal(output, "No flags\nVERDICT: approve");
	assert.equal(calls.length, 2);
	assert.ok(calls[1].includes("--no-session"));
	assert.ok(calls[1].includes("read,grep,find,ls"));
	assert.ok(calls[1].includes("provider/model"));
});

test("Pi JSON parser surfaces a final assistant error and ignores diagnostics", () => {
	const parsed = extractFinalAssistantOutput([
		"not json",
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed", content: [] } }),
	].join("\n"));
	assert.equal(parsed.output, "");
	assert.equal(parsed.error, "provider failed");
});

test("Pi JSON parser accepts a successful retry after a transient assistant error", () => {
	const parsed = extractFinalAssistantOutput([
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error", content: [] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No flags\nVERDICT: approve" }] } }),
		JSON.stringify({ type: "agent_settled" }),
	].join("\n"));
	assert.equal(parsed.output, "No flags\nVERDICT: approve");
	assert.equal(parsed.error, undefined);
});

test("Pi JSON parser rejects a truncated successful message without agent_settled", () => {
	const parsed = extractFinalAssistantOutput(
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "VERDICT: approve" }] } }),
	);
	assert.equal(parsed.output, "");
	assert.match(parsed.error ?? "", /before agent_settled/);
});

test("Pi JSON parser does not certify tool-use or unknown terminal states", () => {
	const parsed = extractFinalAssistantOutput([
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "VERDICT: approve" }] } }),
		JSON.stringify({ type: "agent_settled" }),
	].join("\n"));
	assert.equal(parsed.output, "");
	assert.equal(parsed.error, undefined);
});

test("a later tool-use outcome invalidates an earlier successful candidate", () => {
	const parsed = extractFinalAssistantOutput([
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "VERDICT: approve" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [] } }),
		JSON.stringify({ type: "agent_settled" }),
	].join("\n"));
	assert.equal(parsed.output, "");
	assert.equal(parsed.error, undefined);
});

test("agent_settled cannot certify a later out-of-order stop", () => {
	const parsed = extractFinalAssistantOutput([
		JSON.stringify({ type: "agent_settled" }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "VERDICT: approve" }] } }),
	].join("\n"));
	assert.equal(parsed.output, "");
	assert.match(parsed.error ?? "", /before agent_settled/);
});
