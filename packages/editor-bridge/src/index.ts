import { applyPatches, type ContentPatch } from "@git-native-cms/document-model";
import {
  PREVIEW_CHANNEL,
  type EditorPreviewMessage,
  type PreviewCapability,
  type PreviewEditorMessage,
} from "@git-native-cms/protocol/preview";

export interface PreviewBridgeOptions {
  readonly parentOrigin: string;
  readonly sessionId: string;
  readonly getDocument: () => unknown;
  readonly setDocument: (document: unknown) => void;
  readonly onNavigate?: (path: string) => void;
}

interface CmsPreviewOverlayElement extends HTMLElement {
  select(element: Element | undefined, label?: string): void;
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
    "viewport-context",
  ];
  const overlay = document.createElement(
    "cms-preview-overlay",
  ) as CmsPreviewOverlayElement;
  document.documentElement.append(overlay);
  let port: MessagePort | undefined;

  const send = (message: PreviewEditorMessage): void => port?.postMessage(message);
  const handlePortMessage = (event: MessageEvent<EditorPreviewMessage>): void => {
    const message = event.data;
    if (message.protocolVersion !== "1.0.0") return;
    switch (message.type) {
      case "editor.initialize":
        send({
          protocolVersion: "1.0.0",
          type: "preview.document-loaded",
          timestamp: new Date().toISOString(),
          payload: { documentId: "preview", revision: "initialized" },
        });
        break;
      case "editor.apply-patches":
        options.setDocument(
          applyPatches(options.getDocument(), message.payload.patches as readonly ContentPatch[]),
        );
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
      case "editor.navigate":
        options.onNavigate?.(message.payload.path);
        break;
    }
  };
  const handleWindowMessage = (event: MessageEvent): void => {
    if (
      event.origin !== options.parentOrigin ||
      event.data?.channel !== PREVIEW_CHANNEL ||
      event.data?.sessionId !== options.sessionId
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
      window.removeEventListener("message", handleWindowMessage);
      window.clearInterval(announceTimer);
      port?.close();
      overlay.remove();
    },
  };
}
