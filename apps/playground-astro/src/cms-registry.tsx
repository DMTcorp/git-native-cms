import { createReactRegistry, registerReactSection } from "@git-native-cms/react";
import { defineSection, fields } from "@git-native-cms/schema";

const sectionDefinition = (name: string, label: string) =>
  defineSection({
    name,
    version: 1,
    label,
    fields: {
      heading: fields.text({ required: true, inline: true }),
      description: fields.text({ inline: true }),
    },
  });

function text(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

export const sandboxRegistry = createReactRegistry({
  sections: [
    registerReactSection(sectionDefinition("hero", "Hero"), ({ section }) => (
      <section className="hero">
        <div>
          <span className="eyebrow">Built with Astro</span>
          <h1 data-cms-inline-field="heading">{String(section.heading)}</h1>
          <p data-cms-inline-field="description">{String(section.description)}</p>
        </div>
        <aside className="release-card">
          <strong>Immutable release</strong>
          <code>Production pointer</code>
        </aside>
      </section>
    )),
    registerReactSection(sectionDefinition("proof", "Proof"), ({ section }) => (
      <section className="proof">
        <span className="eyebrow">Renderer capability</span>
        <h2 data-cms-inline-field="heading">{String(section.heading)}</h2>
        <p data-cms-inline-field="description">{String(section.description)}</p>
      </section>
    )),
    registerReactSection(
      defineSection({
        name: "pricingGrid",
        version: 1,
        label: "Pricing grid",
        fields: {
          heading: fields.text({ required: true, inline: true }),
          bindings: fields.json(),
        },
      }),
      ({ section }) => (
        <section className="proof">
          <span className="eyebrow">Collection materialization</span>
          <h2 data-cms-inline-field="heading">{String(section.heading)}</h2>
          {(Array.isArray(section.plans) ? section.plans : []).map((plan) => {
            const value = plan as Readonly<Record<string, unknown>>;
            return <p key={String(value.id)}>{text(value.name, text(value.title, "Plan"))}</p>;
          })}
        </section>
      ),
    ),
  ],
});
