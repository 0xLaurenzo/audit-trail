import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "audit-trail-control";
/// Reviewer preference, most advanced first. The Anthropic entries only apply
/// when the working model is from another provider (e.g. OpenAI); the
/// different-provider constraint filters them out otherwise. The Codex entry
/// covers Anthropic working models, where the alphabetically-first eligible
/// model may be unusable on the configured account.
const REVIEW_MODEL_PREFERENCE = [/fable/i, /opus-4-8/i, /gpt-5\.6-sol/i];
const LEGACY_HEADER = [
	"id",
	"ts",
	"session",
	"entry",
	"phase",
	"decision",
	"why",
	"alternatives",
	"confidence",
	"evidence",
	"result",
	"supersedes",
].join("\t");
const HEADER = [
	"id",
	"ts",
	"session",
	"entry",
	"phase",
	"origin",
	"decision",
	"why",
	"alternatives",
	"confidence",
	"evidence",
	"result",
	"supersedes",
].join("\t");

const ORIGIN_VALUES = [
	"user requirement",
	"user correction",
	"source invariant",
	"failing test",
	"code review",
	"external specification",
	"implementation discovery",
] as const;
const Origin = StringEnum(ORIGIN_VALUES, {
	description:
		"What caused this decision to be considered: user requirement, user correction, source invariant, failing test, code review, external specification, or implementation discovery",
});
const Confidence = StringEnum(["high", "medium", "low"] as const);
const Result = StringEnum(["open", "verified", "reverted", "inconclusive"] as const);

type OriginValue =
	| "user requirement"
	| "user correction"
	| "source invariant"
	| "failing test"
	| "code review"
	| "external specification"
	| "implementation discovery"
	| "unavailable";
type ConfidenceValue = "high" | "medium" | "low";
type ResultValue = "open" | "verified" | "reverted" | "inconclusive";

interface AuditRow {
	id: string;
	ts: string;
	session: string;
	entry: string;
	phase: string;
	origin: OriginValue;
	decision: string;
	why: string;
	alternatives: string;
	confidence: ConfidenceValue;
	evidence: string;
	result: ResultValue;
	supersedes: string;
}

interface GitProvenance {
	version: 1;
	task: string;
	startedAt: string;
	repository: string;
	repositoryUrl: string;
	branch: string;
	startCommit: string;
	worktreeDirty: boolean;
	sessionId: string;
}

interface AuditState {
	task: string;
	logPath: string;
	provenancePath?: string;
	provenance?: GitProvenance;
	reviewPath?: string;
	reviewedCount?: number;
}

type ControlData =
	| {
			action: "start";
			task: string;
			logPath: string;
			provenancePath?: string;
			provenance?: GitProvenance;
	  }
	| { action: "review"; task: string; logPath: string; reviewPath: string; reviewedCount: number }
	| { action: "close"; task: string; logPath: string };

const AuditDecisionParams = Type.Object({
	phase: Type.String({ description: "Short workstream or phase name" }),
	origin: Origin,
	decision: Type.String({
		description:
			"The reviewer-relevant product or engineering choice, assumption, pivot, or revert—not a workflow action or verification step",
	}),
	why: Type.String({
		description: "Technical reason the option is correct, including the consequence or invariant it protects",
	}),
	alternatives: Type.Optional(
		Type.String({ description: "Alternatives considered and why they were not selected; use 'none' if none" }),
	),
	confidence: Confidence,
	evidence: Type.String({
		description: "A concise evidence pointer such as file:line, commit SHA, test command, trace, or artifact path",
	}),
	result: Result,
	supersedes: Type.Optional(Type.String({ description: "Prior decision ID replaced by this row, such as D0003" })),
});

