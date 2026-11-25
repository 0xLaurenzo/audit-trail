/**
 * Central registry of shipped harnesses and their declared capabilities.
 *
 * Every shipped harness adapter must declare what it supports here, and the
 * conformance suite (test/harness-conformance.test.ts) enforces that each
 * declaration is backed by a test driver. Capability differences are explicit
 * and reviewable: a harness either passes the shared behavior contract for a
 * capability or declares it unsupported, in which case the corresponding
 * contract tests are skipped with a visible reason instead of silently
 * omitted.
 */

/** Harnesses with shipped adapters; planned harnesses are excluded until they ship. */
export const SHIPPED_HARNESSES = ["pi", "opencode", "claude", "codex"] as const;

export type ShippedHarness = (typeof SHIPPED_HARNESSES)[number];

export interface HarnessCapabilities {
	/** Bump when the capability shape changes so declarations stay reviewable. */
	version: 3;
	/** Select a private task audit by explicit ID independently of the worktree. */
	taskAuditSelection: boolean;
	/**
	 * Automatic reviewer selection from the maintained allowlist. Harnesses with
	 * model discovery preserve independence tiers; provider-bound harnesses use
	 * their fixed allowed-provider order and derive mode from the working model.
	 */
	automaticReviewerSelection: boolean;
	/** Reviewer model catalog discovery at review time. */
	modelDiscovery: boolean;
	/** A session transcript can be supplied to the independent reviewer. */
	transcriptSupport: boolean;
	/** Active-audit guidance is injected into the agent's system prompt. */
	systemPromptInjection: boolean;
}

export const HARNESS_CAPABILITIES: Record<ShippedHarness, HarnessCapabilities> = {
	pi: {
		version: 3,
		taskAuditSelection: true,
		automaticReviewerSelection: true,
		modelDiscovery: true,
		transcriptSupport: true,
		systemPromptInjection: true,
	},
	opencode: {
		version: 3,
		taskAuditSelection: false,
		automaticReviewerSelection: true,
		modelDiscovery: true,
		transcriptSupport: true,
		systemPromptInjection: true,
	},
	claude: {
		version: 3,
		taskAuditSelection: false,
		// No catalog discovery; fixed Fable/Opus fallback stays provider-bound.
		automaticReviewerSelection: true,
		modelDiscovery: false,
		transcriptSupport: true,
		systemPromptInjection: true,
	},
	codex: {
		version: 3,
		taskAuditSelection: false,
		// No catalog discovery; fixed Astra/Sol fallback stays provider-bound.
		automaticReviewerSelection: true,
		modelDiscovery: false,
		transcriptSupport: true,
		systemPromptInjection: true,
	},
};
