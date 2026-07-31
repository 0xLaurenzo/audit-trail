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
export const SHIPPED_HARNESSES = ["pi", "opencode", "claude"] as const;

export type ShippedHarness = (typeof SHIPPED_HARNESSES)[number];

export interface HarnessCapabilities {
	/** Bump when the capability shape changes so declarations stay reviewable. */
	version: 1;
	/**
	 * Catalog-driven reviewer fallback across independence tiers (issue #29):
	 * cross-provider candidates, then same-provider/different-model, then the
	 * working model itself.
	 */
	automaticReviewerSelection: boolean;
	/** Reviewer model catalog discovery at review time. */
	modelDiscovery: boolean;
	/** A session transcript can be supplied to the independent reviewer. */
	transcriptSupport: boolean;
	/** Active-audit guidance is injected into the agent's system prompt. */
	systemPromptInjection: boolean;
	/** Writes to extension-managed audit files are blocked, failing closed. */
	managedFileGuard: boolean;
}

export const HARNESS_CAPABILITIES: Record<ShippedHarness, HarnessCapabilities> = {
	pi: {
		version: 1,
		automaticReviewerSelection: true,
		modelDiscovery: true,
		transcriptSupport: true,
		systemPromptInjection: true,
		managedFileGuard: true,
	},
	opencode: {
		version: 1,
		automaticReviewerSelection: true,
		modelDiscovery: true,
		transcriptSupport: true,
		systemPromptInjection: true,
		managedFileGuard: true,
	},
	claude: {
		version: 1,
		// The claude CLI reviewer only runs anthropic/<model-id> models and
		// rejects cross-provider mode, so catalog-driven tier fallback cannot
		// be implemented truthfully; reviews are explicit model + mode.
		automaticReviewerSelection: false,
		modelDiscovery: false,
		transcriptSupport: true,
		systemPromptInjection: true,
		managedFileGuard: true,
	},
};
