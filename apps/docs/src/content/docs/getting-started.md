---
title: Getting started
description: Install the CMS and open the editor.
---

## Requirements

- Node.js 22.12 or newer
- Next.js 16 App Router or Astro 7 with server output
- a GitHub App installation and a separate content repository

```bash
pnpm add @git-native-cms/next
pnpm cms init
pnpm cms doctor
pnpm dev
```

Open `/cms`. The generated framework routes are thin mounts around the shared CMS server.
