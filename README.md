# Audit trail extension

A pi extension for reviewing consequential agent choices instead of reconstructing them from a large diff.

## Install with Nix

This repository is currently private, so GitHub SSH access must be configured first.

```bash
nix profile install 'git+ssh://git@github.com/0xLaurenzo/audit-trail.git'
```

Then register the immutable profile path in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/you/.nix-profile/share/pi-audit-trail/index.ts"
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

## Commands

- `/audit-start <task>` — start or resume `.audit/<task>.tsv`
- `/audit-status` — show unresolved, low-confidence, and unsupported decisions
- `/audit-review [provider/model]` — review the log and pi session with a model from a different provider
- `/audit-publish [number-or-url]` — create or update the audit summary comment on the original branch's PR
- `/audit-close` — close only after all active rows are resolved and the latest rows have been reviewed

## Agent tool

While an audit is active, pi exposes `audit_decision`. It is reserved for reviewer-relevant product and engineering choices where a reasonable alternative would materially change behavior or code: compatibility and migrations, public API or schema behavior, architecture and meaningful implementation trade-offs, correctness or security invariants, ambiguous requirements, user corrections, and consequential pivots or reverts.

Delivery operations (branches, commits, pushes, pull requests, and audit publication), routine verification, commands, straightforward implementation steps, formatting, and non-compatibility documentation or version updates are intentionally excluded. Rows are append-only; revisions point to an earlier row with `supersedes`.

Every new decision records its causal `origin` separately from its technical `why`. Origins use a constrained vocabulary: `user requirement`, `user correction`, `source invariant`, `failing test`, `code review`, `external specification`, or `implementation discovery`. This keeps user corrections and other triggers attributable after the session transcript is gone.

## Files

Audit artifacts are local working files under `.audit/`:

- `<task>.tsv` — canonical decision trail
- `<task>.provenance.json` — original GitHub repository, branch, starting commit, worktree state, and Pi session ID
- `<task>.review.<timestamp>.md` — independent review output

Add `.audit/` to `.gitignore` or `.git/info/exclude` if trails should remain local. Commit selected artifacts when reviewers need them.

## Review model

`/audit-review` automatically selects an available model whose provider differs from the active working model. You can choose one explicitly:

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

Publishing requires the `gh` CLI to be installed and authenticated. The command refuses to post to a PR whose head branch differs from the audit's original branch. Before rendering, a model pass classifies each active decision and drops superseded rows and self-evident or process-only entries; the retained rows are then published verbatim—decision, origin, why, alternatives, evidence, and status—rather than re-summarized. Filtered rows appear in a collapsed section with the filter's reason, and superseded history and independent-review commentary stay in their own collapsed sections. If the filter model fails, all active rows are published unfiltered.

The summary uses a hidden marker, so running `/audit-publish` again updates the extension's existing PR comment instead of creating duplicates. Publish before `/audit-close`; closing removes the audit from active session state.
