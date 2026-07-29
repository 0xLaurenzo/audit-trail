import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { sha256Hex } from "../core/active-state.ts";
import { publishRawAudit } from "../core/github-publisher.ts";
import { runIndependentReview } from "../core/independent-review.ts";
import type { CommandRunner, ReviewerPort, SessionIdentity } from "../core/ports.ts";
import { formatStatusLines } from "../core/status.ts";
import { reviewBlocker } from "../core/validation.ts";
import {
	CONFIDENCE_VALUES,
	ORIGIN_VALUES,
	RESULT_VALUES,
	REVIEW_MODES,
	type NewAuditRow,
	type ReviewMode,
} from "../core/types.ts";
import type { AuditWorkflow } from "../core/workflow.ts";
import { readFile } from "node:fs/promises";

/** Newest first; initialize echoes the client's version when supported. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: any;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: object;
}

const TOOLS: ToolDefinition[] = [
	{
		name: "audit_start",
		description: "Start or resume the append-only decision audit for this Git worktree.",
		inputSchema: {
			type: "object",
			properties: { task: { type: "string", description: "Task name; slugged to .audit/<task>.tsv" } },
			required: ["task"],
		},
	},
	{
		name: "audit_decision",
		description:
			"Append one reviewer-relevant product or engineering decision whose alternative would materially change behavior or code. Excludes delivery operations and routine verification.",
		inputSchema: {
			type: "object",
			properties: {
				phase: { type: "string", description: "Short workstream or phase name" },
				origin: { type: "string", enum: [...ORIGIN_VALUES] },
				decision: { type: "string", description: "The reviewer-relevant choice, assumption, pivot, or revert" },
				why: { type: "string", description: "Technical rationale and the consequence or invariant protected" },
				alternatives: { type: "string", description: "Alternatives considered; 'none' if none" },
				confidence: { type: "string", enum: [...CONFIDENCE_VALUES] },
				evidence: { type: "string", description: "Evidence pointer such as file:line, commit SHA, or test command" },
				result: { type: "string", enum: [...RESULT_VALUES] },
				supersedes: { type: "string", description: "Prior decision ID replaced by this row, such as D0003" },
			},
			required: ["phase", "origin", "decision", "why", "confidence", "evidence", "result"],
		},
	},
	{
		name: "audit_status",
		description: "Show audit status: row counts, unresolved and low-confidence IDs, and review freshness.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "audit_review",
		description:
			"Run an independent transcript-less review with the given provider/model and record the checkpoint. May take several minutes; this server handles requests sequentially, so other tool calls queue behind it.",
		inputSchema: {
			type: "object",
			properties: {
				model: { type: "string", description: "Reviewer as provider/model" },
				mode: {
					type: "string",
					enum: [...REVIEW_MODES],
					description:
						"How the reviewer relates to the working model; state it truthfully, it is recorded in the checkpoint",
				},
			},
			required: ["model", "mode"],
		},
	},
	{
		name: "audit_publish",
		description: "Create or update readable audit comments with canonical TSV on the current checked-out branch's pull request.",
		inputSchema: {
			type: "object",
			properties: {
				selector: {
					type: "string",
					description: "PR number or URL; defaults to the current branch. The PR must be in the provenance repository, match exact local HEAD, and descend from the audit start commit.",
				},
			},
		},
	},
	{
		name: "audit_close",
		description: "Close the audit; fails while decisions are unresolved or the latest bytes are unreviewed.",
		inputSchema: { type: "object", properties: {} },
	},
];

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required argument: ${key}`);
	return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value ? value : undefined;
}

function oneOf<T extends readonly string[]>(values: T, value: string, label: string): T[number] {
	if (!values.includes(value)) {
		throw new Error(`Invalid ${label}: ${value}. Expected one of: ${values.join(", ")}`);
	}
	return value;
}

export interface McpServerOptions {
	workflow: AuditWorkflow;
	runner: CommandRunner;
	/** Reviewer runtime used by audit_review. */
	reviewer: ReviewerPort;
	/**
	 * Fixed identity, or a per-call resolver for harnesses (like Claude Code)
	 * whose session changes while this server process keeps running.
	 */
	session: SessionIdentity | (() => Promise<SessionIdentity>);
	/** Optional harness transcript for audit_review; omit for transcript-less review. */
	reviewTranscriptPath?: () => Promise<string | undefined>;
	version?: string;
}

/**
 * Minimal deterministic MCP server over the shared audit workflow. Transport
 * agnostic: `handle` maps one JSON-RPC message to at most one response.
 */
export class McpAuditServer {
	private readonly workflow: AuditWorkflow;
	private readonly runner: CommandRunner;
	private readonly reviewer: ReviewerPort;
	private readonly sessionSource: SessionIdentity | (() => Promise<SessionIdentity>);
	private readonly reviewTranscriptPath?: () => Promise<string | undefined>;
	private readonly version: string;

	constructor(options: McpServerOptions) {
		this.workflow = options.workflow;
		this.runner = options.runner;
		this.reviewer = options.reviewer;
		this.sessionSource = options.session;
		this.reviewTranscriptPath = options.reviewTranscriptPath;
		this.version = options.version ?? "0.0.0";
	}

	private session(): Promise<SessionIdentity> {
		return typeof this.sessionSource === "function" ? this.sessionSource() : Promise.resolve(this.sessionSource);
	}

