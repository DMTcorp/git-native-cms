---
title: Releases and delivery
description: Reproducible artifacts, S3/R2 pointers, caching, fallback and atomic rollback.
---

A release is built from an exact Git SHA, config version, registry digest and schema version.
Documents, redirects, locale routes, sitemap, content graph, search index and checksums are sorted
and serialized deterministically. Equal input produces the same `rel_…` ID and bytes.

Storage layout:

```text
releases/<release-id>/manifest.json
releases/<release-id>/checksums.json
releases/<release-id>/content/...
environments/staging/current.json
environments/production/current.json
```

Release objects are immutable and may use a one-year cache. Environment pointers must revalidate.
The S3-compatible adapter rejects a different object body at an existing release key and switches
pointers with compare-and-swap.

The typed delivery client supports Git/filesystem during development, immutable CDN JSON in
production and Change preview. It verifies the release manifest and can fall back to the last
known valid release if the pointer or network is temporarily unavailable.

Rollback switches the Production pointer first, with an expected pointer revision, then opens an
auditable revert pull request and revalidates the frontend. This restores delivery immediately
without rewriting immutable artifacts.
