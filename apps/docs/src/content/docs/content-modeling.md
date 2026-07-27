---
title: Content modeling
description: Schemas, references, reusable blocks, localization and search.
---

Use `fields.*`, `defineSection`, `defineCollection`, `definePageType`, `defineGlobal` and
`defineSettings` from the framework registry export. Compilation produces a stable AST, JSON
Schema, editor/MCP manifest, TypeScript declarations and validators.

The content tree supports Pages, Posts, Collections, Globals, Settings and Reusable Blocks.
Sections can bind to a filtered collection query or reference a reusable block with instance
overrides; detached sections stay local to the page.

Portable rich text is a validated JSON AST, never stored HTML. References and asset IDs build a
release graph used by “find usages”, broken-reference checks and deletion safety.

Locale documents use `en-US` as the source and `pl-PL` as the first fallback demonstration.
Editors can export/import XLIFF or create an external translation job. Translation import records
the source revision and status inside the same Change.

Release artifacts include `content-index.json`, `content-graph.json`, search index, redirects,
sitemap, canonical metadata and hreflang. Slug changes preserve redirect history.
