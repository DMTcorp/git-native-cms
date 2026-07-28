---
title: Scheduling and integrations
description: Idempotent Actions, locks, webhooks, deployments, revalidation and translation ports.
---

Scheduling creates a reviewed schedule file and generated GitHub Actions workflow on the Change.
The executor is protected by an independent machine token, verifies the scheduled UTC instant and
uses a concurrency group so retries cannot publish twice.

```bash
pnpm cms schedule create --cron "0 8 * * 1-5" --environment production
```

Publish and unpublish execute through application commands with deterministic idempotency keys.
An unpublish removes the selected documents before building the next immutable release; it does
not mutate an old release.

GitHub webhooks require SHA-256 HMAC and claim each delivery ID once. Deployment and revalidation
providers receive the release ID, environment, exact Git revision and retry-safe key. Configure
both hook URLs and one integration token or leave both disabled.

Translation providers implement job creation and polling only. The returned XLIFF is still
validated and imported through the normal authorization, revision and audit path.