function cleanCell(value: unknown): string {
	let text = String(value ?? "")
		.replace(/[\t\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return text;
}

function safeSlug(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || `audit-${new Date().toISOString().slice(0, 10)}`;
}

function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function parseGitHubRemote(remote: string): { repository: string; repositoryUrl: string } | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
	if (!match) return undefined;
	return {
		repository: match[1],
		repositoryUrl: `https://github.com/${match[1]}`,
	};
}

async function captureGitProvenance(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
): Promise<GitProvenance> {
	const runGit = async (args: string[], allowFailure = false) => {
		const result = await pi.exec("git", args, { timeout: 10_000 });
		if (result.code !== 0 && !allowFailure) {
			throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
		}
		return result.stdout.trim();
	};

	await runGit(["rev-parse", "--show-toplevel"]);
	const remote = parseGitHubRemote(await runGit(["remote", "get-url", "origin"]));
	if (!remote) throw new Error("origin is not a GitHub repository");
	const branch = (await runGit(["branch", "--show-current"])) || "DETACHED";
	const startCommit = await runGit(["rev-parse", "HEAD"]);
	const status = await runGit(["status", "--porcelain"], true);

	return {
		version: 1,
		task,
		startedAt: new Date().toISOString(),
		repository: remote.repository,
		repositoryUrl: remote.repositoryUrl,
		branch,
		startCommit,
		worktreeDirty: Boolean(status),
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

async function ensureProvenance(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	provenancePath: string,
): Promise<GitProvenance> {
	return withFileMutationQueue(provenancePath, async () => {
		try {
			const existing = JSON.parse(await readFile(provenancePath, "utf8")) as GitProvenance;
			if (existing.version !== 1 || existing.task !== task) {
				throw new Error(`Unexpected provenance metadata in ${provenancePath}`);
			}
			return existing;
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}

		const provenance = await captureGitProvenance(pi, ctx, task);
		await mkdir(dirname(provenancePath), { recursive: true });
		await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return provenance;
	});
}

function markdownCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim() || "—";
}

function githubRefUrl(repositoryUrl: string, kind: "tree" | "commit", ref: string): string {
	return `${repositoryUrl}/${kind}/${encodeURIComponent(ref)}`;
}

function sanitizeReviewForGitHub(review: string, state: AuditState, ctx: ExtensionContext): string {
	let sanitized = review
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("- Audit log:") && !line.startsWith("- Pi session:"))
		.join("\n");
	for (const localPath of [state.logPath, state.reviewPath, ctx.cwd, ctx.sessionManager.getSessionFile()]) {
		if (localPath) sanitized = sanitized.split(localPath).join("[local path]");
	}
	return sanitized.trim();
}

function truncateGitHubComment(body: string, maxBytes = 60_000): string {
	if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
	let truncated = body;
	while (Buffer.byteLength(truncated, "utf8") > maxBytes - 100) truncated = truncated.slice(0, -500);
	return `${truncated.trimEnd()}\n\n> Summary truncated to fit GitHub's comment limit.\n`;
}

async function buildGitHubSummary(
	state: AuditState,
	rows: AuditRow[],
	ctx: ExtensionContext,
): Promise<string> {
	if (!state.provenance) throw new Error("This audit has no Git provenance; start a new audit with this version.");
	const provenance = state.provenance;
	const stats = summarize(rows);
	const active = activeRows(rows);
	const supersededIds = new Set(rows.map((row) => row.supersedes).filter(Boolean));
	const superseded = rows.filter((row) => supersededIds.has(row.id));
	const marker = `<!-- pi-audit-trail:${provenance.repository}:${state.task} -->`;
	const branchLink = githubRefUrl(provenance.repositoryUrl, "tree", provenance.branch);
	const commitLink = githubRefUrl(provenance.repositoryUrl, "commit", provenance.startCommit);
	const lines = [
		marker,
		`## Decision audit: \`${state.task}\``,
		"",
		"### Why these changes exist",
		"",
		...active.flatMap((row) => [
			`#### \`${row.id}\` · ${markdownCell(row.phase)}`,
			"",
			`- **Resulting change:** ${markdownCell(row.decision)}`,
			`- **Origin:** ${row.origin === "unavailable" ? "Unavailable (legacy decision)" : markdownCell(row.origin)}`,
			`- **Why / invariant protected:** ${markdownCell(row.why)}`,
			`- **Evidence:** ${markdownCell(row.evidence)}`,
			"",
		]),
	];

	if (active.length === 0) lines.push("No active decisions.", "");
	lines.push(
		"### Provenance",
		"",
		"| Repository | Original branch | Starting commit | Worktree at start | Pi session |",
		"|---|---|---|---|---|",
		`| [${provenance.repository}](${provenance.repositoryUrl}) | [\`${markdownCell(provenance.branch)}\`](${branchLink}) | [\`${provenance.startCommit.slice(0, 12)}\`](${commitLink}) | ${provenance.worktreeDirty ? "dirty" : "clean"} | \`${provenance.sessionId}\` |`,
		"",
		`**Decisions:** ${stats.total} total · ${stats.active} active · ${superseded.length} superseded`,
	);
	if (superseded.length) {
		lines.push(
			"",
			"<details>",
			`<summary>Superseded decisions (${superseded.length})</summary>`,
			"",
			"| ID | Phase | Decision | Result |",
			"|---|---|---|---|",
			...superseded.map(
				(row) => `| \`${row.id}\` | ${markdownCell(row.phase)} | ${markdownCell(row.decision)} | ${row.result} |`,
			),
			"",
			"</details>",
		);
	}

	const flags = [
		...stats.unresolved.map((row) => `${row.id} unresolved`),
		...stats.lowConfidence.map((row) => `${row.id} low confidence`),
		...stats.missingEvidence.map((row) => `${row.id} missing evidence`),
	];
	lines.push("", "### Attention", "", flags.length ? flags.map((flag) => `- ${flag}`).join("\n") : "No decision-state flags.");

	const review = state.reviewPath
		? sanitizeReviewForGitHub(await readFile(state.reviewPath, "utf8"), state, ctx) ||
			"Review completed with no textual findings."
		: "Not run.";
	lines.push(
		"",
		"<details>",
		"<summary>Independent review</summary>",
		"",
		review,
		"",
		"</details>",
	);
	lines.push("", "---", "_Generated by [pi-audit-trail](https://github.com/0xLaurenzo/audit-trail)._", "");
	return truncateGitHubComment(lines.join("\n"));
}

async function readRows(logPath: string): Promise<AuditRow[]> {
	let text: string;
	try {
		text = await readFile(logPath, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}

	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) return [];
	let legacy = lines[0] === LEGACY_HEADER;
	if (!legacy && lines[0] !== HEADER) throw new Error(`Unexpected audit header in ${logPath}`);

	const rows: AuditRow[] = [];
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index];
		if (line === HEADER && legacy) {
			legacy = false;
			continue;
		}
		if (line === HEADER || line === LEGACY_HEADER) {
			throw new Error(`Unexpected audit header at line ${index + 1} in ${logPath}`);
		}
		const cells = line.split("\t");
		const expectedCells = legacy ? 12 : 13;
		if (cells.length !== expectedCells) throw new Error(`Malformed audit row ${index + 1} in ${logPath}`);
		const offset = legacy ? 0 : 1;
		if (!legacy && !ORIGIN_VALUES.includes(cells[5] as (typeof ORIGIN_VALUES)[number])) {
			throw new Error(`Invalid decision origin at line ${index + 1} in ${logPath}`);
		}
		rows.push({
			id: cells[0],
			ts: cells[1],
			session: cells[2],
			entry: cells[3],
			phase: cells[4],
			origin: legacy ? "unavailable" : (cells[5] as OriginValue),
			decision: cells[5 + offset],
			why: cells[6 + offset],
			alternatives: cells[7 + offset],
			confidence: cells[8 + offset] as ConfidenceValue,
			evidence: cells[9 + offset],
			result: cells[10 + offset] as ResultValue,
			supersedes: cells[11 + offset],
		});
	}
	return rows;
}

