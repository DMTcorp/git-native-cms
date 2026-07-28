# Next.js enterprise example

This app demonstrates the production mounting contract: registered React sections, a public
server-rendered page, the catch-all CMS route and one Web API handler. Copy `.env.example` from the
repository root, run `cms github setup --origin <url> --owner <org>`, and configure R2 before
opening `/cms`.

For a zero-credential editable demo use `apps/playground-next`; this example intentionally fails
closed when the production GitHub App or storage configuration is absent.
