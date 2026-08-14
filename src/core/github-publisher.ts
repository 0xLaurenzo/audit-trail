import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRows } from "./audit-store.ts";
import type { CommandRunner } from "./ports.ts";
import type { AuditRow, AuditState, GitProvenance } from "./types.ts";
import { activeRows, summarize } from "./validation.ts";

const SAFE_GITHUB_COMMENT_BYTES = 60_000;
// Leave room for the aggregate audit count and wider future part labels.
const SAFE_COMPONENT_BYTES = SAFE_GITHUB_COMMENT_BYTES - 256;
const COMPONENT_MARKER_PREFIX = "<!-- pi-audit-trail:component:v1:audit:";

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

function decisionLink(id: string, linkableIds: ReadonlySet<string>, anchorPrefix: string): string {
	const label = markdownText(id);
	return /^D\d+$/.test(id) && linkableIds.has(id) ? `[${label}](#user-content-${anchorPrefix}-${id.toLowerCase()})` : label;
}

function htmlDecisionLink(id: string, linkableIds: ReadonlySet<string>, anchorPrefix: string): string {
	const label = `<code>${htmlText(id)}</code>`;
	return /^D\d+$/.test(id) && linkableIds.has(id)
		? `<a href="#user-content-${anchorPrefix}-${id.toLowerCase()}">${label}</a>`
		: label;
}

