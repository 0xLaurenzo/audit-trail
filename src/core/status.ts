import type { CommandRunner } from "./ports.ts";
import { displayPath } from "./paths.ts";
import type { AuditRow, AuditState } from "./types.ts";
import { summarize } from "./validation.ts";

/** Live checkout identity, not the provenance captured when the audit started. */
export async function formatWorktreeTarget(root: string, runner: CommandRunner): Promise<string> {
	const [repository, branch] = await Promise.all([
		runner.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		runner.exec("git", ["branch", "--show-current"]),
	]);
	return [
		`worktree: ${root}`,
		`repository: ${repository.code === 0 ? repository.stdout.trim() : "unavailable"}`,
		`branch: ${branch.code === 0 ? branch.stdout.trim() || "DETACHED" : "unavailable"}`,
	].join("\n");
}

export function formatStatusLines(
	state: AuditState,
	rows: AuditRow[],
	currentSha256: string | undefined,
	root: string,
): string[] {
	const stats = summarize(rows);
	const list = (items: { id: string }[]) => items.map((item) => item.id).join(", ") || "none";
	return [
		`${state.taskName ?? state.task}: ${stats.total} rows (${stats.active} active)`,
		`unresolved: ${list(stats.unresolved)}`,
		`low confidence: ${list(stats.lowConfidence)}`,
		`missing evidence: ${list(stats.missingEvidence)}`,
		`log: ${displayPath(state.logPath, root)}`,
		state.provenance
			? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
			: "origin: unavailable (local audit)",
		state.review
			? `review: ${state.review.path} (${state.review.mode}${state.review.verdict !== "approve" ? ", blocked" : ""}${state.review.sha256 === currentSha256 ? "" : ", stale"})`
			: "review: not run",
	];
}
