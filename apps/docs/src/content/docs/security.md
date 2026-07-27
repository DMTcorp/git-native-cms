---
title: Security model
description: Authentication, untrusted content, machine actors and storage boundaries.
---

GitHub OAuth uses state and PKCE. The access token is stored only inside an encrypted, rotating
JWE cookie and is revoked during logout. Cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, have
absolute and idle expiry, and each session carries an independent CSRF secret.

All mutations require JSON, a same-origin request, CSRF, an idempotency key and an exact expected
Git revision. Publication and rollback additionally require a short-lived, actor/action-scoped
JWE confirmation token whose JTI can be claimed only once.

GitHub webhooks require SHA-256 HMAC verification and a one-time delivery ID. MCP machine access
uses a separate bearer token and maps to an editor-only actor; it cannot stage or publish without
permission and a confirmation token.

Untrusted boundaries enforce:

- 1 MiB HTTP bodies, depth/node limits and protected-key rejection;
- deterministic JSON/YAML with alias limits and no custom object types;
- RFC 6901 patch paths with prototype-pollution protection;
- sanitized portable rich text and blocked `javascript:` links;
- non-SVG allowlisted uploads, declared/actual size and MIME checks, SHA-256 addressing;
- Sharp EXIF removal and a 40-megapixel decode limit;
- safe release paths, full Git/registry digests and immutable checksum verification;
- exact preview origin/session handshake plus Ajv validation in both MessageChannel directions;
- HTTPS-only external integration URLs and redirect rejection.

Assets and immutable releases may use public R2 delivery URLs. `CMS_STATE_BUCKET` must remain
private because it contains audit, idempotency, webhook replay, one-time confirmation and
distributed rate-limit records.

The Vercel configs add CSP, HSTS, `nosniff`, frame, referrer, permissions, COOP and CORP headers.
Run unit security tests, MinIO/R2 contracts, three-browser E2E and axe WCAG checks before release.
