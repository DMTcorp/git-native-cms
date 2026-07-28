export interface AstroSectionInstance {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

export type AstroSectionRenderer = (
  section: AstroSectionInstance,
  context: { readonly preview: boolean },
) => string | Promise<string>;

export interface AstroRegistry {
  readonly sections: ReadonlyMap<string, AstroSectionRenderer>;
}

export interface AstroContentDocument {
  readonly id: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function matchesQuery(
  document: AstroContentDocument,
  query: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(query).every(([field, expected]) => {
    const actual = document.data[field];
    return Array.isArray(expected) ? expected.includes(actual) : Object.is(actual, expected);
  });
}

export function materializeAstroSection(
  section: AstroSectionInstance,
  documents: readonly AstroContentDocument[],
): AstroSectionInstance {
  const bindings =
    typeof section.bindings === "object" && section.bindings !== null
      ? (section.bindings as Readonly<Record<string, unknown>>)
      : {};
  const materialized: Record<string, unknown> = { ...section };
  for (const [field, value] of Object.entries(bindings)) {
    if (typeof value !== "object" || value === null) continue;
    const binding = value as Readonly<Record<string, unknown>>;
    if (typeof binding.collection === "string") {
      const query =
        typeof binding.query === "object" && binding.query !== null && !Array.isArray(binding.query)
          ? (binding.query as Readonly<Record<string, unknown>>)
          : {};
      materialized[field] = documents
        .filter((document) => document.type === binding.collection)
        .filter((document) => matchesQuery(document, query))
        .map((document) => ({ id: document.id, ...document.data }));
    } else if (typeof binding.id === "string") {
      const referenced = documents.find((document) => document.id === binding.id);
      materialized[field] =
        referenced === undefined ? undefined : { id: referenced.id, ...referenced.data };
    } else if (typeof binding.global === "string") {
      materialized[field] = documents.find(
        (document) => document.id === binding.global || document.type === binding.global,
      )?.data;
    }
  }
  return materialized as AstroSectionInstance;
}

export function resolveAstroPageSections(
  sections: readonly AstroSectionInstance[],
  documents: readonly AstroContentDocument[],
): readonly AstroSectionInstance[] {
  return sections.flatMap((section) => {
    if (section.type !== "reference" || typeof section.ref !== "string") return [section];
    const slug = section.ref.replace(/^reusable-blocks\//u, "");
    const reusable = documents.find(
      (document) =>
        document.type === "reusable-blocks" &&
        (document.id === section.ref ||
          document.id === slug ||
          document.data.slug === slug ||
          document.data.path === section.ref),
    );
    const source =
      Array.isArray(section.detachedSections) && section.detached === true
        ? section.detachedSections
        : reusable?.data.sections;
    if (!Array.isArray(source)) return [section];
    const overrides =
      typeof section.overrides === "object" &&
      section.overrides !== null &&
      !Array.isArray(section.overrides)
        ? (section.overrides as Readonly<Record<string, unknown>>)
        : {};
    return source.flatMap((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const block = value as AstroSectionInstance;
      const override =
        typeof overrides[block.id] === "object" &&
        overrides[block.id] !== null &&
        !Array.isArray(overrides[block.id])
          ? (overrides[block.id] as Readonly<Record<string, unknown>>)
          : {};
      return [{ ...block, ...override, id: `${section.id}:${block.id || String(index)}` }];
    });
  });
}

export function createAstroRegistry(
  entries: Readonly<Record<string, AstroSectionRenderer>>,
): AstroRegistry {
  return { sections: new Map(Object.entries(entries)) };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function renderAstroSections(input: {
  readonly sections: readonly AstroSectionInstance[];
  readonly registry: AstroRegistry;
  readonly content?: readonly AstroContentDocument[];
  readonly preview?: boolean;
}): Promise<string> {
  return (
    await Promise.all(
      resolveAstroPageSections(input.sections, input.content ?? []).map(async (sourceSection) => {
        const section = materializeAstroSection(sourceSection, input.content ?? []);
        const renderer = input.registry.sections.get(section.type);
        const content =
          renderer === undefined
            ? `<div role="alert">Section ${escapeAttribute(section.type)} is not registered.</div>`
            : await renderer(section, { preview: input.preview ?? false });
        return input.preview === true
          ? `<cms-section data-cms-section-id="${escapeAttribute(section.id)}" data-cms-section-type="${escapeAttribute(section.type)}">${content}</cms-section>`
          : content;
      }),
    )
  ).join("");
}
