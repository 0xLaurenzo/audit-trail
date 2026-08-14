import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeRow } from "../src/core/audit-store.ts";
import {
	auditSetMarkerPrefix,
	buildAuditComponentSegments,
	buildAuditSetComments,
	publishRawAudit,
	rawAuditComponentMarker,
	rawAuditMarker,
	rawAuditSetMarker,
} from "../src/core/github-publisher.ts";
import type { CommandRunner, ExecResult } from "../src/core/ports.ts";
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
const AUDIT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_AUDIT_ID = "99999999-8888-4777-a666-555555555555";
const state: AuditState = {
	task: "core",
	auditId: AUDIT_ID,
	logPath: "/repo/.audit/core.tsv",
	provenance,
	review: {
		path: ".audit/core.review.md",
		sha256: "a".repeat(64),
		mode: "cross-provider",
		model: "provider/reviewer",
		at: "2026-01-01T02:00:00.000Z",
		verdict: "approve",
	},
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

function render(
	auditState: AuditState,
	rows: AuditRow[],
	raw = rawFor(rows),
	head = "head-core",
	setId = auditState.auditId!,
): string[] {
	return buildAuditSetComments(
		provenance.repository,
		4,
		setId,
		buildAuditComponentSegments(auditState, rows, raw, head, 4),
	);
}

function extractTsvs(bodies: string[]): string[] {
	return bodies.flatMap((body) => [...body.matchAll(/(`{3,})tsv\n([\s\S]*?)\1\n<\/details>/g)].map((match) => match[2]));
}

function componentBody(body: string, auditId: string): string {
	const begin = rawAuditComponentMarker(auditId, 1, 1, "begin");
	const end = rawAuditComponentMarker(auditId, 1, 1, "end");
	const start = body.indexOf(begin);
	const finish = body.indexOf(end, start);
	assert.notEqual(start, -1);
	assert.notEqual(finish, -1);
	return body.slice(start, finish + end.length);
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

test("aggregate rendering preserves exact TSV and exposes coverage, review, and namespaced decisions", () => {
	const rows = [baseRow];
	const bodies = render(state, rows);
	assert.equal(bodies.length, 1);
	assert.equal(extractTsvs(bodies).join(""), rawFor(rows));
	const body = bodies[0];
	assert.ok(body.startsWith(rawAuditSetMarker("owner/repo", 4, AUDIT_ID, 1, 1)));
	assert.match(body, /\*\*Audit ID:\*\* `11111111-2222-4333-8444-555555555555`/);
	assert.match(body, /\*\*Commit range:\*\* \[`abcdef123456`\].*\.\.\[`head-core`\]/);
	assert.match(body, /Review `approve` · `cross-provider` · `provider\/reviewer`/);
	assert.match(body, new RegExp(`<a id="audit-${AUDIT_ID}-d0001"></a>`));
	assert.match(body, new RegExp(`D0001\\]\\(#user-content-audit-${AUDIT_ID}-d0001\\)`));
});

test("large audits split only at rows and reconstruct their exact canonical TSV", () => {
	const rows = ["a", "b", "c"].map((value, index) => ({
		...baseRow,
		id: `D000${index + 1}`,
		decision: value.repeat(20_000),
	}));
	const segments = buildAuditComponentSegments(state, rows, rawFor(rows), "head-core", 4);
	const bodies = buildAuditSetComments("owner/repo", 4, AUDIT_ID, segments);
	assert.equal(segments.length, 3);
	assert.equal(bodies.length, 3);
	assert.equal(extractTsvs(bodies).join(""), rawFor(rows));
	assert.ok(bodies[1].includes("(2/3)"));
	assert.ok(bodies[2].includes("segment 3 of 3"));
	for (const [index, body] of bodies.entries()) assert.ok(body.includes(`### D000${index + 1}`));
});

test("several small audits share one aggregate comment and retain independent TSV blocks", () => {
	const otherState: AuditState = {
		...state,
		task: "follow-up",
		auditId: OTHER_AUDIT_ID,
		provenance: { ...provenance, task: "follow-up", startCommit: "head-before-follow-up" },
	};
	const first = buildAuditComponentSegments(state, [baseRow], rawFor([baseRow]), "head-one", 4);
	const secondRow = { ...baseRow, decision: "Follow-up choice" };
	const second = buildAuditComponentSegments(otherState, [secondRow], rawFor([secondRow]), "head-two", 4);
	const bodies = buildAuditSetComments("owner/repo", 4, AUDIT_ID, [...first, ...second]);
	assert.equal(bodies.length, 1);
	assert.equal(extractTsvs(bodies).length, 2);
	assert.ok(bodies[0].includes(rawAuditComponentMarker(AUDIT_ID, 1, 1, "begin")));
	assert.ok(bodies[0].includes(rawAuditComponentMarker(OTHER_AUDIT_ID, 1, 1, "begin")));
	assert.match(bodies[0], /head-before.*\.\.\[`head-two`\]/s);
	assert.match(bodies[0], new RegExp(`audit-${AUDIT_ID}-d0001`));
	assert.match(bodies[0], new RegExp(`audit-${OTHER_AUDIT_ID}-d0001`));
});

test("rendering chooses safe TSV fences and escapes generated Markdown and HTML", () => {
	const malicious = "</details> ### Fake <!-- pi-audit-trail:component:v1:audit:evil:segment:1/1:end --> ``` ````";
	const rows = [{ ...baseRow, phase: "安全 | review", decision: malicious, why: "Unicode: café 🚀" }];
	const body = render(state, rows)[0];
	const generated = body.slice(0, body.indexOf("<details>\n<summary>Canonical audit TSV"));
	assert.ok(generated.includes("安全 \\| review"));
	assert.ok(generated.includes("&lt;/details&gt; \\#\\#\\# Fake"));
	assert.doesNotMatch(generated, /### Fake|:evil:segment:1\/1:end -->/);
	assert.match(body, /`````tsv/);
	assert.equal(extractTsvs([body]).join(""), rawFor(rows));
});

test("reviewer view retains blockers and bidirectional supersession history", () => {
	const rows: AuditRow[] = [
		{ ...baseRow, id: "D0001", result: "open", confidence: "low", evidence: "none" },
		{ ...baseRow, id: "D0002", decision: "Use cards", supersedes: "D0001" },
	];
	const body = render(state, rows)[0];
	assert.match(body, /\*\*2 decisions\*\* · \*\*1 active\*\* · \*\*0 unresolved\*\*/);
	assert.match(body, /superseded by <a href="#user-content-audit-.*-d0002">/);
	assert.match(body, /Supersedes <a href="#user-content-audit-.*-d0001">/);
	assert.match(body, /result: <code>open<\/code> · confidence: <code>low<\/code>/);
});

test("component rendering rejects source mismatches and an indivisible oversized decision", () => {
	assert.throws(
		() => buildAuditComponentSegments(state, [baseRow], rawFor([]), "head", 4),
		/row count does not match parsed decisions/,
	);
	assert.throws(
		() => buildAuditComponentSegments(state, [{ ...baseRow, decision: "stale" }], rawFor([baseRow]), "head", 4),
		/does not match the exact canonical TSV/,
	);
	const oversized = [{ ...baseRow, decision: "x".repeat(35_000) }];
	assert.throws(
		() => buildAuditComponentSegments(state, oversized, rawFor(oversized), "head", 4),
		/exceed/,
	);
});

interface FakeOptions {
	branch?: string;
	head?: string;
	prHead?: string;
	prBranch?: string;
	repository?: string;
	compare?: string;
	login?: string;
	comments?: FakeComment[];
	onList?: (fake: FakeGitHub, listNumber: number) => void;
	onRevalidate?: (fake: FakeGitHub, viewNumber: number) => void;
	onGitRead?: (fake: FakeGitHub, kind: "branch" | "head", readNumber: number) => string | undefined;
}

interface FakeComment {
	id: number;
	html_url: string;
	body: string;
	user: { login: string };
}

class FakeGitHub implements CommandRunner {
	branch: string;
	head: string;
	prHead: string;
	prBranch: string;
	repository: string;
	compare: string;
	login: string;
	comments: FakeComment[];
	calls: { command: string; args: string[] }[] = [];
	mutations: string[] = [];
	private nextId = 100;
	private listNumber = 0;
	private viewNumber = 0;
	private branchReads = 0;
	private headReads = 0;
	private readonly onList?: FakeOptions["onList"];
	private readonly onRevalidate?: FakeOptions["onRevalidate"];
	private readonly onGitRead?: FakeOptions["onGitRead"];

	constructor(options: FakeOptions = {}) {
		this.branch = options.branch ?? "feature/core";
		this.head = options.head ?? "head-core";
		this.prHead = options.prHead ?? this.head;
		this.prBranch = options.prBranch ?? this.branch;
		this.repository = options.repository ?? "owner/repo";
		this.compare = options.compare ?? "ahead";
		this.login = options.login ?? "reviewer";
		this.comments = options.comments ?? [];
		this.onList = options.onList;
		this.onRevalidate = options.onRevalidate;
		this.onGitRead = options.onGitRead;
	}

	async exec(command: string, args: string[]): Promise<ExecResult> {
		this.calls.push({ command, args });
		if (command === "git" && args[0] === "branch") {
			this.branchReads += 1;
			return { code: 0, stdout: `${this.onGitRead?.(this, "branch", this.branchReads) ?? this.branch}\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "rev-parse") {
			this.headReads += 1;
			return { code: 0, stdout: `${this.onGitRead?.(this, "head", this.headReads) ?? this.head}\n`, stderr: "" };
		}
		assert.equal(command, "gh");
		if (args[0] === "pr") {
			this.viewNumber += 1;
			if (this.viewNumber > 1) this.onRevalidate?.(this, this.viewNumber);
			if (args.at(-1) === "headRefOid") {
				return { code: 0, stdout: JSON.stringify({ headRefOid: this.prHead }), stderr: "" };
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					number: 4,
					url: "https://github.com/owner/repo/pull/4",
					title: "Core",
					headRefName: this.prBranch,
					headRefOid: this.prHead,
					headRepository: { nameWithOwner: this.repository },
					isCrossRepository: this.repository !== "owner/repo",
					baseRefName: "main",
				}),
				stderr: "",
			};
		}
		if (args.some((arg) => arg.includes("/compare/"))) return { code: 0, stdout: `${this.compare}\n`, stderr: "" };
		if (args[1] === "user") return { code: 0, stdout: `${this.login}\n`, stderr: "" };
		if (args.includes("--paginate")) {
			this.listNumber += 1;
			this.onList?.(this, this.listNumber);
			return { code: 0, stdout: JSON.stringify([this.comments]), stderr: "" };
		}
		const method = args[args.indexOf("--method") + 1];
		const endpoint = args[args.indexOf("--method") + 2];
		if (method === "POST" || method === "PATCH") {
			const inputPath = args[args.indexOf("--input") + 1];
			const body = JSON.parse(await readFile(inputPath, "utf8")).body as string;
			if (method === "POST") {
				const comment = { id: this.nextId++, html_url: `https://comment/${this.nextId - 1}`, body, user: { login: this.login } };
				this.comments.push(comment);
				this.mutations.push(`POST:${comment.id}`);
				return { code: 0, stdout: JSON.stringify(comment), stderr: "" };
			}
			const id = Number(endpoint.split("/").at(-1));
			const comment = this.comments.find((candidate) => candidate.id === id);
			assert.ok(comment);
			comment.body = body;
			this.mutations.push(`PATCH:${id}`);
			return { code: 0, stdout: JSON.stringify(comment), stderr: "" };
		}
		if (method === "DELETE") {
			const id = Number(endpoint.split("/").at(-1));
			this.comments = this.comments.filter((comment) => comment.id !== id);
			this.mutations.push(`DELETE:${id}`);
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected call: ${command} ${args.join(" ")}`);
	}
}

function commentsFor(bodies: string[], login = "reviewer", firstId = 10): FakeComment[] {
	return bodies.map((body, index) => ({
		id: firstId + index,
		html_url: `https://comment/${firstId + index}`,
		body,
		user: { login },
	}));
}

test("first publish creates an author-owned aggregate set anchored by the audit ID", async () => {
	const fake = new FakeGitHub();
	const result = await publishRawAudit({ runner: fake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) });
	assert.deepEqual(result, {
		prNumber: 4,
		prUrl: "https://github.com/owner/repo/pull/4",
		commentUrl: "https://comment/100",
		commentCount: 1,
		commentSetId: AUDIT_ID,
		componentCount: 1,
		legacyCommentCount: 0,
	});
	assert.deepEqual(fake.mutations, ["POST:100"]);
	assert.ok(fake.comments[0].body.startsWith(rawAuditSetMarker("owner/repo", 4, AUDIT_ID, 1, 1)));
	assert.match(fake.comments[0].body, /abcdef123456.*\.\.\[`head-core`\]/s);
});

test("a second audit appends to the same set and republishing replaces only its component", async () => {
	const fake = new FakeGitHub();
	await publishRawAudit({ runner: fake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) });
	const firstComponent = componentBody(fake.comments[0].body, AUDIT_ID);
	const secondState: AuditState = {
		...state,
		task: "follow-up",
		auditId: OTHER_AUDIT_ID,
		provenance: { ...provenance, task: "follow-up", startCommit: "head-before-follow-up" },
	};
	const firstSecondRow = { ...baseRow, decision: "Initial follow-up" };
	const appended = await publishRawAudit({ runner: fake, state: secondState, rows: [firstSecondRow], rawTsv: rawFor([firstSecondRow]) });
	assert.equal(appended.commentSetId, AUDIT_ID);
	assert.equal(appended.componentCount, 2);
	assert.equal(fake.comments.length, 1);
	assert.ok(fake.comments[0].body.includes(firstComponent), "the first audit component is preserved byte-for-byte");
	assert.equal(count(fake.comments[0].body, rawAuditComponentMarker(OTHER_AUDIT_ID, 1, 1, "begin")), 1);

	const replacementRow = { ...baseRow, decision: "Updated follow-up" };
	await publishRawAudit({ runner: fake, state: secondState, rows: [replacementRow], rawTsv: rawFor([replacementRow]) });
	assert.ok(fake.comments[0].body.includes(firstComponent));
	assert.ok(fake.comments[0].body.includes("Updated follow\\-up"));
	assert.ok(!fake.comments[0].body.includes("Initial follow\\-up"));
	assert.equal(count(fake.comments[0].body, rawAuditComponentMarker(OTHER_AUDIT_ID, 1, 1, "begin")), 1);
});

