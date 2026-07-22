import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandRunner } from "../src/core/ports.ts";
import { captureGitProvenance, ensureProvenance, parseGitHubRemote } from "../src/core/provenance.ts";
import { buildReviewDocument, buildReviewPrompt } from "../src/core/review.ts";

class GitRunner implements CommandRunner {
	async exec(_command: string, args: string[]) {
		const key = args.join(" ");
		const outputs: Record<string, string> = {
			"rev-parse --show-toplevel": "/repo",
			"remote get-url origin": "git@github.com:owner/repo.git",
			"branch --show-current": "feature/core",
			"rev-parse HEAD": "abcdef1234567890",
			"status --porcelain": " M index.ts",
		};
		return { code: key in outputs ? 0 : 1, stdout: outputs[key] ?? "", stderr: "unknown command" };
	}
}

test("GitHub remotes and version 1 provenance remain compatible", async () => {
	assert.deepEqual(parseGitHubRemote("https://github.com/owner/repo.git"), {
		repository: "owner/repo",
		repositoryUrl: "https://github.com/owner/repo",
	});
	const provenance = await captureGitProvenance(
		new GitRunner(),
		"core",
		"session-1",
		new Date("2026-02-03T04:05:06.000Z"),
	);
	assert.deepEqual(provenance, {
		version: 1,
		task: "core",
		startedAt: "2026-02-03T04:05:06.000Z",
		repository: "owner/repo",
		repositoryUrl: "https://github.com/owner/repo",
		branch: "feature/core",
		startCommit: "abcdef1234567890",
		worktreeDirty: true,
		sessionId: "session-1",
	});
});

test("ensureProvenance reads an existing version 1 file without invoking Git", async () => {
	const dir = await mkdtemp(join(tmpdir(), "provenance-test-"));
	try {
		const path = join(dir, "audit.provenance.json");
		const existing = {
			version: 1 as const,
			task: "existing",
			startedAt: "2026-01-01T00:00:00.000Z",
			repository: "owner/repo",
			repositoryUrl: "https://github.com/owner/repo",
			branch: "main",
			startCommit: "abc",
			worktreeDirty: false,
			sessionId: "old-session",
		};
		await writeFile(path, JSON.stringify(existing));
		const runner: CommandRunner = { exec: async () => { throw new Error("Git must not run"); } };
		assert.deepEqual(await ensureProvenance(runner, "existing", "new-session", path), existing);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("transcript-less review prompt and document target the TSV, diff, and repository", () => {
	const prompt = buildReviewPrompt({
		logPath: "/repo/.audit/core.tsv",
		workingDirectory: "/repo",
		harnessName: "cli",
	});
	assert.match(prompt, /append-only TSV decision log, the Git diff against the audit's starting commit, and the repository/);
	assert.match(prompt, /decision IDs and repository evidence/);
	assert.doesNotMatch(prompt, /session transcript|session: /);
	const document = buildReviewDocument({
		model: "openai/reviewer",
		reviewMode: "cross-model",
		logPath: "/repo/.audit/core.tsv",
		workingDirectory: "/repo",
		rowCount: 2,
		output: "No flags\n",
		harnessName: "cli",
	});
	assert.equal(
		document,
		"# Decision audit review\n\n- Reviewed by: openai/reviewer\n- Review mode: cross-model\n- Audit log: .audit/core.tsv\n- Decision rows reviewed: 2\n\nNo flags\n",
	);
});

test("review prompt and document preserve the Pi review contract", () => {
	const prompt = buildReviewPrompt({
		logPath: "/repo/.audit/core.tsv",
		transcriptPath: "/sessions/pi.jsonl",
		workingDirectory: "/repo",
		harnessName: "pi",
	});
	assert.match(prompt, /append-only TSV decision log and the pi JSONL session transcript/);
	assert.match(prompt, /Pi session: \/sessions\/pi.jsonl/);
	const document = buildReviewDocument({
		model: "openai/reviewer",
		logPath: "/repo/.audit/core.tsv",
		transcriptPath: "/sessions/pi.jsonl",
		workingDirectory: "/repo",
		rowCount: 3,
		output: "No flags\n",
		harnessName: "pi",
	});
	assert.equal(
		document,
		"# Decision audit review\n\n- Reviewed by: openai/reviewer\n- Audit log: .audit/core.tsv\n- Pi session: /sessions/pi.jsonl\n- Decision rows reviewed: 3\n\nNo flags\n",
	);
});
