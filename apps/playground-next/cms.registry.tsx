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
          <span className="hero__eyebrow">A Git-native publication</span>
          <h1 data-cms-inline-field="heading">{String(section.heading)}</h1>
          <p data-cms-inline-field="description">{String(section.description)}</p>
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
        <section className="site-section pricing-grid" id="plans">
          <span className="hero__eyebrow">Collection materialization</span>
          <h2 data-cms-inline-field="heading">{String(section.heading)}</h2>
          <div className="pricing-grid__items">
            {(Array.isArray(section.plans) ? section.plans : []).map((plan) => {
              const value = plan as Readonly<Record<string, unknown>>;
              const price =
                typeof value.price === "object" && value.price !== null
                  ? (value.price as Readonly<Record<string, unknown>>)
                  : {};
              return (
                <article key={String(value.id)}>
                  <strong>{text(value.name, text(value.title, "Plan"))}</strong>
                  <span>
                    {typeof price.amount === "number"
                      ? `${text(price.currency, "USD")} ${(price.amount / 100).toFixed(2)}`
                      : ""}
                  </span>
                </article>
              );
            })}
          </div>
        </section>
      ),
    ),
  ],
});
