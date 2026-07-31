import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpencodeSubprocessReviewer } from "../src/adapters/opencode-reviewer.ts";
import { createPiSubprocessReviewer } from "../src/adapters/pi-reviewer.ts";
import { runIndependentReview } from "../src/core/independent-review.ts";
import type { CommandRunner, ReviewerPort } from "../src/core/ports.ts";
import { buildReviewerCandidates } from "../src/core/reviewer-candidates.ts";
import type { NewAuditRow } from "../src/core/types.ts";
import { AuditWorkflow } from "../src/core/workflow.ts";

const noGit: CommandRunner = { exec: async () => ({ code: 1, stdout: "", stderr: "git unavailable" }) };
const row: Omit<NewAuditRow, "session" | "entry"> = {
	phase: "review",
	origin: "implementation discovery",
	decision: "Exercise reviewer fallback",
	why: "Verify adapter runtime behavior",
	alternatives: "none",
	confidence: "high",
	evidence: "test/reviewer-fallback-paths.test.ts:1",
	result: "verified",
	supersedes: "",
};
const working = { provider: "anthropic", id: "claude-opus-4-8" };
const candidates = buildReviewerCandidates(
	[
		working,
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openai", id: "fable-5" },
		{ provider: "zai", id: "glm-5" },
	],
	working,
);
const orderedModels = candidates.map((candidate) => candidate.model);

function reviewerFor(harness: "pi" | "opencode", successfulModel: string | undefined, attempted: string[]): ReviewerPort {
	const runner: CommandRunner = {
		exec: async (_command, args) => {
			if (args[0] === "--version") return { code: 0, stdout: "test", stderr: "" };
			const flag = harness === "pi" ? "--model" : "-m";
			const model = args[args.indexOf(flag) + 1];
			attempted.push(model);
			if (model !== successfulModel) {
				return { code: 1, stdout: "", stderr: "429 rate limited request_id=req_sensitive api_key=sk-sensitive" };
			}
			if (harness === "pi") {
				return {
					code: 0,
					stdout: [
						JSON.stringify({
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "No flags\nVERDICT: approve" }],
							},
						}),
						JSON.stringify({ type: "agent_settled" }),
					].join("\n"),
					stderr: "",
				};
			}
			return { code: 0, stdout: "No flags\nVERDICT: approve\n", stderr: "" };
		},
	};
	return harness === "pi" ? createPiSubprocessReviewer(runner) : createOpencodeSubprocessReviewer(runner);
}

async function startedWorkflow(root: string): Promise<AuditWorkflow> {
	const workflow = new AuditWorkflow(root, noGit);
	await workflow.start("fallback", { harness: "test", id: "session" });
	await workflow.append({ harness: "test", id: "session" }, row);
	return workflow;
}

const scenarios = [
	{ name: "same-tier retry", successfulIndex: 1 },
	{ name: "tier progression", successfulIndex: 2 },
	{ name: "final same-model fallback", successfulIndex: 3 },
] as const;

for (const harness of ["pi", "opencode"] as const) {
	for (const scenario of scenarios) {
		test(`${harness} reviewer path supports ${scenario.name}`, async () => {
			const root = await mkdtemp(join(tmpdir(), `audit-${harness}-fallback-`));
			try {
				const workflow = await startedWorkflow(root);
				const attempted: string[] = [];
				const successfulModel = orderedModels[scenario.successfulIndex];
				const result = await runIndependentReview({
					workflow,
					reviewer: reviewerFor(harness, successfulModel, attempted),
					candidates,
					harnessName: harness,
				});
				assert.deepEqual(attempted, orderedModels.slice(0, scenario.successfulIndex + 1));
				assert.equal(result.model, successfulModel);
				assert.equal(result.mode, candidates[scenario.successfulIndex].mode);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}

	test(`${harness} reviewer path reports safe total-failure diagnostics`, async () => {
		const root = await mkdtemp(join(tmpdir(), `audit-${harness}-fallback-`));
		try {
			const workflow = await startedWorkflow(root);
			const attempted: string[] = [];
			await assert.rejects(
				() =>
					runIndependentReview({
						workflow,
						reviewer: reviewerFor(harness, undefined, attempted),
						candidates,
						harnessName: harness,
					}),
				(error: Error) => {
					assert.match(error.message, /All reviewer candidates failed/);
					assert.doesNotMatch(error.message, /req_sensitive|sk-sensitive/);
					return true;
				},
			);
			assert.deepEqual(attempted, orderedModels);
			const artifacts = (await readdir(join(root, ".audit"))).filter((name) => name.includes(".review."));
			assert.deepEqual(artifacts, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
