---
title: Changes and publishing
---

A Change is an isolated editorial workspace backed by a branch. Sending it for review opens a
pull request to staging. Approved Changes are squash-merged into staging; a release pull request
moves the complete staging batch to Production.

Publication builds a deterministic immutable JSON release, verifies checksums, then changes one
environment pointer with optimistic concurrency.
