# Visual regression fixtures

Canonical light and dark snapshots live in `tests/e2e/snapshots`. Run
`pnpm exec playwright test --grep "visual"` against both framework projects; update snapshots only
after reviewing the rendered editor, preview overlay, focus states and reduced-motion behavior.
