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
          <span className="hero__eyebrow">A Git-native publication</span>
          <h1>{String(section.heading)}</h1>
          <p>{String(section.description)}</p>
        </div>
        <aside className="hero__proof" aria-label="Publication workflow">
          <span>Current proof</span>
          <ol>
            <li>Change prepared</li>
            <li>Review complete</li>
            <li>Ready for staging</li>
          </ol>
        </aside>
      </section>
    )),
    registerReactSection(sectionDefinition("proof", "Proof"), ({ section }) => (
      <section className="site-section" id="journal">
        <span className="hero__eyebrow">Publication proof</span>
        <h2>{String(section.heading)}</h2>
        <p>{String(section.description)}</p>
      </section>
    )),
  ],
});
