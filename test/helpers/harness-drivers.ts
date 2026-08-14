/**
 * Conformance test drivers: one per shipped harness, each translating the
 * shared contract operations into that harness's real adapter boundary
 * (registered Pi commands/tools/hooks, OpenCode plugin tools/hooks, Claude
 * hooks + MCP server). Only external systems are simulated: Git, GitHub, and
 * the reviewer CLIs. The adapter code under test is the shipped code.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleClaudeHook } from "../../src/adapters/claude-hook.ts";
import { createClaudeSubprocessReviewer } from "../../src/adapters/claude-reviewer.ts";
import { handleCodexHook } from "../../src/adapters/codex-hook.ts";
import { codexMcpOptions } from "../../src/adapters/codex-mcp.ts";
import { AuditTrailPlugin } from "../../src/adapters/opencode.ts";
import auditTrailExtension from "../../src/adapters/pi.ts";
import type { CommandRunner, ExecResult, ReviewModel } from "../../src/core/ports.ts";
import { REVIEW_OUTPUT_CONTRACT } from "../../src/core/review-output.ts";
import { AuditWorkflow } from "../../src/core/workflow.ts";
import type { ShippedHarness } from "../../src/harness/capabilities.ts";
import { McpAuditServer } from "../../src/mcp/server.ts";
import { buildReviewOutputFixture } from "./review-output.ts";

export type ReviewerBehavior = "approve" | "block" | "missing-design-friction" | "invalid-verdict" | "fail";

/**
 * Deliberately secret-looking failure stderr: the contract asserts these
 * tokens never surface in user-facing diagnostics.
 */
export const SENSITIVE_STDERR = "429 rate limited api_key=sk-contract-secret request_id=req-contract-private";

export interface DecisionInput {
	phase: string;
	origin: string;
	decision: string;
	why: string;
	alternatives: string;
	confidence: string;
	evidence: string;
	result: string;
	supersedes: string;
}

export const DEFAULT_DECISION: DecisionInput = {
	phase: "contract",
	origin: "implementation discovery",
	decision: "A contract decision",
	why: "Because the contract requires it",
	alternatives: "none",
	confidence: "high",
	evidence: "test/helpers/harness-drivers.ts:1",
	result: "verified",
	supersedes: "",
};

export interface OperationOutcome {
	/** True when the harness reported success (including a blocking review). */
	completed: boolean;
	message: string;
}

/**
 * Scripted Git + GitHub externals for publish-path contract tests. Disabled
 * by default so most tests run provenance-less; enable before `start` so the
 * audit captures provenance and publish can validate against the scripted PR.
 */
export interface GitHubStub {
	enabled: boolean;
	/** PR head OID reported by the scripted gh; diverge it to test head validation. */
	prHeadOid: string;
	handle(command: string, args: string[]): ExecResult | undefined;
}

