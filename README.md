# Audit trail extension

A pi extension for reviewing consequential agent choices instead of reconstructing them from a large diff. Harness-neutral audit behavior lives under `src/core/`; the Pi lifecycle, commands, tools, and UI are isolated in `src/adapters/pi.ts`, which is the package entry point.

## Install with Nix

This repository is currently private, so GitHub SSH access must be configured first.

```bash
nix profile install 'git+ssh://git@github.com/0xLaurenzo/audit-trail.git'
```

Then register the immutable profile path in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/you/.nix-profile/share/pi-audit-trail/src/adapters/pi.ts"
  ]
}
```

Run `/reload` in an existing pi session. Update the installed extension with:

```bash
nix profile upgrade pi-audit-trail
```

## Install with pi

Alternatively, install it through pi over SSH:

```bash
pi install git:git@github.com:0xLaurenzo/audit-trail
```

For project-local installation:

```bash
pi install -l git:git@github.com:0xLaurenzo/audit-trail
```

During local development, load the checkout directly:

```bash
pi -e /path/to/audit-trail
```

## Development

Run the dependency-free core test suite with Node.js 22 or newer:

```bash
npm test
```

The core modules depend only on Node.js and explicit ports from `src/core/ports.ts`; they do not import Pi packages. Adapter-specific behavior belongs under `src/adapters/`.

## Shared worktree state

Exactly one audit may be active per Git worktree. The authoritative state lives in `.audit/active.json`, so any session in the same worktree — including concurrent ones — sees and contributes to the same audit; the audit survives session restarts and branch switches. Every mutation (start/resume, append, review checkpoint, close) runs under an atomic cross-process lock at `.audit/.lock`, so concurrent appends cannot lose rows or allocate duplicate decision IDs. Abandoned locks from crashed processes are reclaimed automatically.

The TSV `session` cell is harness-qualified (for example `pi/<session-id>`), keeping contributions attributable when multiple harnesses share one audit.

## Commands

- `/audit-start <task>` — start or resume the worktree audit at `.audit/<task>.tsv`; starting a different task while one is active fails
- `/audit-status` — show unresolved, low-confidence, and unsupported decisions, plus review freshness
- `/audit-review [provider/model]` — review the log and pi session, preferring a cross-provider model
- `/audit-publish [number-or-url]` — create or update raw audit TSV comments on the original branch's PR
- `/audit-close` — close only after all active rows are resolved and the latest audit bytes have been reviewed

## Agent tool

While an audit is active, pi exposes `audit_decision`. It is reserved for reviewer-relevant product and engineering choices where a reasonable alternative would materially change behavior or code: compatibility and migrations, public API or schema behavior, architecture and meaningful implementation trade-offs, correctness or security invariants, ambiguous requirements, user corrections, and consequential pivots or reverts.

Delivery operations (branches, commits, pushes, pull requests, and audit publication), routine verification, commands, straightforward implementation steps, formatting, and non-compatibility documentation or version updates are intentionally excluded. Rows are append-only; revisions point to an earlier row with `supersedes`.

Every new decision records its causal `origin` separately from its technical `why`. Origins use a constrained vocabulary: `user requirement`, `user correction`, `source invariant`, `failing test`, `code review`, `external specification`, or `implementation discovery`. This keeps user corrections and other triggers attributable after the session transcript is gone.

## Files

Audit artifacts are local working files under `.audit/`:

- `active.json` — authoritative active-audit state shared by all sessions in the worktree
- `.lock/` — transient cross-process mutation lock
- `<task>.tsv` — canonical decision trail
- `<task>.provenance.json` — original GitHub repository, branch, starting commit, worktree state, and harness-qualified session ID
- `<task>.review.<timestamp>.md` — independent review output

Add `.audit/` to `.gitignore` or `.git/info/exclude` if trails should remain local. Commit selected artifacts when reviewers need them.

## Review model

`/audit-review` selects a reviewer in preference order: a model from a different provider (`cross-provider`), then a different model from the same provider (`cross-model`), then the working model itself (`same-model`). The chosen mode is recorded in the review artifact and the review checkpoint. You can choose a model explicitly:

```text
/audit-review openai/gpt-5.2
```

The reviewer runs in a separate no-session pi process with read-only tools.

## Publish to a pull request

Start the audit from the branch that will open the pull request. The extension captures that branch and its starting commit once and reuses the metadata when an audit is resumed.

After reviewing the latest decisions, publish to the pull request associated with the original branch:

```text
/audit-review openai/gpt-5.2
/audit-publish
```

Pass a PR number or URL when automatic branch lookup is not appropriate:

```text
/audit-publish 123
```

Publishing requires a review checkpoint matching the current audit bytes: after any new decision, run `/audit-review` again. The `gh` CLI must be installed and authenticated. The command refuses to post to a PR whose head branch differs from the audit's original branch. It publishes the exact canonical TSV inside a collapsed code block, preceded by concise format, history, state, and Git provenance context. No model filters or rewrites the source before publication, allowing reviewers and their own tooling to process every audit row.

GitHub comments have a size limit, so large TSV files are split at row boundaries into deterministic numbered comments. Concatenating their fenced TSV blocks in part order recovers the original file exactly. Hidden markers make publication idempotent: subsequent runs update each existing part and remove stale extra parts instead of creating duplicates. Publish before `/audit-close`; closing removes `.audit/active.json` for the worktree.
