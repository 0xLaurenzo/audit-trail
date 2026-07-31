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

Run the full check (syntax checks plus every test suite) with Node.js 22 or newer:

```bash
npm run typecheck   # full static type-check (tsc --noEmit)
npm run check       # syntax checks + npm test
npm test            # all test suites
```

The core modules depend only on Node.js and explicit ports from `src/core/ports.ts`; they do not import Pi packages. Adapter-specific behavior belongs under `src/adapters/`. CI (`.github/workflows/ci.yml`) runs install, type-check, and all tests on every pull request; make that workflow a required branch-protection check.

### Testing model

Testing happens in two layers:

- **Core unit tests** (`test/audit-store.test.ts`, `test/workflow.test.ts`, `test/independent-review.test.ts`, ...) exercise the shared, harness-neutral behavior once: storage, locking, review fallback, publication, gating.
- **Harness conformance tests** (`test/harness-conformance.test.ts`) run one shared behavior contract against every shipped harness through its real adapter boundary — registered Pi commands/tools/hooks, OpenCode plugin tools/hooks, and Claude hooks plus the MCP server. Only external systems (Git, GitHub, reviewer CLIs) are simulated. A second capability-gated contract covers catalog-driven reviewer fallback for harnesses that support model discovery.

Each shipped harness declares its capabilities in `src/harness/capabilities.ts`. A capability is either backed by passing contract tests or declared unsupported, in which case its contract tests are *skipped with a visible reason* — never silently omitted. Harness-specific suites (JSON stream parsing, installers, packaging smoke tests) remain separate because they test genuinely platform-specific behavior.

### Adding a new harness

1. Implement the adapter under `src/adapters/` and its installer in `src/install/installers.ts`.
2. Declare its capabilities in `src/harness/capabilities.ts` (`SHIPPED_HARNESSES` + `HARNESS_CAPABILITIES`). Declare only what the harness truthfully supports.
3. Add a conformance driver in `test/helpers/harness-drivers.ts` (`CONFORMANCE_DRIVERS`) that drives the real adapter boundary with simulated externals.
4. Run `npm run check` — the registry-completeness test fails until capabilities, driver, and installer agree, and the contract suite then runs your adapter automatically.

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

`audit-trail install <pi|claude|codex|opencode|all>` configures harnesses idempotently from a registry. Today `pi` registers the extension entry point in `~/.pi/agent/settings.json` (stale audit-trail entries — including pre-0.4 `index.ts` paths — are replaced rather than duplicated, and unrelated settings are preserved), `claude` links the Claude Code plugin described below, and `opencode` installs the plugin shim and `/audit-*` commands described below; `codex` is a registry placeholder until its adapter issue lands. Declaratively managed settings (for example home-manager) fail with a clear error — add the extension path in your Nix configuration instead.

## Claude Code

The package doubles as a Claude Code plugin: `.claude-plugin/plugin.json` at the package root declares commands, hooks, and an MCP server under `claude/`. Installation is one symlink:

```bash
audit-trail install claude
```

This links `~/.claude/skills/audit-trail` to the installed package, which Claude Code loads in place as `audit-trail@skills-dir` on the next session — no marketplace, no edits to `settings.json` or Claude-managed plugin state. Reinstalling against the same package path is idempotent. Because a symlink cannot prove who created it, any different target (including a same-name plugin or dangling link) and any real directory fails the install instead of being replaced; remove the old link explicitly before reinstalling after a package-location upgrade. Remove the symlink (or `claude plugin disable audit-trail@skills-dir`) to deactivate.

The plugin provides:

- **Tools** via the shared MCP server (`audit-trail mcp --harness claude`), exposed as `mcp__plugin_audit-trail_audit-trail__audit_*`. A `SessionStart` hook records `{session ID, transcript path, model, worktree}` under `$XDG_STATE_HOME/audit-trail/claude/`, and the server re-reads it on every call, so successful startup/resume/clear hooks refresh attribution to `claude/<session-id>`. Concurrent Claude sessions in one worktree share last-writer-wins attribution. Session state has no expiry or cleanup: if a later `SessionStart` hook fails or does not run, the previous session ID may be reused indefinitely until a successful refresh. Only absent or unreadable state falls back to `claude/<user>@<host>`.
- **Commands** namespaced by the plugin: `/audit-trail:audit-start`, `/audit-trail:audit-status`, `/audit-trail:audit-review`, `/audit-trail:audit-publish`, `/audit-trail:audit-close`.
- **Guidance injection**: the `SessionStart` hook adds the active-audit instructions as additional context whenever the worktree has an active audit.
- **A write guard**: a `PreToolUse` hook denies `Write`/`Edit` of the TSV, provenance, and `active.json`, failing closed over `.audit/` when audit state is unreadable.

