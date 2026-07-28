---
title: Fields, sections and validators
description: Define visual components once and compile every runtime contract deterministically.
---

The registry schema is the contract between stored content, the editor inspector, preview,
delivery renderer and MCP. A section definition contains a stable name, integer version, label,
category, fields and deterministic defaults.

```tsx
import { defineSection, fields } from "@git-native-cms/schema";
import { registerReactSection } from "@git-native-cms/react";

const hero = defineSection({
  name: "hero",
  version: 1,
  label: "Hero",
  category: "Introduction",
  fields: {
    heading: fields.text({ required: true, inline: true }),
    body: fields.richText({ required: true }),
    media: fields.asset({ accept: ["image/*"], aspectRatio: [4, 3] }),
    theme: fields.select({ options: ["light", "dark"] }),
  },
  defaults: { heading: "A clear statement", body: { root: { children: [] } }, media: null },
});

export const registeredHero = registerReactSection(hero, ({ section }) => (
  <section data-theme={String(section.theme ?? "light")}>
    <h1 data-cms-inline-field="heading">{String(section.heading)}</h1>
  </section>
));
```

Available field families cover text, textarea, number, boolean, date/time, select, asset,
reference, list, object, JSON and portable rich text. Asset fields store a stable asset reference,
not bytes or an expiring upload URL. Reference fields participate in the content graph and safe
deletion checks.

Schema compilation produces a sorted AST, JSON Schema, manifest, TypeScript declaration and Ajv
validator. Reordering source object keys must not change the digest. Change a section version when
stored data needs a migration, then add the ordered migration before deploying the new registry.

Never render stored rich text as untrusted HTML. Use the portable AST renderer, which rejects
unsafe links, unknown node types and executable payloads.
