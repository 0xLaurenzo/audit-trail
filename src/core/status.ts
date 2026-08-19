import { displayPath } from "./paths.ts";
import type { AuditRow, AuditState } from "./types.ts";
import { summarize } from "./validation.ts";

export function formatStatusLines(
	state: AuditState,
	rows: AuditRow[],
	currentSha256: string | undefined,
	root: string,
	/** True when the start commit is provably no longer an ancestor of HEAD. */
	diverged?: boolean,
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
			? `origin: ${state.provenance.repository}@${state.provenance.branch} (${state.provenance.startCommit.slice(0, 12)})${diverged ? " — provenance diverged: rollover required" : ""}`
			: "origin: unavailable (local audit)",
		...(state.rolloverFrom
			? [`rolled over from: ${state.rolloverFrom.taskName ?? state.rolloverFrom.task} (${state.rolloverFrom.startCommit.slice(0, 12)}..${state.rolloverFrom.head.slice(0, 12)})`]
			: []),
		state.review
			? `review: ${state.review.path} (${state.review.mode}${state.review.verdict !== "approve" ? ", blocked" : ""}${state.review.sha256 === currentSha256 ? "" : ", stale"})`
			: "review: not run",
	];
}