export function createGitHubStub(root: string): GitHubStub {
	const ok = (stdout: string): ExecResult => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
	const comments: { id: number; html_url: string; body: string; user: { login: string } }[] = [];
	const stub: GitHubStub = {
		enabled: false,
		prHeadOid: "head-contract",
		handle(command, args) {
			if (!stub.enabled) return undefined;
			if (command === "git") {
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(root);
				if (args[0] === "remote") return ok("git@github.com:owner/repo.git");
				if (args[0] === "branch") return ok("feature/contract");
				if (args[0] === "rev-parse") return ok("head-contract");
				return ok("");
			}
			if (command !== "gh") return undefined;
			if (args[0] === "pr") {
				return ok(
					JSON.stringify({
						number: 7,
						url: "https://github.com/owner/repo/pull/7",
						title: "Contract",
						headRefName: "feature/contract",
						headRefOid: stub.prHeadOid,
						headRepository: { nameWithOwner: "owner/repo" },
						isCrossRepository: false,
						baseRefName: "main",
					}),
				);
			}
			if (args.some((arg) => arg.includes("/compare/"))) return ok("ahead");
			if (args[1] === "user") return ok("reviewer");
			if (args.some((arg) => arg.includes("comments?per_page=100"))) return ok(JSON.stringify([comments]));
			const method = args[args.indexOf("--method") + 1];
			if (method === "POST" || method === "PATCH") {
				const inputPath = args[args.indexOf("--input") + 1];
				const body = JSON.parse(readFileSync(inputPath, "utf8")).body as string;
				const id = method === "POST" ? comments.length + 1 : Number(args[args.indexOf("--method") + 2].split("/").at(-1));
				const comment = method === "POST"
					? { id, html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`, body, user: { login: "reviewer" } }
					: comments.find((candidate) => candidate.id === id)!;
				comment.body = body;
				if (method === "POST") comments.push(comment);
				return ok(JSON.stringify(comment));
			}
			if (method === "DELETE") {
				const id = Number(args[args.indexOf("--method") + 2].split("/").at(-1));
				const index = comments.findIndex((comment) => comment.id === id);
				if (index !== -1) comments.splice(index, 1);
				return ok("");
			}
			return { code: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
		},
	};
	return stub;
}

export interface HarnessDriver {
	readonly harness: ShippedHarness;
	/** Explicit reviewer accepted by this harness's pinned-review path. */
	readonly explicitReviewModel: string;
	/** Mutable script: reviewer behavior per `provider/model`. */
	readonly reviewerScript: Record<string, ReviewerBehavior>;
	/** Scripted Git/GitHub externals for publish-path tests. */
	readonly github: GitHubStub;
	start(task: string): Promise<void>;
	resume(task: string): Promise<void>;
	reopen(task: string): Promise<void>;
	decide(overrides?: Partial<DecisionInput>): Promise<void>;
	status(): Promise<string>;
	review(model?: string): Promise<OperationOutcome>;
	publish(): Promise<OperationOutcome>;
	close(): Promise<OperationOutcome>;
	/** Active-audit guidance the harness would inject, if any. */
	guidance(): Promise<string | undefined>;
	attemptWrite(path: string): Promise<{ blocked: boolean; reason?: string }>;
	/** Models attempted by the simulated reviewer runtime, in order. */
	attemptedModels(): string[];
	setWorkingModel(model: ReviewModel): Promise<void>;
	setCatalog(models: ReviewModel[]): Promise<void>;
	dispose(): Promise<void>;
}

export type DriverFactory = (root: string) => Promise<HarnessDriver>;

const failGit: ExecResult = { code: 1, stdout: "", stderr: "git unavailable" };

export const DEFAULT_WORKING_MODEL: ReviewModel = { provider: "anthropic", id: "claude-opus-4-8" };
export const DEFAULT_CATALOG: ReviewModel[] = [
	DEFAULT_WORKING_MODEL,
	{ provider: "anthropic", id: "claude-fable-5" },
	{ provider: "openai", id: "fable-5" },
	{ provider: "openai", id: "gpt-5.6-sol" },
];

function behaviorText(behavior: Exclude<ReviewerBehavior, "fail">): string {
	if (behavior === "approve") return buildReviewOutputFixture({ verdict: "approve" });
	if (behavior === "block") {
		return buildReviewOutputFixture({
			sections: { auditFindings: "D0001 overstates verification." },
			verdict: "block",
		});
	}
	if (behavior === "missing-design-friction") {
		return `No flags\n${REVIEW_OUTPUT_CONTRACT.verdict.prefix} approve`;
	}
	return "Looks fine to me, probably approve-ish.";
}

/** Pi driver: loads the shipped extension against a scripted ExtensionAPI. */
export const createPiDriver: DriverFactory = async (root) => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, any>();
	const eventHandlers = new Map<string, any[]>();
	const notifications: { message: string; level: string }[] = [];
	const attempted: string[] = [];
	const reviewerScript: Record<string, ReviewerBehavior> = {};
	const github = createGitHubStub(root);
	let catalog: ReviewModel[] = [...DEFAULT_CATALOG];

	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		if (command !== "pi") return github.handle(command, args) ?? failGit;
		if (args[0] === "--version") return { code: 0, stdout: "0.0.0-contract", stderr: "" };
		const model = args[args.indexOf("--model") + 1];
		attempted.push(model);
		const behavior = reviewerScript[model] ?? "fail";
		if (behavior === "fail") return { code: 1, stdout: "", stderr: SENSITIVE_STDERR };
		return {
			code: 0,
			stdout: [
				JSON.stringify({
					type: "message_end",
					message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: behaviorText(behavior) }] },
				}),
				JSON.stringify({ type: "agent_settled" }),
			].join("\n"),
			stderr: "",
		};
	};

	const ctx: any = {
		cwd: root,
		model: { ...DEFAULT_WORKING_MODEL },
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level: level ?? "info" }),
			setStatus: () => {},
		},
		sessionManager: {
			getSessionId: () => "pi-contract-session",
			getLeafId: () => "entry-1",
			getSessionFile: () => join(root, "session.jsonl"),
		},
		modelRegistry: { getAvailable: async () => catalog },
	};

	const api = {
		exec,
		on: (name: string, handler: unknown) => {
			eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
		},
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
	};
	auditTrailExtension(api as unknown as ExtensionAPI);

	const runCommand = async (name: string, args: string): Promise<{ message: string; level: string }> => {
		const before = notifications.length;
		const command = commands.get(name);
		if (!command) throw new Error(`Pi command not registered: ${name}`);
		await command.handler(args, ctx);
		const emitted = notifications.slice(before);
		const last = emitted.at(-1) ?? { message: "", level: "info" };
		const error = emitted.find((entry) => entry.level === "error");
		return error ?? last;
	};

	return {
		harness: "pi",
		explicitReviewModel: "openai/gpt-5.6-sol",
		reviewerScript,
		github,
		async start(task) {
			const result = await runCommand("audit-start", task);
			if (result.level === "error") throw new Error(result.message);
		},
		async resume(task) {
			const result = await runCommand("audit-resume", task);
			if (result.level === "error") throw new Error(result.message);
		},
		async reopen(task) {
			const result = await runCommand("audit-reopen", task);
			if (result.level === "error") throw new Error(result.message);
		},
		async decide(overrides) {
			await tools.get("audit_decision").execute("call-1", { ...DEFAULT_DECISION, ...overrides }, undefined, undefined, ctx);
		},
		async status() {
			return (await runCommand("audit-status", "")).message;
		},
		async review(model) {
			const result = await runCommand("audit-review", model ?? "");
			return { completed: result.level !== "error", message: result.message };
		},
		async publish() {
			const result = await runCommand("audit-publish", "");
			return { completed: result.level !== "error", message: result.message };
		},
		async close() {
			const result = await runCommand("audit-close", "");
			return { completed: result.level !== "error", message: result.message };
		},
		async guidance() {
			for (const handler of eventHandlers.get("before_agent_start") ?? []) {
				const result = await handler({ systemPrompt: "BASE" }, ctx);
				if (result?.systemPrompt && result.systemPrompt !== "BASE") return result.systemPrompt;
			}
			return undefined;
		},
		async attemptWrite(path) {
			for (const handler of eventHandlers.get("tool_call") ?? []) {
				const result = await handler({ toolName: "write", input: { path } }, ctx);
				if (result?.block) return { blocked: true, reason: result.reason };
			}
			return { blocked: false };
		},
		attemptedModels: () => [...attempted],
		async setWorkingModel(model) {
			ctx.model = { ...model };
		},
		async setCatalog(models) {
			catalog = [...models];
		},
		async dispose() {},
	};
};

/** OpenCode driver: loads the shipped plugin with a stub client and scripted runner. */
export const createOpencodeDriver: DriverFactory = async (root) => {
	const attempted: string[] = [];
	const reviewerScript: Record<string, ReviewerBehavior> = {};
	const github = createGitHubStub(root);
	let providers: { id: string; models: Record<string, object> }[] = [];
	const toCatalog = (models: ReviewModel[]) => {
		const grouped = new Map<string, Record<string, object>>();
		for (const model of models) {
			grouped.set(model.provider, { ...(grouped.get(model.provider) ?? {}), [model.id]: {} });
		}
		providers = [...grouped.entries()].map(([id, models]) => ({ id, models }));
	};
	toCatalog(DEFAULT_CATALOG);

	const runner: CommandRunner = {
		exec: async (command, args) => {
			if (command !== "opencode") return github.handle(command, args) ?? failGit;
			if (args[0] === "--version") return { code: 0, stdout: "0.0.0-contract", stderr: "" };
			if (args[0] === "export") return { code: 1, stdout: "", stderr: "export unavailable" };
			const model = args[args.indexOf("-m") + 1];
			attempted.push(model);
			const behavior = reviewerScript[model] ?? "fail";
			if (behavior === "fail") return { code: 1, stdout: "", stderr: SENSITIVE_STDERR };
			return { code: 0, stdout: `${behaviorText(behavior)}\n`, stderr: "" };
		},
	};
	const client = { config: { providers: async () => ({ data: { providers } }) } };
	const hooks: any = await AuditTrailPlugin({ client, directory: root, runner });
	const context = { sessionID: "oc-contract-session", messageID: "msg-1" };
	const outcome = async (operation: () => Promise<string>): Promise<OperationOutcome> => {
		try {
			return { completed: true, message: await operation() };
		} catch (error: any) {
			return { completed: false, message: String(error?.message ?? error) };
		}
	};

	const driver: HarnessDriver = {
		harness: "opencode",
		explicitReviewModel: "openai/gpt-5.6-sol",
		reviewerScript,
		github,
		async start(task) {
			await hooks.tool.audit_start.execute({ task }, context);
		},
		async resume(task) {
			await hooks.tool.audit_resume.execute({ task }, context);
		},
		async reopen(task) {
			await hooks.tool.audit_reopen.execute({ task }, context);
		},
		async decide(overrides) {
			await hooks.tool.audit_decision.execute({ ...DEFAULT_DECISION, ...overrides }, context);
		},
		async status() {
			return hooks.tool.audit_status.execute({}, context);
		},
		review: (model) => outcome(() => hooks.tool.audit_review.execute({ model }, context)),
		publish: () => outcome(() => hooks.tool.audit_publish.execute({}, context)),
		close: () => outcome(() => hooks.tool.audit_close.execute({}, context)),
		async guidance() {
			const output = { system: [] as string[] };
			await hooks["experimental.chat.system.transform"]({}, output);
			return output.system.at(-1);
		},
		async attemptWrite(path) {
			try {
				await hooks["tool.execute.before"]({ tool: "write", sessionID: context.sessionID }, { args: { filePath: path } });
				return { blocked: false };
			} catch (error: any) {
				return { blocked: true, reason: String(error?.message ?? error) };
			}
		},
		attemptedModels: () => [...attempted],
		async setWorkingModel(model) {
			await hooks["chat.message"]({ sessionID: context.sessionID, model: { providerID: model.provider, modelID: model.id } }, {});
		},
		async setCatalog(models) {
			toCatalog(models);
		},
		async dispose() {},
	};
	await driver.setWorkingModel(DEFAULT_WORKING_MODEL);
	return driver;
};

/** Claude driver: shipped hooks plus the MCP server wiring commandMcp uses. */
export const createClaudeDriver: DriverFactory = async (root) => {
	const stateHome = await mkdtemp(join(tmpdir(), "audit-claude-contract-state-"));
	const env = { XDG_STATE_HOME: stateHome } as NodeJS.ProcessEnv;
	const attempted: string[] = [];
	const reviewerScript: Record<string, ReviewerBehavior> = {};
	const github = createGitHubStub(root);
	const gitRunner: CommandRunner = { exec: async (command, args) => github.handle(command, args) ?? failGit };
	const claudeRunner: CommandRunner = {
		exec: async (command, args) => {
			if (command !== "claude") return failGit;
			if (args[0] === "--version") return { code: 0, stdout: "0.0.0-contract", stderr: "" };
			const model = `anthropic/${args[args.indexOf("--model") + 1]}`;
			attempted.push(model);
			const behavior = reviewerScript[model] ?? "fail";
			if (behavior === "fail") return { code: 1, stdout: "", stderr: SENSITIVE_STDERR };
			return { code: 0, stdout: `${behaviorText(behavior)}\n`, stderr: "" };
		},
	};
	const workflow = new AuditWorkflow(root, gitRunner);
	const server = new McpAuditServer({
		workflow,
		runner: gitRunner,
		reviewer: createClaudeSubprocessReviewer(claudeRunner),
		session: { harness: "claude", id: "claude-contract-session" },
	});
	// Record hook session state so guidance/guard run against a live session.
	await handleClaudeHook(
		JSON.stringify({ hook_event_name: "SessionStart", session_id: "claude-contract-session", cwd: root }),
		() => gitRunner,
		env,
	);
	const outcome = async (operation: () => Promise<string>): Promise<OperationOutcome> => {
		try {
			return { completed: true, message: await operation() };
		} catch (error: any) {
			return { completed: false, message: String(error?.message ?? error) };
		}
	};
	const hook = (payload: object) => handleClaudeHook(JSON.stringify(payload), () => gitRunner, env);

	return {
		harness: "claude",
		explicitReviewModel: "anthropic/claude-fable-5",
		reviewerScript,
		github,
		async start(task) {
			await server.call("audit_start", { task });
		},
		async resume(task) {
			await server.call("audit_resume", { task });
		},
		async reopen(task) {
			await server.call("audit_reopen", { task });
		},
		async decide(overrides) {
			await server.call("audit_decision", { ...DEFAULT_DECISION, ...overrides });
		},
		async status() {
			return server.call("audit_status", {});
		},
		// The claude reviewer runs same-provider models only; mode is explicit.
		review: (model) => outcome(() => server.call("audit_review", { model: model ?? "", mode: "cross-model" })),
		publish: () => outcome(() => server.call("audit_publish", {})),
		close: () => outcome(() => server.call("audit_close", {})),
		async guidance() {
			const result = await hook({ hook_event_name: "SessionStart", session_id: "claude-contract-session", cwd: root });
			if (!result.output) return undefined;
			return JSON.parse(result.output).hookSpecificOutput?.additionalContext as string | undefined;
		},
		async attemptWrite(path) {
			const result = await hook({
				hook_event_name: "PreToolUse",
				tool_name: "Write",
				tool_input: { file_path: path },
				cwd: root,
			});
			if (!result.output) return { blocked: false };
			const decision = JSON.parse(result.output).hookSpecificOutput;
			return decision?.permissionDecision === "deny"
				? { blocked: true, reason: decision.permissionDecisionReason }
				: { blocked: false };
		},
		attemptedModels: () => [...attempted],
		async setWorkingModel() {
			// Claude declares modelDiscovery: false; the contract never calls this.
			throw new Error("claude does not support model discovery");
		},
		async setCatalog() {
			throw new Error("claude does not support model discovery");
		},
		async dispose() {
			await rm(stateHome, { recursive: true, force: true });
		},
	};
};

/** Codex driver: shipped hooks plus the Codex-specialized MCP boundary. */
export const createCodexDriver: DriverFactory = async (root) => {
	const stateHome = await mkdtemp(join(tmpdir(), "audit-codex-contract-state-"));
	const env = { XDG_STATE_HOME: stateHome } as NodeJS.ProcessEnv;
	const attempted: string[] = [];
	const reviewerScript: Record<string, ReviewerBehavior> = {};
	const github = createGitHubStub(root);
	const gitRunner: CommandRunner = { exec: async (command, args) => github.handle(command, args) ?? failGit };
	const codexRunner: CommandRunner = {
		exec: async (command, args) => {
			if (command !== "codex") return failGit;
			if (args[0] === "--version") return { code: 0, stdout: "0.0.0-contract", stderr: "" };
			const model = `openai/${args[args.indexOf("--model") + 1]}`;
			attempted.push(model);
			const behavior = reviewerScript[model] ?? "fail";
			if (behavior === "fail") return { code: 1, stdout: "", stderr: SENSITIVE_STDERR };
			const outputPath = args[args.indexOf("--output-last-message") + 1];
			await writeFile(outputPath, `${behaviorText(behavior)}\n`, "utf8");
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	const workflow = new AuditWorkflow(root, gitRunner);
	const server = new McpAuditServer({
		workflow,
		runner: gitRunner,
		...codexMcpOptions(root, codexRunner, "codex-contract-fallback", env),
	});
	const hook = (payload: object) => handleCodexHook(JSON.stringify(payload), () => gitRunner, env);
	await hook({
		hook_event_name: "SessionStart",
		session_id: "codex-contract-session",
		model: "gpt-5.6-sol",
		cwd: root,
	});
	const outcome = async (operation: () => Promise<string>): Promise<OperationOutcome> => {
		try {
			return { completed: true, message: await operation() };
		} catch (error: any) {
			return { completed: false, message: String(error?.message ?? error) };
		}
	};

	return {
		harness: "codex",
		explicitReviewModel: "openai/gpt-5.6-sol",
		reviewerScript,
		github,
		async start(task) {
			await server.call("audit_start", { task });
		},
		async resume(task) {
			await server.call("audit_resume", { task });
		},
		async reopen(task) {
			await server.call("audit_reopen", { task });
		},
		async decide(overrides) {
			await server.call("audit_decision", { ...DEFAULT_DECISION, ...overrides });
		},
		async status() {
			return server.call("audit_status", {});
		},
		review: (model) => outcome(() => server.call("audit_review", { model: model ?? "" })),
		publish: () => outcome(() => server.call("audit_publish", {})),
		close: () => outcome(() => server.call("audit_close", {})),
		async guidance() {
			const result = await hook({
				hook_event_name: "SessionStart",
				session_id: "codex-contract-session",
				model: "gpt-5.6-sol",
				cwd: root,
			});
			if (!result.output) return undefined;
			return JSON.parse(result.output).hookSpecificOutput?.additionalContext as string | undefined;
		},
		async attemptWrite(path) {
			const result = await hook({
				hook_event_name: "PreToolUse",
				tool_name: "apply_patch",
				tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` },
				cwd: root,
			});
			if (!result.output) return { blocked: false };
			const decision = JSON.parse(result.output).hookSpecificOutput;
			return decision?.permissionDecision === "deny"
				? { blocked: true, reason: decision.permissionDecisionReason }
				: { blocked: false };
		},
		attemptedModels: () => [...attempted],
		async setWorkingModel() {
			throw new Error("codex does not support model discovery");
		},
		async setCatalog() {
			throw new Error("codex does not support model discovery");
		},
		async dispose() {
			await rm(stateHome, { recursive: true, force: true });
		},
	};
};

/**
 * Conformance driver registry. The registry-completeness test fails when a
 * shipped harness has no driver here, so new adapters cannot ship without
 * joining the contract suite.
 */
export const CONFORMANCE_DRIVERS: Record<ShippedHarness, DriverFactory> = {
	pi: createPiDriver,
	opencode: createOpencodeDriver,
	claude: createClaudeDriver,
	codex: createCodexDriver,
};

/** Corrupt the active-audit state to exercise fail-closed guard behavior. */
export async function corruptActiveState(root: string): Promise<void> {
	await writeFile(join(root, ".audit", "active.json"), "{corrupt", "utf8");
}
