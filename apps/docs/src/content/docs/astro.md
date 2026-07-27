---
title: Astro 7 SSR
description: Server output, React editor island and Astro renderer.
---

Full editing requires Astro server output and the React integration:

```bash
pnpm astro add react
pnpm add @git-native-cms/astro
pnpm add -D @git-native-cms/cli
pnpm cms init
```

The generator creates an `ALL` API route, an SSR `/cms/[...path]` page, the preview route and a
registered component library. `CmsHostedApp` is the only hydrated editor island; published Astro
pages use the lightweight renderer and CDN delivery data.

Configure a server adapter such as `@astrojs/vercel` and keep `output: "server"`. The API,
GitHub OAuth callback, signed webhook, MCP endpoint and schedule executor all share the same Web
API handler.

Astro static output can read production content at build time, but it cannot host authentication
or mutations. Keep the editor in a separate SSR deployment or use local editor mode as described
in [Astro static](/astro-static/).
