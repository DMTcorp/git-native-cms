"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { create } from "zustand";
import type { Change, ContentDocument, Revision } from "@git-native-cms/core";
import { applyPatches, contentPath, type ContentPatch } from "@git-native-cms/document-model";
import { PREVIEW_CHANNEL } from "@git-native-cms/protocol/preview";
import { Button, ChangeRail, StatusBadge, TextField } from "@git-native-cms/editor-ui";

interface EditableSection {
  readonly id: string;
  readonly type: string;
  readonly heading?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

interface EditablePage {
  readonly title?: string;
  readonly route?: { readonly path?: string };
  readonly sections?: readonly EditableSection[];
  readonly [key: string]: unknown;
}

interface EditorUiState {
  readonly selectedSectionId: string | undefined;
  readonly viewport: "desktop" | "tablet" | "mobile";
  readonly inspectorOpen: boolean;
  readonly selectSection: (id: string | undefined) => void;
  readonly setViewport: (viewport: EditorUiState["viewport"]) => void;
  readonly toggleInspector: () => void;
}

export const useEditorUiStore = create<EditorUiState>((set) => ({
  selectedSectionId: undefined,
  viewport: "desktop",
  inspectorOpen: true,
  selectSection: (selectedSectionId) =>
    set(selectedSectionId === undefined ? { selectedSectionId: undefined } : { selectedSectionId }),
  setViewport: (viewport) => set({ viewport }),
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
}));

export interface EditorAppProps {
  readonly change: Change;
  readonly document: ContentDocument<EditablePage>;
  readonly previewUrl: string;
  readonly locale?: string;
  readonly onSave?: (input: {
    readonly expectedRevision: Revision;
    readonly patches: readonly ContentPatch[];
  }) => Promise<Revision>;
}

export interface RecoverySnapshot {
  readonly documentId: string;
  readonly revision: Revision;
  readonly patches: readonly ContentPatch[];
  readonly savedAt: string;
}

const RECOVERY_DATABASE = "git-native-cms-recovery";

async function recoveryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECOVERY_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("snapshots")) {
        request.result.createObjectStore("snapshots", { keyPath: "documentId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecoverySnapshot(snapshot: RecoverySnapshot): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const database = await recoveryDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("snapshots", "readwrite");
    transaction.objectStore("snapshots").put(snapshot);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function readRecoverySnapshot(
  documentId: string,
): Promise<RecoverySnapshot | undefined> {
  if (!("indexedDB" in globalThis)) return undefined;
  const database = await recoveryDatabase();
  const result = await new Promise<RecoverySnapshot | undefined>((resolve, reject) => {
    const request = database.transaction("snapshots").objectStore("snapshots").get(documentId);
    request.onsuccess = () => resolve(request.result as RecoverySnapshot | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

function sectionLabel(section: EditableSection): string {
  return section.heading?.trim() || section.type;
}

export function EditorApp(props: EditorAppProps): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  const [previewConnected, setPreviewConnected] = useState(false);
  const [patches, setPatches] = useState<readonly ContentPatch[]>([]);
  const [revision, setRevision] = useState(props.document.revision);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const iframe = useRef<HTMLIFrameElement>(null);
  const previewPort = useRef<MessagePort | undefined>(undefined);
  const {
    selectedSectionId,
    viewport,
    inspectorOpen,
    selectSection,
    setViewport,
    toggleInspector,
  } = useEditorUiStore();
  const document = useMemo(
    () => applyPatches(props.document.data, patches),
    [patches, props.document.data],
  );
  const sections = document.sections ?? [];
  const selectedIndex = sections.findIndex((section) => section.id === selectedSectionId);
  const selectedSection = selectedIndex < 0 ? undefined : sections[selectedIndex];
  const reactId = useId();
  const sessionId = useMemo(
    () => `cms-${reactId.replaceAll(":", "")}`,
    [reactId],
  );

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    void readRecoverySnapshot(props.document.id).then((snapshot) => {
      if (
        snapshot !== undefined &&
        snapshot.revision === props.document.revision &&
        snapshot.patches.length > 0
      ) {
        setPatches(snapshot.patches);
        setSaveState("dirty");
      }
    });
  }, [props.document.id, props.document.revision]);

  useEffect(() => {
    if (patches.length === 0) return;
    const timeout = window.setTimeout(() => {
      void saveRecoverySnapshot({
        documentId: props.document.id,
        revision,
        patches,
        savedAt: new Date().toISOString(),
      });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [patches, props.document.id, revision]);

  useEffect(() => {
    const handleReady = (event: MessageEvent): void => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.data?.channel !== PREVIEW_CHANNEL ||
        event.data?.sessionId !== sessionId
      ) {
        return;
      }
      if (previewPort.current !== undefined) return;
      const channel = new MessageChannel();
      previewPort.current = channel.port1;
      setPreviewConnected(true);
      channel.port1.start();
      const origin = new URL(props.previewUrl, window.location.href).origin;
      iframe.current?.contentWindow?.postMessage({ channel: PREVIEW_CHANNEL, sessionId }, origin, [
        channel.port2,
      ]);
      channel.port1.postMessage({
        protocolVersion: "1.0.0",
        type: "editor.initialize",
        timestamp: new Date().toISOString(),
        payload: {
          sessionId,
          document,
          capabilities: ["patches", "selection", "inline-editing", "navigation"],
        },
      });
    };
    window.addEventListener("message", handleReady);
    return () => {
      window.removeEventListener("message", handleReady);
      previewPort.current?.close();
    };
  }, [document, props.previewUrl, sessionId]);

  function addPatch(patch: ContentPatch): void {
    const next = [...patches, patch];
    setPatches(next);
    setSaveState("dirty");
    previewPort.current?.postMessage({
      protocolVersion: "1.0.0",
      type: "editor.apply-patches",
      timestamp: new Date().toISOString(),
      payload: { revision, patches: [patch] },
    });
  }

  function select(id: string): void {
    selectSection(id);
    previewPort.current?.postMessage({
      protocolVersion: "1.0.0",
      type: "editor.select-section",
      timestamp: new Date().toISOString(),
      payload: { sectionId: id },
    });
  }

  async function save(): Promise<void> {
    if (patches.length === 0 || props.onSave === undefined) return;
    setSaveState("saving");
    try {
      const nextRevision = await props.onSave({ expectedRevision: revision, patches });
      setRevision(nextRevision);
      setPatches([]);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div
      className="cms-app cms-editor-shell"
      data-cms-hydrated={hydrated}
      data-cms-preview-connected={previewConnected}
    >
      <header className="cms-editor-topbar">
        <div className="cms-change-title">
          <span className="cms-change-title__mark" aria-hidden="true">
            C
          </span>
          <div>
            <strong>{props.change.name}</strong>
            <span>
              {props.locale ?? "en-US"} · {document.title ?? "Untitled page"}
            </span>
          </div>
        </div>
        <ChangeRail
          current={
            props.change.status === "published"
              ? "live"
              : props.change.status === "staging"
                ? "staging"
                : props.change.status === "in_review" || props.change.status === "approved"
                  ? "review"
                  : "change"
          }
        />
        <div className="cms-topbar-actions">
          <Button onPress={toggleInspector}>
            {inspectorOpen ? "Hide inspector" : "Show inspector"}
          </Button>
          <Button
            tone="primary"
            onPress={() => void save()}
            isDisabled={hydrated && (patches.length === 0 || saveState === "saving")}
          >
            {saveState === "saving" ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </header>

      <div className={`cms-editor-grid${inspectorOpen ? "" : " is-inspector-hidden"}`}>
        <nav className="cms-editor-navigation" aria-label="Content">
          <div className="cms-panel-heading">
            <span>Page structure</span>
            <StatusBadge tone={patches.length > 0 ? "review" : "draft"}>
              {patches.length > 0 ? `${patches.length} edits` : "Draft"}
            </StatusBadge>
          </div>
          <ol className="cms-section-tree">
            {sections.map((section, index) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={section.id === selectedSectionId ? "is-selected" : ""}
                  onClick={() => select(section.id)}
                >
                  <span className="cms-section-tree__index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{sectionLabel(section)}</strong>
                    <small>{section.type}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <Button className="cms-add-section">Add section</Button>
          <div className="cms-navigation-groups">
            {["Pages", "Collections", "Globals", "Assets"].map((label) => (
              <button type="button" key={label}>
                {label}
                <span>›</span>
              </button>
            ))}
          </div>
        </nav>

        <main className="cms-canvas-panel">
          <div className="cms-canvas-toolbar">
            <div role="group" aria-label="Preview viewport">
              {(["desktop", "tablet", "mobile"] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  className={viewport === item ? "is-active" : ""}
                  onClick={() => setViewport(item)}
                  aria-pressed={viewport === item}
                >
                  {item}
                </button>
              ))}
            </div>
            <span>{document.route?.path ?? "/"}</span>
            <button type="button" onClick={() => iframe.current?.contentWindow?.location.reload()}>
              Reload
            </button>
          </div>
          <div className={`cms-preview-stage cms-preview-stage--${viewport}`}>
            <iframe
              ref={iframe}
              title={`Preview of ${document.title ?? "page"}`}
              src={`${props.previewUrl}${props.previewUrl.includes("?") ? "&" : "?"}cmsSession=${encodeURIComponent(sessionId)}`}
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          </div>
        </main>

        {inspectorOpen && (
          <aside className="cms-inspector" aria-label="Inspector">
            {selectedSection === undefined ? (
              <div className="cms-inspector-empty">
                <span>Select a section</span>
                <h2>Edit what readers see</h2>
                <p>Choose a section on the page or in the structure panel to edit its fields.</p>
              </div>
            ) : (
              <>
                <div className="cms-panel-heading">
                  <div>
                    <span>Selected section</span>
                    <h2>{selectedSection.type}</h2>
                  </div>
                  <StatusBadge tone="draft">
                    v{typeof selectedSection.version === "number" ? selectedSection.version : 1}
                  </StatusBadge>
                </div>
                <div className="cms-inspector-fields">
                  <TextField
                    label="Heading"
                    value={selectedSection.heading ?? ""}
                    onChange={(value) =>
                      addPatch({
                        op: "set",
                        path: contentPath(`/sections/${selectedIndex}/heading`),
                        value,
                        metadata: {
                          id: globalThis.crypto.randomUUID(),
                          actorId: props.change.ownerId,
                          createdAt: new Date().toISOString(),
                          source: "editor",
                          description: "Update section heading",
                        },
                      })
                    }
                  />
                  <TextField
                    label="Description"
                    value={selectedSection.description ?? ""}
                    onChange={(value) =>
                      addPatch({
                        op: "set",
                        path: contentPath(`/sections/${selectedIndex}/description`),
                        value,
                        metadata: {
                          id: globalThis.crypto.randomUUID(),
                          actorId: props.change.ownerId,
                          createdAt: new Date().toISOString(),
                          source: "editor",
                          description: "Update section description",
                        },
                      })
                    }
                  />
                </div>
                <details className="cms-technical">
                  <summary>Technical details</summary>
                  <dl>
                    <div>
                      <dt>Section ID</dt>
                      <dd>{selectedSection.id}</dd>
                    </div>
                    <div>
                      <dt>Revision</dt>
                      <dd>{revision}</dd>
                    </div>
                  </dl>
                </details>
              </>
            )}
          </aside>
        )}
      </div>
      <footer className="cms-editor-statusbar">
        <span className={`cms-save-dot cms-save-dot--${saveState}`} aria-hidden="true" />
        <span>
          {saveState === "saved"
            ? "All changes saved"
            : saveState === "dirty"
              ? "Unsaved changes"
              : saveState === "saving"
                ? "Saving changes"
                : "Changes could not be saved"}
        </span>
        <span className="cms-statusbar-spacer" />
        <span>{sections.length} sections</span>
        <span>{previewConnected ? "Preview connected" : "Connecting preview…"}</span>
      </footer>
    </div>
  );
}
