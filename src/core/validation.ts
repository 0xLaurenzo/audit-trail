import type { AuditRow, AuditState, AuditStats } from "./types.ts";

export function activeRows(rows: AuditRow[]): AuditRow[] {
	const superseded = new Set(rows.map((row) => row.supersedes).filter(Boolean));
	return rows.filter((row) => !superseded.has(row.id));
}

export function summarize(rows: AuditRow[]): AuditStats {
	const active = activeRows(rows);
	return {
		total: rows.length,
		active: active.length,
		unresolved: active.filter((row) => row.result === "open" || row.result === "inconclusive"),
		lowConfidence: active.filter((row) => row.confidence === "low"),
		missingEvidence: active.filter((row) => !row.evidence || row.evidence.toLowerCase() === "none"),
	};
}

export function closeBlockers(state: AuditState, rows: AuditRow[], currentSha256?: string): string[] {
	const stats = summarize(rows);
	const blockers: string[] = [];
	if (stats.unresolved.length) blockers.push(`unresolved: ${stats.unresolved.map((row) => row.id).join(", ")}`);
	if (stats.lowConfidence.length) {
		blockers.push(`low confidence: ${stats.lowConfidence.map((row) => row.id).join(", ")}`);
	}
	if (stats.missingEvidence.length) {
		blockers.push(`missing evidence: ${stats.missingEvidence.map((row) => row.id).join(", ")}`);
	}
	if (!state.review) blockers.push("independent review not run");
	else if (currentSha256 === undefined || state.review.sha256 !== currentSha256) {
		blockers.push("the audit changed after the last review");
	}
	return blockers;
}
