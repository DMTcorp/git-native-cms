---
title: Asset storage and image processing
description: Direct uploads, content addressing, metadata, variants, usages and safe cleanup.
---

Asset bytes live in the asset bucket, independently from Git documents and release objects. The
editor uploads directly to a short-lived signed URL, then finalizes the upload through the Web API.
Finalization verifies declared size, MIME signature and SHA-256 before moving the object to:

```text
assets/<sha256>/<safe-file-name>
```

The asset ID derives from the checksum. Repeating a finalize request is safe. SVG is rejected by
default; raster images pass through Sharp, have EXIF removed, enforce decode limits and may produce
AVIF/WebP/responsive variants.

The **Assets** page browses and filters the storage-backed gallery. Inside a Change, asset fields
can select an existing item, upload a new item, edit alt text and focal point, and update preview
without a reload. Metadata changes are recorded on the Change branch and copied to S3/R2 object
metadata.

Before deletion, the application checks active document references and immutable releases.
Released or referenced assets cannot be removed. Orphaned unfinished uploads are cleaned only
after the configured grace period.

Use an object read/write token scoped to the asset, release and private state buckets. Do not use
account administrator permissions. Only asset/release delivery buckets may be public; keep the
state bucket private.
