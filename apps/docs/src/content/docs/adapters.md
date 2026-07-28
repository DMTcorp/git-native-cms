---
title: Adapter authoring
description: Implement stable ports and run the shared contracts.
---

Implement ports from `@git-native-cms/application`; application code never imports an adapter.
Adapters must preserve abort signals, typed errors, optimistic concurrency and idempotent retry
semantics.

`@git-native-cms/adapter-kit` exports executable common suites:

```ts
import {
  GitProviderContract,
  ContentRepositoryContract,
  ReviewPortContract,
  AssetStoreContract,
  AssetProcessorPortContract,
  AssetUsagePortContract,
  ReleaseBuilderPortContract,
  ReleaseStoreContract,
  SessionStoreContract,
  PreviewSessionPortContract,
  TeamProvisioningPortContract,
  DeploymentPortContract,
  RevalidationPortContract,
  PublicationNotifierPortContract,
  TranslationProviderContract,
  WebhookReplayStoreContract,
  RateLimitPortContract,
  SchedulerPortContract,
  IdempotencyStoreContract,
  AuditSinkContract,
  FrameworkAdapterContract,
  RendererContract,
  contractPassed,
} from "@git-native-cms/adapter-kit";
```

The repository runs all capability suites against memory fixtures, the sanitized GitHub Git Data
fixture and S3-compatible MinIO. A new adapter is not complete until every applicable shared suite
passes.

External deployment and revalidation adapters receive deterministic idempotency keys.
Translation providers implement `createJob` and `readJob`; the returned XLIFF still passes through
the application import command, permissions, revision check and audit trail.
