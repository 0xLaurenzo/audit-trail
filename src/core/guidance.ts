/**
 * Shared active-audit guidance injected into the agent context by every
 * harness adapter (Pi system prompt, OpenCode system transform, ...). One
 * source keeps the audit_decision usage rules identical across harnesses so
 * rows stay comparable no matter which harness appended them.
 */
export function buildActiveAuditGuidance(logPath: string): string {
	return (
		`## Active decision audit\n` +
		`An append-only decision audit is active at ${logPath}. ` +
		`Use audit_decision only for reviewer-relevant product or engineering choices where a reasonable alternative would materially change behavior or code. ` +
		`Log compatibility and migration policy, public API or schema behavior, architecture and meaningful implementation trade-offs, security or correctness invariants, ambiguous requirement interpretations, user corrections, and consequential pivots or reverts. ` +
		`Do not log branches, commits, pushes, pull requests, audit publication, routine verification, commands or tool usage, straightforward implementation steps, formatting, or documentation/version updates that do not change compatibility. ` +
		`Record what caused each choice in origin separately from the technical rationale in why; use user correction when a user changes or clarifies prior direction. ` +
		`Log choices introduced by underspecified requirements before implementing them, and state the plausible alternative and the behavior, compatibility guarantee, or invariant protected. ` +
		`Mark narrowly tailored choices, untested assumptions, and uncertainty honestly with medium/low confidence or an open/inconclusive result. ` +
		`When correcting a prior choice, append a row using supersedes; never rewrite history. ` +
		`Do not declare the audited task complete while active decisions remain open, inconclusive, low-confidence, or unsupported by evidence.`
	);
}
