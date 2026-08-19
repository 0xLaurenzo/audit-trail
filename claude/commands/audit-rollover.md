---
description: Archive a rebase-diverged audit and start a linked successor
---
Call the audit_rollover tool from the audit-trail MCP server. Parse "$ARGUMENTS" as the exact task name, a required --reason <text>, and an optional --name <successor-task>; pass them as task, reason, and name. Report the tool output verbatim, including the range-diff instruction.
