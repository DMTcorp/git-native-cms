---
title: Troubleshooting
description: Diagnose GitHub App, R2, preview, publishing and framework integration failures.
---

Start with:

```bash
pnpm cms doctor
pnpm cms registry validate
```

## GitHub App form rejects the manifest

Regenerate it with `pnpm cms github setup`. Do not add `installation` as a default event: GitHub
does not allow that event in the manifest default-events list. The command handles the one-time
conversion callback and writes new credentials with restricted permissions.

## The callback code expired

Rerun the setup command. GitHub private keys and client secrets are shown once; create new values
if they were not saved. Install the App on the content repository and update the installation ID.

## R2 credentials fail

Use **Object Read & Write**, scoped to the three project buckets. Copy the S3 Access Key ID and
Secret Access Key from the token success screen; the Cloudflare API token itself is not an S3
secret. Confirm endpoint, region `auto`, bucket names and public delivery URLs.

## Preview never connects

Check that the preview route is SSR, parent and child origins match the allowlist, CSP permits the
frame, and the deployed registry digest equals `CMS_REGISTRY_DIGEST`. A session is short-lived and
bound to actor, Change, frontend ref and locale.

## A save or publish returns conflict

Another operation moved the exact Git ref or environment pointer. Reload the Change, review the
semantic conflicts and retry with the new `expectedRevision`; never disable compare-and-swap.

## Astro editor routes are missing

Full editing requires `output: "server"`, a server adapter, React integration, `runtimeModule` and
`registryModule`. Static mode deliberately provides delivery only.
