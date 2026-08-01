---
name: audit-trail
description: Run append-only decision audits for implementation work. Use when starting, resuming, reopening, reviewing, publishing, or closing an audit, or whenever consequential product or engineering choices should be recorded for independent review.
---

# Audit Trail

Use the audit-trail MCP tools for all audit operations. Never create, edit, or repair files under `.audit/` directly.

## Workflow

1. Call `audit_status` to see whether this worktree already has an active audit.
2. Choose the lifecycle operation explicitly and pass the exact original task name:
   - call `audit_start` only to create a new audit;
   - call `audit_resume` only to join the matching active audit;
   - call `audit_reopen` only to restore the matching closed audit intentionally.
   Never change the task's case or punctuation to bypass an identity error.
3. During implementation, call `audit_decision` only for reviewer-relevant choices whose reasonable alternative would materially change behavior or code:
   - compatibility or migration policy
   - public API or schema behavior
   - architecture or meaningful implementation trade-offs
   - correctness or security invariants
   - ambiguous requirements and user corrections
   - consequential pivots or reverts
4. Do not log routine commands, commits, branches, formatting, straightforward implementation, or ordinary verification.
5. Use `audit_status` before review. Resolve open, inconclusive, low-confidence, or unsupported active decisions, superseding earlier rows rather than modifying them.
6. Call `audit_review`. Omit `model` to use the current Codex working model, or pass a different OpenAI model ID for a cross-model review. Report blocking findings verbatim and address them before reviewing again.
7. After an approving review of the current bytes, call `audit_publish` while checked out at the exact pull-request head. Pass a PR number or URL only when branch lookup is inappropriate.
8. Call `audit_close` only after publication and only when it reports no blockers.

## Decision fields

Keep `origin` causal and separate from `why`:

- `origin`: what triggered the decision (`user requirement`, `user correction`, `source invariant`, `failing test`, `code review`, `external specification`, or `implementation discovery`)
- `why`: technical rationale and the consequence or invariant protected
- `alternatives`: meaningful alternatives and why they were rejected; use `none` only when there were none
- `evidence`: concise file, line, test, trace, commit, or artifact pointer
- `result`: `open`, `verified`, `reverted`, or `inconclusive`

The review artifact remains canonical. Inline blocking feedback is a bounded rendering for actionability.
