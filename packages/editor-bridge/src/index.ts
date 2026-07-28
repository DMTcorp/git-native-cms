import { applyPatches, type ContentPatch } from "@git-native-cms/document-model";
import {
  isEditorPreviewMessage,
  PREVIEW_CHANNEL,
  type PreviewCapability,
  type PreviewEditorMessage,
} from "@git-native-cms/protocol/preview";

export interface PreviewBridgeOptions {
  readonly parentOrigin: string;
  readonly sessionId: string;
  readonly getDocument: () => unknown;
  readonly setDocument: (document: unknown) => void;
  readonly setContent?: (documents: readonly unknown[]) => void;
  readonly getContent?: () => readonly unknown[];
  readonly onNavigate?: (path: string) => void;
  readonly onViewportContext?: (context: {
    readonly viewport: "desktop" | "tablet" | "mobile";
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor?: number;
  }) => void;
  readonly onPreviewContext?: (context: {
    readonly locale: string;
    readonly market: string;
    readonly audience: string;
    readonly at?: string;
    readonly featureFlags: Readonly<Record<string, boolean>>;
  }) => void;
  readonly onRequestScreenshot?: (request: {
    readonly viewport: "desktop" | "tablet" | "mobile";
    readonly fullPage: boolean;
  }) =>
    | {
        readonly dataUrl: string;
        readonly mimeType: "image/svg+xml" | "image/png";
        readonly width: number;
        readonly height: number;
      }
    | Promise<{
        readonly dataUrl: string;
        readonly mimeType: "image/svg+xml" | "image/png";
        readonly width: number;
        readonly height: number;
      }>;
}

interface CmsPreviewOverlayElement extends HTMLElement {
  select(element: Element | undefined, label?: string): void;
}

export function isTrustedPreviewHandshake(
  event: Pick<MessageEvent, "origin" | "data" | "ports">,
  expected: { readonly parentOrigin: string; readonly sessionId: string },
): boolean {
  if (event.origin !== expected.parentOrigin || event.ports[0] === undefined) return false;
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Readonly<Record<string, unknown>>;
  return data.channel === PREVIEW_CHANNEL && data.sessionId === expected.sessionId;
}

