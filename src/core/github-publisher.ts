import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRows } from "./audit-store.ts";
import type { CommandRunner } from "./ports.ts";
import type { AuditRow, AuditState, GitProvenance } from "./types.ts";
import { activeRows, summarize } from "./validation.ts";

const SAFE_GITHUB_COMMENT_BYTES = 60_000;

function githubRefUrl(repositoryUrl: string, kind: "tree" | "commit", ref: string): string {
	return `${repositoryUrl}/${kind}/${encodeURIComponent(ref)}`;
}

function markdownText(value: string): string {
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return "—";
	return normalized
		.split("\n")
		.map((line) => line
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/([\\`*_[\]{}()#+.!|\-])/g, "\\$1"))
		.join("<br>\n");
}

function htmlText(value: string): string {
	return (value || "—")
		.replace(/\r?\n/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function inlineCode(value: string): string {
	const normalized = value.replace(/\r\n?/g, "\n") || "—";
	const longest = Math.max(0, ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(Math.max(1, longest + 1));
	const padding = /^`|`$/.test(normalized) ? " " : "";
	return `${fence}${padding}${normalized}${padding}${fence}`;
}

function decisionLink(id: string, linkableIds: ReadonlySet<string>): string {
	const label = markdownText(id);
	return /^D\d+$/.test(id) && linkableIds.has(id) ? `[${label}](#user-content-${id.toLowerCase()})` : label;
}

function htmlDecisionLink(id: string, linkableIds: ReadonlySet<string>): string {
	const label = `<code>${htmlText(id)}</code>`;
	return /^D\d+$/.test(id) && linkableIds.has(id)
		? `<a href="#user-content-${id.toLowerCase()}">${label}</a>`
		: label;
}

function compactTimestamp(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? value || "—"
		: `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function renderCompactMetadata(row: AuditRow, lifecycle: string, warnings: string[] = []): string[] {
	return [
		`**${markdownText(row.phase)}** · ${lifecycle} · ${inlineCode(row.result)} · ${inlineCode(row.confidence)} · ${markdownText(row.origin)}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}  `,
		`<sub>${htmlText(compactTimestamp(row.ts))} · session ${htmlText(row.session)} · entry ${htmlText(row.entry)}</sub>`,
	];
}

function activeWarnings(row: AuditRow, active: boolean): string[] {
	if (!active) return [];
	const warnings: string[] = [];
	if (row.result === "open" || row.result === "inconclusive") warnings.push("⚠️ unresolved");
	if (row.confidence === "low") warnings.push("⚠️ low confidence");
	if (!row.evidence || row.evidence.toLowerCase() === "none") warnings.push("⚠️ missing evidence");
	return warnings;
}

export function rawAuditMarker(provenance: GitProvenance, task: string, part: number): string {
	return `<!-- pi-audit-trail:${provenance.repository}:${task}:part:${part} -->`;
}

export function tsvFence(rawTsv: string): string {
	const longest = Math.max(0, ...Array.from(rawTsv.matchAll(/`+/g), (match) => match[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}

function replacementMap(rows: AuditRow[]): Map<string, string[]> {
	const replacements = new Map<string, string[]>();
	for (const row of rows) {
		if (!row.supersedes) continue;
		const ids = replacements.get(row.supersedes) ?? [];
		ids.push(row.id);
		replacements.set(row.supersedes, ids);
	}
	return replacements;
}

function renderDecisionBody(
	row: AuditRow,
	replacements: Map<string, string[]>,
	linkableIds: ReadonlySet<string>,
	includeMetadata = false,
): string[] {
	const replacementIds = replacements.get(row.id) ?? [];
	const history: string[] = [];
	if (row.supersedes) history.push(`Supersedes ${htmlDecisionLink(row.supersedes, linkableIds)}.`);
	if (replacementIds.length) history.push(`Superseded by ${replacementIds.map((id) => htmlDecisionLink(id, linkableIds)).join(", ")}.`);
	if (!history.length) history.push("No supersession links.");
	const lifecycle = replacementIds.length
		? `superseded by ${replacementIds.map((id) => decisionLink(id, linkableIds)).join(", ")}`
		: "active";
	return [
		...(includeMetadata ? [...renderCompactMetadata(row, lifecycle), ""] : []),
		"**Decision**",
		"",
		markdownText(row.decision),
		"",
		"**Why**",
		"",
		markdownText(row.why),
		"",
		"**Alternatives considered**",
		"",
		markdownText(row.alternatives),
		"",
		`<sub><strong>Evidence:</strong> ${htmlText(row.evidence)}</sub>`,
		"",
		`<sub><strong>History:</strong> ${history.join(" ")}</sub>`,
	];
}

function renderDecisionCard(
	row: AuditRow,
	replacements: Map<string, string[]>,
	linkableIds: ReadonlySet<string>,
): string[] {
	const replacementIds = replacements.get(row.id) ?? [];
	const superseded = replacementIds.length > 0;
	const anchor = /^D\d+$/.test(row.id) ? [`<a id="${row.id.toLowerCase()}"></a>`] : [];
	const body = renderDecisionBody(row, replacements, linkableIds, superseded);
	if (superseded) {
		const replacementSummary = replacementIds.map((id) => htmlDecisionLink(id, linkableIds)).join(", ");
		return [
			...anchor,
			"<details>",
			`<summary><strong>${htmlText(row.id)}</strong> · ${htmlText(row.phase)} · superseded by ${replacementSummary} · result: <code>${htmlText(row.result)}</code> · confidence: <code>${htmlText(row.confidence)}</code></summary>`,
			"",
			...body,
			"</details>",
			"",
		];
	}
	const warnings = activeWarnings(row, true);
	return [
		...anchor,
		`### ${markdownText(row.id)}`,
		"",
		...renderCompactMetadata(row, "active", warnings),
		"",
		...body,
		"",
	];
}

interface RenderChunk {
	rows: AuditRow[];
	rawTsv: string;
}

function renderAuditComment(
	state: AuditState,
	allRows: AuditRow[],
	chunk: RenderChunk,
	part: number,
	totalParts: number,
): string {
	const provenance = state.provenance!;
	const stats = summarize(allRows);
	const current = activeRows(allRows);
	const replacements = replacementMap(allRows);
	// A bare #fragment is only reliable inside the same rendered comment. Keep
	// cross-part relationships visible as IDs rather than emitting dead links.
	const linkableIds = new Set(chunk.rows.map((row) => row.id));
	const branchLink = githubRefUrl(provenance.repositoryUrl, "tree", provenance.branch);
	const commitLink = githubRefUrl(provenance.repositoryUrl, "commit", provenance.startCommit);
	const lines = [
		rawAuditMarker(provenance, state.task, part),
		`## Decision audit: ${inlineCode(state.task)}${totalParts > 1 ? ` (${part}/${totalParts})` : ""}`,
		"",
	];
	if (part === 1) {
		lines.push(
			"Deterministic reviewer view derived from the canonical, append-only audit TSV.",
			"",
			`**${stats.total} decisions** · **${stats.active} active** · **${stats.unresolved.length} unresolved** · **${stats.lowConfidence.length} low-confidence** · **${stats.missingEvidence.length} missing evidence**`,
			"",
			"### Provenance",
			"",
			`[${markdownText(provenance.repository)}](${provenance.repositoryUrl}) · original branch [${inlineCode(provenance.branch)}](${branchLink}) · starting commit [${inlineCode(provenance.startCommit.slice(0, 12))}](${commitLink}) · worktree ${provenance.worktreeDirty ? "dirty" : "clean"} · session ${inlineCode(provenance.sessionId)}`,
			"",
			"### Current decisions",
			"",
			...(current.length
				? current.map((row) => {
					const warnings = activeWarnings(row, true);
					return `- ${decisionLink(row.id, linkableIds)} — ${markdownText(row.phase)} · ${inlineCode(row.result)} · ${inlineCode(row.confidence)}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`;
				})
				: ["_None._"]),
			"",
			"## Chronological decision history",
			"",
		);
	} else {
		lines.push(
			"Continuation of the chronological decision history. Concatenate canonical TSV blocks in part order to recover the exact file.",
			"",
		);
	}
	for (const [index, row] of chunk.rows.entries()) {
		if (index > 0) lines.push("---", "");
		lines.push(...renderDecisionCard(row, replacements, linkableIds));
	}
	const fence = tsvFence(chunk.rawTsv);
	lines.push(
		"<details>",
		`<summary>Canonical audit TSV${totalParts > 1 ? ` — part ${part} of ${totalParts}` : ""}</summary>`,
		"",
		`${fence}tsv\n${chunk.rawTsv}${fence}`,
		"</details>",
		"",
		"---",
		"_Generated by [pi-audit-trail](https://github.com/0xLaurenzo/audit-trail). The Markdown above is a deterministic derived view; the fenced TSV is the unmodified source._",
		"",
	);
	return lines.join("\n");
}

export function buildRawGitHubComments(state: AuditState, rows: AuditRow[], rawTsv: string): string[] {
	if (!state.provenance) throw new Error("This audit has no Git provenance; start a new audit with this version.");
	if (!rawTsv.endsWith("\n")) {
		throw new Error("Canonical audit TSV must end with a newline before it can be published exactly");
	}
	const rawLines = rawTsv.match(/.*\n/g) ?? [];
	if (rawLines.join("") !== rawTsv || rawLines.length !== rows.length + 1) {
		throw new Error(`Canonical audit TSV row count does not match parsed decisions (${rawLines.length - 1} source rows, ${rows.length} parsed rows)`);
	}
	const sourceRows = parseRows(rawTsv, "canonical audit TSV selected for publication");
	const fields: (keyof AuditRow)[] = [
		"id", "ts", "session", "entry", "phase", "origin", "decision", "why", "alternatives",
		"confidence", "evidence", "result", "supersedes",
	];
	const mismatch = rows.findIndex((row, index) => fields.some((field) => row[field] !== sourceRows[index]?.[field]));
	if (mismatch !== -1) {
		throw new Error(`Parsed decision ${rows[mismatch].id || mismatch + 1} does not match the exact canonical TSV selected for publication`);
	}

	// Use the maximum possible part count while sizing so final part labels can
	// only become shorter. The rendered card and its exact source row stay in
	// the same comment; the header belongs only to part one.
	const sizingTotal = Math.max(1, rows.length + 1);
	const chunks: RenderChunk[] = [];
	let cursor = 0;
	do {
		const part = chunks.length + 1;
		const chunkRows: AuditRow[] = [];
		let chunkRaw = part === 1 ? rawLines[0] : "";
		const baseBody = renderAuditComment(state, rows, { rows: chunkRows, rawTsv: chunkRaw }, part, sizingTotal);
		if (Buffer.byteLength(baseBody, "utf8") > SAFE_GITHUB_COMMENT_BYTES) {
			throw new Error(`Audit overview exceeds the ${SAFE_GITHUB_COMMENT_BYTES}-byte safe GitHub comment limit`);
		}
		while (cursor < rows.length) {
			const candidateRows = [...chunkRows, rows[cursor]];
			const candidateRaw = `${chunkRaw}${rawLines[cursor + 1]}`;
			const candidate = renderAuditComment(state, rows, { rows: candidateRows, rawTsv: candidateRaw }, part, sizingTotal);
			if (Buffer.byteLength(candidate, "utf8") > SAFE_GITHUB_COMMENT_BYTES) break;
			chunkRows.push(rows[cursor]);
			chunkRaw = candidateRaw;
			cursor += 1;
		}
		if (chunkRows.length === 0 && cursor < rows.length && part > 1) {
			throw new Error(`Decision ${rows[cursor].id} and its canonical TSV row exceed the ${SAFE_GITHUB_COMMENT_BYTES}-byte safe GitHub comment limit`);
		}
		chunks.push({ rows: chunkRows, rawTsv: chunkRaw });
	} while (cursor < rows.length);

	return chunks.map((chunk, index) => {
		const body = renderAuditComment(state, rows, chunk, index + 1, chunks.length);
		if (Buffer.byteLength(body, "utf8") > SAFE_GITHUB_COMMENT_BYTES) {
			throw new Error(`Generated audit comment part ${index + 1} exceeds the safe GitHub comment limit`);
		}
		return body;
	});
}

interface PullRequest {
	number: number;
	url: string;
	title: string;
	headRefName: string;
	headRefOid: string;
	headRepository: { nameWithOwner: string };
	isCrossRepository: boolean;
	baseRefName: string;
}

interface GitHubComment {
	id: number;
	html_url: string;
	body: string;
	user?: { login?: string };
}

export interface PublishAuditInput {
	runner: CommandRunner;
	state: AuditState;
	rows: AuditRow[];
	rawTsv: string;
	/** PR number/URL/branch. Defaults to the current checked-out branch. */
	selector?: string;
}

export interface PublishAuditResult {
	prNumber: number;
	prUrl: string;
	commentUrl: string;
	commentCount: number;
}

export async function publishRawAudit(input: PublishAuditInput): Promise<PublishAuditResult> {
	const provenance = input.state.provenance;
	if (!provenance) throw new Error("This audit has no Git provenance; start a new audit with this version.");

	// Resolve checkout identity even for explicit selectors: a PR number alone
	// is vulnerable to typos between sibling branches that share startCommit.
	const branchResult = await input.runner.exec("git", ["branch", "--show-current"], { timeout: 10_000 });
	const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
	const checkoutDetached = branchResult.code === 0 && !currentBranch;
	const headResult = await input.runner.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000 });
	const currentHead = headResult.code === 0 ? headResult.stdout.trim() : "";

	let selector = input.selector?.trim();
	if (!selector) {
		// The work may branch after audit start. Keep provenance immutable and
		// use the caller's current branch as publication intent. A detached
		// checkout has no branch intent, even when provenance started named.
		if (!currentBranch) {
			throw new Error(
				`${checkoutDetached ? "Detached checkouts" : "Checkouts whose current branch cannot be identified"} require an explicit PR number or URL selector`,
			);
		}
		selector = currentBranch;
	}
	if (!selector) throw new Error("An explicit PR number or URL selector is required");

	const prResult = await input.runner.exec(
		"gh",
		[
			"pr",
			"view",
			selector,
			"--repo",
			provenance.repository,
			"--json",
			"number,url,title,headRefName,headRefOid,headRepository,isCrossRepository,baseRefName",
		],
		{ timeout: 30_000 },
	);
	if (prResult.code !== 0) throw new Error(prResult.stderr.trim() || `could not resolve pull request for ${selector}`);
	const pr = JSON.parse(prResult.stdout) as PullRequest;
	// Every selected PR must match the repository and exact checkout commit.
	// Branch names are labels, not identity: forks and stale remote heads can
	// share a name while referring to different work.
	const sameRepository = pr.headRepository?.nameWithOwner?.toLowerCase() === provenance.repository.toLowerCase();
	const sameBranch = currentBranch ? pr.headRefName === currentBranch : true;
	const sameHead = Boolean(currentHead && pr.headRefOid === currentHead);
	if (!sameRepository || !sameBranch || !sameHead) {
		throw new Error(
			`PR #${pr.number} head ${pr.headRepository?.nameWithOwner ?? "unknown"}:${pr.headRefName}@${pr.headRefOid?.slice(0, 12) ?? "unknown"} does not match current checkout ${provenance.repository}:${currentBranch || "DETACHED"}@${currentHead.slice(0, 12) || "unknown"}. Check out and update the intended PR branch before publishing.`,
		);
	}
	// Branch names survive force pushes and history recreation, so every target
	// (including the original named branch) must descend from immutable
	// startCommit. GitHub compare works without a locally fetched PR head.
	const compareResult = await input.runner.exec(
		"gh",
		[
			"api",
			`repos/${provenance.repository}/compare/${encodeURIComponent(provenance.startCommit)}...${encodeURIComponent(pr.headRefOid)}`,
			"--jq",
			".status",
		],
		{ timeout: 30_000 },
	);
	const relation = compareResult.code === 0 ? compareResult.stdout.trim() : "";
	if (relation !== "ahead" && relation !== "identical") {
		throw new Error(
			`PR #${pr.number} head does not descend from audit start commit ${provenance.startCommit.slice(0, 12)} (GitHub compare: ${relation || "unavailable"}). Check out or select a PR branch that contains the audit start commit.`,
		);
	}

	const bodies = buildRawGitHubComments(input.state, input.rows, input.rawTsv);
	const markerPrefix = `<!-- pi-audit-trail:${provenance.repository}:${input.state.task}:part:`;
	const userResult = await input.runner.exec("gh", ["api", "user", "--jq", ".login"], { timeout: 30_000 });
	if (userResult.code !== 0) throw new Error(userResult.stderr.trim() || "GitHub authentication failed");
	const login = userResult.stdout.trim();
	const commentsResult = await input.runner.exec(
		"gh",
		["api", "--paginate", "--slurp", `repos/${provenance.repository}/issues/${pr.number}/comments?per_page=100`],
		{ timeout: 30_000 },
	);
	if (commentsResult.code !== 0) {
		throw new Error(commentsResult.stderr.trim() || "could not list pull-request comments");
	}
	const comments = (JSON.parse(commentsResult.stdout) as GitHubComment[][]).flat();
	const managed = comments.filter(
		(comment) => comment.user?.login === login && comment.body.includes(markerPrefix),
	);
	const assertTargetUnchanged = async (): Promise<void> => {
		// Revalidate local intent first: another process may commit or switch the
		// shared worktree while publication is listing/building comments.
		const [branchNow, headNow] = await Promise.all([
			input.runner.exec("git", ["branch", "--show-current"], { timeout: 10_000 }),
			input.runner.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000 }),
		]);
		const branch = branchNow.code === 0 ? branchNow.stdout.trim() : "";
		const head = headNow.code === 0 ? headNow.stdout.trim() : "";
		if (branch !== currentBranch || head !== currentHead) {
			throw new Error(
				`Local checkout changed from ${currentBranch || "DETACHED"}@${currentHead.slice(0, 12)} to ${branch || "DETACHED"}@${head.slice(0, 12) || "unknown"} while publishing; no further audit comments were changed. Re-run publish from the intended checkout.`,
			);
		}

		// GitHub comment APIs have no conditional write tied to a PR head OID.
		// Revalidate immediately before every mutation to minimize the remote
		// force-push window; never mutate after an observed head change.
		const currentResult = await input.runner.exec(
			"gh",
			["pr", "view", String(pr.number), "--repo", provenance.repository, "--json", "headRefOid"],
			{ timeout: 30_000 },
		);
		if (currentResult.code !== 0) throw new Error(currentResult.stderr.trim() || `could not revalidate PR #${pr.number} head`);
		const current = JSON.parse(currentResult.stdout) as { headRefOid?: string };
		if (current.headRefOid !== pr.headRefOid) {
			throw new Error(
				`PR #${pr.number} changed from ${pr.headRefOid.slice(0, 12)} to ${current.headRefOid?.slice(0, 12) ?? "unknown"} while publishing; no further audit comments were changed. Re-run publish from the updated checkout.`,
			);
		}
	};
	const unused = new Map(managed.map((comment) => [comment.id, comment]));
	const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-publish-"));
	const bodyPath = join(tempDir, "comment.json");
	let publishedUrl = pr.url;
	try {
		for (const [index, body] of bodies.entries()) {
			const marker = rawAuditMarker(provenance, input.state.task, index + 1);
			const existing = managed.find((comment) => comment.body.includes(marker));
			if (existing) unused.delete(existing.id);
			await writeFile(bodyPath, JSON.stringify({ body }), { encoding: "utf8", mode: 0o600 });
			const endpoint = existing
				? `repos/${provenance.repository}/issues/comments/${existing.id}`
				: `repos/${provenance.repository}/issues/${pr.number}/comments`;
			await assertTargetUnchanged();
			const publishResult = await input.runner.exec(
				"gh",
				["api", "--method", existing ? "PATCH" : "POST", endpoint, "--input", bodyPath],
				{ timeout: 30_000 },
			);
			if (publishResult.code !== 0) {
				throw new Error(publishResult.stderr.trim() || `could not publish audit TSV part ${index + 1}`);
			}
			const published = JSON.parse(publishResult.stdout) as { html_url?: string };
			if (index === 0 && published.html_url) publishedUrl = published.html_url;
		}
		for (const stale of unused.values()) {
			await assertTargetUnchanged();
			const deleteResult = await input.runner.exec(
				"gh",
				["api", "--method", "DELETE", `repos/${provenance.repository}/issues/comments/${stale.id}`],
				{ timeout: 30_000 },
			);
			if (deleteResult.code !== 0) {
				throw new Error(deleteResult.stderr.trim() || `could not remove stale audit comment ${stale.id}`);
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
	return {
		prNumber: pr.number,
		prUrl: pr.url,
		commentUrl: publishedUrl,
		commentCount: bodies.length,
	};
}
