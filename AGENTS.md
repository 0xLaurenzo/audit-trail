# Agent Guidelines

## Project overview

`audit-trail` is a cross-harness decision-auditing tool for Pi, OpenCode, Claude Code, and Codex. Shared behavior belongs in the harness-neutral core; adapters should expose that behavior without changing its invariants.

## Repository layout

- `src/core/` — audit storage, workflow, review, publication, locking, and ports
- `src/adapters/` — harness-specific integration code
- `src/harness/` — shipped harness registry and capability declarations
- `src/install/` — collision-safe, idempotent installers
- `src/mcp/` and `src/cli/` — MCP and command-line surfaces
- `test/` — core, adapter, conformance, installer, and packaging tests
- `.claude-plugin/`, `.codex-plugin/`, `claude/`, `hooks/`, `skills/` — plugin assets

## Development commands

Requires Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm run check
```

Run a focused test with:

```bash
node --experimental-strip-types --test test/<name>.test.ts
```

When packaging changes, also run:

```bash
nix build .# --no-link
```

## Implementation principles

- Keep `src/core/` independent of harness SDKs; use explicit ports for external behavior.
- Put genuine harness differences behind declared capabilities in `src/harness/capabilities.ts`.
- Back shared behavior with the reusable harness conformance contract. Unsupported capabilities must produce visible skips.
- Treat the TSV audit artifact as canonical; inline findings and PR comments are bounded renderings.
- Preserve truthful reviewer model/provider modes. Never infer or claim unsupported discovery, transcript, or provenance guarantees.
- Make installers idempotent and collision-safe. Preflight before mutation and preserve unrelated user configuration.
- Do not expose credentials, provider-sensitive diagnostics, or raw secret-bearing subprocess output.
- Protect audit-managed files through adapter boundaries rather than editing them directly.
- Backward compatibility is not a project requirement. Prefer the cleanest current design, remove obsolete paths, and avoid compatibility shims unless an issue explicitly requires a migration strategy.

## Feature workflow

Every issue is implemented on its own feature branch. Never implement feature work directly on the default branch.

1. **Create the feature branch.** Branch from the intended base using a descriptive `feature/<issue>-<name>` branch.
2. **Start the audit.** Start a decision audit for the issue before changing implementation files.
3. **Reiterate the issue.** Restate the problem, intended outcome, scope, constraints, and acceptance criteria in concrete terms. Inspect the relevant repository boundaries rather than relying on the issue title alone.
4. **Clarify before implementation.** Identify ambiguities, consequential alternatives, and missing acceptance criteria. Ask the user to resolve them. Do not begin implementation until there is agreement on the restatement and the user gives an explicit go-ahead.
5. **Implement the agreed scope.** Keep the implementation on the feature branch, record consequential decisions as they arise, and update tests, conformance coverage, packaging, and documentation as applicable. Do not add backward-compatibility machinery unless it was explicitly agreed.
6. **Verify the change.** Run focused tests while iterating, then the complete required checks. Validate any affected plugin and installed-package artifacts.
7. **Review the audit.** Run an independent audit review. Address every blocking finding, record resulting pivots or corrections, and re-review until it approves.
8. **Create the pull request.** Commit and push the completed feature branch, then open an issue-linked PR that accurately summarizes behavior, limitations, and verification.
9. **Publish the audit.** Publish the approved canonical audit to the newly created PR. Never publish it to an unrelated or stale PR.

## Decision auditing

Record a decision when a reasonable alternative would materially change behavior, architecture, compatibility, schema, security, or a correctness invariant. Also record consequential requirement clarifications, review-driven pivots, and reverts.

Do not record routine commands, formatting, commits, pushes, ordinary verification, or straightforward implementation steps.

A useful decision entry states:

- what triggered the choice;
- the selected behavior and invariant it protects;
- meaningful alternatives and why they were rejected;
- concrete evidence and the verification result.

Supersede earlier entries when a later choice replaces them; do not rewrite audit history.

## Change checklist

1. Inspect the relevant core and adapter boundaries before editing.
2. Add or update focused tests and shared conformance coverage where applicable.
3. Run `npm run typecheck` and `npm run check`.
4. Validate affected plugin or package artifacts.
5. Ensure documentation describes limitations and trust requirements accurately.