test("multipart growth and shrink use numbered continuations and remove only stale selected-set parts", async () => {
	const rows = ["a", "b", "c"].map((value, index) => ({
		...baseRow,
		id: `D000${index + 1}`,
		decision: value.repeat(20_000),
	}));
	const fake = new FakeGitHub();
	const grown = await publishRawAudit({ runner: fake, state, rows, rawTsv: rawFor(rows) });
	assert.equal(grown.commentCount, 3);
	assert.equal(fake.comments.length, 3);
	assert.ok(fake.comments[1].body.startsWith(rawAuditSetMarker("owner/repo", 4, AUDIT_ID, 2, 3)));

	const shrunk = await publishRawAudit({ runner: fake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) });
	assert.equal(shrunk.commentCount, 1);
	assert.equal(fake.comments.length, 1);
	assert.ok(fake.mutations.some((mutation) => mutation.startsWith("DELETE:")));
	assert.equal(extractTsvs(fake.comments.map((comment) => comment.body)).join(""), rawFor([baseRow]));
});

test("multiple owned sets require explicit selection and update only the chosen set", async () => {
	const secondSetId = "22222222-3333-4444-8555-666666666666";
	const firstBodies = render(state, [baseRow], rawFor([baseRow]), "head-core", AUDIT_ID);
	const secondBodies = render(state, [baseRow], rawFor([baseRow]), "head-core", secondSetId);
	const comments = [...commentsFor(firstBodies, "reviewer", 10), ...commentsFor(secondBodies, "reviewer", 20)];
	const fake = new FakeGitHub({ comments });
	await assert.rejects(
		() => publishRawAudit({ runner: fake, state: { ...state, auditId: OTHER_AUDIT_ID }, rows: [baseRow], rawTsv: rawFor([baseRow]) }),
		/Multiple audit comment sets.*choose one.*11111111.*22222222/,
	);
	const firstBefore = fake.comments.find((comment) => comment.id === 10)!.body;
	const result = await publishRawAudit({
		runner: fake,
		state: { ...state, task: "follow-up", auditId: OTHER_AUDIT_ID },
		rows: [baseRow],
		rawTsv: rawFor([baseRow]),
		commentSetId: secondSetId,
	});
	assert.equal(result.commentSetId, secondSetId);
	assert.equal(fake.comments.find((comment) => comment.id === 10)!.body, firstBefore);
	assert.ok(fake.comments.find((comment) => comment.id === 20)!.body.includes(OTHER_AUDIT_ID));
	assert.ok(!fake.mutations.some((mutation) => mutation.endsWith(":10")));
});

