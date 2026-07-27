---
title: MCP and AI safety
description: Stdio/HTTP transport, permissions and confirmations.
---

The MCP server exposes project, Change, document and release resources plus tools for creating a
Change, applying typed patches, requesting review, previewing, publishing and rollback. Stdio and
Streamable HTTP call the same application handlers as UI, HTTP and CLI.

For hosted HTTP, send:

```http
Authorization: Bearer <CMS_MCP_TOKEN>
Content-Type: application/json
```

The machine actor is intentionally mapped to the `editor` role. It can create a Change and obtain
a preview, but cannot approve, stage, publish or rollback by token alone.

Destructive tools require both the normal actor permission and a short-lived confirmation token
for the exact action. Confirmation tokens are encrypted, actor-bound, expire quickly and are
single-use. Every command audit event records `source: mcp`.

Never pass GitHub, R2 or session secrets through MCP resources, prompts or tool arguments.