`audit_review` runs the reviewer through non-interactive `claude -p` with a read-only tool allowlist, `--strict-mcp-config` (the reviewer cannot reach this or any MCP server), and no session persistence. Claude-run reviewers are Anthropic models, so pass the reviewer as `anthropic/<model-id>` and record `cross-model` or `same-model` truthfully — the `/audit-trail:audit-review` command encodes this. The hook-captured session transcript is included in the review when readable; otherwise the review falls back to the TSV, Git diff, and repository.

Trust implications: enabling the plugin means Claude Code runs the plugin's hook commands at session start and before `Write`/`Edit` calls, and starts the bundled MCP server, all with your user privileges from the linked package. MCP tool calls remain subject to Claude Code's per-server permission approval (pre-authorize `mcp__plugin_audit-trail_audit-trail` in allowed tools for headless use).

## OpenCode

`src/adapters/opencode.ts` is a native OpenCode plugin over the same shared worktree state, so Pi, CLI, MCP, and OpenCode sessions interoperate on one audit: an audit started in Pi can be resumed from OpenCode and vice versa. It registers all six operations as plugin tools (`audit_start`, `audit_decision`, `audit_status`, `audit_review`, `audit_publish`, `audit_close`), injects the active-audit guidance into the system prompt, and write-protects extension-managed audit files. Rows are attributed as `opencode/<session-id>` with the message ID as the entry.

Global activation:

```bash
audit-trail install opencode
```

This writes only files the package owns — a plugin shim at `~/.config/opencode/plugins/audit-trail.ts` re-exporting the adapter from the installed package, and five prompt-template commands (`/audit-start`, `/audit-status`, `/audit-review`, `/audit-publish`, `/audit-close`) under `~/.config/opencode/commands/` — and never touches `opencode.json` or other user files. Reinstalling is safe: unchanged files are left alone, managed files carry a stable ownership marker, and a stale shim from a previous install location is regenerated. If a target path already contains an unmarked file, installation fails before writing anything rather than overwriting potentially unrelated configuration.

For project-local activation, place the same shim in `.opencode/plugins/` inside the project:

```ts
// .opencode/plugins/audit-trail.ts
export { AuditTrailPlugin } from "/path/to/audit-trail/src/adapters/opencode.ts";
```

`audit_review` selects a reviewer across the configured OpenCode providers, preferring cross-provider, then cross-model, then the working model itself, and truthfully records the relation. The session transcript is captured with `opencode export` into `.audit/<task>.transcript.<session-id>.json` when available; otherwise the review runs transcript-less against the TSV, Git diff, and repository. The reviewer itself runs as a separate non-interactive `opencode run` subprocess using the built-in read-only `plan` agent with `--pure`, so it cannot load this plugin or mutate the worktree.

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

Publishing requires an approving review checkpoint matching the current audit bytes: after any new decision, run `/audit-review` again, and a `VERDICT: block` review must be resolved and re-reviewed first. The `gh` CLI must be installed and authenticated. Provenance keeps the original audit-start branch immutable. GitHub must prove that every selected PR head descends from the pinned audit start commit, including same-named branches that may have been force-rewritten. Unrelated or diverged PRs are rejected before comments are read or written. Local branch/HEAD and the remote PR head OID are revalidated immediately before every comment mutation; GitHub has no atomic conditional comment write, so a local change or force-push in the sub-request window cannot be eliminated and requires publishing again from the updated checkout. It publishes a deterministic reviewer view with an active-decision index, blocker counts, and one Markdown card per decision. Horizontal rules separate entries. Active decisions are expanded; each superseded decision becomes a single collapsed summary line (ID, phase, replacement, result, and confidence) with the complete body and bidirectional history links available on expansion. Each card exposes phase, result, confidence, origin, decision, rationale, alternatives, evidence, supersession, timestamp, and session. A real harness entry ID is shown when available; the CLI/MCP `none` sentinel stays only in canonical TSV. Open, inconclusive, low-confidence, and missing-evidence active rows are visibly flagged. No model summarizes or rewrites these fields.

```markdown
### D0002

**publication** · active · `verified` · `high` · user requirement  
<sub>2026-01-01T01:02:03.000Z · session cli/user</sub>

**Decision**

Render deterministic reviewer-friendly decision cards.

<sub><strong>Evidence:</strong> test/github-publisher.test.ts</sub>

<sub><strong>History:</strong> No supersession links.</sub>
```

The exact canonical TSV remains in a collapsed block beneath the cards. GitHub comments have a size limit, so large audits are split at decision-row boundaries based on the combined Markdown and TSV size. Each card stays with its exact source row; concatenating fenced TSV blocks in part order recovers the original file byte-for-byte. Hidden markers make publication idempotent: subsequent runs update each existing part and remove stale extra parts instead of creating duplicates. Publish before `/audit-close`; closing removes `.audit/active.json` for the worktree.
