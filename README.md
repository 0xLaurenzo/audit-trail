# Audit trail

Agents make dozens of consequential choices per task — compatibility trade-offs, schema decisions, requirement interpretations, silent pivots — and reviewers usually meet them only as a large diff. Audit trail records those choices *as they are made* in an append-only, per-worktree decision log, has an independent model review the log against the actual changes, and publishes the result to the pull request.

It works the same across **Pi**, **Claude Code**, **Codex**, and **OpenCode** (plus a standalone CLI and MCP server): harness-neutral behavior lives in `src/core/`, and each harness adapter exposes the identical worktree workflow through its native extension, plugin, hook, skill, and MCP surfaces. Sessions from different harnesses interoperate on one audit.

- **Append-only TSV** — the canonical artifact under `.audit/`; every decision records what triggered it, the chosen behavior, rejected alternatives, evidence, and confidence. Corrections supersede; history is never rewritten.
- **Independent review** — a separate read-only model (cross-provider when possible, truthfully recorded) reviews the log, diff, and repository, must evaluate design friction, and ends with an explicit approve/block verdict.
- **Gated publication** — approving review required before the audit is published as deterministic, reviewer-friendly PR comments or closed.
- **Write-protected artifacts** — hooks and guards prevent agents from editing the audit files directly.

## Install

