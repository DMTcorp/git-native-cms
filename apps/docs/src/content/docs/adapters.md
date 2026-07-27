---
title: Adapter authoring
---

Implement the stable ports exported by `@git-native-cms/application/ports`, then run the shared
contract harness from `@git-native-cms/testing`. Adapters must support abort signals, typed errors,
optimistic concurrency and idempotent retries.
