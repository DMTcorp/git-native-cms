import { createReactRegistry, registerReactSection } from "@git-native-cms/react";
import { defineSection, fields } from "@git-native-cms/schema";

const sectionDefinition = (name: string, label: string, media = false) =>
  defineSection({
    name,
    version: 1,
    label,
    category: name === "hero" ? "Introduction" : "Evidence",
    description:
      name === "hero"
        ? "A primary statement with optional media from asset storage."
        : "A focused proof point or editorial callout.",
    fields: {
      heading: fields.text({ required: true, inline: true }),
      description: fields.text({ inline: true }),
      ...(media
        ? {
            media: fields.asset({
              label: "Hero media",
              description: "An image selected from the project asset library.",
              accept: ["image/*"],
              aspectRatio: [4, 3],
            }),
          }
        : {}),
    },
    defaults: {
      heading: name === "hero" ? "A clear headline" : "Why this matters",
      description: "Add supporting context here.",
      ...(media ? { media: null } : {}),
    },
  });

function text(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function asset(value: unknown):
  | {
      readonly url: string;
      readonly fileName: string;
      readonly altText?: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.url !== "string" || typeof record.fileName !== "string") return undefined;
  return {
    url: record.url,
    fileName: record.fileName,
    ...(typeof record.altText === "string" ? { altText: record.altText } : {}),
  };
}

export const sandboxRegistry = createReactRegistry({
  sections: [
    registerReactSection(sectionDefinition("hero", "Hero", true), ({ section }) => {
      const media = asset(section.media);
      return (
        <section className="hero">
          <div>
            <span className="eyebrow">Built with Astro</span>
            <h1 data-cms-inline-field="heading">{String(section.heading)}</h1>
            <p data-cms-inline-field="description">{String(section.description)}</p>
          </div>
          {media === undefined ? (
            <aside className="release-card">
              <strong>Immutable release</strong>
              <code>Production pointer</code>
            </aside>
          ) : (
            <figure className="hero__media">
              <img src={media.url} alt={media.altText ?? ""} />
              <figcaption>{media.fileName}</figcaption>
            </figure>
          )}
        </section>
      );
    }),
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
        <section className="proof" id="plans">
          <span className="eyebrow">Collection materialization</span>
          <h2 data-cms-inline-field="heading">{String(section.heading)}</h2>
          {(Array.isArray(section.plans) ? section.plans : []).map((plan) => {
            const value = plan as Readonly<Record<string, unknown>>;
            const price =
              typeof value.price === "object" && value.price !== null
                ? (value.price as Readonly<Record<string, unknown>>)
                : {};
            return (
              <p key={String(value.id)}>
                {text(value.name, text(value.title, "Plan"))}
                {typeof price.amount === "number"
                  ? ` · ${text(price.currency, "USD")} ${(price.amount / 100).toFixed(2)}`
                  : ""}
              </p>
            );
          })}
        </section>
      ),
    ),
  ],
});