Requires Node.js 22+ and Git. Publishing to PRs requires an authenticated [`gh`](https://cli.github.com) CLI.

Pi, Claude Code, and Codex install straight from GitHub through their own package managers — no checkout needed. OpenCode (and Nix users) install from a checkout or Nix profile. Each harness section later in this document details exactly what is configured and the trust implications.

### Pi

```bash
pi install git:github.com/0xLaurenzo/audit-trail       # user-wide
pi install -l git:github.com/0xLaurenzo/audit-trail    # project-local
```

Pi clones the package, installs its dependencies, and registers the extension in one step; run `/reload` in an existing session to activate. During development, load a checkout directly with `pi -e /path/to/audit-trail`.

### Claude Code

```bash
claude plugin marketplace add 0xLaurenzo/audit-trail
claude plugin install audit-trail@audit-trail
```

Claude Code fetches the repository as a marketplace and installs the plugin (commands, hooks, and MCP tools) for the **next session**; update later with `claude plugin marketplace update audit-trail`. For headless use, pre-authorize the `mcp__plugin_audit-trail_audit-trail` MCP server in your allowed tools. From a checkout or Nix install, `audit-trail install claude` instead links the package into `~/.claude/skills/audit-trail`, which loads as `audit-trail@skills-dir` with no marketplace and no `settings.json` edits.

### Codex

```bash
codex plugin marketplace add 0xLaurenzo/audit-trail
codex plugin add audit-trail@audit-trail
```

Codex snapshots the repository marketplace and installs the plugin (the `$audit-trail` skill, hooks, and MCP tools) into its plugin cache. Then start a **new Codex thread** and approve the plugin's `SessionStart` and `PreToolUse` hooks via `/hooks` — installation never grants hook trust automatically. From a checkout or Nix install, `audit-trail install codex` instead links the package through the personal local marketplace.

### OpenCode

OpenCode loads remote plugins only from npm, so install from a checkout or Nix profile:

```bash
git clone https://github.com/0xLaurenzo/audit-trail
cd audit-trail && npm install --omit=dev
./bin/audit-trail install opencode
```

This writes a plugin shim to `~/.config/opencode/plugins/audit-trail.ts` and the `/audit-*` commands under `~/.config/opencode/commands/`; it never touches `opencode.json`. Restart OpenCode to load the plugin. For project-local activation instead, see the OpenCode section below.

### Nix

```bash
nix profile install github:0xLaurenzo/audit-trail
audit-trail install all    # or: pi | claude | codex | opencode
```

Puts `audit-trail` on your PATH from an immutable store path and registers harnesses through the collision-safe installer, which preserves unrelated configuration and refuses to touch entries it cannot prove it owns. Upgrade with `nix profile upgrade pi-audit-trail`, then rerun `audit-trail install`.

## Use

Start an audit in the worktree before implementation work, record decisions as they arise, then review, publish, and close:

```text
/audit-start issue-42-rate-limiting
... implement; the agent records reviewer-relevant decisions via the audit_decision tool ...
/audit-status
/audit-review              # independent model reviews log + diff, verdict approve/block
/audit-publish             # posts decision cards + canonical TSV to the branch's PR
/audit-close
```

While an audit is active, every harness injects guidance so the agent records reviewer-relevant choices — compatibility, API/schema behavior, architecture trade-offs, correctness or security invariants, ambiguous requirements, user corrections, pivots — and skips routine noise like commits, formatting, or ordinary verification. The same workflow is available outside any harness:

```bash
audit-trail start issue-42-rate-limiting
audit-trail decision --phase core --origin "user requirement" --decision "..." \
  --why "..." --confidence high --evidence "src/x.ts:10" --result verified
audit-trail review openai/gpt-5.2 --mode cross-provider
audit-trail publish && audit-trail close
```

The sections below document the shared state model, each harness integration, the review and publication model, and development.

## Shared worktree state

Exactly one audit may be active per Git worktree. The authoritative state lives in `.audit/active.json`, so any session in the same worktree — including concurrent ones — sees and contributes to the same audit; the audit survives session restarts and branch switches. Starting, resuming, and reopening are distinct operations: `start` only creates, `resume` requires the exact original name of the active audit, and `reopen` intentionally restores the exact matching `.audit/<slug>.closed.json` lifecycle. Different original names that normalize to the same slug are rejected. Audits closed before lifecycle versioning recorded original task names (version 1 state) can never be resumed or reopened — their identity cannot be proven — so reusing such a task name requires manually removing its `.audit/<slug>.closed.json` marker outside agent edit tools. Every mutation runs under an atomic cross-process lock at `.audit/.lock`, so concurrent appends cannot lose rows or allocate duplicate decision IDs. Abandoned locks from crashed processes are reclaimed automatically.

The TSV `session` cell is harness-qualified (for example `pi/<session-id>`), keeping contributions attributable when multiple harnesses share one audit.

## Standalone CLI

The same workflow is available outside any harness via `audit-trail` (installed to `bin/` by both npm-style and Nix installs). Because state is shared per worktree, CLI invocations and harness sessions interoperate on one audit:

```bash
audit-trail start <task>    # create only
audit-trail resume <task>   # join the exact active task
audit-trail reopen <task>   # restore the exact closed task
audit-trail decision --phase core --origin "implementation discovery" \
  --decision "..." --why "..." --confidence high --evidence "file:1" --result verified
audit-trail status
audit-trail review <provider/model> --mode cross-provider|cross-model|same-model
audit-trail publish [pr-number-or-url]
audit-trail close
```

CLI rows are attributed as `cli/<user>@<host>` in the TSV `session` cell. `audit-trail review` runs the reviewer through a no-session `pi` subprocess against the TSV, Git diff, and repository (no transcript). Use `-C <dir>` to operate on another worktree.

## MCP server

`audit-trail mcp` serves the same eight operations as deterministic MCP tools over stdio — `audit_start`, `audit_resume`, `audit_reopen`, `audit_decision`, `audit_status`, `audit_review`, `audit_publish`, `audit_close` — for harnesses that integrate via MCP rather than a native extension. Rows are attributed as `mcp/<user>@<host>`. Example client registration:

```json
{
  "mcpServers": {
    "audit-trail": { "command": "audit-trail", "args": ["mcp"] }
  }
}
```

## Installer

`audit-trail install <pi|claude|codex|opencode|all>` configures harnesses idempotently from a registry. `pi` registers the extension entry point in `~/.pi/agent/settings.json`, `claude` links the Claude Code plugin, `codex` installs the Codex plugin through the personal local marketplace, and `opencode` installs its plugin shim and `/audit-*` commands. Installers preserve unrelated configuration and reject same-name paths or entries they cannot prove they own. Declaratively managed settings (for example home-manager) fail with a clear error — add equivalent declarations in your configuration instead.

The Pi installer records the exact paths it manages in `~/.pi/agent/audit-trail/installed.json`. It accepts JSON settings with comments and trailing commas and edits only the `extensions` array, preserving unrelated formatting and comments. On an immutable-package upgrade it replaces only an exact path in that ownership record; it never infers ownership from a directory or package name. An exact existing registration is adopted safely when the sidecar is first created. Differently located registrations from installer versions predating the sidecar remain untouched and may load the extension twice; remove the obsolete entry manually, then rerun the installer. Symlinked/declaratively managed settings, malformed ownership records, invalid JSON/JSONC, and incompatible `extensions` values fail before settings mutation with a manual registration instruction.

## Claude Code

The package doubles as a Claude Code plugin: `.claude-plugin/plugin.json` at the package root declares commands, hooks, and an MCP server under `claude/`, and `.claude-plugin/marketplace.json` makes the repository itself an installable marketplace (`claude plugin marketplace add 0xLaurenzo/audit-trail`). Marketplace installs are bare clones, so the plugin's runtime — CLI, hooks, and MCP server — deliberately has no external dependencies; only the `audit-trail install` command needs the package's declared dependencies and says so when they are missing. From a checkout or Nix install, installation is instead one symlink:

```bash
audit-trail install claude
```

This links `~/.claude/skills/audit-trail` to the installed package, which Claude Code loads in place as `audit-trail@skills-dir` on the next session — no marketplace, no edits to `settings.json` or Claude-managed plugin state. Reinstalling against the same package path is idempotent. Because a symlink cannot prove who created it, any different target (including a same-name plugin or dangling link) and any real directory fails the install instead of being replaced; remove the old link explicitly before reinstalling after a package-location upgrade. Remove the symlink (or `claude plugin disable audit-trail@skills-dir`) to deactivate.

The plugin provides:

- **Tools** via the shared MCP server (`audit-trail mcp --harness claude`), exposed as `mcp__plugin_audit-trail_audit-trail__audit_*`. A `SessionStart` hook records `{session ID, transcript path, model, worktree}` under `$XDG_STATE_HOME/audit-trail/claude/`, and the server re-reads it on every call, so successful startup/resume/clear hooks refresh attribution to `claude/<session-id>`. Concurrent Claude sessions in one worktree share last-writer-wins attribution. Session state has no expiry or cleanup: if a later `SessionStart` hook fails or does not run, the previous session ID may be reused indefinitely until a successful refresh. Only absent or unreadable state falls back to `claude/<user>@<host>`.
- **Commands** namespaced by the plugin: `/audit-trail:audit-start`, `/audit-trail:audit-resume`, `/audit-trail:audit-reopen`, `/audit-trail:audit-status`, `/audit-trail:audit-review`, `/audit-trail:audit-publish`, `/audit-trail:audit-close`.
- **Guidance injection**: the `SessionStart` hook adds the active-audit instructions as additional context whenever the worktree has an active audit.
- **A write guard**: a `PreToolUse` hook denies `Write`/`Edit` of the TSV, provenance, `active.json`, and closed lifecycle markers (including when no audit is active), failing closed over `.audit/` when audit state is unreadable.

`audit_review` runs the reviewer through non-interactive `claude -p` with a read-only tool allowlist, `--strict-mcp-config` (the reviewer cannot reach this or any MCP server), and no session persistence. Claude-run reviewers are Anthropic models, so pass the reviewer as `anthropic/<model-id>` and record `cross-model` or `same-model` truthfully — the `/audit-trail:audit-review` command encodes this. The hook-captured session transcript is included in the review when readable; otherwise the review falls back to the TSV, Git diff, and repository.

Trust implications: enabling the plugin means Claude Code runs the plugin's hook commands at session start and before `Write`/`Edit` calls, and starts the bundled MCP server, all with your user privileges from the linked package. MCP tool calls remain subject to Claude Code's per-server permission approval (pre-authorize `mcp__plugin_audit-trail_audit-trail` in allowed tools for headless use).

## Codex

The package is also a Codex plugin: `.codex-plugin/plugin.json` bundles the `$audit-trail` Agent Skill, `hooks/hooks.json`, and `.mcp.json`, and `.agents/plugins/marketplace.json` makes the repository an installable Codex marketplace (`codex plugin marketplace add 0xLaurenzo/audit-trail`). Codex requires marketplace plugins to live below the marketplace root, so the checked-in `plugins/audit-trail` symlink routes that subdirectory back to the repository root; Codex resolves it once when copying the plugin into its cache. From a checkout or Nix install, install through the personal local marketplace instead:

```bash
audit-trail install codex
```

The installer validates the manifest, manages only `~/plugins/audit-trail` and the `audit-trail` entry in `~/.agents/plugins/marketplace.json`, then runs `codex plugin add audit-trail@<marketplace>`. Reinstalling the same package path is idempotent and preserves unrelated marketplace metadata and plugin entries. A different symlink target, non-symlink path, or same-name marketplace entry with another source is rejected rather than replaced.

Start a **new Codex thread** after installation. Open `/hooks`, inspect the plugin source, and trust the `SessionStart` and `PreToolUse` definitions; installing or enabling a plugin never grants hook trust automatically, and changed hook definitions require approval again. Project-local `.codex/` hooks additionally require project trust, although audit-trail's hooks are plugin-bundled. Use `/skills` or `$audit-trail` for explicit skill invocation; Codex can also activate the skill from its description.

The plugin provides the shared `audit_start`, `audit_resume`, `audit_reopen`, `audit_decision`, `audit_status`, `audit_review`, `audit_publish`, and `audit_close` MCP tools. `SessionStart` records `{session ID, optional transcript path, model, worktree}` under `$XDG_STATE_HOME/audit-trail/codex/`, injects guidance for an active audit, and attributes decisions as `codex/<session-id>`. The transcript path is supplementary only: Codex does not promise a stable transcript format, and missing or unreadable transcripts fall back to TSV, Git diff, and repository evidence. Concurrent sessions in one worktree use last-writer-wins attribution. Session state has no expiry or cleanup: if a later `SessionStart` hook is untrusted, skipped, or fails to run, its predecessor's session ID and model may be reused indefinitely. Only absent or unreadable state falls back to `codex/<user>@<host>` attribution; review without captured model metadata fails instead of guessing a mode.

A `PreToolUse` hook protects extension-managed audit files, including closed lifecycle markers when no audit is active, from direct `apply_patch`/`Edit`/`Write` changes and fails closed over `.audit/` when state is unreadable. This is a guardrail for direct edit tools, not a shell sandbox. Plugin hooks and the local MCP server run with your user privileges, so inspect the linked package and approve MCP tools according to your Codex policy.

`audit_review` runs an isolated child through `codex exec --ignore-user-config --ephemeral --sandbox read-only`. Omitting `model` uses the hook-captured working model and records `same-model`; specifying a different OpenAI model records `cross-model` and remains pinned if it fails. Codex does not claim cross-provider review or catalog-driven model discovery. If `SessionStart` did not capture a model, review fails clearly rather than guessing provenance.

## OpenCode

`src/adapters/opencode.ts` is a native OpenCode plugin over the same shared worktree state, so Pi, CLI, MCP, and OpenCode sessions interoperate on one audit: an audit started in Pi can be explicitly resumed from OpenCode and vice versa. It registers all eight operations as plugin tools (`audit_start`, `audit_resume`, `audit_reopen`, `audit_decision`, `audit_status`, `audit_review`, `audit_publish`, `audit_close`), injects the active-audit guidance into the system prompt, and write-protects extension-managed audit files. Rows are attributed as `opencode/<session-id>` with the message ID as the entry.

Global activation:

```bash
audit-trail install opencode
```

This writes only files the package owns — a plugin shim at `~/.config/opencode/plugins/audit-trail.ts` re-exporting the adapter from the installed package, and seven prompt-template commands (`/audit-start`, `/audit-resume`, `/audit-reopen`, `/audit-status`, `/audit-review`, `/audit-publish`, `/audit-close`) under `~/.config/opencode/commands/` — and never touches `opencode.json` or other user files. Reinstalling is safe: unchanged files are left alone, managed files carry a stable ownership marker, and a stale shim from a previous install location is regenerated. If a target path already contains an unmarked file, installation fails before writing anything rather than overwriting potentially unrelated configuration.

For project-local activation, place the same shim in `.opencode/plugins/` inside the project:

```ts
// .opencode/plugins/audit-trail.ts
export { AuditTrailPlugin } from "/path/to/audit-trail/src/adapters/opencode.ts";
```

`audit_review` selects a reviewer across the configured OpenCode providers, preferring cross-provider, then cross-model, then the working model itself, and truthfully records the relation. The session transcript is captured with `opencode export` into `.audit/<task>.transcript.<session-id>.json` when available; otherwise the review runs transcript-less against the TSV, Git diff, and repository. The reviewer itself runs as a separate non-interactive `opencode run` subprocess using the built-in read-only `plan` agent with `--pure`, so it cannot load this plugin or mutate the worktree.

## Commands

- `/audit-start <task>` — create a new worktree audit; it never resumes or reopens existing state
- `/audit-resume <task>` — explicitly join the active audit when its trimmed original task name matches exactly
- `/audit-reopen <task>` — explicitly restore the exact matching closed lifecycle
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

Every completed review contains a final `## Design-friction evaluation` section followed by an explicit verdict. The reviewer asks whether concrete challenges or walls encountered during review would be substantially simplified by a design-level change. It records either `None identified.` or concise actionable observations covering the friction, evidence or decision IDs, proposed design change, and simplification benefit—never private chain-of-thought. Design friction is not automatically blocking: it changes the verdict only when it exposes a current audit-integrity, correctness, unresolved-decision, or symptom-patch problem. The ordered protocol is defined once in `src/core/review-output.ts`; prompt rendering, validation, and shared test fixtures consume that contract.

The reviewer must finish with `VERDICT: approve` or `VERDICT: block`. The parser accepts the canonical design-friction heading and verdict markers case-insensitively while the prompt always requests their canonical spelling. A missing or malformed design-friction section or verdict invalidates that attempt; fallback tries the next candidate when available, and no artifact or checkpoint is recorded unless a reviewer completes the full contract. The verdict is recorded in the review artifact and checkpoint. A blocking verdict keeps publish and close gated until the findings are addressed and the audit is re-reviewed—a review certifies the audit, it is not an attendance stamp.

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

Each audit lifecycle carries a stable identity (a UUID minted at `start`, or on demand for state created before identities existed) that is embedded in every published comment's hidden marker. Publication only ever updates or deletes comments carrying this exact identity: same-task comments from a different audit — including another worktree, a collaborator, or the pre-identity marker format — are never touched, and publish warns when such foreign comments exist so duplicates are visible. Because legacy markers cannot prove ownership, republishing an audit first published before identities existed creates fresh comments; remove the old ones manually if unwanted.

The exact canonical TSV remains in a collapsed block beneath the cards. GitHub comments have a size limit, so large audits are split at decision-row boundaries based on the combined Markdown and TSV size. Each card stays with its exact source row; concatenating fenced TSV blocks in part order recovers the original file byte-for-byte. Hidden markers make publication idempotent: subsequent runs update each existing part and remove stale extra parts instead of creating duplicates. Publish before `/audit-close`; closing atomically moves `.audit/active.json` to `.audit/<slug>.closed.json`, preserving the lifecycle for an explicit reopen.

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
- **Harness conformance tests** (`test/harness-conformance.test.ts`) run one shared behavior contract against every shipped harness through its real adapter boundary — registered Pi commands/tools/hooks, OpenCode plugin tools/hooks, and Claude/Codex hooks plus the MCP server. Only external systems (Git, GitHub, reviewer CLIs) are simulated. A second capability-gated contract covers catalog-driven reviewer fallback for harnesses that support model discovery.

Each shipped harness declares its capabilities in `src/harness/capabilities.ts`. A capability is either backed by passing contract tests or declared unsupported, in which case its contract tests are *skipped with a visible reason* — never silently omitted. Harness-specific suites (JSON stream parsing, installers, packaging smoke tests) remain separate because they test genuinely platform-specific behavior.

### Adding a new harness

1. Implement the adapter under `src/adapters/` and its installer in `src/install/installers.ts`.
2. Declare its capabilities in `src/harness/capabilities.ts` (`SHIPPED_HARNESSES` + `HARNESS_CAPABILITIES`). Declare only what the harness truthfully supports.
3. Add a conformance driver in `test/helpers/harness-drivers.ts` (`CONFORMANCE_DRIVERS`) that drives the real adapter boundary with simulated externals.
4. Run `npm run check` — the registry-completeness test fails until capabilities, driver, and installer agree, and the contract suite then runs your adapter automatically.
