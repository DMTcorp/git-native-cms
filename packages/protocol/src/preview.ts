import {
  compileProtocolSchema,
  isProtocolEnvelope,
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
} from "./index.js";

export type PreviewCapability =
  "patches" | "selection" | "inline-editing" | "navigation" | "screenshots" | "viewport-context";

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

const capabilitySchema = {
  type: "string",
  enum: ["patches", "selection", "inline-editing", "navigation", "screenshots", "viewport-context"],
} as const;

function messageSchema(type: string, payload: unknown): unknown {
  return {
    type: "object",
    required: ["protocolVersion", "type", "timestamp", "payload"],
    properties: {
      protocolVersion: { type: "string", const: PROTOCOL_VERSION },
      type: { type: "string", const: type },
      requestId: { type: "string", minLength: 1 },
      timestamp: { type: "string", format: "date-time" },
      payload,
    },
    additionalProperties: false,
  };
}

const editorPreviewSchema = {
  $id: "cms://protocol/preview/editor-message/v1",
  oneOf: [
    messageSchema("editor.initialize", {
      type: "object",
      required: ["sessionId", "document", "capabilities"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        document: {},
        content: { type: "array" },
        capabilities: { type: "array", items: capabilitySchema, uniqueItems: true },
      },
      additionalProperties: false,
    }),
    messageSchema("editor.apply-patches", {
      type: "object",
      required: ["revision", "patches"],
      properties: {
        revision: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        patches: { type: "array", items: { type: "object" } },
      },
      additionalProperties: false,
    }),
    messageSchema("editor.select-section", {
      type: "object",
      properties: { sectionId: { type: "string", minLength: 1 } },
      additionalProperties: false,
    }),
    messageSchema("editor.navigate", {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", pattern: "^/" } },
      additionalProperties: false,
    }),
  ],
} as const;

const previewEditorSchema = {
  $id: "cms://protocol/preview/preview-message/v1",
  oneOf: [
    messageSchema("preview.ready", {
      type: "object",
      required: ["sessionId", "capabilities"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        capabilities: { type: "array", items: capabilitySchema, uniqueItems: true },
      },
      additionalProperties: false,
    }),
    messageSchema("preview.document-loaded", {
      type: "object",
      required: ["documentId", "revision"],
      properties: {
        documentId: { type: "string", minLength: 1 },
        revision: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    }),
    messageSchema("preview.section-selected", {
      type: "object",
      required: ["sectionId"],
      properties: { sectionId: { type: "string", minLength: 1 } },
      additionalProperties: false,
    }),
    messageSchema("preview.inline-patch", {
      type: "object",
      required: ["patch"],
      properties: { patch: { type: "object" } },
      additionalProperties: false,
    }),
    messageSchema("preview.runtime-error", {
      type: "object",
      required: ["message", "recoverable"],
      properties: {
        message: { type: "string", minLength: 1 },
        recoverable: { type: "boolean" },
      },
      additionalProperties: false,
    }),
  ],
} as const;

const validateEditorPreview = compileProtocolSchema<EditorPreviewMessage>(editorPreviewSchema);
const validatePreviewEditor = compileProtocolSchema<PreviewEditorMessage>(previewEditorSchema);

export function isEditorPreviewMessage(value: unknown): value is EditorPreviewMessage {
  return isProtocolEnvelope(value) && validateEditorPreview(value);
}

export function isPreviewEditorMessage(value: unknown): value is PreviewEditorMessage {
  return isProtocolEnvelope(value) && validatePreviewEditor(value);
}
