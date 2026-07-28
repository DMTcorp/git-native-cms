# ADR-0004: Semantic conflict resolution is an application command

Status: accepted

## Context

A Git pull request can report a textual conflict, but editors need field-level choices that remain
correct when YAML formatting, document order or unrelated Staging content changes. Conflict
resolution also changes the content that was previously approved, so it cannot be implemented as
presentation-only state or an unchecked Git operation.

## Decision

- `ReadChangeConflictsHandler` compares the exact Change base, current Change branch and current
  Staging revision across the union of their document IDs.
- The merge uses RFC 6901 paths and covers field edits, document creation and document deletion.
- `ResolveChangeConflictsHandler` requires an explicit `change` or `staging` choice for every
  conflict and the current Change revision.
- Non-conflicting Staging values are carried into the Change branch. Resolved documents and
  deletions use the content repository capability with compare-and-swap and idempotency keys.
- The Change records Staging as its new semantic base. An approved Change returns to `in_review`,
  and the audit timeline records paths and choices without duplicating content values.
- HTTP and React integrations only validate/collect input and delegate to these handlers.

## Consequences

The pull request diff is relative to the content editors actually reconciled, a stale branch cannot
silently overwrite Staging, and no approval survives a post-review content merge. Large Changes
must resolve all concurrent conflicts as one auditable operation; this intentionally prevents a
partially resolved Change from entering Staging.
