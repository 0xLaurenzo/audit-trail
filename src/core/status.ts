import { displayPath } from "./paths.ts";
import type { AuditRow, AuditState } from "./types.ts";
import { summarize } from "./validation.ts";

export function formatStatusLines(
	state: AuditState,
	rows: AuditRow[],
	currentSha256: string | undefined,
	root: string,
): string[] {
	const stats = summarize(rows);
	const list = (items: { id: string }[]) => items.map((item) => item.id).join(", ") || "none";
	return [
		`${state.task}: ${stats.total} rows (${stats.active} active)`,
		`unresolved: ${list(stats.unresolved)}`,
		`low confidence: ${list(stats.lowConfidence)}`,
		`missing evidence: ${list(stats.missingEvidence)}`,
		`log: ${displayPath(state.logPath, root)}`,
		state.provenance
			? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})`
			: "origin: unavailable (local audit)",
		state.review
			? `review: ${state.review.path} (${state.review.mode}${state.review.sha256 === currentSha256 ? "" : ", stale"})`
			: "review: not run",
	];
}
