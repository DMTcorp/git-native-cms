---
title: Security
---

OAuth uses state and PKCE. Sessions are encrypted JWE cookies with absolute and idle expiration.
Mutations require a session-bound CSRF token. Webhook signatures, delivery IDs, preview origins,
asset MIME types and every protocol message are validated before domain commands run.
