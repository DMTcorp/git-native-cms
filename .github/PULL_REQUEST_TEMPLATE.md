## Change

Describe the user-facing outcome and the application command or query that owns it.

## Verification

- [ ] `pnpm check`
- [ ] Contract tests added or updated for every changed port
- [ ] Next.js and Astro behavior verified when framework integration changes
- [ ] Security, accessibility and bundle impact considered
- [ ] Documentation and Changeset updated when public behavior changes

## Architecture

- [ ] Route handlers, UI, CLI and MCP call the application layer
- [ ] No secret or installation credential is exposed to browser code or Git
- [ ] Mutations use `expectedRevision` and an idempotency key
- [ ] Deterministic outputs remain reproducible
