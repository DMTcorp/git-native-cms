"use client";

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";

export interface CmsPreviewContextValue {
  readonly preview: boolean;
  readonly selectedSectionId?: string;
  readonly hoveredSectionId?: string;
  readonly selectSection?: (sectionId: string) => void;
  readonly hoverSection?: (sectionId: string | undefined) => void;
  readonly updateInlineField?: (input: {
    readonly sectionId: string;
    readonly field: string;
    readonly value: unknown;
  }) => void;
}

const CmsPreviewContext = createContext<CmsPreviewContextValue>({ preview: false });

export function CmsPreviewProvider(props: {
  readonly value: CmsPreviewContextValue;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(CmsPreviewContext.Provider, {
    value: props.value,
    children: props.children,
  });
}

export function useCmsPreview(): CmsPreviewContextValue {
  return useContext(CmsPreviewContext);
}

export function useCmsSection(sectionId: string): {
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly preview: boolean;
  readonly select: () => void;
  readonly hover: (active: boolean) => void;
} {
  const preview = useCmsPreview();
  return useMemo(
    () => ({
      preview: preview.preview,
      selected: preview.selectedSectionId === sectionId,
      hovered: preview.hoveredSectionId === sectionId,
      select: () => preview.selectSection?.(sectionId),
      hover: (active: boolean) => preview.hoverSection?.(active ? sectionId : undefined),
    }),
    [preview, sectionId],
  );
}

export function useCmsInlineField(
  sectionId: string,
  field: string,
): {
  readonly editable: boolean;
  readonly update: (value: unknown) => void;
  readonly attributes: Readonly<Record<string, string>>;
} {
  const preview = useCmsPreview();
  return useMemo(
    () => ({
      editable: preview.preview && preview.updateInlineField !== undefined,
      update: (value: unknown) => preview.updateInlineField?.({ sectionId, field, value }),
      attributes: {
        "data-cms-section-id": sectionId,
        "data-cms-inline-field": field,
      },
    }),
    [field, preview, sectionId],
  );
}
