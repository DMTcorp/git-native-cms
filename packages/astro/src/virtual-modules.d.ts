declare module "virtual:git-native-cms/config" {
  const config: {
    readonly editorPath: string;
    readonly previewPath: string;
    readonly apiPath: string;
    readonly internalEditorPath: string;
    readonly internalPreviewPath: string;
  };
  export default config;
}

declare module "virtual:git-native-cms/runtime" {
  import type { HostedCmsRuntime } from "@git-native-cms/hosted-runtime";

  export const hostedRuntime: HostedCmsRuntime;
}

declare module "virtual:git-native-cms/registry" {
  import type { HostedEditorState } from "@git-native-cms/hosted-runtime";
  import type { ComponentType } from "react";
  import type { ReactRegistry } from "@git-native-cms/react";

  export const registry: ReactRegistry | undefined;
  export const CmsEditor: ComponentType<{ readonly state: HostedEditorState }>;
  export const CmsPreview: ComponentType;
}
