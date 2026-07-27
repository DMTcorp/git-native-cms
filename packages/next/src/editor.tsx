"use client";

import type { ReactElement } from "react";
import { EditorApp, type EditorAppProps } from "@git-native-cms/editor";

export function CmsEditorPage(props: EditorAppProps): ReactElement {
  return <EditorApp {...props} />;
}

export { CmsHostedApp, createCmsPreviewComponent } from "@git-native-cms/hosted-runtime/react";
