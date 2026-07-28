---
title: Changes and publishing
description: Branches, review, staging batches, releases and rollback.
---

A Change starts from the exact `main` SHA and gets an isolated `cms/<actor>/<change>` branch.
Every save uses Git Data compare-and-swap and includes `Change-ID` metadata.

Sending for review opens a pull request. Semantic field changes, live visual baseline, comments,
required checks and merge conflicts are shown in the workspace. When Staging and the Change edit
the same field, the review panel shows both values. Resolve every field by choosing **Keep this
Change** or **Use Staging**. The CMS carries over non-conflicting Staging edits, writes the merged
documents with compare-and-swap, records an audit event and resets the previous approval so the
actual merged result is reviewed. Approval records the reviewer; adding to staging squash-merges
the Change, deletes its branch and keeps the audit record.

Staging is a batch. Publication:

1. opens and merge-commits a staging → main release PR;
2. merges main back into staging;
3. builds a deterministic release from the exact Git SHA and registry digest;
4. writes immutable files and verifies checksums;
5. atomically switches the environment pointer;
6. calls deployment and revalidation hooks with retry-safe keys.

Production reads `environments/production/current.json`, then immutable JSON/XML/TXT files from
that release. Rollback switches the pointer first with compare-and-swap, notifies integrations,
and then opens an auditable revert PR. A retry after any intermediate network failure resumes
without duplicating publication.
