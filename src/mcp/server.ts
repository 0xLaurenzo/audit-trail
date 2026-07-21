import { createInterface } from "node:readline";
import { sha256Hex } from "../core/active-state.ts";
import { publishRawAudit } from "../core/github-publisher.ts";
import { runIndependentReview } from "../core/independent-review.ts";
import type { CommandRunner, SessionIdentity } from "../core/ports.ts";
import { formatStatusLines } from "../core/status.ts";
import { ORIGIN_VALUES, type NewAuditRow, type ReviewMode } from "../core/types.ts";
import type { AuditWorkflow } from "../core/workflow.ts";
import { readFile } from "node:fs/promises";

const PROTOCOL_VERSION = "2024-11-05";
const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
const RESULT_VALUES = ["open", "verified", "reverted", "inconclusive"] as const;
const REVIEW_MODES = ["cross-provider", "cross-model", "same-model"] as const;

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
		description: "Run an independent transcript-less review with the given provider/model and record the checkpoint.",
		inputSchema: {
			type: "object",
			properties: {
				model: { type: "string", description: "Reviewer as provider/model" },
				mode: { type: "string", enum: [...REVIEW_MODES], description: "Relation to the working model" },
			},
			required: ["model"],
		},
	},
	{
		name: "audit_publish",
		description: "Create or update raw audit TSV comments on the original branch's pull request.",
		inputSchema: {
			type: "object",
			properties: { selector: { type: "string", description: "PR number or URL; defaults to the audit branch" } },
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
	session: SessionIdentity;
	version?: string;
}

/**
 * Minimal deterministic MCP server over the shared audit workflow. Transport
 * agnostic: `handle` maps one JSON-RPC message to at most one response.
 */
export class McpAuditServer {
	private readonly workflow: AuditWorkflow;
	private readonly runner: CommandRunner;
	private readonly session: SessionIdentity;
	private readonly version: string;

	constructor(options: McpServerOptions) {
		this.workflow = options.workflow;
		this.runner = options.runner;
		this.session = options.session;
		this.version = options.version ?? "0.0.0";
	}

	async call(name: string, args: Record<string, unknown>): Promise<string> {
		switch (name) {
			case "audit_start": {
				const result = await this.workflow.start(requireString(args, "task"), this.session);
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
				const appended = await this.workflow.append(this.session, row);
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
				const mode = oneOf(REVIEW_MODES, optionalString(args, "mode") ?? "cross-provider", "mode") as ReviewMode;
				const review = await runIndependentReview({
					workflow: this.workflow,
					runner: this.runner,
					model,
					mode,
					harnessName: "mcp",
				});
				return `Review saved: ${review.reviewPath} (${review.rowCount} rows reviewed)`;
			}
			case "audit_publish": {
				const state = await this.workflow.active();
				if (!state) throw new Error("No audit is active in this worktree.");
				if (!state.provenance) throw new Error("This audit has no Git provenance; publishing requires a GitHub origin.");
				const rows = await this.workflow.rows(state);
				// Gate on the exact bytes being published.
				const rawTsv = await readFile(state.logPath, "utf8");
				if (!state.review || state.review.sha256 !== sha256Hex(rawTsv)) {
					throw new Error("Run audit_review after the latest decision before publishing.");
				}
				const selector =
					optionalString(args, "selector") ?? (state.provenance.branch !== "DETACHED" ? state.provenance.branch : "");
				if (!selector) throw new Error("Detached audits require a PR number or URL selector.");
				const result = await publishRawAudit({ runner: this.runner, state, rows, rawTsv, selector });
				return `Published raw audit TSV in ${result.commentCount} comment${result.commentCount === 1 ? "" : "s"} on PR #${result.prNumber}: ${result.commentUrl}`;
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
				case "initialize":
					return {
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "audit-trail", version: this.version },
						},
					};
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
export async function serveStdio(server: McpAuditServer): Promise<void> {
	const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		if (!line.trim()) continue;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		const response = await server.handle(message);
		if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
	}
}
