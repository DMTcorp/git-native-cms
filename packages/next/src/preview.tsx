import type { ReactElement } from "react";
import { CmsPageRenderer, type CmsPageDocument, type ReactRegistry } from "@git-native-cms/react";

export function CmsPreviewPage(props: {
  readonly document: CmsPageDocument;
  readonly registry: ReactRegistry;
}): ReactElement {
  return <CmsPageRenderer document={props.document} registry={props.registry} preview />;
}
