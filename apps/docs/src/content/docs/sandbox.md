---
title: Sandbox deployment
description: External services and secrets required by the public demonstration.
---

The public sandbox uses two Vercel projects (`git-native-cms-next` and
`git-native-cms-astro`), separate GitHub Apps and two Cloudflare R2 buckets. Keep every secret in
GitHub Environments or Vercel Environment Variables; the browser bundle and content repository
must never receive credentials.

## Provisioning checklist

1. Create `DMTcorp/git-native-cms` and `DMTcorp/git-native-cms-sandbox-content`.
2. Create one GitHub App per playground with its own callback and webhook URL.
3. Create the `git-native-cms-sandbox-assets` and `git-native-cms-sandbox-releases` buckets.
4. Configure the variables documented in `.env.example` for each deployment environment.
5. Run `pnpm cms doctor`, `pnpm check`, `pnpm test:integration` and `pnpm test:e2e`.
6. Deploy both SSR playgrounds, then exercise publish, delivery and rollback against the sandbox
   content repository.

Set `CMS_R2_SMOKE=true` only in a protected integration environment. The smoke suite is read-only
and validates R2 through the same S3 adapter used by production delivery.
