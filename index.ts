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
const HEADER = [
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

const Confidence = StringEnum(["high", "medium", "low"] as const);
const Result = StringEnum(["open", "verified", "reverted", "inconclusive"] as const);

type ConfidenceValue = "high" | "medium" | "low";
type ResultValue = "open" | "verified" | "reverted" | "inconclusive";

interface AuditRow {
	id: string;
	ts: string;
	session: string;
	entry: string;
	phase: string;
	decision: string;
	why: string;
	alternatives: string;
	confidence: ConfidenceValue;
	evidence: string;
	result: ResultValue;
	supersedes: string;
}

interface AuditState {
	task: string;
	logPath: string;
	reviewPath?: string;
	reviewedCount?: number;
}

type ControlData =
	| { action: "start"; task: string; logPath: string }
	| { action: "review"; task: string; logPath: string; reviewPath: string; reviewedCount: number }
	| { action: "close"; task: string; logPath: string };

const AuditDecisionParams = Type.Object({
	phase: Type.String({ description: "Short workstream or phase name" }),
	decision: Type.String({ description: "The concrete choice, action, assumption, pivot, or checkpoint" }),
	why: Type.String({ description: "Plain-language reason for the choice" }),
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
	if (lines[0] !== HEADER) throw new Error(`Unexpected audit header in ${logPath}`);

	return lines.slice(1).map((line, index) => {
		const cells = line.split("\t");
		if (cells.length !== 12) throw new Error(`Malformed audit row ${index + 2} in ${logPath}`);
		return {
			id: cells[0],
			ts: cells[1],
			session: cells[2],
			entry: cells[3],
			phase: cells[4],
			decision: cells[5],
			why: cells[6],
			alternatives: cells[7],
			confidence: cells[8] as ConfidenceValue,
			evidence: cells[9],
			result: cells[10] as ResultValue,
			supersedes: cells[11],
		};
	});
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
		else if (existing.split(/\r?\n/, 1)[0] !== HEADER) throw new Error(`Unexpected audit header in ${logPath}`);
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
		const line = [
			complete.id,
			complete.ts,
			complete.session,
			complete.entry,
			complete.phase,
			complete.decision,
			complete.why,
			complete.alternatives,
			complete.confidence,
			complete.evidence,
			complete.result,
			complete.supersedes,
		]
			.map(cleanCell)
			.join("\t");
		const existing = rows.length === 0 ? `${HEADER}\n` : await readFile(logPath, "utf8");
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
		if (data.action === "start") state = { task: data.task, logPath: data.logPath };
		if (data.action === "review" && state?.logPath === data.logPath) {
			state.reviewPath = data.reviewPath;
			state.reviewedCount = data.reviewedCount;
		}
		if (data.action === "close" && state?.logPath === data.logPath) state = undefined;
	}
	return state;
}

function extractFinalAssistantOutput(stdout: string): string {
	let output = "";
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			const text = (event.message.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			if (text) output = text;
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return output;
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
				`Use audit_decision contemporaneously for consequential choices, assumptions, pivots, reverts, and verification checkpoints—not routine tool calls. ` +
				`Log choices introduced by underspecified requirements before implementing them. ` +
				`Mark narrowly tailored fixes, untested assumptions, and uncertainty honestly with medium/low confidence or an open/inconclusive result. ` +
				`When correcting a prior choice, append a row using supersedes; never rewrite history. ` +
				`Do not declare the audited task complete while active decisions remain open, inconclusive, low-confidence, or unsupported by evidence.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const input = event.input as { path?: unknown };
		const inputPath = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : undefined;
		if (inputPath === resolve(state.logPath)) {
			return { block: true, reason: "The active audit log is append-only; use audit_decision instead." };
		}
	});

	pi.registerTool({
		name: "audit_decision",
		label: "Audit decision",
		description:
			"Append one consequential decision, assumption, pivot, revert, or verification checkpoint to the active audit trail. Do not use for routine tool calls.",
		promptSnippet: "Append a consequential choice or checkpoint to the active decision audit",
		promptGuidelines: [
			"Use audit_decision contemporaneously whenever an active audit requires a consequential choice, assumption, pivot, revert, or verification checkpoint.",
			"Do not use audit_decision for routine file reads, edits, or shell commands.",
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
			await ensureLog(logPath);
			state = { task, logPath };
			pi.appendEntry(ENTRY_TYPE, { action: "start", task, logPath } satisfies ControlData);
			const rows = await readRows(logPath);
			updateStatus(ctx, state, rows);
			ctx.ui.notify(`Decision audit active: ${displayPath(logPath, ctx.cwd)}`, "info");
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
			let reviewModel = requested
				? available.find((model) => `${model.provider}/${model.id}` === requested)
				: available.find((model) => model.provider !== currentProvider);
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
				const output = extractFinalAssistantOutput(invocation.stdout);
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
