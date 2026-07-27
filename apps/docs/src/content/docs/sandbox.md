---
title: Sandbox deployment
description: Deploy the Next.js and Astro playgrounds with GitHub, Vercel and Cloudflare R2.
---

The reference sandbox uses:

- source: `DMTcorp/git-native-cms`;
- content: `DMTcorp/git-native-cms-sandbox-content`;
- Vercel: `git-native-cms-next` and `git-native-cms-astro`;
- R2: `git-native-cms-sandbox-assets`, `git-native-cms-sandbox-releases` and private
  `git-native-cms-sandbox-state`;
- one private GitHub App per playground.

## R2

Create separate buckets and an API token limited to those buckets. Keep the state bucket private;
only assets and releases receive public development URLs. Use the S3 endpoint
`https://ACCOUNT_ID.r2.cloudflarestorage.com`, region `auto`, and public development URLs for
`CMS_PUBLIC_ASSETS_URL` and `CMS_PUBLIC_RELEASES_URL`.

The assets bucket CORS policy allows `PUT` and `HEAD` only from the two stable Vercel origins,
including `content-type` and signed `x-amz-*` headers. `tooling/scripts/configure-r2.mjs` applies
that policy after its credential smoke test.

Set immutable release and asset objects to long-lived cache. Configure
`environments/*/current.json` for revalidation/no-cache. The adapter uses conditional writes for
immutable files and compare-and-swap for pointers.

## Vercel

Set every variable from `.env.example` in Production and Preview. `CMS_ORIGIN` must match the
stable deployment origin used by the GitHub App. Set `CMS_HOSTED_RUNTIME=true`.

The two playgrounds must use different App IDs, private keys, OAuth client secrets and webhook
secrets. They may share the content repository and R2 buckets.

## GitHub Actions

Add repository secrets:

```text
CMS_SCHEDULE_ENDPOINT=https://YOUR_STABLE_ORIGIN/api/cms/schedules/execute
CMS_SCHEDULE_TOKEN=<same value as Vercel>
```

The five-minute executor is concurrency-locked and safe to retry. Publication hooks and
translation providers are optional; configure both deployment/revalidation URLs together.

## Acceptance run

```bash
pnpm cms doctor
pnpm check
CMS_CONTAINER_TESTS=true pnpm test:integration
pnpm test:e2e
pnpm test:live
```

Then verify GitHub login, a page plus global navigation/pricing in one Change, preview, review,
staging, production CDN delivery, rollback, asset deletion safety, `en-US`/`pl-PL`, scheduling and
an editor-only MCP actor that cannot publish.
