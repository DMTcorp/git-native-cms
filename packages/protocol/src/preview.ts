import type { ProtocolEnvelope } from "./index.js";

export type PreviewCapability =
  "patches" | "selection" | "inline-editing" | "navigation" | "screenshots" | "viewport-context";

export type EditorPreviewMessage =
  | ProtocolEnvelope<
      "editor.initialize",
      {
        readonly sessionId: string;
        readonly document: unknown;
        readonly capabilities: readonly PreviewCapability[];
      }
    >
  | ProtocolEnvelope<
      "editor.apply-patches",
      { readonly revision: string; readonly patches: readonly unknown[] }
    >
  | ProtocolEnvelope<"editor.select-section", { readonly sectionId?: string }>
  | ProtocolEnvelope<"editor.navigate", { readonly path: string }>;

export type PreviewEditorMessage =
  | ProtocolEnvelope<
      "preview.ready",
      { readonly sessionId: string; readonly capabilities: readonly PreviewCapability[] }
    >
  | ProtocolEnvelope<
      "preview.document-loaded",
      { readonly documentId: string; readonly revision: string }
    >
  | ProtocolEnvelope<"preview.section-selected", { readonly sectionId: string }>
  | ProtocolEnvelope<"preview.inline-patch", { readonly patch: unknown }>
  | ProtocolEnvelope<
      "preview.runtime-error",
      { readonly message: string; readonly recoverable: boolean }
    >;

export const PREVIEW_CHANNEL = "git-native-cms.preview.v1";
