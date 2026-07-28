---
title: Getting started
description: Install the CMS, connect GitHub and R2, and open the editor.
---

## Requirements

- Node.js 22.12 or newer and pnpm 11
- Next.js 16 App Router or Astro 7 in SSR mode
- a GitHub organization where you can create and install a private GitHub App
- a content repository with protected `main` and `staging` branches
- three S3-compatible buckets: assets, immutable releases and a private runtime-state bucket

## 1. Install and generate the integration

Next.js:

```bash
pnpm add @git-native-cms/next
pnpm add -D @git-native-cms/cli
pnpm cms init
```

Astro:

```bash
pnpm add @git-native-cms/astro @astrojs/react
pnpm add -D @git-native-cms/cli
pnpm astro add react
pnpm cms init
```

`cms init` creates the server API, `/cms`, `/__cms/preview`, the component registry,
`.cms/project.yaml`, validation Actions and the schedule executor. Generated files are never
overwritten.

## 2. Prepare the content repository

Create `main`, branch `staging` from it, and commit the generated `.cms` directory plus your
`content/` documents. Protect both branches. Editors do not need personal access tokens: the
server uses a GitHub App installation and users sign in through GitHub OAuth with PKCE.

Create and install the private App without copying a manifest secret by hand:

```bash
pnpm cms github setup --origin https://YOUR_ORIGIN --owner YOUR_ORGANIZATION
```

The command starts a loopback callback, opens GitHub's one-time manifest form, converts the
returned code, opens the installation page and writes server-only credentials to
`.env.cms.local` with mode `0600`. GitHub only shows the generated client secret and private key
once; if the callback expires, rerun the command and create new credentials.

The GitHub App needs:

| Repository permission | Access         |
| --------------------- | -------------- |
| Contents              | Read and write |
| Pull requests         | Read and write |
| Issues                | Read and write |
| Checks                | Read and write |
| Deployments           | Read and write |
| Metadata              | Read           |
| Members               | Read and write |

Subscribe to `check_run`, `check_suite`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `push`, `deployment`, `deployment_status`, `installation` and
`installation_repositories`. Set the OAuth callback to
`https://YOUR_ORIGIN/api/cms/auth/github/callback` and the webhook to
`https://YOUR_ORIGIN/api/cms/webhooks/github`. Install the App only on the content repository.

## 3. Configure server-only environment variables

Copy `.env.example`. At minimum configure the GitHub App/OAuth values, a 32+ character
`CMS_SESSION_SECRET`, S3 credentials, both bucket names and public bucket URLs. Also set separate
32+ character `CMS_SCHEDULE_TOKEN` and `CMS_MCP_TOKEN`.

Keep `CMS_STATE_BUCKET` private; unlike immutable delivery and asset buckets it contains
idempotency, audit, replay and rate-limit state and must never have an `r2.dev` or public custom
domain.

`CMS_REGISTRY_DIGEST` is `sha256:` followed by the full SHA-256 digest of the deployed component
registry. Recompute it whenever registered components or schemas change.

```bash
pnpm registry:digest src/cms/registry.tsx
```

Never prefix these values with `NEXT_PUBLIC_` or expose them through Astro `PUBLIC_` variables.

## 4. Verify before starting

```bash
pnpm cms doctor
pnpm build
pnpm dev
```

Open `/cms`, sign in with GitHub, create a Change, edit a page and publish it through Review →
Staging → Live. A failed `doctor` check includes the exact repair action.

For production, add `CMS_SCHEDULE_ENDPOINT=https://YOUR_ORIGIN/api/cms/schedules/execute` and
`CMS_SCHEDULE_TOKEN` as GitHub Actions secrets. The generated workflow calls the same
permission-aware application commands as the UI.
