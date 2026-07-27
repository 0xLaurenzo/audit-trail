export const AUDIT_HEADER = [
	"id",
	"ts",
	"session",
	"entry",
	"phase",
	"origin",
	"decision",
	"why",
	"alternatives",
	"confidence",
	"evidence",
	"result",
	"supersedes",
].join("\t");

export const ORIGIN_VALUES = [
	"user requirement",
	"user correction",
	"source invariant",
	"failing test",
	"code review",
	"external specification",
	"implementation discovery",
] as const;

export type OriginValue = (typeof ORIGIN_VALUES)[number];
export type ConfidenceValue = "high" | "medium" | "low";
export type ResultValue = "open" | "verified" | "reverted" | "inconclusive";

export interface AuditRow {
	id: string;
	ts: string;
	session: string;
	entry: string;
	phase: string;
	origin: OriginValue;
	decision: string;
	why: string;
	alternatives: string;
	confidence: ConfidenceValue;
	evidence: string;
	result: ResultValue;
	supersedes: string;
}

export type NewAuditRow = Omit<AuditRow, "id" | "ts">;

/** How the independent reviewer relates to the working model. */
export type ReviewMode = "cross-provider" | "cross-model" | "same-model";

/** Snapshot of the audit at the moment it was last independently reviewed. */
export interface ReviewSnapshot {
	/** Review artifact path, relative to the worktree root when inside it. */
	path: string;
	/** SHA-256 of the exact TSV bytes that were reviewed. */
	sha256: string;
	mode: ReviewMode;
	model: string;
	at: string;
}

/** Version 1 is kept intact so existing Pi provenance files remain readable. */
export interface GitProvenance {
	version: 1;
	task: string;
	startedAt: string;
	repository: string;
	repositoryUrl: string;
	branch: string;
	startCommit: string;
	worktreeDirty: boolean;
	sessionId: string;
}

export interface AuditState {
	task: string;
	logPath: string;
	provenancePath?: string;
	provenance?: GitProvenance;
	review?: ReviewSnapshot;
}

export interface AuditStats {
	total: number;
	active: number;
	unresolved: AuditRow[];
	lowConfidence: AuditRow[];
	missingEvidence: AuditRow[];
}
