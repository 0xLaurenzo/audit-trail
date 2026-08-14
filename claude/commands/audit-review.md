---
description: Run an independent review of the active decision audit
---
Call the audit_review tool from the audit-trail MCP server. The reviewer runs through the non-interactive claude CLI, so choose a Claude model and pass it as `anthropic/<model-id>`.

- If "$ARGUMENTS" is non-empty, use it as the reviewer model (prefix with `anthropic/` when the prefix is missing).
- Otherwise prefer `anthropic/claude-fable-5`, then `anthropic/claude-opus-5`, choosing a model different from your own; fall back to your own model only when neither is available.

Set mode truthfully by comparing the reviewer model with the model you are running as right now: `same-model` when identical, otherwise `cross-model`. Never claim `cross-provider` for a Claude-run reviewer.

The review may take several minutes. Report the tool output verbatim.