test("legacy and other-author comments remain untouched", async () => {
	const legacy = rawAuditMarker(provenance, "core", AUDIT_ID, 1);
	const foreignBody = render(state, [baseRow])[0];
	const fake = new FakeGitHub({
		comments: [
			{ id: 5, html_url: "legacy", body: legacy, user: { login: "reviewer" } },
			{ id: 6, html_url: "foreign", body: foreignBody, user: { login: "other-user" } },
		],
	});
	const result = await publishRawAudit({ runner: fake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) });
	assert.equal(result.legacyCommentCount, 1);
	assert.equal(fake.comments.find((comment) => comment.id === 5)!.body, legacy);
	assert.equal(fake.comments.find((comment) => comment.id === 6)!.body, foreignBody);
	assert.ok(!fake.mutations.some((mutation) => mutation.endsWith(":5") || mutation.endsWith(":6")));
});

test("owned malformed and incomplete aggregate sets fail closed before mutation", async () => {
	const malformed = `${auditSetMarkerPrefix("owner/repo", 4)}${AUDIT_ID}:broken -->`;
	const fake = new FakeGitHub({ comments: commentsFor([malformed]) });
	await assert.rejects(
		() => publishRawAudit({ runner: fake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) }),
		/Malformed owned audit comment-set marker/,
	);
	assert.deepEqual(fake.mutations, []);

	const incomplete = render(state, [baseRow])[0].replace(":part:1/1 -->", ":part:1/2 -->");
	const incompleteFake = new FakeGitHub({ comments: commentsFor([incomplete]) });
	await assert.rejects(
		() => publishRawAudit({ runner: incompleteFake, state, rows: [baseRow], rawTsv: rawFor([baseRow]) }),
		/incomplete continuation comments/,
	);
	assert.deepEqual(incompleteFake.mutations, []);
});

