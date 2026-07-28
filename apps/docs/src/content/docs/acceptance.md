---
title: Product acceptance
description: Executable evidence for the 25 product Definition of Done requirements.
---

The product Definition of Done is enforced by code, shared contracts and the sandbox acceptance
run. A requirement is not considered complete when only a mock or a document exists.

|   # | Requirement                                | Executable evidence                                                                      |
| --: | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
|   1 | Next.js and Astro installation             | framework package builds, playground builds and `next-*` / `astro-*` Playwright projects |
|   2 | GitHub login without personal tokens       | GitHub App OAuth with PKCE, rotating JWE session and live OAuth smoke test               |
|   3 | editor creates a Change, page and sections | application command suite and editor Playwright flow                                     |
|   4 | globals and pages share one Change         | logical repository/application suite and sandbox acceptance flow                         |
|   5 | coherent full preview                      | MessageChannel handshake, registry renderer and no-reload Playwright assertion           |
|   6 | semantic and visual review                 | diff unit suite, baseline/current preview panes and review UI flow                       |
|   7 | approval enters staging                    | independent-reviewer rule, required checks and application transition suite              |
|   8 | staging immutable release                  | deterministic builder, immutable store and staging publish command                       |
|   9 | staging to main production release         | merge-commit promotion, back-merge and production publish command                        |
|  10 | production CDN JSON                        | delivery client, fallback tests and live R2 manifest smoke test                          |
|  11 | atomic rollback                            | release-store CAS contract and pointer-first rollback command                            |
|  12 | all content models                         | schema compiler and fixtures for pages, posts, collections, globals, settings and blocks |
|  13 | SEO, locales, redirects, assets, schedules | package suites plus localized Playwright and integration tests                           |
|  14 | MCP parity                                 | MCP delegates to application handlers and has permission/confirmation tests              |
|  15 | zero editor runtime in public bundle       | bundle budget and public Playwright assertion                                            |
|  16 | every capability port has a contract       | `@git-native-cms/adapter-kit` all-port contract suites                                   |
|  17 | Next.js and Astro E2E                      | Chromium, Firefox and WebKit matrix for both frameworks                                  |
|  18 | WCAG 2.2 AA                                | axe light/dark checks, keyboard focus and reduced-motion configuration                   |
|  19 | `cms doctor`                               | CLI environment, security, registry, storage and installation checks                     |
|  20 | `cms upgrade`                              | migration/codemod package and CLI test suite                                             |
|  21 | install-from-zero docs                     | Getting started, Next.js, Astro, adapters, security and sandbox guides                   |
|  22 | application layer cannot be bypassed       | dependency-cruiser architecture gate                                                     |
|  23 | thin routes and presentation components    | framework route adapters delegate to Web API/application contracts                       |
|  24 | reproducible release                       | deterministic identity/checksum tests for equal SHA and config                           |
|  25 | tested security                            | CSRF, fixation, XSS, YAML, SVG, traversal, webhook replay, origin and permission suites  |

Run the local evidence:

```bash
pnpm check
pnpm test:e2e
```

With Docker available, run adapter integrations:

```bash
CMS_CONTAINER_TESTS=true pnpm test:integration
```

After deploying the stable sandbox origins, run:

```bash
pnpm test:live
pnpm test:live:flow -- --session-secret-file /secure/path/to/session-secret
```

The live smoke test initializes both hosted runtimes and verifies their public/editor split,
OAuth+PKCE redirect, scheduler and MCP authentication, the production pointer and its immutable
manifest with the exact deployed registry digest.

The opt-in live flow creates a real Change with a page plus pricing/navigation globals, directly
uploads an image to the separate R2 asset bucket, stores its metadata on the Change and selects it
through the same media reference consumed by the editor. It then updates the server-rendered
preview, opens and independently approves a GitHub review, squash-merges to Staging, promotes with
an independently verified immutable Staging release and atomic pointer, promotes with a release PR,
verifies the asset reference in immutable production CDN JSON, atomically rolls back, and restores
the verified release. It requires a production session secret supplied through a local
permission-restricted file; the value is never printed.
