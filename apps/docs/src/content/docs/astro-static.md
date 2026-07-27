---
title: Astro static mode
description: Supported delivery and explicit editing limitations for static Astro builds.
---

Astro static builds can read filesystem content during build and consume immutable CDN releases at
runtime. They cannot host OAuth callbacks, encrypted sessions, Web API mutations, preview
handshakes or GitHub webhooks.

Use the full `output: "server"` adapter for an embedded editor. For a static site, run the editor
as a separate authenticated SSR application, publish content to the release store, and trigger a
rebuild or CDN revalidation. Local editing is supported for development, but it is not a
replacement for the authenticated server workflow.