test("publisher rejects a concurrent managed-comment change before mutation", async () => {
	const existing = render(state, [baseRow]);
	const fake = new FakeGitHub({
		comments: commentsFor(existing),
		onList(current, listNumber) {
			if (listNumber === 2) current.comments[0].body += "\nconcurrent edit";
		},
	});
	const changed = { ...baseRow, decision: "Changed" };
	await assert.rejects(
		() => publishRawAudit({ runner: fake, state, rows: [changed], rawTsv: rawFor([changed]) }),
		/changed concurrently/,
	);
	assert.deepEqual(fake.mutations, []);
});

test("publisher rejects PR-head and local-checkout changes before comment mutation", async () => {
	const movingRemote = new FakeGitHub({
		onRevalidate(fake) {
			fake.prHead = "force-pushed-head";
		},
	});
	await assert.rejects(
		() => publishRawAudit({ runner: movingRemote, state, rows: [baseRow], rawTsv: rawFor([baseRow]) }),
		/changed from head-core to force-pushed/,
	);
	assert.deepEqual(movingRemote.mutations, []);

	const movingLocal = new FakeGitHub({
		onGitRead(fake, kind, readNumber) {
			if (readNumber === 1) return undefined;
			return kind === "branch" ? "feature/other" : "changed-local-head";
		},
	});
	await assert.rejects(
		() => publishRawAudit({ runner: movingLocal, state, rows: [baseRow], rawTsv: rawFor([baseRow]) }),
		/Local checkout changed/,
	);
	assert.deepEqual(movingLocal.mutations, []);
});

