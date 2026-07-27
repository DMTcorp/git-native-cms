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

export const sandboxRegistry = createReactRegistry({
  sections: [
    registerReactSection(sectionDefinition("hero", "Hero"), ({ section }) => (
      <section className="hero">
        <div>
          <span className="eyebrow">Built with Astro</span>
          <h1>{String(section.heading)}</h1>
          <p>{String(section.description)}</p>
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
        <h2>{String(section.heading)}</h2>
        <p>{String(section.description)}</p>
      </section>
    )),
  ],
});