function activeRows(rows: AuditRow[]): AuditRow[] {
	const superseded = new Set(rows.map((row) => row.supersedes).filter(Boolean));
	return rows.filter((row) => !superseded.has(row.id));
}

function summarize(rows: AuditRow[]) {
	const active = activeRows(rows);
	return {
		total: rows.length,
		active: active.length,
		unresolved: active.filter((row) => row.result === "open" || row.result === "inconclusive"),
		lowConfidence: active.filter((row) => row.confidence === "low"),
		missingEvidence: active.filter((row) => !row.evidence || row.evidence.toLowerCase() === "none"),
	};
}

async function ensureLog(logPath: string): Promise<void> {
	await withFileMutationQueue(logPath, async () => {
		await mkdir(dirname(logPath), { recursive: true });
		let existing = "";
		try {
			existing = await readFile(logPath, "utf8");
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (!existing) await writeFile(logPath, `${HEADER}\n`, { encoding: "utf8", mode: 0o600 });
		else {
			const header = existing.split(/\r?\n/, 1)[0];
			if (header !== HEADER && header !== LEGACY_HEADER) throw new Error(`Unexpected audit header in ${logPath}`);
		}
	});
}

async function appendRow(logPath: string, row: Omit<AuditRow, "id" | "ts">): Promise<AuditRow> {
	return withFileMutationQueue(logPath, async () => {
		await mkdir(dirname(logPath), { recursive: true });
		const rows = await readRows(logPath);
		if (row.supersedes && !rows.some((candidate) => candidate.id === row.supersedes)) {
			throw new Error(`Cannot supersede unknown decision ${row.supersedes}`);
		}

		const maxId = rows.reduce((max, candidate) => {
			const match = /^D(\d+)$/.exec(candidate.id);
			return match ? Math.max(max, Number(match[1])) : max;
		}, 0);
		const complete: AuditRow = {
			id: `D${String(maxId + 1).padStart(4, "0")}`,
			ts: new Date().toISOString(),
			...row,
		};
		const serializeRow = (candidate: AuditRow) =>
			[
				candidate.id,
				candidate.ts,
				candidate.session,
				candidate.entry,
				candidate.phase,
				candidate.origin,
				candidate.decision,
				candidate.why,
				candidate.alternatives,
				candidate.confidence,
				candidate.evidence,
				candidate.result,
				candidate.supersedes,
			]
				.map(cleanCell)
				.join("\t");
		const line = serializeRow(complete);
		const current = await readFile(logPath, "utf8").catch((error: any) => {
			if (error?.code === "ENOENT") return "";
			throw error;
		});
		const hasNewSchema = current.split(/\r?\n/).includes(HEADER);
		let existing = current || `${HEADER}\n`;
		if (current.startsWith(LEGACY_HEADER) && !hasNewSchema) {
			existing = `${current.endsWith("\n") ? current : `${current}\n`}${HEADER}\n`;
		}
		await writeFile(logPath, `${existing.endsWith("\n") ? existing : `${existing}\n`}${line}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return complete;
	});
}

function updateStatus(ctx: ExtensionContext, state: AuditState | undefined, rows: AuditRow[] = []): void {
	if (!state) {
		ctx.ui.setStatus("audit-trail", undefined);
		return;
	}
	const stats = summarize(rows);
	const flags = stats.unresolved.length + stats.lowConfidence.length;
	ctx.ui.setStatus("audit-trail", `audit: ${stats.total} decisions${flags ? ` · ${flags} flags` : ""}`);
}

function reconstructState(ctx: ExtensionContext): AuditState | undefined {
	let state: AuditState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as ControlData | undefined;
		if (!data) continue;
		if (data.action === "start") {
			state = {
				task: data.task,
				logPath: data.logPath,
				provenancePath: data.provenancePath,
				provenance: data.provenance,
			};
		}
		if (data.action === "review" && state?.logPath === data.logPath) {
			state.reviewPath = data.reviewPath;
			state.reviewedCount = data.reviewedCount;
		}
		if (data.action === "close" && state?.logPath === data.logPath) state = undefined;
	}
	return state;
}

function extractFinalAssistantOutput(stdout: string): { output: string; error?: string } {
	let output = "";
	let error: string | undefined;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			if (event.message.stopReason === "error") {
				error = event.message.errorMessage || "assistant message ended with an error";
			}
			const text = (event.message.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			if (text) output = text;
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return { output, error };
}

export default function auditTrailExtension(pi: ExtensionAPI) {
	let state: AuditState | undefined;

	const refresh = async (ctx: ExtensionContext) => {
		state = reconstructState(ctx);
		const rows = state ? await readRows(state.logPath).catch(() => []) : [];
		updateStatus(ctx, state, rows);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!state) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Active decision audit\n` +
				`An append-only decision audit is active at ${state.logPath}. ` +
				`Use audit_decision only for reviewer-relevant product or engineering choices where a reasonable alternative would materially change behavior or code. ` +
				`Log compatibility and migration policy, public API or schema behavior, architecture and meaningful implementation trade-offs, security or correctness invariants, ambiguous requirement interpretations, user corrections, and consequential pivots or reverts. ` +
				`Do not log branches, commits, pushes, pull requests, audit publication, routine verification, commands or tool usage, straightforward implementation steps, formatting, or documentation/version updates that do not change compatibility. ` +
				`Record what caused each choice in origin separately from the technical rationale in why; use user correction when a user changes or clarifies prior direction. ` +
				`Log choices introduced by underspecified requirements before implementing them, and state the plausible alternative and the behavior, compatibility guarantee, or invariant protected. ` +
				`Mark narrowly tailored choices, untested assumptions, and uncertainty honestly with medium/low confidence or an open/inconclusive result. ` +
				`When correcting a prior choice, append a row using supersedes; never rewrite history. ` +
				`Do not declare the audited task complete while active decisions remain open, inconclusive, low-confidence, or unsupported by evidence.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const input = event.input as { path?: unknown };
		const inputPath = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : undefined;
		const protectedPaths = [state.logPath, state.provenancePath].filter((path): path is string => Boolean(path));
		if (inputPath && protectedPaths.some((path) => inputPath === resolve(path))) {
			return {
				block: true,
				reason: "Audit logs and Git provenance are extension-managed; use audit_decision for corrections.",
			};
		}
	});

	pi.registerTool({
		name: "audit_decision",
		label: "Audit decision",
		description:
			"Append one reviewer-relevant product or engineering decision whose alternative would materially change behavior or code. Excludes delivery operations and routine verification.",
		promptSnippet: "Append a reviewer-relevant product or engineering choice to the active decision audit",
		promptGuidelines: [
			"Use audit_decision for compatibility or migration policy, public API or schema behavior, architecture or meaningful implementation trade-offs, correctness or security invariants, ambiguous requirement interpretations, user corrections, and consequential pivots or reverts.",
			"Use it only when a reasonable alternative would materially change the resulting behavior or code; state that alternative and the guarantee or invariant protected.",
			"Do not log branches, commits, pushes, pull requests, audit publication, routine verification, commands or tool usage, straightforward implementation steps, formatting, or non-compatibility documentation/version updates.",
			"Choose origin for what triggered consideration of the decision; reserve why for its technical rationale and protected consequence or invariant.",
			"Use user correction when a user changes or clarifies prior direction so attribution survives beyond the session transcript.",
		],
		parameters: AuditDecisionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) throw new Error("No audit is active. Ask the user to run /audit-start <task>.");
			const session = ctx.sessionManager.getSessionId();
			const entry = ctx.sessionManager.getLeafId() ?? "none";
			const row = await appendRow(state.logPath, {
				session,
				entry,
				phase: params.phase,
				origin: params.origin,
				decision: params.decision,
				why: params.why,
				alternatives: params.alternatives ?? "none",
				confidence: params.confidence,
				evidence: params.evidence,
				result: params.result,
				supersedes: params.supersedes ?? "",
			});
			const rows = await readRows(state.logPath);
			updateStatus(ctx, state, rows);
			return {
				content: [{ type: "text", text: `Logged ${row.id}: ${row.decision}` }],
				details: { row, logPath: state.logPath, rows },
			};
		},
	});

	pi.registerCommand("audit-start", {
		description: "Start or resume an append-only decision audit: /audit-start <task>",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify("Usage: /audit-start <task>", "error");
				return;
			}
			if (state) {
				ctx.ui.notify(`Audit already active: ${state.task} (${displayPath(state.logPath, ctx.cwd)})`, "warning");
				return;
			}
			const task = safeSlug(requested);
			const logPath = resolve(ctx.cwd, ".audit", `${task}.tsv`);
			const provenancePath = resolve(ctx.cwd, ".audit", `${task}.provenance.json`);
			let provenance: GitProvenance | undefined;
			try {
				provenance = await ensureProvenance(pi, ctx, task, provenancePath);
			} catch (error: any) {
				ctx.ui.notify(
					`Audit will remain local because GitHub provenance could not be captured: ${error?.message ?? error}`,
					"warning",
				);
			}
			await ensureLog(logPath);
			state = { task, logPath, provenancePath: provenance ? provenancePath : undefined, provenance };
			pi.appendEntry(ENTRY_TYPE, {
				action: "start",
				task,
				logPath,
				provenancePath: provenance ? provenancePath : undefined,
				provenance,
			} satisfies ControlData);
			const rows = await readRows(logPath);
			updateStatus(ctx, state, rows);
			ctx.ui.notify(
				`Decision audit active: ${displayPath(logPath, ctx.cwd)}${provenance ? `\nGitHub: ${provenance.repository}@${provenance.branch}` : ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("audit-status", {
		description: "Show active decision-audit status and unresolved decision IDs",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "info");
				return;
			}
			const rows = await readRows(state.logPath);
			const stats = summarize(rows);
			updateStatus(ctx, state, rows);
			const unresolved = stats.unresolved.map((row) => row.id).join(", ") || "none";
			const low = stats.lowConfidence.map((row) => row.id).join(", ") || "none";
			const missing = stats.missingEvidence.map((row) => row.id).join(", ") || "none";
			ctx.ui.notify(
				[
					`${state.task}: ${stats.total} rows (${stats.active} active)`,
					`unresolved: ${unresolved}`,
					`low confidence: ${low}`,
					`missing evidence: ${missing}`,
					`log: ${displayPath(state.logPath, ctx.cwd)}`,
					state.provenance
						? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
						: "origin: unavailable (legacy audit)",
					state.reviewPath ? `review: ${displayPath(state.reviewPath, ctx.cwd)}` : "review: not run",
				].join("\n"),
				stats.unresolved.length || stats.lowConfidence.length || stats.missingEvidence.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("audit-review", {
		description: "Review the active trail with a different model: /audit-review [provider/model]",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("Independent review requires a persisted pi session", "error");
				return;
			}

			const requested = args.trim();
			const available = await ctx.modelRegistry.getAvailable();
			const currentProvider = ctx.model?.provider;
			const eligible = available.filter((model) => model.provider !== currentProvider);
			const reviewModel = requested
				? available.find((model) => `${model.provider}/${model.id}` === requested)
				: (REVIEW_MODEL_PREFERENCE.map((pattern) =>
						eligible.find((model) => pattern.test(model.id)),
					).find(Boolean) ?? eligible[0]);
			if (!reviewModel) {
				ctx.ui.notify(
					requested
						? `Review model unavailable: ${requested}`
						: "No model from a different provider is available; pass /audit-review provider/model after configuring one",
					"error",
				);
				return;
			}
			if (reviewModel.provider === currentProvider) {
				ctx.ui.notify("The reviewer must use a different model provider from the working model", "error");
				return;
			}

			const rows = await readRows(state.logPath);
			const tempDir = await mkdtemp(join(tmpdir(), "pi-audit-review-"));
			const promptPath = join(tempDir, "reviewer.md");
			const reviewerPrompt = `You are an independent decision-trail reviewer. Do not redo a general line-by-line code review. Read the append-only TSV decision log and the pi JSONL session transcript, then report only what a human should scrutinize. Check that logged rows map to real actions, evidence supports claims, consequential forks or pivots were not omitted, verification was not overstated, and choices are general rather than merely sufficient for the observed case. Flag weak evidence, skipped verification, symptom patches, unjustified assumptions, scope creep, and unresolved uncertainty. Point to exact decision IDs and transcript moments. A concise "No flags" is valid. Never modify files.\n\nAudit log: ${state.logPath}\nPi session: ${sessionPath}\nWorking directory: ${ctx.cwd}`;
			await writeFile(promptPath, reviewerPrompt, { encoding: "utf8", mode: 0o600 });
			ctx.ui.notify(`Reviewing with ${reviewModel.provider}/${reviewModel.id}...`, "info");

			try {
				const invocation = await pi.exec(
					"pi",
					[
						"--mode",
						"json",
						"-p",
						"--no-session",
						"--model",
						`${reviewModel.provider}/${reviewModel.id}`,
						"--tools",
						"read,grep,find,ls",
						"--append-system-prompt",
						promptPath,
						"Perform the independent audit review now.",
					],
					{ timeout: 10 * 60 * 1000 },
				);
				if (invocation.code !== 0) {
					throw new Error(invocation.stderr.trim() || `reviewer exited with code ${invocation.code}`);
				}
				const { output, error } = extractFinalAssistantOutput(invocation.stdout);
				if (error) throw new Error(`reviewer model failed: ${error}`);
				if (!output) throw new Error("reviewer produced no final assistant output");
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const reviewPath = resolve(ctx.cwd, ".audit", `${state.task}.review.${stamp}.md`);
				const reviewDocument = `# Decision audit review\n\n- Reviewed by: ${reviewModel.provider}/${reviewModel.id}\n- Audit log: ${displayPath(state.logPath, ctx.cwd)}\n- Pi session: ${sessionPath}\n- Decision rows reviewed: ${rows.length}\n\n${output.trim()}\n`;
				await withFileMutationQueue(reviewPath, async () => {
					await mkdir(dirname(reviewPath), { recursive: true });
					await writeFile(reviewPath, reviewDocument, { encoding: "utf8", mode: 0o600 });
				});
				state.reviewPath = reviewPath;
				state.reviewedCount = rows.length;
				pi.appendEntry(ENTRY_TYPE, {
					action: "review",
					task: state.task,
					logPath: state.logPath,
					reviewPath,
					reviewedCount: rows.length,
				} satisfies ControlData);
				ctx.ui.notify(`Review saved: ${displayPath(reviewPath, ctx.cwd)}`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Audit review failed: ${error?.message ?? error}`, "error");
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	});

	pi.registerCommand("audit-publish", {
		description: "Create or update the audit summary comment on the branch PR: /audit-publish [number-or-url]",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "error");
				return;
			}
			if (!state.provenance) {
				ctx.ui.notify("This legacy audit has no Git provenance; start a new audit before publishing", "error");
				return;
			}
			const rows = await readRows(state.logPath);
			if (!state.reviewPath || state.reviewedCount !== rows.length) {
				ctx.ui.notify("Run /audit-review after the latest decision before publishing", "error");
				return;
			}

			const provenance = state.provenance;
			const requestedPr = args.trim();
			const selector = requestedPr || (provenance.branch !== "DETACHED" ? provenance.branch : "");
			if (!selector) {
				ctx.ui.notify("Detached audits require /audit-publish <pr-number-or-url>", "error");
				return;
			}
			ctx.ui.notify(`Resolving PR for ${provenance.repository}@${provenance.branch}...`, "info");

			try {
				const prResult = await pi.exec(
					"gh",
					[
						"pr",
						"view",
						selector,
						"--repo",
						provenance.repository,
						"--json",
						"number,url,title,headRefName,baseRefName",
					],
					{ timeout: 30_000 },
				);
				if (prResult.code !== 0) throw new Error(prResult.stderr.trim() || "could not resolve pull request");
				const pr = JSON.parse(prResult.stdout) as {
					number: number;
					url: string;
					title: string;
					headRefName: string;
					baseRefName: string;
				};
				if (provenance.branch !== "DETACHED" && pr.headRefName !== provenance.branch) {
					throw new Error(
						`PR #${pr.number} belongs to ${pr.headRefName}, but this audit started on ${provenance.branch}`,
					);
				}

				const body = await buildGitHubSummary(state, rows, ctx);
				const marker = `<!-- pi-audit-trail:${provenance.repository}:${state.task} -->`;
				const userResult = await pi.exec("gh", ["api", "user", "--jq", ".login"], { timeout: 30_000 });
				if (userResult.code !== 0) throw new Error(userResult.stderr.trim() || "GitHub authentication failed");
				const login = userResult.stdout.trim();
				const commentsResult = await pi.exec(
					"gh",
					[
						"api",
						"--paginate",
						"--slurp",
						`repos/${provenance.repository}/issues/${pr.number}/comments?per_page=100`,
					],
					{ timeout: 30_000 },
				);
				if (commentsResult.code !== 0) {
					throw new Error(commentsResult.stderr.trim() || "could not list pull-request comments");
				}
				const commentPages = JSON.parse(commentsResult.stdout) as Array<
					Array<{
						id: number;
						html_url: string;
						body: string;
						user?: { login?: string };
					}>
				>;
				const comments = commentPages.flat();
				const existing = comments.find((comment) => comment.user?.login === login && comment.body.includes(marker));
				const tempDir = await mkdtemp(join(tmpdir(), "pi-audit-publish-"));
				const bodyPath = join(tempDir, "comment.json");
				try {
					await writeFile(bodyPath, JSON.stringify({ body }), { encoding: "utf8", mode: 0o600 });
					const endpoint = existing
						? `repos/${provenance.repository}/issues/comments/${existing.id}`
						: `repos/${provenance.repository}/issues/${pr.number}/comments`;
					const publishResult = await pi.exec(
						"gh",
						["api", "--method", existing ? "PATCH" : "POST", endpoint, "--input", bodyPath],
						{ timeout: 30_000 },
					);
					if (publishResult.code !== 0) {
						throw new Error(publishResult.stderr.trim() || "could not publish audit summary");
					}
					const published = JSON.parse(publishResult.stdout) as { html_url?: string };
					ctx.ui.notify(
						`${existing ? "Updated" : "Posted"} audit summary on PR #${pr.number}: ${published.html_url ?? pr.url}`,
						"info",
					);
				} finally {
					await rm(tempDir, { recursive: true, force: true });
				}
			} catch (error: any) {
				ctx.ui.notify(`Audit publish failed: ${error?.message ?? error}`, "error");
			}
		},
	});

	pi.registerCommand("audit-close", {
		description: "Close the active audit after all choices are resolved and independently reviewed",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No decision audit is active", "info");
				return;
			}
			const rows = await readRows(state.logPath);
			const stats = summarize(rows);
			const blockers: string[] = [];
			if (stats.unresolved.length) blockers.push(`unresolved: ${stats.unresolved.map((row) => row.id).join(", ")}`);
			if (stats.lowConfidence.length) blockers.push(`low confidence: ${stats.lowConfidence.map((row) => row.id).join(", ")}`);
			if (stats.missingEvidence.length)
				blockers.push(`missing evidence: ${stats.missingEvidence.map((row) => row.id).join(", ")}`);
			if (!state.reviewPath || state.reviewedCount === undefined) blockers.push("independent review not run");
			else if (state.reviewedCount < rows.length) blockers.push("new decisions were added after the last review");
			if (blockers.length) {
				ctx.ui.notify(`Cannot close audit:\n${blockers.map((item) => `- ${item}`).join("\n")}`, "error");
				return;
			}
			const closing = state;
			pi.appendEntry(ENTRY_TYPE, {
				action: "close",
				task: closing.task,
				logPath: closing.logPath,
			} satisfies ControlData);
			state = undefined;
			updateStatus(ctx, undefined);
			ctx.ui.notify(`Audit closed: ${displayPath(closing.logPath, ctx.cwd)}`, "info");
		},
	});
}
