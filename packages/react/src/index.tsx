import {
  createElement,
  Fragment,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type { SchemaDefinition } from "@git-native-cms/schema";

export interface CmsSectionInstance {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

export interface CmsPageDocument {
  readonly id: string;
  readonly route?: { readonly path: string };
  readonly sections: readonly CmsSectionInstance[];
}

export interface RenderContentDocument {
  readonly id: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function matchesQuery(
  document: RenderContentDocument,
  query: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(query).every(([field, expected]) => {
    const actual = document.data[field];
    return Array.isArray(expected) ? expected.includes(actual) : Object.is(actual, expected);
  });
}

export function materializeSection(
  section: CmsSectionInstance,
  documents: readonly RenderContentDocument[],
): CmsSectionInstance {
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
      const global = documents.find(
        (document) => document.id === binding.global || document.type === binding.global,
      );
      materialized[field] = global?.data;
    }
  }
  return materialized as CmsSectionInstance;
}

export function resolvePageSections(
  sections: readonly CmsSectionInstance[],
  documents: readonly RenderContentDocument[],
): readonly CmsSectionInstance[] {
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
      const block = value as CmsSectionInstance;
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

export interface SectionRenderProps {
  readonly section: CmsSectionInstance;
  readonly preview: boolean;
}

export interface RegisteredReactSection {
  readonly definition: SchemaDefinition;
  readonly component: ComponentType<SectionRenderProps>;
}

export interface ReactRegistry {
  readonly sections: ReadonlyMap<string, RegisteredReactSection>;
  readonly manifest: readonly {
    readonly name: string;
    readonly version: number;
    readonly label: string;
  }[];
}

export function registerReactSection(
  definition: SchemaDefinition,
  component: ComponentType<SectionRenderProps>,
): RegisteredReactSection {
  return { definition, component };
}

export function createReactRegistry(input: {
  readonly sections: readonly RegisteredReactSection[];
}): ReactRegistry {
  const sections = new Map(input.sections.map((section) => [section.definition.name, section]));
  if (sections.size !== input.sections.length)
    throw new Error("Section registry contains duplicate names.");
  return {
    sections,
    manifest: input.sections.map(({ definition }) => ({
      name: definition.name,
      version: definition.version,
      label: definition.label,
    })),
  };
}

export function CmsSectionBoundary(props: {
  readonly section: CmsSectionInstance;
  readonly preview: boolean;
  readonly children: ReactNode;
}): ReactElement {
  if (!props.preview) return createElement(Fragment, null, props.children);
  return createElement(
    "cms-section",
    {
      "data-cms-section-id": props.section.id,
      "data-cms-section-type": props.section.type,
      style: { display: "contents" },
    },
    props.children,
  );
}

export function CmsPageRenderer(props: {
  readonly document: CmsPageDocument;
  readonly registry: ReactRegistry;
  readonly preview?: boolean;
  readonly content?: readonly RenderContentDocument[];
  readonly fallback?: ComponentType<{ readonly section: CmsSectionInstance }>;
}): ReactElement {
  return createElement(
    Fragment,
    null,
    ...resolvePageSections(props.document.sections, props.content ?? []).map((sourceSection) => {
      const section = materializeSection(sourceSection, props.content ?? []);
      const registered = props.registry.sections.get(section.type);
      const content =
        registered === undefined
          ? props.fallback === undefined
            ? createElement(
                "div",
                { role: "alert" },
                `Section "${section.type}" is not registered by this frontend.`,
              )
            : createElement(props.fallback, { section })
          : createElement(registered.component, {
              section,
              preview: props.preview ?? false,
            });
      return createElement(CmsSectionBoundary, {
        key: section.id,
        section,
        preview: props.preview ?? false,
        children: content,
      });
    }),
  );
}
