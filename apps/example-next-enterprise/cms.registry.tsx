import { createReactRegistry, registerReactSection } from "@git-native-cms/react";
import { defineSection, fields } from "@git-native-cms/schema";

const hero = defineSection({
  name: "enterpriseHero",
  version: 1,
  label: "Enterprise hero",
  category: "Introduction",
  fields: {
    eyebrow: fields.text({ inline: true }),
    heading: fields.text({ required: true, inline: true }),
    description: fields.text({ inline: true }),
  },
  defaults: {
    eyebrow: "Enterprise example",
    heading: "Content delivery with an auditable Git workflow",
    description: "The public route renders registered components without loading the editor.",
  },
});

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export const enterpriseRegistry = createReactRegistry({
  sections: [
    registerReactSection(hero, ({ section }) => (
      <section className="hero">
        <span data-cms-inline-field="eyebrow">{text(section.eyebrow)}</span>
        <h1 data-cms-inline-field="heading">{text(section.heading)}</h1>
        <p data-cms-inline-field="description">{text(section.description)}</p>
      </section>
    )),
  ],
});
