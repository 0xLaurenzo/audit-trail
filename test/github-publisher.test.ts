import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	buildRawGitHubComments,
	publishRawAudit,
	rawAuditMarker,
} from "../src/core/github-publisher.ts";
import type { CommandRunner } from "../src/core/ports.ts";
import type { AuditState, GitProvenance } from "../src/core/types.ts";

const provenance: GitProvenance = {
	version: 1,
	task: "core",
	startedAt: "2026-01-01T00:00:00.000Z",
	repository: "owner/repo",
	repositoryUrl: "https://github.com/owner/repo",
	branch: "feature/core",
	startCommit: "abcdef1234567890",
	worktreeDirty: false,
	sessionId: "session-1",
};
const state: AuditState = {
	task: "core",
	logPath: "/repo/.audit/core.tsv",
	provenance,
};

function extractTsv(body: string): string {
	const match = body.match(/(`{3,})tsv\n([\s\S]*?)\1\n<\/details>/);
	assert.ok(match, "raw TSV fence is present");
	return match[2];
}

test("raw GitHub comments split at lines and reconstruct exact TSV bytes", () => {
	const raw = `header\n${"a".repeat(20_000)}\n${"b".repeat(20_000)}\n${"c".repeat(20_000)}\n`;
	const comments = buildRawGitHubComments(state, [], raw);
	assert.equal(comments.length, 2);
	assert.equal(comments.map(extractTsv).join(""), raw);
	assert.ok(comments[0].includes(rawAuditMarker(provenance, "core", 1)));
	assert.ok(comments[1].includes("part 2 of 2"));
});

test("raw GitHub comments choose a safe fence when source contains backticks", () => {
	const raw = "header\nvalue with ``` and ```` fences\n";
	const body = buildRawGitHubComments(state, [], raw)[0];
	assert.equal(extractTsv(body), raw);
	assert.match(body, /`````tsv/);
});

test("publisher updates managed comments and removes stale parts idempotently", async () => {
	const raw = "header\nrow\n";
	const calls: string[][] = [];
	let patchedBody = "";
	const runner: CommandRunner = {
		async exec(command, args) {
			assert.equal(command, "gh");
			calls.push(args);
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 4,
						url: "https://github.com/owner/repo/pull/4",
						title: "Core",
						headRefName: "feature/core",
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (args[1] === "user") return { code: 0, stdout: "reviewer\n", stderr: "" };
			if (args.some((arg) => arg.endsWith("comments?per_page=100"))) {
				return {
					code: 0,
					stdout: JSON.stringify([[
						{ id: 10, html_url: "old-1", body: rawAuditMarker(provenance, "core", 1), user: { login: "reviewer" } },
						{ id: 11, html_url: "old-2", body: rawAuditMarker(provenance, "core", 2), user: { login: "reviewer" } },
					]]),
					stderr: "",
				};
			}
			const method = args[args.indexOf("--method") + 1];
			if (method === "PATCH") {
				const inputPath = args[args.indexOf("--input") + 1];
				patchedBody = JSON.parse(await readFile(inputPath, "utf8")).body;
				return { code: 0, stdout: JSON.stringify({ html_url: "https://comment/10" }), stderr: "" };
			}
			if (method === "DELETE") return { code: 0, stdout: "", stderr: "" };
			throw new Error(`Unexpected gh call: ${args.join(" ")}`);
		},
	};

	const result = await publishRawAudit({ runner, state, rows: [], rawTsv: raw, selector: "feature/core" });
	assert.deepEqual(result, {
		prNumber: 4,
		prUrl: "https://github.com/owner/repo/pull/4",
		commentUrl: "https://comment/10",
		commentCount: 1,
	});
	assert.equal(extractTsv(patchedBody), raw);
	assert.ok(calls.some((args) => args.includes("PATCH") && args.includes("repos/owner/repo/issues/comments/10")));
	assert.ok(calls.some((args) => args.includes("DELETE") && args.includes("repos/owner/repo/issues/comments/11")));
	assert.ok(!calls.some((args) => args.includes("POST")));
});

test("publisher defaults to the current branch and accepts a PR descended from the immutable start commit", async () => {
	const raw = "header\nrow\n";
	const startedOnMain: AuditState = {
		...state,
		provenance: { ...provenance, branch: "main", startCommit: "start123" },
	};
	const calls: { command: string; args: string[] }[] = [];
	const runner: CommandRunner = {
		async exec(command, args) {
			calls.push({ command, args });
			if (command === "git") return { code: 0, stdout: "feature/after-start\n", stderr: "" };
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 23,
						url: "https://github.com/owner/repo/pull/23",
						title: "After start",
						headRefName: "feature/after-start",
						headRefOid: "head456",
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (args.some((arg) => arg.includes("/compare/start123...head456"))) {
				return { code: 0, stdout: "ahead\n", stderr: "" };
			}
			if (args[1] === "user") return { code: 0, stdout: "reviewer\n", stderr: "" };
			if (args.some((arg) => arg.endsWith("comments?per_page=100"))) {
				return { code: 0, stdout: "[[]]", stderr: "" };
			}
			if (args.includes("POST")) {
				return { code: 0, stdout: JSON.stringify({ html_url: "https://comment/23" }), stderr: "" };
			}
			throw new Error(`Unexpected call: ${command} ${args.join(" ")}`);
		},
	};

	const result = await publishRawAudit({ runner, state: startedOnMain, rows: [], rawTsv: raw });
	assert.equal(result.prNumber, 23);
	const prCall = calls.find((call) => call.args[0] === "pr");
	assert.equal(prCall?.args[2], "feature/after-start", "current branch is the default selector");
	assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("/compare/start123...head456"))));
});

test("publisher rejects a detached audit's explicit PR when it does not descend from the start commit", async () => {
	const startedDetached: AuditState = {
		...state,
		provenance: { ...provenance, branch: "DETACHED", startCommit: "start1234567890" },
	};
	let commentsListed = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			assert.equal(command, "gh", "explicit selector does not need current Git branch");
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 99,
						url: "https://github.com/owner/repo/pull/99",
						title: "Unrelated",
						headRefName: "feature/unrelated",
						headRefOid: "other999",
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (args.some((arg) => arg.includes("/compare/start1234567890...other999"))) {
				return { code: 0, stdout: "diverged\n", stderr: "" };
			}
			commentsListed = true;
			return { code: 1, stdout: "", stderr: "must not publish" };
		},
	};

	await assert.rejects(
		() => publishRawAudit({ runner, state: startedDetached, rows: [], rawTsv: "header\n", selector: "99" }),
		/does not descend from audit start commit/,
	);
	assert.equal(commentsListed, false, "lineage rejection happens before comments are read or written");
});