	async call(name: string, args: Record<string, unknown>): Promise<string> {
		switch (name) {
			case "audit_start": {
				const result = await this.workflow.start(requireString(args, "task"), await this.session());
				const provenance = result.state.provenance;
				const lines = [
					`${result.resumed ? "Resumed" : "Started"} decision audit: ${result.state.logPath}${provenance ? ` (${provenance.repository}@${provenance.branch})` : ""}`,
				];
				if (result.provenanceError) lines.push(`Provenance unavailable: ${result.provenanceError}`);
				return lines.join("\n");
			}
			case "audit_decision": {
				const row: Omit<NewAuditRow, "session" | "entry"> = {
					phase: requireString(args, "phase"),
					origin: oneOf(ORIGIN_VALUES, requireString(args, "origin"), "origin"),
					decision: requireString(args, "decision"),
					why: requireString(args, "why"),
					alternatives: optionalString(args, "alternatives") ?? "none",
					confidence: oneOf(CONFIDENCE_VALUES, requireString(args, "confidence"), "confidence"),
					evidence: requireString(args, "evidence"),
					result: oneOf(RESULT_VALUES, requireString(args, "result"), "result"),
					supersedes: optionalString(args, "supersedes") ?? "",
				};
				const appended = await this.workflow.append(await this.session(), row);
				return `Logged ${appended.row.id}: ${appended.row.decision}`;
			}
			case "audit_status": {
				const state = await this.workflow.active();
				if (!state) return "No audit is active in this worktree.";
				const rows = await this.workflow.rows(state);
				const sha = await this.workflow.currentSha(state);
				return formatStatusLines(state, rows, sha, this.workflow.root).join("\n");
			}
			case "audit_review": {
				const model = requireString(args, "model");
				if (!model.includes("/")) throw new Error("model must be provider/model");
				// No default: the server cannot verify the reviewer's relation to the
				// working model, and a guessed mode would record false independence
				// claims in the checkpoint (mirrors the CLI's required --mode).
				const mode = oneOf(REVIEW_MODES, requireString(args, "mode"), "mode") as ReviewMode;
				const review = await runIndependentReview({
					workflow: this.workflow,
					reviewer: this.reviewer,
					model,
					mode,
					// The review artifact names the harness that served this call.
					harnessName: (await this.session()).harness,
					transcriptPath: await this.reviewTranscriptPath?.(),
				});
				const lines = [`Review saved: ${review.reviewPath} (${review.rowCount} rows reviewed, verdict: ${review.verdict})`];
				if (review.verdict === "block") {
					lines.push("The reviewer blocked this audit; publish and close stay gated until findings are addressed and it is re-reviewed.");
				}
				return lines.join("\n");
			}
			case "audit_publish": {
				const state = await this.workflow.active();
				if (!state) throw new Error("No audit is active in this worktree.");
				if (!state.provenance) throw new Error("This audit has no Git provenance; publishing requires a GitHub origin.");
				const rows = await this.workflow.rows(state);
				// Gate on the exact bytes being published.
				const rawTsv = await readFile(state.logPath, "utf8");
				const blocker = reviewBlocker(state, sha256Hex(rawTsv));
				if (blocker) throw new Error(`${blocker}. Run audit_review before publishing.`);
				const result = await publishRawAudit({
					runner: this.runner,
					state,
					rows,
					rawTsv,
					selector: optionalString(args, "selector"),
				});
				return `Published audit in ${result.commentCount} readable comment${result.commentCount === 1 ? "" : "s"} with canonical TSV on PR #${result.prNumber}: ${result.commentUrl}`;
			}
			case "audit_close": {
				const result = await this.workflow.close();
				if (!result.closed) {
					throw new Error(`Cannot close audit:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
				}
				return `Audit closed: ${result.state.logPath}`;
			}
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}

	async handle(message: JsonRpcMessage): Promise<object | undefined> {
		if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return undefined;
		const { id, method, params } = message;
		const isNotification = id === undefined || id === null;
		if (method === "notifications/initialized" || method.startsWith("notifications/")) return undefined;
		if (isNotification) return undefined;
		try {
			switch (method) {
				case "initialize": {
					const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
					return {
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion:
								requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
									? requested
									: SUPPORTED_PROTOCOL_VERSIONS[0],
							capabilities: { tools: {} },
							serverInfo: { name: "audit-trail", version: this.version },
						},
					};
				}
				case "ping":
					return { jsonrpc: "2.0", id, result: {} };
				case "tools/list":
					return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
				case "tools/call": {
					const name = params?.name;
					if (typeof name !== "string") {
						return { jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call requires params.name" } };
					}
					try {
						const text = await this.call(name, params?.arguments ?? {});
						return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
					} catch (error: any) {
						return {
							jsonrpc: "2.0",
							id,
							result: { content: [{ type: "text", text: `Error: ${error?.message ?? error}` }], isError: true },
						};
					}
				}
				default:
					return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
			}
		} catch (error: any) {
			return { jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message ?? error) } };
		}
	}
}

/** Newline-delimited JSON-RPC over stdio, per the MCP stdio transport. */
export async function serveStdio(
	server: McpAuditServer,
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<void> {
	const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		if (!line.trim()) continue;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		const response = await server.handle(message);
		if (response) output.write(`${JSON.stringify(response)}\n`);
	}
}
