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

## Standalone CLI

The same workflow is available outside any harness via `audit-trail` (installed to `bin/` by both npm-style and Nix installs). Because state is shared per worktree, CLI invocations and harness sessions interoperate on one audit:

```bash
audit-trail start <task>
audit-trail decision --phase core --origin "implementation discovery" \
  --decision "..." --why "..." --confidence high --evidence "file:1" --result verified
audit-trail status
audit-trail review <provider/model> --mode cross-provider|cross-model|same-model
audit-trail publish [pr-number-or-url]
audit-trail close
```

CLI rows are attributed as `cli/<user>@<host>` in the TSV `session` cell. `audit-trail review` runs the reviewer through a no-session `pi` subprocess against the TSV, Git diff, and repository (no transcript). Use `-C <dir>` to operate on another worktree.

## MCP server

`audit-trail mcp` serves the same six operations as deterministic MCP tools over stdio — `audit_start`, `audit_decision`, `audit_status`, `audit_review`, `audit_publish`, `audit_close` — for harnesses that integrate via MCP rather than a native extension. Rows are attributed as `mcp/<user>@<host>`. Example client registration:

```json
{
  "mcpServers": {
    "audit-trail": { "command": "audit-trail", "args": ["mcp"] }
  }
}
```

## Installer

`audit-trail install <pi|claude|codex|opencode|all>` configures harnesses idempotently from a registry. Today `pi` registers the extension entry point in `~/.pi/agent/settings.json` (stale audit-trail entries — including pre-0.4 `index.ts` paths — are replaced rather than duplicated, and unrelated settings are preserved); `claude`, `codex`, and `opencode` are registry placeholders until their adapter issues land. Declaratively managed settings (for example home-manager) fail with a clear error — add the extension path in your Nix configuration instead.

## Commands

- `/audit-start <task>` — start or resume the worktree audit at `.audit/<task>.tsv`; starting a different task while one is active fails
- `/audit-status` — show unresolved, low-confidence, and unsupported decisions, plus review freshness
- `/audit-review [provider/model]` — review the log and pi session, preferring a cross-provider model
- `/audit-publish [number-or-url]` — create or update reviewer-friendly audit comments with canonical TSV on the current checked-out branch's PR
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

The reviewer runs through a `ReviewerPort`: harness adapters may supply a native reviewer runtime, and the default implementation spawns a separate no-session `pi` process with read-only tools (it fails fast when `pi` is not installed).

Every review ends with an explicit verdict. The reviewer must finish its report with `VERDICT: approve` or `VERDICT: block`; a missing verdict fails closed to `block`. The verdict is recorded in the review artifact and the review checkpoint. A blocking verdict keeps publish and close gated until the findings are addressed and the audit is re-reviewed — a review certifies the audit, it is not an attendance stamp.

## Publish to a pull request

The audit captures its original branch and starting commit once and preserves them as immutable provenance. You may create or switch to the feature branch after starting; publication uses the current checked-out branch (or an explicit PR selector) and verifies that a later PR head descends from the pinned start commit.

After reviewing the latest decisions, publish to the pull request associated with the current checked-out branch:

```text
/audit-review openai/gpt-5.2
/audit-publish
```

Pass a PR number or URL when automatic branch lookup is not appropriate. Every target must belong to the provenance repository, match both the current branch name (when named) and exact committed local HEAD, and descend from the pinned audit start commit, so check out, commit, and update that PR branch first. Uncommitted working-tree/index changes are not part of PR target identity:

```text
/audit-publish 123
```

Publishing requires an approving review checkpoint matching the current audit bytes: after any new decision, run `/audit-review` again, and a `VERDICT: block` review must be resolved and re-reviewed first. The `gh` CLI must be installed and authenticated. Provenance keeps the original audit-start branch immutable. GitHub must prove that every selected PR head descends from the pinned audit start commit, including same-named branches that may have been force-rewritten. Unrelated or diverged PRs are rejected before comments are read or written. Local branch/HEAD and the remote PR head OID are revalidated immediately before every comment mutation; GitHub has no atomic conditional comment write, so a local change or force-push in the sub-request window cannot be eliminated and requires publishing again from the updated checkout. It publishes a deterministic reviewer view with an active-decision index, blocker counts, and one Markdown card per decision. Active decisions are expanded; superseded decisions remain in chronological history with collapsed bodies and bidirectional links. Each card exposes phase, result, confidence, origin, decision, rationale, alternatives, evidence, supersession, timestamp, session, and entry. Open, inconclusive, low-confidence, and missing-evidence active rows are visibly flagged. No model summarizes or rewrites these fields.

```markdown
### D0002

**Phase:** publication · active · result: `verified` · confidence: `high`

**Decision**

Render deterministic reviewer-friendly decision cards.
```

The exact canonical TSV remains in a collapsed block beneath the cards. GitHub comments have a size limit, so large audits are split at decision-row boundaries based on the combined Markdown and TSV size. Each card stays with its exact source row; concatenating fenced TSV blocks in part order recovers the original file byte-for-byte. Hidden markers make publication idempotent: subsequent runs update each existing part and remove stale extra parts instead of creating duplicates. Publish before `/audit-close`; closing removes `.audit/active.json` for the worktree.
