"use client";

import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { create } from "zustand";
import { createEditor, type SerializedEditorState } from "lexical";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  Asset,
  DocumentSummary,
  EnvironmentPointer,
  ReviewCheck,
  ReviewComment,
  StoredRelease,
} from "@git-native-cms/application";
import type { Change, ChangeStatus, ContentDocument, Revision } from "@git-native-cms/core";
import {
  applyPatches,
  compactPatches,
  contentPath,
  mergeDocuments,
  type ContentPatch,
} from "@git-native-cms/document-model";
import { semanticDiff, summarizeDiff } from "@git-native-cms/diff";
import { isPreviewEditorMessage, PREVIEW_CHANNEL } from "@git-native-cms/protocol/preview";
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

export interface EditorSectionTemplate {
  readonly type: string;
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly defaults: Readonly<Record<string, unknown>>;
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
  readonly contentDocuments?: readonly ContentDocument[];
  readonly previewDocument?: ContentDocument<EditablePage>;
  readonly previewUrl: string;
  readonly productionUrl?: string;
  readonly locale?: string;
  readonly documents?: readonly DocumentSummary[];
  readonly onNavigateDocument?: (documentId: string, type: string) => void;
  readonly onCreateDocument?: (input: {
    readonly type: string;
    readonly title: string;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly id: string; readonly revision: Revision }>;
  readonly onDeleteDocument?: (input: {
    readonly documentId: string;
    readonly expectedRevision: Revision;
  }) => Promise<Revision>;
  readonly sectionTemplates?: readonly EditorSectionTemplate[];
  readonly baseDocument?: ContentDocument<EditablePage>;
  readonly productionDocument?: ContentDocument<EditablePage>;
  readonly review?: {
    readonly comments: readonly ReviewComment[];
    readonly checks: readonly ReviewCheck[];
  };
  readonly onAddReviewComment?: (body: string, path?: string) => Promise<void>;
  readonly onRequestChanges?: (input: {
    readonly body: string;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly status: ChangeStatus; readonly revision: Revision }>;
  readonly assets?: readonly Asset[];
  readonly onUploadAsset?: (input: {
    readonly file: File;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly asset: Asset; readonly revision: Revision }>;
  readonly onDeleteAsset?: (input: {
    readonly assetId: Asset["id"];
    readonly expectedRevision: Revision;
  }) => Promise<Revision>;
  readonly onImportTranslation?: (input: {
    readonly locale: string;
    readonly xliff: string;
    readonly expectedRevision: Revision;
  }) => Promise<Revision>;
  readonly onCreateTranslationJob?: (input: {
    readonly locale: string;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly jobId: string }>;
  readonly onReadTranslationJob?: (
    jobId: string,
  ) => Promise<
    | { readonly status: "queued" | "working" }
    | { readonly status: "complete"; readonly xliff: string }
    | { readonly status: "failed"; readonly message: string }
  >;
  readonly onSchedule?: (input: {
    readonly action: "publish" | "unpublish";
    readonly executeAt: string;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly scheduleId: string; readonly revision: Revision }>;
  readonly onFindUsages?: () => Promise<
    readonly {
      readonly sourceId: string;
      readonly sourcePath: string;
    }[]
  >;
  readonly onSave?: (input: {
    readonly expectedRevision: Revision;
    readonly patches: readonly ContentPatch[];
  }) => Promise<Revision>;
  readonly onWorkflowAction?: (input: {
    readonly action: "submit" | "approve" | "stage" | "publish";
    readonly expectedRevision: Revision;
    readonly pullRequestNumber?: number;
  }) => Promise<{
    readonly status: ChangeStatus;
    readonly revision: Revision;
    readonly pullRequestNumber?: number;
    readonly releaseId?: string;
  }>;
}

export interface RecoverySnapshot {
  readonly documentId: string;
  readonly revision: Revision;
  readonly patches: readonly ContentPatch[];
  readonly savedAt: string;
}

const RECOVERY_DATABASE = "git-native-cms-recovery";

function statusTone(status: ChangeStatus): "draft" | "review" | "staging" | "live" {
  if (status === "published") return "live";
  if (status === "staging") return "staging";
  if (status === "in_review" || status === "approved" || status === "changes_requested") {
    return "review";
  }
  return "draft";
}

export function DashboardApp(props: {
  readonly projectName: string;
  readonly actorName: string;
  readonly changes: readonly Change[];
  readonly releases: readonly StoredRelease[];
  readonly pointers?: readonly EnvironmentPointer[];
  readonly stagingRevision?: Revision;
  readonly onCreateChange: (input: {
    readonly name: string;
    readonly description?: string;
  }) => Promise<Change>;
  readonly onRollback?: (input: {
    readonly releaseId: string;
    readonly expectedPointerRevision: string;
  }) => Promise<void>;
  readonly onPublishStaging?: (expectedRevision: Revision) => Promise<void>;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [releaseOperation, setReleaseOperation] = useState<"idle" | "working" | "complete">("idle");
  const active = props.changes.filter((change) => change.status !== "archived");
  const needsReview = active.filter((change) =>
    ["in_review", "changes_requested"].includes(change.status),
  );
  const staged = active.filter((change) => change.status === "staging");
  const productionPointer = props.pointers?.find((pointer) => pointer.environment === "production");

  async function createChange(): Promise<void> {
    if (name.trim().length < 3 || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const change = await props.onCreateChange({
        name: name.trim(),
        ...(description.trim().length === 0 ? {} : { description: description.trim() }),
      });
      window.location.assign(`/cms/changes/${encodeURIComponent(change.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Change could not be created.");
      setCreating(false);
    }
  }

  return (
    <main className="cms-app cms-dashboard">
      <header className="cms-dashboard__header">
        <div>
          <span className="cms-login__eyebrow">Git-native visual CMS</span>
          <h1>{props.projectName}</h1>
          <p>Welcome back, {props.actorName}. Choose a Change or prepare a new one.</p>
        </div>
        <a href="/api/cms/auth/github/start">Switch GitHub account</a>
      </header>
      <div className="cms-dashboard__layout">
        <section className="cms-dashboard__main" aria-labelledby="changes-heading">
          <div className="cms-dashboard__section-heading">
            <div>
              <span>Editorial workspace</span>
              <h2 id="changes-heading">Changes</h2>
            </div>
            <StatusBadge tone="draft">{active.length} active</StatusBadge>
          </div>
          {active.length === 0 ? (
            <div className="cms-empty">
              <p className="cms-empty__eyebrow">A clean slate</p>
              <h2>Create the first Change</h2>
              <p>
                Group related page, collection, global and asset edits into one reviewable unit.
              </p>
            </div>
          ) : (
            <ul className="cms-change-list">
              {active.map((change) => (
                <li key={change.id}>
                  <a href={`/cms/changes/${encodeURIComponent(change.id)}`}>
                    <span className="cms-change-list__marker" aria-hidden="true" />
                    <span>
                      <strong>{change.name}</strong>
                      <small>{change.description ?? "No description"}</small>
                    </span>
                    <StatusBadge tone={statusTone(change.status)}>
                      {change.status.replaceAll("_", " ")}
                    </StatusBadge>
                    <time dateTime={change.updatedAt}>
                      {new Intl.DateTimeFormat("en", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(change.updatedAt))}
                    </time>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="cms-dashboard__aside">
          <section className="cms-new-change" aria-labelledby="new-change-heading">
            <span className="cms-login__eyebrow">New Change</span>
            <h2 id="new-change-heading">What are you preparing?</h2>
            <TextField label="Name" value={name} onChange={setName} />
            <TextField label="Description" value={description} onChange={setDescription} />
            {error !== undefined && <p role="alert">{error}</p>}
            <Button
              tone="primary"
              onPress={() => void createChange()}
              isDisabled={creating || name.trim().length < 3}
            >
              {creating ? "Creating…" : "Create Change"}
            </Button>
            <small>Starts from Production. Collaborators can be added during review.</small>
          </section>
          <section className="cms-dashboard__signals">
            <h2>Publication signals</h2>
            <dl>
              <div>
                <dt>Needs review</dt>
                <dd>{needsReview.length}</dd>
              </div>
              <div>
                <dt>On staging</dt>
                <dd>{staged.length}</dd>
              </div>
              <div>
                <dt>Recent releases</dt>
                <dd>{props.releases.length}</dd>
              </div>
            </dl>
            <ChangeRail current={staged.length > 0 ? "staging" : "change"} />
            {staged.length > 0 &&
              props.stagingRevision !== undefined &&
              props.onPublishStaging !== undefined && (
                <Button
                  className="cms-workflow-action"
                  onPress={() => {
                    if (
                      !window.confirm(
                        `Publish the ${String(staged.length)} staged Change(s) to Production?`,
                      )
                    ) {
                      return;
                    }
                    setReleaseOperation("working");
                    void props
                      .onPublishStaging?.(props.stagingRevision as Revision)
                      .then(() => {
                        setReleaseOperation("complete");
                        window.location.reload();
                      })
                      .catch(() => setReleaseOperation("idle"));
                  }}
                  isDisabled={releaseOperation === "working"}
                >
                  {releaseOperation === "working"
                    ? "Publishing…"
                    : `Publish ${String(staged.length)} staged`}
                </Button>
              )}
          </section>
          {props.releases.length > 0 && (
            <section className="cms-dashboard__releases">
              <h2>Release timeline</h2>
              <ul>
                {props.releases.map((release) => {
                  const environments =
                    props.pointers
                      ?.filter((pointer) => pointer.releaseId === release.id)
                      .map((pointer) => pointer.environment) ?? [];
                  return (
                    <li key={release.id}>
                      <span>
                        <strong>{release.id}</strong>
                        <small>{environments.join(" · ") || "immutable"}</small>
                      </span>
                      {props.onRollback !== undefined &&
                        productionPointer !== undefined &&
                        productionPointer.releaseId !== release.id && (
                          <Button
                            tone="danger"
                            onPress={() => {
                              if (
                                !window.confirm(
                                  `Restore Production to ${release.id}? The pointer changes immediately and an audit PR will be opened.`,
                                )
                              ) {
                                return;
                              }
                              setReleaseOperation("working");
                              void props
                                .onRollback?.({
                                  releaseId: release.id,
                                  expectedPointerRevision: productionPointer.revision,
                                })
                                .then(() => setReleaseOperation("complete"))
                                .catch(() => setReleaseOperation("idle"));
                            }}
                            isDisabled={releaseOperation === "working"}
                          >
                            Restore
                          </Button>
                        )}
                    </li>
                  );
                })}
              </ul>
              {releaseOperation === "complete" && (
                <p role="status">Production was restored atomically. Refresh to see the pointer.</p>
              )}
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

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

function documentGroup(type: string): "Pages" | "Posts" | "Collections" | "Globals" | "Settings" {
  if (type === "pages") return "Pages";
  if (type === "posts") return "Posts";
  if (type === "settings") return "Settings";
  if (["navigation", "pricing", "globals"].includes(type)) return "Globals";
  return "Collections";
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fieldLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

const DEFAULT_SECTION_TEMPLATES: readonly EditorSectionTemplate[] = [
  {
    type: "hero",
    label: "Hero",
    category: "Introduction",
    description: "A primary statement with supporting copy.",
    defaults: { heading: "A clear headline", description: "Add supporting context here." },
  },
  {
    type: "proof",
    label: "Proof",
    category: "Evidence",
    description: "A focused proof point or editorial callout.",
    defaults: { heading: "Why this matters", description: "Explain the supporting evidence." },
  },
  {
    type: "pricingGrid",
    label: "Pricing grid",
    category: "Commerce",
    description: "Plans sourced from the plans collection.",
    defaults: { heading: "Choose a plan", bindings: { plans: { collection: "plans" } } },
  },
];

function PortableRichTextEditor(props: {
  readonly label: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const namespace = useId();
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const editor = useMemo(
    () =>
      createEditor({
        namespace: `cms-rich-text-${namespace}`,
        onError(error) {
          throw error;
        },
      }),
    [namespace],
  );
  useEffect(() => {
    editor.setRootElement(root.current);
    const unregister = editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has("cms-external-value")) return;
      const serialized = editorState.toJSON() as unknown as Readonly<Record<string, unknown>>;
      onChange.current(serialized.root ?? serialized);
    });
    return () => {
      unregister();
      editor.setRootElement(null);
    };
  }, [editor]);
  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);
  useEffect(() => {
    try {
      const serialized = ("root" in props.value
        ? props.value
        : { root: props.value }) as unknown as SerializedEditorState;
      const source = JSON.stringify(serialized);
      if (JSON.stringify(editor.getEditorState().toJSON()) === source) return;
      editor.setEditorState(editor.parseEditorState(source), {
        tag: "cms-external-value",
      });
    } catch {
      // Invalid portable rich text remains visible as an empty, recoverable editor.
    }
  }, [editor, props.value]);
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.label}</span>
      <div
        ref={root}
        className="cms-rich-text"
        contentEditable={!props.disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={props.label}
        suppressContentEditableWarning
      />
    </label>
  );
}

function SortableSectionItem(props: {
  readonly section: EditableSection;
  readonly index: number;
  readonly count: number;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly onSelect: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const sortable = useSortable({ id: props.section.id, disabled: !props.editable });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <button
        type="button"
        className={props.selected ? "is-selected" : ""}
        onClick={props.onSelect}
      >
        <span className="cms-section-tree__index">{String(props.index + 1).padStart(2, "0")}</span>
        <span>
          <strong>{sectionLabel(props.section)}</strong>
          <small>{props.section.type}</small>
        </span>
      </button>
      {props.editable && (
        <span className="cms-section-tree__actions">
          <button
            type="button"
            className="cms-section-tree__drag"
            aria-label={`Reorder ${sectionLabel(props.section)}`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            ⠿
          </button>
          <button
            type="button"
            aria-label={`Move ${sectionLabel(props.section)} up`}
            onClick={() => props.onMove(-1)}
            disabled={props.index === 0}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${sectionLabel(props.section)} down`}
            onClick={() => props.onMove(1)}
            disabled={props.index === props.count - 1}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`Remove ${sectionLabel(props.section)}`}
            onClick={props.onRemove}
          >
            ×
          </button>
        </span>
      )}
    </li>
  );
}

function workflowAction(
  status: ChangeStatus,
):
  | { readonly action: "submit" | "approve" | "stage" | "publish"; readonly label: string }
  | undefined {
  switch (status) {
    case "draft":
    case "changes_requested":
      return { action: "submit", label: "Send for review" };
    case "in_review":
      return { action: "approve", label: "Approve Change" };
    case "approved":
      return { action: "stage", label: "Add to staging" };
    case "staging":
      return { action: "publish", label: "Publish live" };
    case "published":
    case "archived":
      return undefined;
  }
}

export function EditorApp(props: EditorAppProps): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [previewConnected, setPreviewConnected] = useState(false);
  const [patches, setPatches] = useState<readonly ContentPatch[]>([]);
  const [revision, setRevision] = useState(props.document.revision);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [changeStatus, setChangeStatus] = useState(props.change.status);
  const [pullRequestNumber, setPullRequestNumber] = useState(props.change.pullRequestNumber);
  const [workflowState, setWorkflowState] = useState<"idle" | "working" | "complete" | "error">(
    "idle",
  );
  const [workflowNote, setWorkflowNote] = useState<string | undefined>(undefined);
  const [documentCreatorOpen, setDocumentCreatorOpen] = useState(false);
  const [sectionLibraryOpen, setSectionLibraryOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [newDocumentType, setNewDocumentType] = useState("pages");
  const [documentOperation, setDocumentOperation] = useState<"idle" | "working" | "error">("idle");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewComments, setReviewComments] = useState(props.review?.comments ?? []);
  const [reviewOperation, setReviewOperation] = useState<"idle" | "working" | "error">("idle");
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [assets, setAssets] = useState(props.assets ?? []);
  const [assetFile, setAssetFile] = useState<File | undefined>();
  const [assetOperation, setAssetOperation] = useState<"idle" | "working" | "error">("idle");
  const [documentSearch, setDocumentSearch] = useState("");
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleAction, setScheduleAction] = useState<"publish" | "unpublish">("publish");
  const [scheduleNote, setScheduleNote] = useState<string | undefined>();
  const [translationJobId, setTranslationJobId] = useState<string | undefined>();
  const [translationJobNote, setTranslationJobNote] = useState<string | undefined>();
  const [translationJobBusy, setTranslationJobBusy] = useState(false);
  const [usageResults, setUsageResults] = useState<
    | "loading"
    | readonly {
        readonly sourceId: string;
        readonly sourcePath: string;
      }[]
    | undefined
  >();
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const iframe = useRef<HTMLIFrameElement>(null);
  const previewPort = useRef<MessagePort | undefined>(undefined);
  const previewDocumentRef = useRef<EditablePage>(
    props.previewDocument?.data ?? props.document.data,
  );
  const previewContentRef = useRef(props.contentDocuments);
  const incomingPatchRef = useRef<(patch: ContentPatch) => void>(() => undefined);
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
  previewDocumentRef.current = props.previewDocument?.data ?? document;
  previewContentRef.current = props.contentDocuments;
  const sections = document.sections ?? [];
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const documents = props.documents ?? [];
  const visibleDocuments = documents.filter((item) =>
    `${item.title} ${item.type}`.toLocaleLowerCase().includes(documentSearch.toLocaleLowerCase()),
  );
  const sectionTemplates = props.sectionTemplates ?? DEFAULT_SECTION_TEMPLATES;
  const selectedIndex = sections.findIndex((section) => section.id === selectedSectionId);
  const selectedSection = selectedIndex < 0 ? undefined : sections[selectedIndex];
  const semanticChanges = useMemo(
    () => (props.baseDocument === undefined ? [] : semanticDiff(props.baseDocument.data, document)),
    [document, props.baseDocument],
  );
  const conflicts = useMemo(
    () =>
      props.baseDocument === undefined || props.productionDocument === undefined
        ? []
        : mergeDocuments(props.baseDocument.data, document, props.productionDocument.data)
            .conflicts,
    [document, props.baseDocument, props.productionDocument],
  );
  const editable = changeStatus === "draft" || changeStatus === "changes_requested";
  const reactId = useId();
  const sessionId = useMemo(() => `cms-${reactId.replaceAll(":", "")}`, [reactId]);

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
      channel.port1.addEventListener("message", (message: MessageEvent<unknown>) => {
        const value = message.data;
        if (!isPreviewEditorMessage(value)) return;
        if (value.type === "preview.section-selected") {
          selectSection(value.payload.sectionId);
        }
        if (value.type === "preview.inline-patch") {
          const patch = value.payload.patch;
          if (typeof patch !== "object" || patch === null) return;
          const inline = patch as Readonly<Record<string, unknown>>;
          if (
            typeof inline.sectionId !== "string" ||
            typeof inline.field !== "string" ||
            typeof inline.value !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(inline.field)
          ) {
            return;
          }
          const index = sectionsRef.current.findIndex((section) => section.id === inline.sectionId);
          if (index < 0) return;
          incomingPatchRef.current({
            op: "set",
            path: contentPath(`/sections/${index}/${pointerSegment(inline.field)}`),
            value: inline.value,
            metadata: {
              id: globalThis.crypto.randomUUID(),
              actorId: props.change.ownerId,
              createdAt: new Date().toISOString(),
              source: "inline",
              description: `Inline edit ${inline.field}`,
            },
          });
        }
      });
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
          document: previewDocumentRef.current,
          content: previewContentRef.current,
          capabilities: ["patches", "selection", "inline-editing", "navigation"],
        },
      });
    };
    window.addEventListener("message", handleReady);
    return () => {
      window.removeEventListener("message", handleReady);
      previewPort.current?.close();
      previewPort.current = undefined;
    };
  }, [props.change.ownerId, props.previewUrl, selectSection, sessionId]);

  function addPatch(patch: ContentPatch): void {
    if (!editable) return;
    setPatches((current) => compactPatches([...current, patch]));
    setSaveState("dirty");
    previewPort.current?.postMessage({
      protocolVersion: "1.0.0",
      type: "editor.apply-patches",
      timestamp: new Date().toISOString(),
      payload: { revision, documentId: props.document.id, patches: [patch] },
    });
  }
  incomingPatchRef.current = addPatch;

  function patchMetadata(description: string): ContentPatch["metadata"] {
    return {
      id: globalThis.crypto.randomUUID(),
      actorId: props.change.ownerId,
      createdAt: new Date().toISOString(),
      source: "editor",
      description,
    };
  }

  function updateSectionField(name: string, value: unknown): void {
    if (selectedIndex < 0) return;
    addPatch({
      op: "set",
      path: contentPath(`/sections/${selectedIndex}/${pointerSegment(name)}`),
      value,
      metadata: patchMetadata(`Update ${fieldLabel(name)}`),
    });
  }

  function updateDocumentValue(path: string, value: unknown, description: string): void {
    addPatch({
      op: "set",
      path: contentPath(path),
      value,
      metadata: patchMetadata(description),
    });
  }

  function addSection(template: EditorSectionTemplate): void {
    const id = `sec_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    addPatch({
      op: "insert",
      path: contentPath("/sections"),
      index: sections.length,
      value: { id, type: template.type, version: 1, ...template.defaults },
      metadata: patchMetadata(`Add ${template.label} section`),
    });
    setSectionLibraryOpen(false);
    selectSection(id);
  }

  function moveSection(index: number, direction: -1 | 1): void {
    const to = index + direction;
    if (to < 0 || to >= sections.length) return;
    addPatch({
      op: "move",
      path: contentPath("/sections"),
      from: index,
      to,
      metadata: patchMetadata("Reorder sections"),
    });
  }

  function moveSectionTo(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) {
      return;
    }
    addPatch({
      op: "move",
      path: contentPath("/sections"),
      from,
      to,
      metadata: patchMetadata("Reorder sections"),
    });
  }

  function finishSectionDrag(event: DragEndEvent): void {
    if (event.over === null || event.active.id === event.over.id) return;
    moveSectionTo(
      sections.findIndex((section) => section.id === event.active.id),
      sections.findIndex((section) => section.id === event.over?.id),
    );
  }

  function removeSection(index: number): void {
    addPatch({
      op: "remove",
      path: contentPath("/sections"),
      index,
      metadata: patchMetadata("Remove section"),
    });
    selectSection(undefined);
  }

  function select(id: string): void {
    setDocumentSettingsOpen(false);
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

  async function advanceWorkflow(): Promise<void> {
    const next = workflowAction(changeStatus);
    if (
      next === undefined ||
      props.onWorkflowAction === undefined ||
      patches.length > 0 ||
      workflowState === "working"
    ) {
      return;
    }
    setWorkflowState("working");
    setWorkflowNote(undefined);
    try {
      const result = await props.onWorkflowAction({
        action: next.action,
        expectedRevision: revision,
        ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
      });
      setChangeStatus(result.status);
      setRevision(result.revision);
      if (result.pullRequestNumber !== undefined) {
        setPullRequestNumber(result.pullRequestNumber);
      }
      setWorkflowState("complete");
      setWorkflowNote(
        result.releaseId === undefined
          ? `${next.label} completed.`
          : `Published release ${result.releaseId}.`,
      );
    } catch (error) {
      setWorkflowState("error");
      setWorkflowNote(
        error instanceof Error
          ? error.message
          : "The workflow could not advance. Refresh and try again.",
      );
    }
  }

  async function createDocument(): Promise<void> {
    if (
      props.onCreateDocument === undefined ||
      newDocumentTitle.trim().length < 2 ||
      documentOperation === "working"
    ) {
      return;
    }
    setDocumentOperation("working");
    try {
      const created = await props.onCreateDocument({
        type: newDocumentType,
        title: newDocumentTitle.trim(),
        expectedRevision: revision,
      });
      props.onNavigateDocument?.(created.id, newDocumentType);
    } catch {
      setDocumentOperation("error");
    }
  }

  async function deleteDocument(): Promise<void> {
    if (
      props.onDeleteDocument === undefined ||
      documents.length <= 1 ||
      documentOperation === "working" ||
      !window.confirm(`Delete “${document.title ?? props.document.id}” from this Change?`)
    ) {
      return;
    }
    setDocumentOperation("working");
    try {
      await props.onDeleteDocument({
        documentId: props.document.id,
        expectedRevision: revision,
      });
      const next = documents.find((item) => item.id !== props.document.id);
      if (next !== undefined) props.onNavigateDocument?.(next.id, next.type);
    } catch {
      setDocumentOperation("error");
    }
  }

  async function addReviewComment(): Promise<void> {
    if (
      props.onAddReviewComment === undefined ||
      reviewDraft.trim().length === 0 ||
      reviewOperation === "working"
    ) {
      return;
    }
    setReviewOperation("working");
    try {
      const body = reviewDraft.trim();
      await props.onAddReviewComment(body);
      setReviewComments((current) => [
        ...current,
        {
          id: globalThis.crypto.randomUUID(),
          author: "You",
          body,
          createdAt: new Date().toISOString(),
        },
      ]);
      setReviewDraft("");
      setReviewOperation("idle");
    } catch {
      setReviewOperation("error");
    }
  }

  async function requestChanges(): Promise<void> {
    if (
      props.onRequestChanges === undefined ||
      reviewDraft.trim().length === 0 ||
      reviewOperation === "working"
    ) {
      return;
    }
    setReviewOperation("working");
    try {
      const result = await props.onRequestChanges({
        body: reviewDraft.trim(),
        expectedRevision: revision,
      });
      setChangeStatus(result.status);
      setRevision(result.revision);
      setReviewDraft("");
      setReviewOperation("idle");
    } catch {
      setReviewOperation("error");
    }
  }

  async function uploadAsset(): Promise<void> {
    if (
      assetFile === undefined ||
      props.onUploadAsset === undefined ||
      assetOperation === "working"
    ) {
      return;
    }
    setAssetOperation("working");
    try {
      const result = await props.onUploadAsset({ file: assetFile, expectedRevision: revision });
      setAssets((current) => [
        ...current.filter((asset) => asset.id !== result.asset.id),
        result.asset,
      ]);
      setRevision(result.revision);
      setAssetFile(undefined);
      setAssetOperation("idle");
    } catch {
      setAssetOperation("error");
    }
  }

  async function deleteAsset(id: Asset["id"]): Promise<void> {
    if (
      props.onDeleteAsset === undefined ||
      assetOperation === "working" ||
      !window.confirm("Delete this unused asset permanently?")
    ) {
      return;
    }
    setAssetOperation("working");
    try {
      const nextRevision = await props.onDeleteAsset({
        assetId: id,
        expectedRevision: revision,
      });
      setRevision(nextRevision);
      setAssets((current) => current.filter((asset) => asset.id !== id));
      setAssetOperation("idle");
    } catch {
      setAssetOperation("error");
    }
  }

  const nextWorkflowAction = workflowAction(changeStatus);

  return (
    <div
      className="cms-app cms-editor-shell"
      data-theme={theme}
      data-cms-hydrated={hydrated}
      data-cms-preview-connected={previewConnected}
    >
      <header className="cms-editor-topbar">
        <div className="cms-change-title">
          <a className="cms-change-title__mark" href="/cms" aria-label="Back to dashboard">
            C
          </a>
          <div>
            <strong>{props.change.name}</strong>
            <span>
              {props.locale ?? "en-US"} · {document.title ?? "Untitled page"}
            </span>
          </div>
        </div>
        <ChangeRail
          current={
            changeStatus === "published"
              ? "live"
              : changeStatus === "staging"
                ? "staging"
                : changeStatus === "in_review" || changeStatus === "approved"
                  ? "review"
                  : "change"
          }
        />
        <div className="cms-topbar-actions">
          <Button
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            onPress={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? "Dark" : "Light"}
          </Button>
          <Button onPress={toggleInspector}>
            {inspectorOpen ? "Hide inspector" : "Show inspector"}
          </Button>
          <Button
            onPress={() => setReviewOpen((current) => !current)}
            className={reviewOpen ? "is-active" : ""}
          >
            {reviewOpen ? "Close review" : `Review · ${semanticChanges.length}`}
          </Button>
          <Button
            tone="primary"
            onPress={() => void save()}
            isDisabled={hydrated && (!editable || patches.length === 0 || saveState === "saving")}
          >
            {saveState === "saving" ? "Saving…" : "Save changes"}
          </Button>
          {nextWorkflowAction !== undefined && props.onWorkflowAction !== undefined && (
            <Button
              className="cms-workflow-action"
              onPress={() => void advanceWorkflow()}
              isDisabled={patches.length > 0 || workflowState === "working"}
            >
              {workflowState === "working" ? "Working…" : nextWorkflowAction.label}
            </Button>
          )}
        </div>
      </header>

      <div className={`cms-editor-grid${inspectorOpen ? "" : " is-inspector-hidden"}`}>
        <nav className="cms-editor-navigation" aria-label="Content">
          <div className="cms-panel-heading">
            <span>Page structure</span>
            <StatusBadge tone={patches.length > 0 ? "review" : "draft"}>
              {patches.length > 0 ? `${patches.length} edits` : changeStatus.replaceAll("_", " ")}
            </StatusBadge>
          </div>
          <DndContext
            id={`cms-sections-${props.document.id}`}
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragEnd={finishSectionDrag}
          >
            <SortableContext
              items={sections.map((section) => section.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="cms-section-tree">
                {sections.map((section, index) => (
                  <SortableSectionItem
                    key={section.id}
                    section={section}
                    index={index}
                    count={sections.length}
                    selected={section.id === selectedSectionId}
                    editable={editable}
                    onSelect={() => select(section.id)}
                    onMove={(direction) => moveSection(index, direction)}
                    onRemove={() => removeSection(index)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <Button
            className="cms-add-section"
            isDisabled={!editable}
            onPress={() => setSectionLibraryOpen(true)}
          >
            Add section
          </Button>
          {sectionLibraryOpen && (
            <div className="cms-section-library" role="dialog" aria-labelledby="section-library">
              <div>
                <span className="cms-login__eyebrow">Section library</span>
                <button
                  type="button"
                  aria-label="Close section library"
                  onClick={() => setSectionLibraryOpen(false)}
                >
                  ×
                </button>
              </div>
              <h2 id="section-library">Build with registered sections</h2>
              <ul>
                {sectionTemplates.map((template) => (
                  <li key={template.type}>
                    <button type="button" onClick={() => addSection(template)}>
                      <span>{template.category}</span>
                      <strong>{template.label}</strong>
                      <small>{template.description}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="cms-navigation-groups">
            <label className="cms-content-search">
              <span className="cms-visually-hidden">Search content</span>
              <input
                type="search"
                placeholder="Search content…"
                value={documentSearch}
                onChange={(event) => setDocumentSearch(event.currentTarget.value)}
              />
            </label>
            {(["Pages", "Posts", "Collections", "Globals", "Settings"] as const).map((label) => {
              const items = visibleDocuments.filter((item) => documentGroup(item.type) === label);
              return (
                <details key={label} open={label === documentGroup(props.document.type)}>
                  <summary>
                    {label}
                    <span>{items.length}</span>
                  </summary>
                  {items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={item.id === props.document.id ? "is-current" : ""}
                      onClick={() => props.onNavigateDocument?.(item.id, item.type)}
                    >
                      {item.title}
                      <span>›</span>
                    </button>
                  ))}
                </details>
              );
            })}
            {props.onCreateDocument !== undefined && editable && (
              <button type="button" onClick={() => setDocumentCreatorOpen(true)}>
                Create content
                <span>＋</span>
              </button>
            )}
            <button type="button" onClick={() => setAssetLibraryOpen(true)}>
              Assets
              <span>{assets.length}</span>
            </button>
            <button
              type="button"
              className={documentSettingsOpen ? "is-current" : ""}
              onClick={() => {
                selectSection(undefined);
                setDocumentSettingsOpen(true);
              }}
            >
              SEO & localization
              <span>›</span>
            </button>
          </div>
          {documentCreatorOpen && (
            <div className="cms-document-creator" role="dialog" aria-labelledby="create-content">
              <div>
                <h2 id="create-content">Create content</h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setDocumentCreatorOpen(false)}
                >
                  ×
                </button>
              </div>
              <label>
                Type
                <select
                  value={newDocumentType}
                  onChange={(event) => setNewDocumentType(event.currentTarget.value)}
                >
                  <option value="pages">Page</option>
                  <option value="posts">Post</option>
                  <option value="plans">Plan collection entry</option>
                  <option value="navigation">Navigation global</option>
                  <option value="pricing">Pricing global</option>
                  <option value="settings">Settings</option>
                  <option value="reusable-blocks">Reusable block</option>
                </select>
              </label>
              <TextField label="Title" value={newDocumentTitle} onChange={setNewDocumentTitle} />
              {documentOperation === "error" && (
                <p role="alert">The document could not be created.</p>
              )}
              <Button
                tone="primary"
                onPress={() => void createDocument()}
                isDisabled={newDocumentTitle.trim().length < 2 || documentOperation === "working"}
              >
                {documentOperation === "working" ? "Creating…" : "Create"}
              </Button>
            </div>
          )}
          {props.onDeleteDocument !== undefined && documents.length > 1 && editable && (
            <Button
              className="cms-delete-document"
              tone="danger"
              onPress={() => void deleteDocument()}
              isDisabled={documentOperation === "working"}
            >
              Delete current
            </Button>
          )}
          {assetLibraryOpen && (
            <div className="cms-asset-library" role="dialog" aria-labelledby="asset-library">
              <header>
                <div>
                  <span className="cms-login__eyebrow">Content-addressed storage</span>
                  <h2 id="asset-library">Assets</h2>
                </div>
                <button
                  type="button"
                  aria-label="Close assets"
                  onClick={() => setAssetLibraryOpen(false)}
                >
                  ×
                </button>
              </header>
              {props.onUploadAsset !== undefined && editable && (
                <div className="cms-asset-upload">
                  <label>
                    Upload image or PDF
                    <input
                      type="file"
                      accept="image/avif,image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(event) => setAssetFile(event.currentTarget.files?.[0])}
                    />
                  </label>
                  <Button
                    tone="primary"
                    onPress={() => void uploadAsset()}
                    isDisabled={assetFile === undefined || assetOperation === "working"}
                  >
                    {assetOperation === "working" ? "Uploading…" : "Upload"}
                  </Button>
                  {assetOperation === "error" && (
                    <p role="alert">
                      The asset could not be changed. It may still be in use or fail validation.
                    </p>
                  )}
                </div>
              )}
              {assets.length === 0 ? (
                <p>No assets have been uploaded.</p>
              ) : (
                <ul>
                  {assets.map((asset) => (
                    <li key={asset.id}>
                      {asset.mimeType.startsWith("image/") ? (
                        <img src={asset.url} alt="" />
                      ) : (
                        <span className="cms-asset-file" aria-hidden="true">
                          PDF
                        </span>
                      )}
                      <span>
                        <strong>{asset.fileName}</strong>
                        <small>
                          {(asset.size / 1024).toFixed(1)} KB · {asset.checksum.slice(0, 12)}
                        </small>
                      </span>
                      <a href={asset.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                      {props.onDeleteAsset !== undefined && editable && (
                        <button
                          type="button"
                          aria-label={`Delete ${asset.fileName}`}
                          onClick={() => void deleteAsset(asset.id)}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
            {selectedSection === undefined && !documentSettingsOpen ? (
              <div className="cms-inspector-empty">
                <span>Select a section</span>
                <h2>Edit what readers see</h2>
                <p>Choose a section on the page or in the structure panel to edit its fields.</p>
              </div>
            ) : documentSettingsOpen ? (
              <>
                <div className="cms-panel-heading">
                  <div>
                    <span>Document settings</span>
                    <h2>SEO & localization</h2>
                  </div>
                  <StatusBadge tone="draft">{props.locale ?? "en-US"}</StatusBadge>
                </div>
                <div className="cms-inspector-fields">
                  <TextField
                    label="Content title"
                    value={document.title ?? ""}
                    isDisabled={!editable}
                    onChange={(value) =>
                      updateDocumentValue("/title", value, "Update document title")
                    }
                  />
                  {document.route !== undefined && (
                    <TextField
                      label="Route path"
                      value={document.route.path ?? ""}
                      isDisabled={!editable}
                      onChange={(value) =>
                        updateDocumentValue("/route/path", value, "Update route path")
                      }
                    />
                  )}
                  <TextField
                    label="Search title"
                    value={
                      typeof (document.seo as Readonly<Record<string, unknown>> | undefined)
                        ?.title === "string"
                        ? String(
                            (document.seo as Readonly<Record<string, unknown>> | undefined)?.title,
                          )
                        : ""
                    }
                    isDisabled={!editable}
                    onChange={(value) =>
                      updateDocumentValue(
                        "/seo",
                        {
                          ...((typeof document.seo === "object" && document.seo !== null
                            ? document.seo
                            : {}) as Readonly<Record<string, unknown>>),
                          title: value,
                        },
                        "Update SEO title",
                      )
                    }
                  />
                  <label className="cms-field">
                    <span className="cms-field__label">Localized fields (en-US / pl-PL)</span>
                    <textarea
                      className="cms-field__input cms-field__input--json"
                      defaultValue={JSON.stringify(
                        typeof document.locales === "object" && document.locales !== null
                          ? document.locales
                          : {
                              "en-US": { status: "approved", fields: {} },
                              "pl-PL": { status: "missing", fields: {} },
                            },
                        null,
                        2,
                      )}
                      disabled={!editable}
                      onBlur={(event) => {
                        try {
                          updateDocumentValue(
                            "/locales",
                            JSON.parse(event.currentTarget.value),
                            "Update localized fields",
                          );
                          event.currentTarget.setCustomValidity("");
                        } catch {
                          event.currentTarget.setCustomValidity("Enter valid locale JSON.");
                          event.currentTarget.reportValidity();
                        }
                      }}
                    />
                  </label>
                  <label className="cms-field">
                    <span className="cms-field__label">Redirects from previous paths</span>
                    <textarea
                      className="cms-field__input cms-field__input--json"
                      defaultValue={JSON.stringify(document.redirectFrom ?? [], null, 2)}
                      disabled={!editable}
                      onBlur={(event) => {
                        try {
                          updateDocumentValue(
                            "/redirectFrom",
                            JSON.parse(event.currentTarget.value),
                            "Update redirects",
                          );
                          event.currentTarget.setCustomValidity("");
                        } catch {
                          event.currentTarget.setCustomValidity("Enter a JSON list of paths.");
                          event.currentTarget.reportValidity();
                        }
                      }}
                    />
                  </label>
                  <div className="cms-translation-actions">
                    <a
                      className="cms-button"
                      href={`/api/cms/changes/${encodeURIComponent(props.change.id)}/documents/${encodeURIComponent(props.document.id)}/locales/pl-PL/xliff`}
                      download={`${props.document.id}.pl-PL.xlf`}
                    >
                      Export pl-PL XLIFF
                    </a>
                    {props.onImportTranslation !== undefined && editable && (
                      <label className="cms-button">
                        Import translated XLIFF
                        <input
                          className="cms-visually-hidden"
                          type="file"
                          accept=".xlf,.xliff,application/xliff+xml"
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (file === undefined) return;
                            void file.text().then(async (xliff) => {
                              try {
                                const nextRevision = await props.onImportTranslation?.({
                                  locale: "pl-PL",
                                  xliff,
                                  expectedRevision: revision,
                                });
                                if (nextRevision !== undefined) setRevision(nextRevision);
                              } catch {
                                setSaveState("error");
                              }
                            });
                          }}
                        />
                      </label>
                    )}
                    {props.onCreateTranslationJob !== undefined && editable && (
                      <button
                        className="cms-button"
                        type="button"
                        disabled={translationJobBusy}
                        onClick={() => {
                          const createJob = props.onCreateTranslationJob;
                          if (createJob === undefined) return;
                          setTranslationJobBusy(true);
                          setTranslationJobNote("Sending XLIFF to the translation provider…");
                          void createJob({
                            locale: "pl-PL",
                            expectedRevision: revision,
                          })
                            .then(({ jobId }) => {
                              setTranslationJobId(jobId);
                              setTranslationJobNote(`Translation job ${jobId} is queued.`);
                            })
                            .catch(() => setTranslationJobNote("Translation job could not start."))
                            .finally(() => setTranslationJobBusy(false));
                        }}
                      >
                        Send to translation provider
                      </button>
                    )}
                    {translationJobId !== undefined && props.onReadTranslationJob !== undefined && (
                      <button
                        className="cms-button"
                        type="button"
                        disabled={translationJobBusy}
                        onClick={() => {
                          setTranslationJobBusy(true);
                          void props
                            .onReadTranslationJob?.(translationJobId)
                            .then(async (job) => {
                              if (job.status === "complete") {
                                setTranslationJobNote("Translation complete. Importing XLIFF…");
                                const nextRevision = await props.onImportTranslation?.({
                                  locale: "pl-PL",
                                  xliff: job.xliff,
                                  expectedRevision: revision,
                                });
                                if (nextRevision !== undefined) setRevision(nextRevision);
                                setTranslationJobNote("Translation imported into this Change.");
                                return;
                              }
                              setTranslationJobNote(
                                job.status === "failed"
                                  ? `Translation failed: ${job.message}`
                                  : `Translation is ${job.status}.`,
                              );
                            })
                            .catch(() =>
                              setTranslationJobNote("Translation status could not be loaded."),
                            )
                            .finally(() => setTranslationJobBusy(false));
                        }}
                      >
                        Check translation status
                      </button>
                    )}
                  </div>
                  {translationJobNote !== undefined && (
                    <small className="cms-field__hint" role="status">
                      {translationJobNote}
                    </small>
                  )}
                  {props.onSchedule !== undefined && editable && (
                    <div className="cms-schedule-editor">
                      <span className="cms-field__label">Scheduling (UTC)</span>
                      <select
                        value={scheduleAction}
                        onChange={(event) =>
                          setScheduleAction(event.currentTarget.value as "publish" | "unpublish")
                        }
                      >
                        <option value="publish">Publish</option>
                        <option value="unpublish">Unpublish</option>
                      </select>
                      <input
                        type="datetime-local"
                        value={scheduleAt}
                        onChange={(event) => setScheduleAt(event.currentTarget.value)}
                      />
                      <Button
                        onPress={() => {
                          if (scheduleAt.length === 0) return;
                          void props
                            .onSchedule?.({
                              action: scheduleAction,
                              executeAt: new Date(scheduleAt).toISOString(),
                              expectedRevision: revision,
                            })
                            .then((result) => {
                              if (result === undefined) return;
                              setRevision(result.revision);
                              setScheduleNote(`Scheduled as ${result.scheduleId}.`);
                            })
                            .catch(() => setScheduleNote("The schedule could not be created."));
                        }}
                        isDisabled={scheduleAt.length === 0}
                      >
                        Schedule
                      </Button>
                      {scheduleNote !== undefined && <small>{scheduleNote}</small>}
                    </div>
                  )}
                  {props.onFindUsages !== undefined && (
                    <div className="cms-usage-results">
                      <Button
                        onPress={() => {
                          setUsageResults("loading");
                          void props
                            .onFindUsages?.()
                            .then((results) => setUsageResults(results ?? []))
                            .catch(() => setUsageResults([]));
                        }}
                        isDisabled={usageResults === "loading"}
                      >
                        {usageResults === "loading" ? "Finding usages…" : "Find usages"}
                      </Button>
                      {Array.isArray(usageResults) && (
                        <p>
                          {usageResults.length === 0
                            ? "No other content references this item."
                            : `${usageResults.length} reference(s): ${usageResults
                                .map((usage) => `${usage.sourceId}${usage.sourcePath}`)
                                .join(", ")}`}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : selectedSection !== undefined ? (
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
                  {Object.entries(selectedSection)
                    .filter(([name]) => !["id", "type", "version"].includes(name))
                    .map(([name, value]) => {
                      if (typeof value === "string") {
                        return (
                          <TextField
                            key={name}
                            label={fieldLabel(name)}
                            value={value}
                            isDisabled={!editable}
                            onChange={(next) => updateSectionField(name, next)}
                          />
                        );
                      }
                      if (typeof value === "number") {
                        return (
                          <label className="cms-field" key={name}>
                            <span className="cms-field__label">{fieldLabel(name)}</span>
                            <input
                              className="cms-field__input"
                              type="number"
                              value={value}
                              disabled={!editable}
                              onChange={(event) =>
                                updateSectionField(name, Number(event.currentTarget.value))
                              }
                            />
                          </label>
                        );
                      }
                      if (typeof value === "boolean") {
                        return (
                          <label className="cms-field cms-field--boolean" key={name}>
                            <input
                              type="checkbox"
                              checked={value}
                              disabled={!editable}
                              onChange={(event) =>
                                updateSectionField(name, event.currentTarget.checked)
                              }
                            />
                            <span>{fieldLabel(name)}</span>
                          </label>
                        );
                      }
                      if (
                        typeof value === "object" &&
                        value !== null &&
                        !Array.isArray(value) &&
                        (value as Readonly<Record<string, unknown>>).type === "root" &&
                        Array.isArray((value as Readonly<Record<string, unknown>>).children)
                      ) {
                        return (
                          <PortableRichTextEditor
                            key={name}
                            label={fieldLabel(name)}
                            value={value as Readonly<Record<string, unknown>>}
                            disabled={!editable}
                            onChange={(next) => updateSectionField(name, next)}
                          />
                        );
                      }
                      return (
                        <label className="cms-field" key={name}>
                          <span className="cms-field__label">{fieldLabel(name)}</span>
                          <textarea
                            className="cms-field__input cms-field__input--json"
                            defaultValue={JSON.stringify(value, null, 2)}
                            disabled={!editable}
                            onBlur={(event) => {
                              try {
                                updateSectionField(name, JSON.parse(event.currentTarget.value));
                                event.currentTarget.setCustomValidity("");
                              } catch {
                                event.currentTarget.setCustomValidity("Enter valid JSON.");
                                event.currentTarget.reportValidity();
                              }
                            }}
                          />
                        </label>
                      );
                    })}
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
            ) : null}
          </aside>
        )}
      </div>
      {reviewOpen && (
        <aside className="cms-review-panel" aria-label="Review Change">
          <header>
            <div>
              <span className="cms-login__eyebrow">Review workspace</span>
              <h2>{summarizeDiff(semanticChanges)}</h2>
            </div>
            <button type="button" aria-label="Close review" onClick={() => setReviewOpen(false)}>
              ×
            </button>
          </header>
          <div className="cms-review-panel__visual">
            <div>
              <h3>Visual comparison</h3>
              <p>Live baseline</p>
            </div>
            <iframe
              src={props.productionUrl ?? "/"}
              title="Live production baseline"
              loading="lazy"
              sandbox="allow-same-origin"
            />
            <p>
              Compare this baseline with the active Change canvas to the left. Both are rendered by
              the real site.
            </p>
          </div>
          <div className="cms-review-panel__checks">
            <h3>Checks</h3>
            {(props.review?.checks.length ?? 0) === 0 ? (
              <p>No blocking checks reported.</p>
            ) : (
              <ul>
                {props.review?.checks.map((check) => (
                  <li key={check.name}>
                    <span
                      className={
                        check.status === "completed" && check.conclusion === "success"
                          ? "is-passing"
                          : "is-pending"
                      }
                      aria-hidden="true"
                    />
                    <strong>{check.name}</strong>
                    <small>{check.conclusion ?? check.status}</small>
                  </li>
                ))}
              </ul>
            )}
            {conflicts.length > 0 && (
              <div className="cms-review-panel__conflicts" role="alert">
                <strong>{conflicts.length} semantic conflict(s)</strong>
                <p>Production and this Change edited the same fields. Resolve before staging.</p>
                <ul>
                  {conflicts.map((conflict) => (
                    <li key={conflict.path}>{conflict.path}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="cms-review-panel__diff">
            <h3>Field diff</h3>
            {semanticChanges.length === 0 ? (
              <p>No content differences in this document.</p>
            ) : (
              <ol>
                {semanticChanges.map((change) => (
                  <li key={`${change.kind}:${change.path}`}>
                    <StatusBadge
                      tone={
                        change.kind === "removed"
                          ? "error"
                          : change.kind === "added"
                            ? "live"
                            : "review"
                      }
                    >
                      {change.kind}
                    </StatusBadge>
                    <code>{change.path || "/"}</code>
                    {change.before !== undefined && <del>{JSON.stringify(change.before)}</del>}
                    {change.after !== undefined && <ins>{JSON.stringify(change.after)}</ins>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="cms-review-panel__comments">
            <h3>Conversation</h3>
            {reviewComments.length === 0 ? (
              <p>No review comments yet.</p>
            ) : (
              <ol>
                {reviewComments.map((comment) => (
                  <li key={comment.id}>
                    <strong>@{comment.author}</strong>
                    <p>{comment.body}</p>
                    <time dateTime={comment.createdAt}>
                      {new Intl.DateTimeFormat("en", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(comment.createdAt))}
                    </time>
                  </li>
                ))}
              </ol>
            )}
            {props.onAddReviewComment !== undefined && (
              <>
                <label>
                  Review note
                  <textarea
                    value={reviewDraft}
                    onChange={(event) => setReviewDraft(event.currentTarget.value)}
                    placeholder="Describe what should change or why this is ready."
                  />
                </label>
                {reviewOperation === "error" && (
                  <p role="alert">The review action could not be saved.</p>
                )}
                <div>
                  <Button
                    onPress={() => void addReviewComment()}
                    isDisabled={reviewDraft.trim().length === 0 || reviewOperation === "working"}
                  >
                    Add comment
                  </Button>
                  {props.onRequestChanges !== undefined && (
                    <Button
                      tone="danger"
                      onPress={() => void requestChanges()}
                      isDisabled={reviewDraft.trim().length === 0 || reviewOperation === "working"}
                    >
                      Request changes
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      )}
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
        <span className={`cms-workflow-note cms-workflow-note--${workflowState}`}>
          {workflowNote ?? `Status: ${changeStatus.replaceAll("_", " ")}`}
        </span>
        <span>{previewConnected ? "Preview connected" : "Connecting preview…"}</span>
      </footer>
    </div>
  );
}
