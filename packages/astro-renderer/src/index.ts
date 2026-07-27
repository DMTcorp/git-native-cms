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
  readonly preview?: boolean;
}): Promise<string> {
  return (
    await Promise.all(
      input.sections.map(async (section) => {
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
