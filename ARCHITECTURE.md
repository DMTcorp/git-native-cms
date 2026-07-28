# Architecture

## Dependency direction

`core`, `schema`, `protocol` and `document-model` are runtime-neutral. Application commands
own capability ports. Adapters depend inward on those ports; application code never imports an
adapter. Transports only parse input, construct a request context, call a command/query and map
the result.

## Durable state

- Git stores content, configuration, Change branches and review history.
- Object storage stores content-addressed assets and immutable releases.
- IndexedDB stores unsynchronized patches and editor recovery state only.

## Request flow

Every entry point follows one direction:

```text
React editor / Next route / Astro route / CLI / Actions / MCP
                              ↓
                    Web API or command input
                              ↓
                 @git-native-cms/application
                              ↓
       GitHub · content · session · storage capability ports
                              ↓
              GitHub App · S3/R2 · filesystem adapters
```

Framework routes only mount `handle(Request, ServerContext)` or obtain a server-computed editor
view. They do not choose workflow transitions, call GitHub directly or read storage credentials.
The editor sends typed commands and renders results; permission, revision, idempotency and audit
rules live in application handlers.

## Public surfaces

- `@git-native-cms/schema` compiles deterministic component/content contracts.
- `@git-native-cms/protocol` owns versioned HTTP, preview and MCP envelopes.
- `@git-native-cms/document-model` owns RFC 6901 patches, history, merge and conflicts.
- `@git-native-cms/application/ports` is the only capability-port definition site.
- `@git-native-cms/server` exposes one Fetch API handler.
- `@git-native-cms/react`, `/next` and `/astro` render content and mount thin integrations.
- `@git-native-cms/delivery` reads filesystem, Git, preview or immutable CDN releases.
- `@git-native-cms/mcp` and `cms` reuse application permissions and confirmation contracts.

## Mutation invariants

Mutations carry an idempotency key and the exact expected Git/pointer revision. Domain IDs use a
prefixed ULID shape; release IDs derive from SHA-256 of the canonical manifest. Timestamps are UTC
ISO-8601. Git writes and environment pointers use compare-and-swap. Retryable external hooks
receive deterministic keys.

Preview sessions, OAuth tokens, installation credentials, S3 credentials and confirmation tokens
are server-only. Cookies are encrypted, rotated, `Secure`, `HttpOnly` and CSRF-bound.

## Git and release workflow

A Change starts from Production `main`. Review opens a pull request, approval requires an
independent reviewer, and adding to Staging squash-merges with `Change-ID` before deleting the
branch. Staging promotion uses a merge commit into `main`, forward-syncs Staging, builds a
reproducible immutable release and atomically moves the pointer. Rollback moves the pointer before
opening its audit revert pull request.

Before the squash merge, the application compares the original base, the Change and current
Staging for every document, including document creation/deletion. Concurrent edits become
RFC 6901 field conflicts. A resolution command requires an explicit `change` or `staging` choice
for every conflict, carries the Change revision, preserves non-conflicting Staging updates, records
the new semantic base and resets an existing approval. The resolved result must therefore be
reviewed again before Staging can accept it.

## Compatibility

The supported server runtimes are Node.js 22.12+ and Node.js 24. Pure packages use Web APIs and
are tested in browser and worker-like environments. Full Astro CMS support requires SSR.

See [ADR-0001](./docs/adr/0001-ports-and-adapters.md),
[ADR-0002](./docs/adr/0002-deterministic-releases.md) and
[ADR-0003](./docs/adr/0003-preview-assets-and-team-capabilities.md), and
[ADR-0004](./docs/adr/0004-semantic-conflict-resolution.md).
