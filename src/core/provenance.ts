import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { directMutationQueue, type CommandRunner, type MutationQueue } from "./ports.ts";
import type { GitProvenance } from "./types.ts";

export function parseGitHubRemote(remote: string): { repository: string; repositoryUrl: string } | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
	if (!match) return undefined;
	return {
		repository: match[1],
		repositoryUrl: `https://github.com/${match[1]}`,
	};
}

export async function captureGitProvenance(
	runner: CommandRunner,
	task: string,
	sessionId: string,
	now = new Date(),
): Promise<GitProvenance> {
	const runGit = async (args: string[], allowFailure = false) => {
		const result = await runner.exec("git", args, { timeout: 10_000 });
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
		startedAt: now.toISOString(),
		repository: remote.repository,
		repositoryUrl: remote.repositoryUrl,
		branch,
		startCommit,
		worktreeDirty: Boolean(status),
		sessionId,
	};
}

export async function ensureProvenance(
	runner: CommandRunner,
	task: string,
	sessionId: string,
	provenancePath: string,
	mutationQueue: MutationQueue = directMutationQueue,
): Promise<GitProvenance> {
	return mutationQueue(provenancePath, async () => {
		try {
			const existing = JSON.parse(await readFile(provenancePath, "utf8")) as GitProvenance;
			if (existing.version !== 1 || existing.task !== task) {
				throw new Error(`Unexpected provenance metadata in ${provenancePath}`);
			}
			return existing;
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}

		const provenance = await captureGitProvenance(runner, task, sessionId);
		await mkdir(dirname(provenancePath), { recursive: true });
		await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return provenance;
	});
}
