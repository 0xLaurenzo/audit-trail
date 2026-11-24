---
description: Run an independent review of the active decision audit
---
Call the audit_review tool from the audit-trail MCP server. Omit `model` when "$ARGUMENTS" is empty so Audit Trail tries its maintained Claude order: `anthropic/claude-fable-5-2`, `anthropic/claude-opus-5-5`, `anthropic/claude-fable-5-1`, then `anthropic/claude-fable-5`. If "$ARGUMENTS" is non-empty, pass it as `model` (prefix with `anthropic/` when missing); only those four model IDs and their `-fast`/dated serving variants are accepted.

Audit Trail derives `same-model` or `cross-model` from the hook-captured working model; never supply or infer the mode yourself. The review may take several minutes. Report the tool output verbatim.
