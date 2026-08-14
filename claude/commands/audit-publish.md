---
description: Publish the audit to the current branch's pull request
---
Call the audit_publish tool from the audit-trail MCP server. Parse "$ARGUMENTS" as an optional PR number/URL and optional --set <comment-set-id>. Pass them as selector and commentSetId; omit absent values so the current branch and sole owned set are selected automatically. Report the tool output verbatim.
