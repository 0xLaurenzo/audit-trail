# Audit trail extension

A pi extension for reviewing consequential agent choices instead of reconstructing them from a large diff.

## Install

This repository is currently private. Install it over SSH after authenticating with GitHub:

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
- `/audit-close` — close only after all active rows are resolved and the latest rows have been reviewed

## Agent tool

While an audit is active, pi exposes `audit_decision`. The extension injects instructions to use it for consequential choices, assumptions, pivots, reverts, and verification checkpoints. Rows are append-only; revisions point to an earlier row with `supersedes`.

## Files

Audit artifacts are local working files under `.audit/`:

- `<task>.tsv` — canonical decision trail
- `<task>.review.<timestamp>.md` — independent review output

Add `.audit/` to `.gitignore` or `.git/info/exclude` if trails should remain local. Commit selected artifacts when reviewers need them.

## Review model

`/audit-review` automatically selects an available model whose provider differs from the active working model. You can choose one explicitly:

```text
/audit-review openai/gpt-5.2
```

The reviewer runs in a separate no-session pi process with read-only tools.