export function definePreviewElements(): void {
  if (!customElements.get("cms-preview-overlay")) {
    customElements.define(
      "cms-preview-overlay",
      class extends HTMLElement implements CmsPreviewOverlayElement {
        private readonly root = this.attachShadow({ mode: "open" });
        private marker: HTMLDivElement | undefined;

        connectedCallback(): void {
          this.root.innerHTML = `<style>
            :host{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
            div{position:fixed;border:2px solid #315efb;border-radius:4px;box-shadow:0 0 0 1px #fff8}
            span{position:absolute;left:-2px;top:-26px;background:#315efb;color:white;padding:4px 7px;border-radius:4px 4px 0 0;
              font:600 11px/1.2 ui-sans-serif,system-ui}
          </style><div hidden><span></span></div>`;
          this.marker = this.root.querySelector("div") ?? undefined;
        }

        select(element: Element | undefined, label = "Section"): void {
          if (this.marker === undefined) return;
          if (element === undefined) {
            this.marker.hidden = true;
            return;
          }
          const rect = element.getBoundingClientRect();
          Object.assign(this.marker.style, {
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
          const span = this.marker.querySelector("span");
          if (span !== null) span.textContent = label;
          this.marker.hidden = false;
        }
      },
    );
  }
}

export function createPreviewBridge(options: PreviewBridgeOptions): {
  readonly capabilities: readonly PreviewCapability[];
  destroy(): void;
} {
  definePreviewElements();
  const capabilities: readonly PreviewCapability[] = [
    "patches",
    "selection",
    "inline-editing",
    "navigation",
    "screenshots",
    "viewport-context",
    "simulation-context",
  ];
  const overlay = document.createElement("cms-preview-overlay") as CmsPreviewOverlayElement;
  document.documentElement.append(overlay);
  let port: MessagePort | undefined;
  const pending: PreviewEditorMessage[] = [];

  const defaultScreenshot = (request: {
    readonly fullPage: boolean;
  }): {
    readonly dataUrl: string;
    readonly mimeType: "image/svg+xml";
    readonly width: number;
    readonly height: number;
  } => {
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(
      1,
      request.fullPage
        ? document.documentElement.scrollHeight
        : document.documentElement.clientHeight,
    );
    const styles = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join("\n");
    const body = new XMLSerializer().serializeToString(document.body.cloneNode(true));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${styles.replaceAll("</style>", "<\\/style>")}</style>${body}</div></foreignObject></svg>`;
    return {
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      mimeType: "image/svg+xml",
      width,
      height,
    };
  };

  const send = (message: PreviewEditorMessage): void => {
    if (port === undefined) {
      if (pending.length < 50) pending.push(message);
      return;
    }
    port.postMessage(message);
  };
  const handlePortMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isEditorPreviewMessage(message)) return;
    switch (message.type) {
      case "editor.initialize":
        options.setDocument(message.payload.document);
        if (message.payload.content !== undefined) options.setContent?.(message.payload.content);
        send({
          protocolVersion: "1.0.0",
          type: "preview.document-loaded",
          timestamp: new Date().toISOString(),
          payload: { documentId: "preview", revision: "initialized" },
        });
        break;
      case "editor.apply-patches":
        try {
          if (
            message.payload.documentId !== undefined &&
            options.getContent !== undefined &&
            options.setContent !== undefined
          ) {
            let updatedPage: unknown;
            const content = options.getContent().map((value) => {
              if (typeof value !== "object" || value === null) return value;
              const document = value as Readonly<Record<string, unknown>>;
              if (document.id !== message.payload.documentId) return value;
              const data = applyPatches(
                document.data,
                message.payload.patches as readonly ContentPatch[],
              );
              if (typeof data === "object" && data !== null && "sections" in data) {
                updatedPage = data;
              }
              return { ...document, data };
            });
            options.setContent(content);
            if (updatedPage !== undefined) options.setDocument(updatedPage);
          } else {
            options.setDocument(
              applyPatches(
                options.getDocument(),
                message.payload.patches as readonly ContentPatch[],
              ),
            );
          }
        } catch (cause) {
          send({
            protocolVersion: "1.0.0",
            type: "preview.validation-error",
            timestamp: new Date().toISOString(),
            payload: {
              path: "/",
              message: cause instanceof Error ? cause.message : "The preview patch is invalid.",
              severity: "error",
            },
          });
        }
        break;
      case "editor.select-section": {
        const id = message.payload.sectionId;
        const selected =
          id === undefined
            ? undefined
            : (document.querySelector(`[data-cms-section-id="${CSS.escape(id)}"]`) ?? undefined);
        overlay.select(selected, selected?.getAttribute("data-cms-section-type") ?? "Section");
        break;
      }
      case "editor.set-viewport-context":
        document.documentElement.dataset.cmsViewport = message.payload.viewport;
        options.onViewportContext?.(message.payload);
        break;
      case "editor.set-preview-context": {
        document.documentElement.lang = message.payload.locale;
        document.documentElement.dataset.cmsLocale = message.payload.locale;
        document.documentElement.dataset.cmsMarket = message.payload.market;
        document.documentElement.dataset.cmsAudience = message.payload.audience;
        if (message.payload.at === undefined) {
          delete document.documentElement.dataset.cmsPreviewAt;
        } else {
          document.documentElement.dataset.cmsPreviewAt = message.payload.at;
        }
        options.onPreviewContext?.(message.payload);
        window.dispatchEvent(
          new CustomEvent("cms:preview-context", {
            detail: message.payload,
          }),
        );
        break;
      }
      case "editor.navigate":
        options.onNavigate?.(message.payload.path);
        break;
      case "editor.request-screenshot":
        void Promise.resolve(
          options.onRequestScreenshot?.(message.payload) ?? defaultScreenshot(message.payload),
        )
          .then((screenshot) => {
            send({
              protocolVersion: "1.0.0",
              type: "preview.screenshot-ready",
              timestamp: new Date().toISOString(),
              payload: {
                requestId: message.requestId ?? globalThis.crypto.randomUUID(),
                viewport: message.payload.viewport,
                ...screenshot,
              },
            });
          })
          .catch((cause: unknown) => {
            send({
              protocolVersion: "1.0.0",
              type: "preview.runtime-error",
              timestamp: new Date().toISOString(),
              payload: {
                message:
                  cause instanceof Error ? cause.message : "Preview screenshot capture failed.",
                recoverable: true,
              },
            });
          });
        break;
    }
  };
  const handleWindowMessage = (event: MessageEvent): void => {
    if (
      !isTrustedPreviewHandshake(event, {
        parentOrigin: options.parentOrigin,
        sessionId: options.sessionId,
      })
    ) {
      return;
    }
    const [receivedPort] = event.ports;
    if (receivedPort === undefined) return;
    window.clearInterval(announceTimer);
    port = receivedPort;
    port.addEventListener("message", handlePortMessage);
    port.start();
    send({
      protocolVersion: "1.0.0",
      type: "preview.ready",
      timestamp: new Date().toISOString(),
      payload: { sessionId: options.sessionId, capabilities },
    });
    for (const message of pending.splice(0)) port.postMessage(message);
  };
  const handleClick = (event: MouseEvent): void => {
    const element = (event.target as Element | null)?.closest("[data-cms-section-id]");
    const id = element?.getAttribute("data-cms-section-id");
    if (id === null || id === undefined) return;
    event.preventDefault();
    send({
      protocolVersion: "1.0.0",
      type: "preview.section-selected",
      timestamp: new Date().toISOString(),
      payload: { sectionId: id },
    });
  };
  document.addEventListener("click", handleClick, true);

  let hoveredSection: string | undefined;
  const handlePointerOver = (event: PointerEvent): void => {
    const section = (event.target as Element | null)?.closest<HTMLElement>("[data-cms-section-id]");
    const sectionId = section?.dataset.cmsSectionId;
    if (sectionId === hoveredSection) return;
    hoveredSection = sectionId;
    send({
      protocolVersion: "1.0.0",
      type: "preview.section-hovered",
      timestamp: new Date().toISOString(),
      payload: sectionId === undefined ? {} : { sectionId },
    });
  };
  document.addEventListener("pointerover", handlePointerOver, true);

  const handleNavigation = (): void => {
    send({
      protocolVersion: "1.0.0",
      type: "preview.navigation",
      timestamp: new Date().toISOString(),
      payload: { path: window.location.pathname, title: document.title },
    });
  };
  window.addEventListener("popstate", handleNavigation);

  const heightObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          send({
            protocolVersion: "1.0.0",
            type: "preview.height-changed",
            timestamp: new Date().toISOString(),
            payload: { height: document.documentElement.scrollHeight },
          });
        });
  heightObserver?.observe(document.documentElement);

  const handleDoubleClick = (event: MouseEvent): void => {
    const field = (event.target as Element | null)?.closest<HTMLElement>("[data-cms-inline-field]");
    const section = field?.closest<HTMLElement>("[data-cms-section-id]");
    const sectionId = section?.dataset.cmsSectionId;
    const fieldName = field?.dataset.cmsInlineField;
    if (
      field === undefined ||
      field === null ||
      sectionId === undefined ||
      fieldName === undefined
    ) {
      return;
    }
    event.preventDefault();
    field.contentEditable = "plaintext-only";
    field.focus();
    let frame: number | undefined;
    let finished = false;
    let lastSentValue = field.textContent ?? "";
    const emit = (): void => {
      const value = field.textContent ?? "";
      if (value === lastSentValue) return;
      lastSentValue = value;
      send({
        protocolVersion: "1.0.0",
        type: "preview.inline-patch",
        timestamp: new Date().toISOString(),
        payload: {
          patch: {
            sectionId,
            field: fieldName,
            value,
          },
        },
      });
    };
    const queue = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        emit();
      });
    };
    const observer = new MutationObserver(queue);
    observer.observe(field, { childList: true, characterData: true, subtree: true });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      field.contentEditable = "false";
      field.removeEventListener("input", queue);
      field.removeEventListener("blur", finish);
      window.removeEventListener("blur", finish);
      emit();
    };
    field.addEventListener("input", queue);
    field.addEventListener("blur", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  };
  document.addEventListener("dblclick", handleDoubleClick, true);

  const announce = (): void => {
    window.parent.postMessage(
      {
        channel: PREVIEW_CHANNEL,
        type: "preview.ready",
        sessionId: options.sessionId,
      },
      options.parentOrigin,
    );
  };
  announce();
  const announceTimer = window.setInterval(announce, 250);
  window.addEventListener("message", handleWindowMessage);

  return {
    capabilities,
    destroy(): void {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("dblclick", handleDoubleClick, true);
      window.removeEventListener("message", handleWindowMessage);
      window.removeEventListener("popstate", handleNavigation);
      window.clearInterval(announceTimer);
      heightObserver?.disconnect();
      port?.close();
      overlay.remove();
    },
  };
}
