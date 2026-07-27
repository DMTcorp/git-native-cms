# Git-native Visual CMS

An open-source, self-hosted visual CMS embedded in Next.js and Astro applications.
Content remains in Git, editorial work happens through Changes, and publication produces
deterministic immutable JSON releases.

## Development

Requirements: Node.js 22.12 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test:integration
pnpm test:e2e
pnpm dev
```

The project is organized as ports and adapters. Framework routes, the editor, CLI, GitHub
Actions and MCP all call the same application commands.

See [ARCHITECTURE.md](./ARCHITECTURE.md) and the
[product specification](./git-native-visual-cms-implementation-plan.md).

The two SSR playgrounds live in `apps/playground-next` and `apps/playground-astro`. Public
provisioning is documented in the Starlight guide under **Sandbox deployment**; it intentionally
requires externally authenticated GitHub, Vercel and Cloudflare accounts.
