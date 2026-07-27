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
  readonly fallback?: ComponentType<{ readonly section: CmsSectionInstance }>;
}): ReactElement {
  return createElement(
    Fragment,
    null,
    ...props.document.sections.map((section) => {
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