test("publisher preserves exact checkout, repository, and ancestry validation", async () => {
	const stale = new FakeGitHub({ head: "local-head", prHead: "remote-head" });
	await assert.rejects(
		() => publishRawAudit({ runner: stale, state, rows: [], rawTsv: rawFor([]) }),
		/does not match current checkout/,
	);
	assert.equal(stale.calls.some((call) => call.args.some((arg) => arg.includes("/compare/"))), false);

	const fork = new FakeGitHub({ repository: "attacker/repo" });
	await assert.rejects(
		() => publishRawAudit({ runner: fork, state, rows: [], rawTsv: rawFor([]) }),
		/attacker\/repo.*does not match current checkout owner\/repo/,
	);

	const diverged = new FakeGitHub({ compare: "diverged" });
	await assert.rejects(
		() => publishRawAudit({ runner: diverged, state, rows: [], rawTsv: rawFor([]) }),
		/does not descend.*diverged/,
	);
	assert.deepEqual(diverged.mutations, []);
});

test("detached and post-start branch publication retain explicit checkout intent checks", async () => {
	const detachedWithoutSelector = new FakeGitHub({ branch: "", prBranch: "feature/detached" });
	await assert.rejects(
		() => publishRawAudit({ runner: detachedWithoutSelector, state, rows: [], rawTsv: rawFor([]) }),
		/Detached checkouts require an explicit PR/,
	);
	assert.equal(detachedWithoutSelector.calls.some((call) => call.command === "gh"), false);

	const detached = new FakeGitHub({ branch: "", prBranch: "feature/detached" });
	const detachedResult = await publishRawAudit({ runner: detached, state, rows: [], rawTsv: rawFor([]), selector: "4" });
	assert.equal(detachedResult.prNumber, 4);

	const startedOnMain: AuditState = { ...state, provenance: { ...provenance, branch: "main" } };
	const branchedAfterStart = new FakeGitHub({ branch: "feature/core", prBranch: "feature/core" });
	assert.equal((await publishRawAudit({ runner: branchedAfterStart, state: startedOnMain, rows: [], rawTsv: rawFor([]) })).prNumber, 4);

	const sibling = new FakeGitHub({ branch: "feature/core", prBranch: "feature/sibling" });
	await assert.rejects(
		() => publishRawAudit({ runner: sibling, state: startedOnMain, rows: [], rawTsv: rawFor([]), selector: "4" }),
		/does not match current checkout/,
	);
	assert.equal(sibling.calls.some((call) => call.args.some((arg) => arg.includes("/compare/"))), false);
});

test("publisher requires identity and a valid explicit owned set", async () => {
	const noCalls: CommandRunner = { async exec() { throw new Error("must not run"); } };
	await assert.rejects(
		() => publishRawAudit({ runner: noCalls, state: { ...state, auditId: undefined }, rows: [], rawTsv: rawFor([]) }),
		/no identity/,
	);
	const fake = new FakeGitHub();
	await assert.rejects(
		() => publishRawAudit({ runner: fake, state, rows: [], rawTsv: rawFor([]), commentSetId: "missing" }),
		/does not exist for the authenticated GitHub author/,
	);
	assert.deepEqual(fake.mutations, []);
});
