import { validateEditorPreview, validatePreviewEditor } from "./generated/preview-validators.js";
import type { ProtocolEnvelope } from "./index.js";

export { editorPreviewSchema, previewEditorSchema } from "./preview-schemas.js";

export type PreviewCapability =
  | "patches"
  | "selection"
  | "inline-editing"
  | "navigation"
  | "screenshots"
  | "viewport-context"
  | "simulation-context";

export type EditorPreviewMessage =
  | ProtocolEnvelope<
      "editor.initialize",
      {
        readonly sessionId: string;
        readonly document: unknown;
        readonly content?: readonly unknown[];
        readonly capabilities: readonly PreviewCapability[];
      }
    >
  | ProtocolEnvelope<
      "editor.apply-patches",
      {
        readonly revision: string;
        readonly documentId?: string;
        readonly patches: readonly unknown[];
      }
    >
  | ProtocolEnvelope<"editor.select-section", { readonly sectionId?: string }>
  | ProtocolEnvelope<
      "editor.set-viewport-context",
      {
        readonly viewport: "desktop" | "tablet" | "mobile";
        readonly width: number;
        readonly height: number;
        readonly deviceScaleFactor?: number;
      }
    >
  | ProtocolEnvelope<"editor.navigate", { readonly path: string }>
  | ProtocolEnvelope<
      "editor.set-preview-context",
      {
        readonly locale: string;
        readonly market: string;
        readonly audience: string;
        readonly at?: string;
        readonly featureFlags: Readonly<Record<string, boolean>>;
      }
    >
  | ProtocolEnvelope<
      "editor.request-screenshot",
      {
        readonly viewport: "desktop" | "tablet" | "mobile";
        readonly fullPage: boolean;
      }
    >;

export type PreviewEditorMessage =
  | ProtocolEnvelope<
      "preview.ready",
      { readonly sessionId: string; readonly capabilities: readonly PreviewCapability[] }
    >
  | ProtocolEnvelope<
      "preview.document-loaded",
      { readonly documentId: string; readonly revision: string }
    >
  | ProtocolEnvelope<"preview.section-hovered", { readonly sectionId?: string }>
  | ProtocolEnvelope<"preview.section-selected", { readonly sectionId: string }>
  | ProtocolEnvelope<"preview.inline-patch", { readonly patch: unknown }>
  | ProtocolEnvelope<"preview.navigation", { readonly path: string; readonly title?: string }>
  | ProtocolEnvelope<
      "preview.runtime-error",
      { readonly message: string; readonly recoverable: boolean }
    >
  | ProtocolEnvelope<
      "preview.validation-error",
      {
        readonly path: string;
        readonly message: string;
        readonly severity: "error" | "warning";
      }
    >
  | ProtocolEnvelope<
      "preview.screenshot-ready",
      {
        readonly requestId: string;
        readonly viewport: "desktop" | "tablet" | "mobile";
        readonly width: number;
        readonly height: number;
        readonly mimeType: "image/svg+xml" | "image/png";
        readonly dataUrl: string;
      }
    >
  | ProtocolEnvelope<"preview.height-changed", { readonly height: number }>;

export const PREVIEW_CHANNEL = "git-native-cms.preview.v1";

function hasValidTimestamp(value: unknown): value is { readonly timestamp: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "string"
  ) {
    return false;
  }
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.timestamp) &&
    !Number.isNaN(Date.parse(value.timestamp))
  );
}

export function isEditorPreviewMessage(value: unknown): value is EditorPreviewMessage {
  return validateEditorPreview(value) && hasValidTimestamp(value);
}

export function isPreviewEditorMessage(value: unknown): value is PreviewEditorMessage {
  return validatePreviewEditor(value) && hasValidTimestamp(value);
}
