import {
  compileProtocolSchema,
  isProtocolEnvelope,
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
} from "./index.js";

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

const capabilitySchema = {
  type: "string",
  enum: [
    "patches",
    "selection",
    "inline-editing",
    "navigation",
    "screenshots",
    "viewport-context",
    "simulation-context",
  ],
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
    messageSchema("editor.set-viewport-context", {
      type: "object",
      required: ["viewport", "width", "height"],
      properties: {
        viewport: { enum: ["desktop", "tablet", "mobile"] },
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
        deviceScaleFactor: { type: "number", minimum: 0.1 },
      },
      additionalProperties: false,
    }),
    messageSchema("editor.navigate", {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", pattern: "^/" } },
      additionalProperties: false,
    }),
    messageSchema("editor.set-preview-context", {
      type: "object",
      required: ["locale", "market", "audience", "featureFlags"],
      properties: {
        locale: { type: "string", minLength: 2, maxLength: 35 },
        market: { type: "string", minLength: 1, maxLength: 64 },
        audience: { type: "string", minLength: 1, maxLength: 64 },
        at: { type: "string", format: "date-time" },
        featureFlags: {
          type: "object",
          additionalProperties: { type: "boolean" },
          maxProperties: 100,
        },
      },
      additionalProperties: false,
    }),
    messageSchema("editor.request-screenshot", {
      type: "object",
      required: ["viewport", "fullPage"],
      properties: {
        viewport: { enum: ["desktop", "tablet", "mobile"] },
        fullPage: { type: "boolean" },
      },
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
    messageSchema("preview.section-hovered", {
      type: "object",
      properties: { sectionId: { type: "string", minLength: 1 } },
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
    messageSchema("preview.navigation", {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", pattern: "^/" },
        title: { type: "string" },
      },
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
    messageSchema("preview.validation-error", {
      type: "object",
      required: ["path", "message", "severity"],
      properties: {
        path: { type: "string", pattern: "^/" },
        message: { type: "string", minLength: 1 },
        severity: { enum: ["error", "warning"] },
      },
      additionalProperties: false,
    }),
    messageSchema("preview.screenshot-ready", {
      type: "object",
      required: ["requestId", "viewport", "width", "height", "mimeType", "dataUrl"],
      properties: {
        requestId: { type: "string", minLength: 1 },
        viewport: { enum: ["desktop", "tablet", "mobile"] },
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
        mimeType: { enum: ["image/svg+xml", "image/png"] },
        dataUrl: { type: "string", pattern: "^data:image/" },
      },
      additionalProperties: false,
    }),
    messageSchema("preview.height-changed", {
      type: "object",
      required: ["height"],
      properties: { height: { type: "number", minimum: 0 } },
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