function renderCompactMetadata(row: AuditRow, lifecycle: string, warnings: string[] = []): string[] {
	const showEntry = Boolean(row.entry.trim()) && row.entry.trim().toLowerCase() !== "none";
	return [
		`**${markdownText(row.phase)}** · ${lifecycle} · ${inlineCode(row.result)} · ${inlineCode(row.confidence)} · ${markdownText(row.origin)}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}  `,
		`<sub>${htmlText(row.ts)} · session ${htmlText(row.session)}${showEntry ? ` · entry ${htmlText(row.entry)}` : ""}</sub>`,
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

/** Legacy per-audit marker family. These comments are detected but never mutated. */
export function auditMarkerFamilyPrefix(repository: string, task: string): string {
	return `<!-- pi-audit-trail:${repository}:${task}:`;
}

/** Legacy marker retained for recognizing and testing pre-aggregate publications. */
export function rawAuditMarker(provenance: GitProvenance, task: string, auditId: string, part: number): string {
	return `${auditMarkerFamilyPrefix(provenance.repository, task)}${auditId}:part:${part} -->`;
}

function requireAuditId(state: AuditState): string {
	if (!state.auditId) {
		throw new Error("This audit has no identity; publish through the audit workflow so one can be minted.");
	}
	return state.auditId;
}

export function auditSetMarkerPrefix(repository: string, prNumber: number): string {
	return `<!-- pi-audit-trail:set:v1:${repository}:pr:${prNumber}:set:`;
}

export function rawAuditSetMarker(
	repository: string,
	prNumber: number,
	setId: string,
	part: number,
	totalParts: number,
): string {
	return `${auditSetMarkerPrefix(repository, prNumber)}${setId}:part:${part}/${totalParts} -->`;
}

export function rawAuditComponentMarker(
	auditId: string,
	segment: number,
	totalSegments: number,
	edge: "begin" | "end",
): string {
	return `${COMPONENT_MARKER_PREFIX}${auditId}:segment:${segment}/${totalSegments}:${edge} -->`;
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
	anchorPrefix: string,
	includeMetadata = false,
): string[] {
	const replacementIds = replacements.get(row.id) ?? [];
	const history: string[] = [];
	if (row.supersedes) history.push(`Supersedes ${htmlDecisionLink(row.supersedes, linkableIds, anchorPrefix)}.`);
	if (replacementIds.length) history.push(`Superseded by ${replacementIds.map((id) => htmlDecisionLink(id, linkableIds, anchorPrefix)).join(", ")}.`);
	if (!history.length) history.push("No supersession links.");
	const lifecycle = replacementIds.length
		? `superseded by ${replacementIds.map((id) => decisionLink(id, linkableIds, anchorPrefix)).join(", ")}`
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
	anchorPrefix: string,
): string[] {
	const replacementIds = replacements.get(row.id) ?? [];
	const superseded = replacementIds.length > 0;
	const anchor = /^D\d+$/.test(row.id) ? [`<a id="${anchorPrefix}-${row.id.toLowerCase()}"></a>`] : [];
	const body = renderDecisionBody(row, replacements, linkableIds, anchorPrefix, superseded);
	if (superseded) {
		const replacementSummary = replacementIds.map((id) => htmlDecisionLink(id, linkableIds, anchorPrefix)).join(", ");
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

export interface AuditComponentSegment {
	auditId: string;
	segment: number;
	totalSegments: number;
	body: string;
}

function renderAuditComponentSegment(
	state: AuditState,
	allRows: AuditRow[],
	chunk: RenderChunk,
	segment: number,
	totalSegments: number,
	publishedHead: string,
): string {
	const provenance = state.provenance!;
	const auditId = requireAuditId(state);
	const anchorPrefix = `audit-${auditId}`;
	const stats = summarize(allRows);
	const current = activeRows(allRows);
	const replacements = replacementMap(allRows);
	// A bare #fragment is only reliable inside the same rendered comment.
	const linkableIds = new Set(chunk.rows.map((row) => row.id));
	const branchLink = githubRefUrl(provenance.repositoryUrl, "tree", provenance.branch);
	const startLink = githubRefUrl(provenance.repositoryUrl, "commit", provenance.startCommit);
	const headLink = githubRefUrl(provenance.repositoryUrl, "commit", publishedHead);
	const lines = [
		rawAuditComponentMarker(auditId, segment, totalSegments, "begin"),
		`## Audit: ${inlineCode(state.taskName ?? state.task)}${totalSegments > 1 ? ` — segment ${segment}/${totalSegments}` : ""}`,
		"",
		`**Audit ID:** ${inlineCode(auditId)}  `,
		`**Commit range:** [${inlineCode(provenance.startCommit.slice(0, 12))}](${startLink})..[${inlineCode(publishedHead.slice(0, 12))}](${headLink})`,
		"",
	];
	if (segment === 1) {
		lines.push(
			"Deterministic reviewer view derived from this audit's canonical, append-only TSV.",
			"",
			`**${stats.total} decisions** · **${stats.active} active** · **${stats.unresolved.length} unresolved** · **${stats.lowConfidence.length} low-confidence** · **${stats.missingEvidence.length} missing evidence**`,
			"",
			"### Provenance and review",
			"",
			`[${markdownText(provenance.repository)}](${provenance.repositoryUrl}) · original branch [${inlineCode(provenance.branch)}](${branchLink}) · worktree ${provenance.worktreeDirty ? "dirty" : "clean"} · session ${inlineCode(provenance.sessionId)}`,
			"",
			...(state.review
				? [
					`Review ${inlineCode(state.review.verdict ?? "unknown")} · ${inlineCode(state.review.mode)} · ${inlineCode(state.review.model)} · ${inlineCode(state.review.at)} · TSV SHA-256 ${inlineCode(state.review.sha256)}`,
				]
				: ["Review metadata unavailable." ]),
			"",
			"### Current decisions",
			"",
			...(current.length
				? current.map((row) => {
					const warnings = activeWarnings(row, true);
					return `- ${decisionLink(row.id, linkableIds, anchorPrefix)} — ${markdownText(row.phase)} · ${inlineCode(row.result)} · ${inlineCode(row.confidence)}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`;
				})
				: ["_None._"]),
			"",
			"### Chronological decision history",
			"",
		);
	} else {
		lines.push(
			"Continuation of this audit's chronological decision history. Concatenate its canonical TSV blocks in segment order to recover the exact file.",
			"",
		);
	}
	for (const [index, row] of chunk.rows.entries()) {
		if (index > 0) lines.push("---", "");
		lines.push(...renderDecisionCard(row, replacements, linkableIds, anchorPrefix));
	}
	const fence = tsvFence(chunk.rawTsv);
	lines.push(
		"<details>",
		`<summary>Canonical audit TSV${totalSegments > 1 ? ` — segment ${segment} of ${totalSegments}` : ""}</summary>`,
		"",
		`${fence}tsv\n${chunk.rawTsv}${fence}`,
		"</details>",
		"",
		rawAuditComponentMarker(auditId, segment, totalSegments, "end"),
	);
	return lines.join("\n");
}

function renderAuditSetComment(
	repository: string,
	prNumber: number,
	setId: string,
	segments: AuditComponentSegment[],
	part: number,
	totalParts: number,
	componentCount: number,
): string {
	const lines = [
		rawAuditSetMarker(repository, prNumber, setId, part, totalParts),
		`# Decision audit set${totalParts > 1 ? ` (${part}/${totalParts})` : ""}`,
		"",
	];
	if (part === 1) {
		lines.push(
			`**Set ID:** ${inlineCode(setId)} · **${componentCount} audit${componentCount === 1 ? "" : "s"}**`,
			"",
			"Successive decision audits published by this GitHub author are grouped here as independently replaceable components.",
			"",
		);
	} else {
		lines.push("Continuation of the same decision audit set.", "");
	}
	for (const [index, segment] of segments.entries()) {
		if (index > 0) lines.push("", "---", "");
		lines.push(segment.body);
	}
	lines.push(
		"",
		"---",
		"_Generated by [pi-audit-trail](https://github.com/0xLaurenzo/audit-trail). Each fenced TSV is the unmodified canonical source for its audit component._",
		"",
	);
	return lines.join("\n");
}

function validateRawAudit(state: AuditState, rows: AuditRow[], rawTsv: string): string[] {
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
	return rawLines;
}

export function buildAuditComponentSegments(
	state: AuditState,
	rows: AuditRow[],
	rawTsv: string,
	publishedHead: string,
	prNumber = 1,
): AuditComponentSegment[] {
	const provenance = state.provenance;
	if (!provenance) throw new Error("This audit has no Git provenance; start a new audit with this version.");
	const auditId = requireAuditId(state);
	const rawLines = validateRawAudit(state, rows, rawTsv);
	const sizingTotal = Math.max(1, rows.length + 1);
	const chunks: RenderChunk[] = [];
	let cursor = 0;
	do {
		const segment = chunks.length + 1;
		const chunkRows: AuditRow[] = [];
		const headerLine = rawLines[0];
		if (headerLine === undefined) throw new Error("Canonical audit TSV is missing its header line");
		let chunkRaw = segment === 1 ? headerLine : "";
		const renderSized = (candidateRows: AuditRow[], candidateRaw: string): string => {
			const body = renderAuditComponentSegment(
				state,
				rows,
				{ rows: candidateRows, rawTsv: candidateRaw },
				segment,
				sizingTotal,
				publishedHead,
			);
			return renderAuditSetComment(
				provenance.repository,
				prNumber,
				auditId,
				[{ auditId, segment, totalSegments: sizingTotal, body }],
				segment,
				sizingTotal,
				1,
			);
		};
		if (Buffer.byteLength(renderSized(chunkRows, chunkRaw), "utf8") > SAFE_COMPONENT_BYTES) {
			throw new Error(`Audit overview exceeds the ${SAFE_GITHUB_COMMENT_BYTES}-byte safe GitHub comment limit`);
		}
		while (cursor < rows.length) {
			const candidateRows = [...chunkRows, rows[cursor]];
			const sourceLine = rawLines[cursor + 1];
			if (sourceLine === undefined) {
				throw new Error(`Canonical audit TSV is missing the source line for decision ${rows[cursor].id}`);
			}
			const candidateRaw = `${chunkRaw}${sourceLine}`;
			if (Buffer.byteLength(renderSized(candidateRows, candidateRaw), "utf8") > SAFE_COMPONENT_BYTES) break;
			chunkRows.push(rows[cursor]);
			chunkRaw = candidateRaw;
			cursor += 1;
		}
		if (chunkRows.length === 0 && cursor < rows.length && segment > 1) {
			throw new Error(`Decision ${rows[cursor].id} and its canonical TSV row exceed the ${SAFE_GITHUB_COMMENT_BYTES}-byte safe GitHub comment limit`);
		}
		chunks.push({ rows: chunkRows, rawTsv: chunkRaw });
	} while (cursor < rows.length);

	return chunks.map((chunk, index) => ({
		auditId,
		segment: index + 1,
		totalSegments: chunks.length,
		body: renderAuditComponentSegment(state, rows, chunk, index + 1, chunks.length, publishedHead),
	}));
}

export function buildAuditSetComments(
	repository: string,
	prNumber: number,
	setId: string,
	segments: AuditComponentSegment[],
): string[] {
	if (!segments.length) throw new Error("An audit comment set must contain at least one component segment");
	const componentCount = new Set(segments.map((segment) => segment.auditId)).size;
	const sizingTotal = segments.length;
	const parts: AuditComponentSegment[][] = [];
	for (const segment of segments) {
		let current = parts.at(-1);
		if (!current) {
			current = [];
			parts.push(current);
		}
		const candidate = [...current, segment];
		const candidateBody = renderAuditSetComment(
			repository,
			prNumber,
			setId,
			candidate,
			parts.length,
			sizingTotal,
			componentCount,
		);
		if (Buffer.byteLength(candidateBody, "utf8") <= SAFE_GITHUB_COMMENT_BYTES) {
			current.push(segment);
			continue;
		}
		if (current.length === 0) {
			throw new Error(`Audit ${segment.auditId} segment ${segment.segment} exceeds the safe GitHub comment limit`);
		}
		parts.push([segment]);
		const single = renderAuditSetComment(
			repository,
			prNumber,
			setId,
			[segment],
			parts.length,
			sizingTotal,
			componentCount,
		);
		if (Buffer.byteLength(single, "utf8") > SAFE_GITHUB_COMMENT_BYTES) {
			throw new Error(`Audit ${segment.auditId} segment ${segment.segment} exceeds the safe GitHub comment limit`);
		}
	}
	return parts.map((partSegments, index) => {
		const body = renderAuditSetComment(
			repository,
			prNumber,
			setId,
			partSegments,
			index + 1,
			parts.length,
			componentCount,
		);
		if (Buffer.byteLength(body, "utf8") > SAFE_GITHUB_COMMENT_BYTES) {
			throw new Error(`Generated audit comment-set part ${index + 1} exceeds the safe GitHub comment limit`);
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

interface SetMarker {
	setId: string;
	part: number;
	totalParts: number;
}

interface OwnedAuditSet {
	setId: string;
	/** Comments in creation (id) order; equals part order for consistent sets. */
	comments: GitHubComment[];
	segments: AuditComponentSegment[];
	/** False when an interrupted publish left valid markers with disagreeing numbering. */
	consistent: boolean;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSetMarker(body: string, repository: string, prNumber: number): SetMarker | undefined {
	const firstLine = body.split("\n", 1)[0];
	const pattern = new RegExp(`^${escapeRegex(auditSetMarkerPrefix(repository, prNumber))}([^:\\s]+):part:(\\d+)\\/(\\d+) -->$`);
	const match = firstLine.match(pattern);
	if (!match) return undefined;
	return { setId: match[1], part: Number(match[2]), totalParts: Number(match[3]) };
}

function parseComponentSegments(body: string): AuditComponentSegment[] {
	const marker = `${escapeRegex(COMPONENT_MARKER_PREFIX)}([^:\\s]+):segment:(\\d+)\\/(\\d+)`;
	const pattern = new RegExp(`^${marker}:begin -->\\n[\\s\\S]*?^${escapeRegex(COMPONENT_MARKER_PREFIX)}\\1:segment:\\2\\/\\3:end -->$`, "gm");
	const matches = [...body.matchAll(pattern)];
	const markerLines = body.split("\n").filter((line) => line.startsWith(COMPONENT_MARKER_PREFIX));
	if (markerLines.length !== matches.length * 2) {
		throw new Error("Malformed audit component markers in an owned comment set");
	}
	return matches.map((match) => ({
		auditId: match[1],
		segment: Number(match[2]),
		totalSegments: Number(match[3]),
		body: match[0],
	}));
}

function validateComponentSequence(setId: string, segments: AuditComponentSegment[]): void {
	if (!segments.length) throw new Error(`Audit comment set ${setId} contains no audit components`);
	const groups = new Map<string, AuditComponentSegment[]>();
	const completed = new Set<string>();
	let previous = "";
	for (const segment of segments) {
		if (segment.auditId !== previous) {
			if (completed.has(segment.auditId)) {
				throw new Error(`Audit ${segment.auditId} is not contiguous in comment set ${setId}`);
			}
			if (previous) completed.add(previous);
			previous = segment.auditId;
		}
		const group = groups.get(segment.auditId) ?? [];
		group.push(segment);
		groups.set(segment.auditId, group);
	}
	for (const [auditId, group] of groups) {
		const total = group[0].totalSegments;
		if (total < 1 || group.some((segment) => segment.totalSegments !== total) || group.length !== total) {
			throw new Error(`Audit ${auditId} has incomplete component segments in comment set ${setId}`);
		}
		for (const [index, segment] of group.entries()) {
			if (segment.segment !== index + 1) {
				throw new Error(`Audit ${auditId} has non-contiguous component segments in comment set ${setId}`);
			}
		}
	}
}

function discoverOwnedSets(
	comments: GitHubComment[],
	login: string,
	repository: string,
	prNumber: number,
): OwnedAuditSet[] {
	const prefix = auditSetMarkerPrefix(repository, prNumber);
	const grouped = new Map<string, { marker: SetMarker; comment: GitHubComment }[]>();
	for (const comment of comments) {
		if (comment.user?.login !== login || !comment.body.includes(prefix)) continue;
		const marker = parseSetMarker(comment.body, repository, prNumber);
		if (!marker) throw new Error(`Malformed owned audit comment-set marker on comment ${comment.id}`);
		const group = grouped.get(marker.setId) ?? [];
		group.push({ marker, comment });
		grouped.set(marker.setId, group);
	}
	const sets: OwnedAuditSet[] = [];
	for (const [setId, entries] of grouped) {
		entries.sort((a, b) => a.comment.id - b.comment.id);
		const segments = entries.flatMap((entry) => parseComponentSegments(entry.comment.body));
		const total = entries[0].marker.totalParts;
		let consistent = entries.length === total
			&& entries.every((entry, index) => entry.marker.totalParts === total && entry.marker.part === index + 1);
		if (consistent) {
			try {
				validateComponentSequence(setId, segments);
			} catch {
				// A crash between comment writes can leave consistent part markers
				// with mixed component packing; adopt it like any interrupted set.
				consistent = false;
			}
		}
		sets.push({ setId, comments: entries.map((entry) => entry.comment), segments, consistent });
	}
	return sets;
}

/**
 * Adopt an interrupted publication: author-owned comments whose valid markers
 * disagree on numbering (a crash between comment writes). Every other audit
 * must keep exactly one identical copy of each segment; the audit being
 * republished is replaced wholesale, so its conflicting copies are dropped.
 */
function repairOwnedSegments(set: OwnedAuditSet, currentAuditId: string): AuditComponentSegment[] {
	const conflict = (auditId: string): Error => new Error(
		`Audit comment set ${set.setId} was left inconsistent by an interrupted publish and audit ${auditId} has conflicting copies. Re-run publish for that audit to repair it, or remove the affected comments: ${set.comments.map((comment) => comment.html_url).join(", ")}`,
	);
	const order: string[] = [];
	const byAudit = new Map<string, Map<number, AuditComponentSegment>>();
	for (const segment of set.segments) {
		let group = byAudit.get(segment.auditId);
		if (!group) {
			group = new Map();
			byAudit.set(segment.auditId, group);
			order.push(segment.auditId);
		}
		const existing = group.get(segment.segment);
		if (!existing) {
			group.set(segment.segment, segment);
		} else if (segment.auditId !== currentAuditId && existing.body !== segment.body) {
			throw conflict(segment.auditId);
		}
	}
	return order.flatMap((auditId) => {
		const group = [...byAudit.get(auditId)!.values()].sort((a, b) => a.segment - b.segment);
		const total = group[0].totalSegments;
		if (auditId !== currentAuditId
			&& (group.length !== total || group.some((segment, index) => segment.segment !== index + 1 || segment.totalSegments !== total))) {
			throw conflict(auditId);
		}
		return group;
	});
}

function selectOwnedSet(
	sets: OwnedAuditSet[],
	requestedId: string | undefined,
	auditId: string,
): { setId: string; set?: OwnedAuditSet } {
	// Republishing must stay idempotent per audit ID at PR scope: the set that
	// already contains this audit wins, and no choice may duplicate it elsewhere.
	const containing = sets.filter((set) => set.segments.some((segment) => segment.auditId === auditId));
	if (requestedId) {
		const selected = sets.find((set) => set.setId === requestedId);
		if (!selected) throw new Error(`Audit comment set ${requestedId} does not exist for the authenticated GitHub author`);
		const conflictSet = containing.find((set) => set.setId !== requestedId);
		if (conflictSet) {
			throw new Error(
				`This audit is already published in comment set ${conflictSet.setId} (${conflictSet.comments[0].html_url}); publish without --set/commentSetId to update it there`,
			);
		}
		return { setId: selected.setId, set: selected };
	}
	if (containing.length > 1) {
		throw new Error(
			`This audit appears in multiple comment sets (${containing.map((set) => `${set.setId} (${set.comments[0].html_url})`).join(", ")}); remove the duplicate component before publishing`,
		);
	}
	if (containing.length === 1) return { setId: containing[0].setId, set: containing[0] };
	if (!sets.length) return { setId: auditId };
	if (sets.length === 1) return { setId: sets[0].setId, set: sets[0] };
	throw new Error(
		`Multiple audit comment sets belong to the authenticated GitHub author; choose one with --set/commentSetId: ${sets.map((set) => `${set.setId} (${set.comments[0].html_url})`).join(", ")}`,
	);
}

function replaceAuditComponent(
	existing: AuditComponentSegment[],
	auditId: string,
	replacement: AuditComponentSegment[],
): AuditComponentSegment[] {
	const first = existing.findIndex((segment) => segment.auditId === auditId);
	if (first === -1) return [...existing, ...replacement];
	let end = first;
	while (end < existing.length && existing[end].auditId === auditId) end += 1;
	return [...existing.slice(0, first), ...replacement, ...existing.slice(end)];
}

export interface PublishAuditInput {
	runner: CommandRunner;
	state: AuditState;
	rows: AuditRow[];
	rawTsv: string;
	/** PR number/URL/branch. Defaults to the current checked-out branch. */
	selector?: string;
	/** Stable first-audit ID of an existing owned comment set. Required only when more than one exists. */
	commentSetId?: string;
}

export interface PublishAuditResult {
	prNumber: number;
	prUrl: string;
	commentUrl: string;
	commentCount: number;
	commentSetId: string;
	componentCount: number;
	/** Legacy per-audit comments owned by this publisher; always left untouched. */
	legacyCommentCount: number;
}

export async function publishRawAudit(input: PublishAuditInput): Promise<PublishAuditResult> {
	const provenance = input.state.provenance;
	if (!provenance) throw new Error("This audit has no Git provenance; start a new audit with this version.");
	const auditId = requireAuditId(input.state);

	const branchResult = await input.runner.exec("git", ["branch", "--show-current"], { timeout: 10_000 });
	const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
	const checkoutDetached = branchResult.code === 0 && !currentBranch;
	const headResult = await input.runner.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000 });
	const currentHead = headResult.code === 0 ? headResult.stdout.trim() : "";

	let selector = input.selector?.trim();
	if (!selector) {
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
	const sameRepository = pr.headRepository?.nameWithOwner?.toLowerCase() === provenance.repository.toLowerCase();
	const sameBranch = currentBranch ? pr.headRefName === currentBranch : true;
	const sameHead = Boolean(currentHead && pr.headRefOid === currentHead);
	if (!sameRepository || !sameBranch || !sameHead) {
		throw new Error(
			`PR #${pr.number} head ${pr.headRepository?.nameWithOwner ?? "unknown"}:${pr.headRefName}@${pr.headRefOid?.slice(0, 12) ?? "unknown"} does not match current checkout ${provenance.repository}:${currentBranch || "DETACHED"}@${currentHead.slice(0, 12) || "unknown"}. Check out and update the intended PR branch before publishing.`,
		);
	}
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

	const userResult = await input.runner.exec("gh", ["api", "user", "--jq", ".login"], { timeout: 30_000 });
	if (userResult.code !== 0) throw new Error(userResult.stderr.trim() || "GitHub authentication failed");
	const login = userResult.stdout.trim();
	const commentsEndpoint = `repos/${provenance.repository}/issues/${pr.number}/comments?per_page=100`;
	const listComments = async (): Promise<GitHubComment[]> => {
		const result = await input.runner.exec("gh", ["api", "--paginate", "--slurp", commentsEndpoint], { timeout: 30_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || "could not list pull-request comments");
		return (JSON.parse(result.stdout) as GitHubComment[][]).flat();
	};
	const comments = await listComments();
	const sets = discoverOwnedSets(comments, login, provenance.repository, pr.number);
	const selected = selectOwnedSet(sets, input.commentSetId?.trim() || undefined, auditId);
	const newSegments = buildAuditComponentSegments(input.state, input.rows, input.rawTsv, pr.headRefOid, pr.number);
	const existingSegments = !selected.set
		? []
		: selected.set.consistent
			? selected.set.segments
			: repairOwnedSegments(selected.set, auditId);
	const mergedSegments = replaceAuditComponent(existingSegments, auditId, newSegments);
	validateComponentSequence(selected.setId, mergedSegments);
	const bodies = buildAuditSetComments(provenance.repository, pr.number, selected.setId, mergedSegments);
	const componentCount = new Set(mergedSegments.map((segment) => segment.auditId)).size;
	const legacyCommentCount = comments.filter(
		(comment) => comment.user?.login === login
			&& comment.body.includes(`<!-- pi-audit-trail:${provenance.repository}:`)
			&& !comment.body.includes(auditSetMarkerPrefix(provenance.repository, pr.number)),
	).length;

	const expected = new Map((selected.set?.comments ?? []).map((comment) => [comment.id, comment.body]));
	const setPrefix = `${auditSetMarkerPrefix(provenance.repository, pr.number)}${selected.setId}:part:`;
	const assertTargetUnchanged = async (): Promise<void> => {
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
		const latest = await listComments();
		const latestManaged = latest.filter(
			(comment) => comment.user?.login === login && comment.body.includes(setPrefix),
		);
		if (latestManaged.length !== expected.size
			|| latestManaged.some((comment) => expected.get(comment.id) !== comment.body)) {
			throw new Error(`Audit comment set ${selected.setId} changed concurrently; no further audit comments were changed. Re-run publish.`);
		}
	};

	const existingByPart = new Map<number, GitHubComment>();
	for (const [index, comment] of (selected.set?.comments ?? []).entries()) {
		// Interrupted sets have unreliable part markers; adopt creation order.
		const part = selected.set?.consistent
			? parseSetMarker(comment.body, provenance.repository, pr.number)!.part
			: index + 1;
		existingByPart.set(part, comment);
	}
	const tempDir = await mkdtemp(join(tmpdir(), "audit-trail-publish-"));
	const bodyPath = join(tempDir, "comment.json");
	let publishedUrl = selected.set?.comments[0]?.html_url ?? pr.url;
	try {
		// Create new continuation comments first so growth never deletes capacity
		// before the replacement set is available.
		for (let part = 1; part <= bodies.length; part += 1) {
			if (existingByPart.has(part)) continue;
			const body = bodies[part - 1];
			await writeFile(bodyPath, JSON.stringify({ body }), { encoding: "utf8", mode: 0o600 });
			await assertTargetUnchanged();
			const result = await input.runner.exec(
				"gh",
				["api", "--method", "POST", `repos/${provenance.repository}/issues/${pr.number}/comments`, "--input", bodyPath],
				{ timeout: 30_000 },
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `could not publish audit comment-set part ${part}`);
			const published = JSON.parse(result.stdout) as { id?: number; html_url?: string };
			if (typeof published.id !== "number") throw new Error("GitHub did not return the created audit comment ID");
			const comment: GitHubComment = { id: published.id, html_url: published.html_url ?? pr.url, body, user: { login } };
			existingByPart.set(part, comment);
			expected.set(comment.id, body);
			if (part === 1) publishedUrl = comment.html_url;
		}
		for (let part = 1; part <= bodies.length; part += 1) {
			const existing = existingByPart.get(part)!;
			const body = bodies[part - 1];
			if (existing.body === body) continue;
			await writeFile(bodyPath, JSON.stringify({ body }), { encoding: "utf8", mode: 0o600 });
			await assertTargetUnchanged();
			const result = await input.runner.exec(
				"gh",
				["api", "--method", "PATCH", `repos/${provenance.repository}/issues/comments/${existing.id}`, "--input", bodyPath],
				{ timeout: 30_000 },
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `could not update audit comment-set part ${part}`);
			expected.set(existing.id, body);
			existing.body = body;
			const published = JSON.parse(result.stdout) as { html_url?: string };
			if (part === 1 && published.html_url) publishedUrl = published.html_url;
		}
		for (const [part, stale] of [...existingByPart].sort((a, b) => a[0] - b[0])) {
			if (part <= bodies.length) continue;
			await assertTargetUnchanged();
			const result = await input.runner.exec(
				"gh",
				["api", "--method", "DELETE", `repos/${provenance.repository}/issues/comments/${stale.id}`],
				{ timeout: 30_000 },
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `could not remove stale audit comment ${stale.id}`);
			expected.delete(stale.id);
		}
		await assertTargetUnchanged();
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
	return {
		prNumber: pr.number,
		prUrl: pr.url,
		commentUrl: publishedUrl,
		commentCount: bodies.length,
		commentSetId: selected.setId,
		componentCount,
		legacyCommentCount,
	};
}
