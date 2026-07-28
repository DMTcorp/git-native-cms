# ADR-0003: Preview, asset metadata and team provisioning are application capabilities

Status: accepted

## Context

Preview session signing, storage asset metadata and GitHub organization provisioning touch
external systems and are used by HTTP, UI, CLI or MCP. Implementing any of them directly in a
framework route or React component would bypass authorization, idempotency and audit behavior.

## Decision

- `PreviewSessionPort` issues, verifies and refreshes short-lived actor/Change/frontend/locale-bound
  sessions. The default adapter signs them with JOSE.
- `AssetStore.updateAssetMetadata` changes object metadata, while `UpdateAssetHandler` records the
  reviewed metadata on the Change branch with compare-and-swap.
- `TeamProvisioningPort` reads members/teams and performs invitations/membership changes through
  the GitHub App. CMS role mappings are proposed through `UpdateTeamRoleMappingsHandler` as a
  pull request changing `.cms/permissions.yaml`.
- The single Web API, hosted editor and future transports only translate their inputs into these
  application handlers.
- Shared adapter contracts cover retry behavior and stable read/write semantics.

## Consequences

Secrets remain server-side, team permission changes have a reviewable Git history, asset bytes
remain independent from content, and preview credentials cannot be reused across actors or
Changes. Adapters have more explicit contracts, but the application layer remains independent of
GitHub, S3/R2, JOSE and frameworks.
