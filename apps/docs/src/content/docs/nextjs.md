---
title: Next.js 16
description: App Router, SSR editor and zero-editor-runtime delivery.
---

Run `pnpm cms init` in a Next.js App Router project. It generates:

- `src/cms/runtime.ts` — the server-only GitHub/R2 runtime;
- `src/cms/registry.tsx` — explicitly registered visual sections;
- `src/cms/preview.tsx` — the MessageChannel preview bridge;
- `app/api/cms/[[...path]]/route.ts` — thin Web API mount;
- `app/cms/[[...path]]` — editor shell and its scoped stylesheet;
- `app/%5F%5Fcms/preview/[[...slug]]` — full-page preview.

If the project uses `src/app`, every route is generated under it automatically.

The public page must import only the delivery client and renderer. Keep
`@git-native-cms/next/styles.css` inside the `/cms` layout. The production bundle gate verifies
that the public route loads 0 bytes of editor runtime.

Use the CDN client in a server component:

```bash
pnpm add @git-native-cms/delivery @git-native-cms/react
```

```tsx
import { cdnSource, createContentClient, loadContentGraph } from "@git-native-cms/delivery";
import { CmsPageRenderer } from "@git-native-cms/react";
import { cmsRegistry } from "@/cms/registry";

const content = createContentClient({
  environment: "production",
  source: cdnSource({ baseUrl: process.env.CMS_PUBLIC_RELEASES_URL! }),
});

export default async function Page() {
  const graph = await loadContentGraph(content);
  const page = graph.find((document) => document.id === "doc_home");
  return <CmsPageRenderer document={page?.data as never} registry={cmsRegistry} content={graph} />;
}
```

Do not cache `environments/production/current.json` permanently. Release files are immutable and
may use a one-year cache; the pointer must revalidate.
