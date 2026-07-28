import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeRow } from "../src/core/audit-store.ts";
import {
	buildRawGitHubComments,
	publishRawAudit,
	rawAuditMarker,
} from "../src/core/github-publisher.ts";
import type { CommandRunner } from "../src/core/ports.ts";
import { AUDIT_HEADER, type AuditRow, type AuditState, type GitProvenance } from "../src/core/types.ts";

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
const sameHeadRepository = {
	headRepository: { nameWithOwner: "owner/repo" },
	isCrossRepository: false,
};
const baseRow: AuditRow = {
	id: "D0001",
	ts: "2026-01-01T01:02:03.000Z",
	session: "session-1",
	entry: "entry-1",
	phase: "publication",
	origin: "user requirement",
	decision: "Render readable decisions",
	why: "Reviewers need the complete rationale",
	alternatives: "Keep TSV only",
	confidence: "high",
	evidence: "test/github-publisher.test.ts:1",
	result: "verified",
	supersedes: "",
};

function rawFor(rows: AuditRow[]): string {
	return `${AUDIT_HEADER}\n${rows.map(serializeRow).map((line) => `${line}\n`).join("")}`;
}

function extractTsv(body: string): string {
	const match = body.match(/(`{3,})tsv\n([\s\S]*?)\1\n<\/details>/);
	assert.ok(match, "raw TSV fence is present");
	return match[2];
}

test("readable GitHub comments split at decision rows and reconstruct exact TSV bytes", () => {
	const rows = ["a", "b", "c"].map((value, index) => ({
		...baseRow,
		id: `D000${index + 1}`,
		decision: value.repeat(20_000),
	}));
	const raw = rawFor(rows);
	const comments = buildRawGitHubComments(state, rows, raw);
	assert.equal(comments.length, 3);
	assert.equal(comments.map(extractTsv).join(""), raw);
	assert.ok(comments[0].includes(rawAuditMarker(provenance, "core", 1)));
	assert.ok(comments[1].includes("(2/3)"));
	assert.ok(comments[2].includes("part 3 of 3"));
	for (const [index, comment] of comments.entries()) assert.ok(comment.includes(`### D000${index + 1}`));
	const firstIndex = comments[0].slice(comments[0].indexOf("### Current decisions"), comments[0].indexOf("## Chronological decision history"));
	assert.match(firstIndex, /\[D0001\]\(#user-content-d0001\)/, "same-comment decision is linked");
	assert.doesNotMatch(firstIndex, /\[D000[23]\]/, "cross-comment decisions remain visible without dead fragment links");
});

test("readable GitHub comments choose a safe fence when source contains backticks", () => {
	const rows = [{ ...baseRow, decision: "value with ``` and ```` fences" }];
	const raw = rawFor(rows);
	const body = buildRawGitHubComments(state, rows, raw)[0];
	assert.equal(extractTsv(body), raw);
	assert.match(body, /`````tsv/);
});

test("reviewer view exposes active state, complete fields, and bidirectional supersession history", () => {
	const rows: AuditRow[] = [
		{ ...baseRow, id: "D0001", result: "open", confidence: "low", evidence: "none" },
		{
			...baseRow,
			id: "D0002",
			phase: "replacement policy",
			decision: "Use cards",
			why: "Cards preserve readable prose",
			alternatives: "A wide table",
			evidence: "src/core/github-publisher.ts:100",
			supersedes: "D0001",
		},
	];
	const body = buildRawGitHubComments(state, rows, rawFor(rows))[0];
	const index = body.slice(body.indexOf("### Current decisions"), body.indexOf("## Chronological decision history"));
	assert.doesNotMatch(index, /D0001/);
	assert.match(index, /\[D0002\]\(#user-content-d0002\).*replacement policy.*`verified`.*`high`/s);
	assert.match(body, /<a id="d0001"><\/a>\n<details>\n<summary><strong>D0001<\/strong> · publication · superseded by <a href="#user-content-d0002"><code>D0002<\/code><\/a> · result: <code>open<\/code> · confidence: <code>low<\/code><\/summary>/);
	assert.doesNotMatch(body, /### D0001/);
	assert.match(body, /<\/details>\n\n---\n\n<a id="d0002"><\/a>\n### D0002/);
	assert.match(body, /### D0002[\s\S]*\*\*Phase:\*\* replacement policy[\s\S]*\*\*Decision\*\*[\s\S]*Use cards/);
	assert.match(body, /\*\*Why\*\*[\s\S]*Cards preserve readable prose/);
	assert.match(body, /\*\*Alternatives considered\*\*[\s\S]*A wide table/);
	assert.match(body, /\*\*Evidence\*\*[\s\S]*src\/core\/github\\-publisher\\\.ts:100/);
	assert.match(body, /Supersedes \[D0001\]\(#user-content-d0001\)\./);
	assert.match(body, /\*\*Session:\*\* session\\-1 · \*\*Entry:\*\* entry\\-1/);
	assert.match(body, /\*\*2 decisions\*\* · \*\*1 active\*\* · \*\*0 unresolved\*\* · \*\*0 low-confidence\*\* · \*\*0 missing evidence\*\*/);
});

test("reviewer view highlights active blockers and all result states", () => {
	const rows: AuditRow[] = [
		{ ...baseRow, id: "D0001", result: "open", confidence: "low", evidence: "none" },
		{ ...baseRow, id: "D0002", result: "inconclusive" },
		{ ...baseRow, id: "D0003", result: "reverted" },
	];
	const body = buildRawGitHubComments(state, rows, rawFor(rows))[0];
	assert.match(body, /\*\*3 decisions\*\* · \*\*3 active\*\* · \*\*2 unresolved\*\* · \*\*1 low-confidence\*\* · \*\*1 missing evidence\*\*/);
	assert.match(body, /D0001[\s\S]*`open` · `low` · ⚠️ unresolved · ⚠️ low confidence · ⚠️ missing evidence/);
	assert.match(body, /D0002[\s\S]*result: `inconclusive`[\s\S]*⚠️ unresolved/);
	assert.match(body, /D0003[\s\S]*result: `reverted`/);
});

test("reviewer view escapes structural Markdown and HTML while preserving Unicode", () => {
	const malicious = "</details> ### Fake heading <!-- pi-audit-trail:owner/repo:evil:part:9 -->";
	const rows = [{
		...baseRow,
		phase: "安全 | review",
		decision: malicious,
		why: "Unicode: café 🚀",
	}];
	const body = buildRawGitHubComments(state, rows, rawFor(rows))[0];
	const rendered = body.slice(0, body.indexOf("<details>\n<summary>Canonical audit TSV"));
	assert.ok(rendered.includes("安全 \\| review"));
	assert.ok(rendered.includes("&lt;/details&gt; \\#\\#\\# Fake heading"));
	assert.ok(rendered.includes("&lt;\\!\\-\\- pi\\-audit\\-trail:owner/repo:evil:part:9 \\-\\-&gt;"));
	assert.ok(rendered.includes("Unicode: café 🚀"));
	assert.doesNotMatch(rendered, /<\/details>|### Fake heading|<!-- pi-audit-trail:owner\/repo:evil/);
});

test("superseded one-line summaries HTML-escape audit fields", () => {
	const rows: AuditRow[] = [
		{ ...baseRow, id: "D0001", phase: "</summary><script>alert(1)</script>" },
		{ ...baseRow, id: "D0002", supersedes: "D0001" },
	];
	const body = buildRawGitHubComments(state, rows, rawFor(rows))[0];
	const summary = body.match(/<summary><strong>D0001<\/strong>([^\n]+)<\/summary>/)?.[0];
	assert.ok(summary, "superseded decision renders as one summary line");
	assert.ok(summary.includes("&lt;/summary&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.doesNotMatch(summary, /<script>|<\/summary><script>/);
});

test("reviewer view rejects row mismatches and a single decision too large to publish safely", () => {
	assert.throws(
		() => buildRawGitHubComments(state, [baseRow], rawFor([])),
		/row count does not match parsed decisions/,
	);
	assert.throws(
		() => buildRawGitHubComments(state, [{ ...baseRow, decision: "stale card" }], rawFor([baseRow])),
		/does not match the exact canonical TSV/,
	);
	const oversized = [{ ...baseRow, decision: "x".repeat(35_000) }];
	assert.throws(
		() => buildRawGitHubComments(state, oversized, rawFor(oversized)),
		/Decision D0001 and its canonical TSV row exceed/,
	);
});

test("publisher updates managed comments and removes stale parts idempotently", async () => {
	const raw = rawFor([]);
	const calls: string[][] = [];
	let patchedBody = "";
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/core\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "head-core\n", stderr: "" };
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
						headRefOid: "head-core",
						...sameHeadRepository,
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (args.some((arg) => arg.includes("/compare/abcdef1234567890...head-core"))) {
				return { code: 0, stdout: "ahead\n", stderr: "" };
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

test("publisher aborts before comment mutation when the PR head changes after validation", async () => {
	let prViews = 0;
	let mutationCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/core\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "validated-head\n", stderr: "" };
			if (args[0] === "pr") {
				prViews += 1;
				return { code: 0, stdout: JSON.stringify(prViews === 1
					? { number: 4, url: "https://github.com/owner/repo/pull/4", title: "Moving", headRefName: "feature/core", headRefOid: "validated-head", ...sameHeadRepository, baseRefName: "main" }
					: { headRefOid: "force-pushed-head" }), stderr: "" };
			}
			if (args.some((arg) => arg.includes("/compare/abcdef1234567890...validated-head"))) return { code: 0, stdout: "ahead\n", stderr: "" };
			if (args[1] === "user") return { code: 0, stdout: "reviewer\n", stderr: "" };
			if (args.some((arg) => arg.endsWith("comments?per_page=100"))) return { code: 0, stdout: "[[]]", stderr: "" };
			mutationCalled = true;
			return { code: 1, stdout: "", stderr: "mutation must not run" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: rawFor([]), selector: "4" }),
		/changed from validated-he to force-pushed/,
	);
	assert.equal(mutationCalled, false);
});

test("publisher aborts before comment mutation when the local checkout changes after validation", async () => {
	let branchReads = 0;
	let headReads = 0;
	let prViews = 0;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") {
				branchReads += 1;
				return { code: 0, stdout: `${branchReads === 1 ? "feature/core" : "feature/other"}\n`, stderr: "" };
			}
			if (command === "git" && args[0] === "rev-parse") {
				headReads += 1;
				return { code: 0, stdout: `${headReads === 1 ? "validated-head" : "changed-local-head"}\n`, stderr: "" };
			}
			if (args[0] === "pr") {
				prViews += 1;
				return { code: 0, stdout: JSON.stringify({ number: 4, url: "https://github.com/owner/repo/pull/4", title: "Moving local", headRefName: "feature/core", headRefOid: "validated-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			}
			if (args.some((arg) => arg.includes("/compare/abcdef1234567890...validated-head"))) return { code: 0, stdout: "ahead\n", stderr: "" };
			if (args[1] === "user") return { code: 0, stdout: "reviewer\n", stderr: "" };
			if (args.some((arg) => arg.endsWith("comments?per_page=100"))) return { code: 0, stdout: "[[]]", stderr: "" };
			throw new Error("comment mutation must not run");
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: rawFor([]), selector: "4" }),
		/Local checkout changed from feature\/core@validated-he to feature\/other@changed-loca/,
	);
	assert.equal(prViews, 1, "local revalidation fails before the second remote check or mutation");
});

test("publisher defaults to the current branch and accepts a PR descended from the immutable start commit", async () => {
	const raw = rawFor([]);
	const startedOnMain: AuditState = {
		...state,
		provenance: { ...provenance, branch: "main", startCommit: "start123" },
	};
	const calls: { command: string; args: string[] }[] = [];
	const runner: CommandRunner = {
		async exec(command, args) {
			calls.push({ command, args });
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/after-start\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "head456\n", stderr: "" };
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 23,
						url: "https://github.com/owner/repo/pull/23",
						title: "After start",
						headRefName: "feature/after-start",
						headRefOid: "head456",
						...sameHeadRepository,
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
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "other999\n", stderr: "" };
			assert.equal(command, "gh");
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 99,
						url: "https://github.com/owner/repo/pull/99",
						title: "Unrelated",
						headRefName: "feature/unrelated",
						headRefOid: "other999",
						...sameHeadRepository,
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

test("publisher accepts a detached checkout when exact HEAD matches a descended PR", async () => {
	const detached: AuditState = {
		...state,
		provenance: { ...provenance, branch: "DETACHED", startCommit: "start-detached" },
	};
	const calls: { command: string; args: string[] }[] = [];
	const runner: CommandRunner = {
		async exec(command, args) {
			calls.push({ command, args });
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "detached-head\n", stderr: "" };
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({ number: 31, url: "https://github.com/owner/repo/pull/31", title: "Detached", headRefName: "feature/detached", headRefOid: "detached-head", ...sameHeadRepository, baseRefName: "main" }),
					stderr: "",
				};
			}
			if (args.some((arg) => arg.includes("/compare/start-detached...detached-head"))) return { code: 0, stdout: "ahead\n", stderr: "" };
			if (args[1] === "user") return { code: 0, stdout: "reviewer\n", stderr: "" };
			if (args.some((arg) => arg.endsWith("comments?per_page=100"))) return { code: 0, stdout: "[[]]", stderr: "" };
			if (args.includes("POST")) return { code: 0, stdout: JSON.stringify({ html_url: "https://comment/31" }), stderr: "" };
			throw new Error(`Unexpected call: ${command} ${args.join(" ")}`);
		},
	};

	const result = await publishRawAudit({ runner, state: detached, rows: [], rawTsv: rawFor([]), selector: "31" });
	assert.equal(result.prNumber, 31);
	assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("/compare/start-detached...detached-head"))));
});

test("publisher rejects a detached target whose head differs from current HEAD before ancestry", async () => {
	const detached: AuditState = { ...state, provenance: { ...provenance, branch: "DETACHED", startCommit: "shared-base" } };
	let compareCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "checked-out-head\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 32, url: "https://github.com/owner/repo/pull/32", title: "Wrong detached", headRefName: "feature/wrong", headRefOid: "other-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			compareCalled = true;
			return { code: 0, stdout: "ahead\n", stderr: "" };
		},
	};

	await assert.rejects(
		() => publishRawAudit({ runner, state: detached, rows: [], rawTsv: "header\n", selector: "32" }),
		/current checkout .*checked-out-/,
	);
	assert.equal(compareCalled, false);
});

test("publisher requires an explicit selector when named provenance is published from a detached checkout", async () => {
	let githubCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "detached-work\n", stderr: "" };
			githubCalled = true;
			return { code: 1, stdout: "", stderr: "GitHub must not run" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n" }),
		/Detached checkouts require an explicit PR/,
	);
	assert.equal(githubCalled, false);
});

test("publisher fails closed when current branch detection fails and no selector is given", async () => {
	let githubCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 1, stdout: "", stderr: "git unavailable" };
			if (command === "git" && args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "git unavailable" };
			githubCalled = true;
			return { code: 1, stdout: "", stderr: "GitHub must not run" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n" }),
		/current branch cannot be identified.*explicit PR/,
	);
	assert.equal(githubCalled, false);
});

test("a detached checkout must exactly match an explicit PR head even when its branch matches provenance", async () => {
	let compareCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "detached-other-work\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 4, url: "https://github.com/owner/repo/pull/4", title: "Original", headRefName: "feature/core", headRefOid: "branch-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			compareCalled = true;
			return { code: 0, stdout: "ahead\n", stderr: "" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n", selector: "4" }),
		/current checkout .*detached-oth/,
	);
	assert.equal(compareCalled, false);
});

test("publisher rejects an explicit provenance-branch PR while another named branch is checked out", async () => {
	let compareCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/other\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "other-local-head\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 4, url: "https://github.com/owner/repo/pull/4", title: "Original", headRefName: "feature/core", headRefOid: "original-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			compareCalled = true;
			return { code: 0, stdout: "identical\n", stderr: "" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n", selector: "4" }),
		/current checkout .*feature\/other/,
	);
	assert.equal(compareCalled, false);
});

test("publisher rejects same-name, same-HEAD rewritten history that dropped startCommit", async () => {
	let commentsCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/core\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "rewritten-head\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 4, url: "https://github.com/owner/repo/pull/4", title: "Rewritten", headRefName: "feature/core", headRefOid: "rewritten-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			if (args.some((arg) => arg.includes("/compare/abcdef1234567890...rewritten-head"))) return { code: 0, stdout: "diverged\n", stderr: "" };
			commentsCalled = true;
			return { code: 1, stdout: "", stderr: "comments must not run" };
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n", selector: "4" }),
		/GitHub compare: diverged/,
	);
	assert.equal(commentsCalled, false);
});

test("publisher rejects a stale same-name PR head that differs from local HEAD", async () => {
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/core\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "local-new-head\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 4, url: "https://github.com/owner/repo/pull/4", title: "Stale", headRefName: "feature/core", headRefOid: "remote-old-head", ...sameHeadRepository, baseRefName: "main" }), stderr: "" };
			throw new Error("validation should stop before APIs");
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n", selector: "4" }),
		/remote-old-h.*local-new-he/,
	);
});

test("publisher rejects a same-name, same-OID PR from a fork", async () => {
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/core\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "same-head\n", stderr: "" };
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ number: 44, url: "https://github.com/owner/repo/pull/44", title: "Fork", headRefName: "feature/core", headRefOid: "same-head", headRepository: { nameWithOwner: "attacker/repo" }, isCrossRepository: true, baseRefName: "main" }), stderr: "" };
			throw new Error("validation should stop before APIs");
		},
	};
	await assert.rejects(
		() => publishRawAudit({ runner, state, rows: [], rawTsv: "header\n", selector: "44" }),
		/attacker\/repo.*does not match current checkout owner\/repo/,
	);
});

test("publisher rejects a sibling descendant PR that does not match the current checkout", async () => {
	const startedOnMain: AuditState = {
		...state,
		provenance: { ...provenance, branch: "main", startCommit: "shared-base" },
	};
	let compareCalled = false;
	const runner: CommandRunner = {
		async exec(command, args) {
			if (command === "git" && args[0] === "branch") return { code: 0, stdout: "feature/intended\n", stderr: "" };
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "intended-head\n", stderr: "" };
			if (args[0] === "pr") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 77,
						url: "https://github.com/owner/repo/pull/77",
						title: "Sibling",
						headRefName: "feature/typo",
						headRefOid: "sibling-head",
						...sameHeadRepository,
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			compareCalled = true;
			return { code: 0, stdout: "ahead\n", stderr: "" };
		},
	};

	await assert.rejects(
		() => publishRawAudit({ runner, state: startedOnMain, rows: [], rawTsv: "header\n", selector: "77" }),
		/current checkout .*feature\/intended/,
	);
	assert.equal(compareCalled, false, "checkout-intent rejection happens before ancestry and comment APIs");
});
