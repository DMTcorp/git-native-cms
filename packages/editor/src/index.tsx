"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { create } from "zustand";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Controller, useForm } from "react-hook-form";
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
  AssetReference,
  AuditEvent,
  ChangeConflict,
  ChangeConflictResolution,
  ContentScheduleAction,
  DocumentSummary,
  EnvironmentPointer,
  ReviewAssignment,
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
import { semanticDiff, summarizeDiff, type SemanticChange } from "@git-native-cms/diff";
import { isPreviewEditorMessage, PREVIEW_CHANNEL } from "@git-native-cms/protocol/preview";
import { Button, ChangeRail, Splitter, StatusBadge, TextField } from "@git-native-cms/editor-ui";
import {
  SchemaFieldEditor,
  type EditorFieldManifest,
  type EditorFieldRegistry,
} from "./field-editor.js";
import { formatCmsTimestamp } from "./time.js";

export {
  CmsEditorRouter,
  createEditorRouter,
  EDITOR_ROUTE_MAP,
  type EditorRouterComponents,
} from "./router.js";
export { CmsOverviewApp, type CmsOverviewAppProps, type CmsOverviewView } from "./overview.js";
export { semanticDiffInWorker, terminateEditorWorker } from "./worker.js";
export {
  SchemaFieldEditor,
  createEditorFieldRegistry,
  defaultEditorFieldRegistry,
  type EditorBlockManifest,
  type EditorFieldManifest,
  type EditorFieldRegistry,
  type FieldEditorRenderer,
  type FieldEditorRenderProps,
} from "./field-editor.js";
import { semanticDiffInWorker } from "./worker.js";

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
  readonly usageGuidance?: string;
  readonly thumbnailUrl?: string;
  readonly variants?: readonly { readonly value: string; readonly label: string }[];
  readonly variantField?: string;
  readonly constraints?: {
    readonly allowedParents?: readonly string[];
    readonly maxInstances?: number;
    readonly recommendedPosition?: "first" | "last";
  };
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly fields?: readonly EditorFieldManifest[];
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
  readonly documentFields?: readonly EditorFieldManifest[];
  readonly sectionTemplates?: readonly EditorSectionTemplate[];
  readonly fieldEditorRegistry?: EditorFieldRegistry;
  readonly baseDocument?: ContentDocument<EditablePage>;
  readonly productionDocument?: ContentDocument<EditablePage>;
  readonly conflicts?: readonly ChangeConflict[];
  readonly review?: {
    readonly comments: readonly ReviewComment[];
    readonly checks: readonly ReviewCheck[];
    readonly assignment: ReviewAssignment;
    readonly timeline: readonly AuditEvent[];
    readonly summary: {
      readonly changedDocumentIds: readonly string[];
      readonly affectedUsages: number;
      readonly warnings: number;
    };
  };
  readonly onAddReviewComment?: (body: string, path?: string) => Promise<void>;
  readonly onResolveReviewComment?: (input: {
    readonly commentId: string;
    readonly resolved: boolean;
  }) => Promise<void>;
  readonly onAssignReviewers?: (input: ReviewAssignment) => Promise<void>;
  readonly onRequestChanges?: (input: {
    readonly body: string;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly status: ChangeStatus; readonly revision: Revision }>;
  readonly onResolveConflicts?: (input: {
    readonly expectedRevision: Revision;
    readonly resolutions: readonly ChangeConflictResolution[];
  }) => Promise<{ readonly status: ChangeStatus; readonly revision: Revision }>;
  readonly assets?: readonly Asset[];
  readonly onUploadAsset?: (input: {
    readonly file: File;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly asset: Asset; readonly revision: Revision }>;
  readonly onUpdateAsset?: (input: {
    readonly assetId: Asset["id"];
    readonly altText: string | null;
    readonly focalPoint: { readonly x: number; readonly y: number } | null;
    readonly expectedRevision: Revision;
  }) => Promise<{ readonly asset: Asset; readonly revision: Revision }>;
  readonly onDeleteAsset?: (input: {
    readonly assetId: Asset["id"];
    readonly expectedRevision: Revision;
  }) => Promise<Revision>;
  readonly onFindAssetUsages?: (assetId: Asset["id"]) => Promise<readonly string[]>;
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
    readonly action: ContentScheduleAction;
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

export interface DashboardAppProps {
  readonly projectName: string;
  readonly actorName: string;
  readonly changes: readonly Change[];
  readonly releases: readonly StoredRelease[];
  readonly pointers?: readonly EnvironmentPointer[];
  readonly stagingRevision?: Revision;
  readonly onCreateChange: (input: {
    readonly name: string;
    readonly description?: string;
    readonly baseBranch?: string;
    readonly collaborators?: readonly string[];
    readonly targetDate?: string;
    readonly emergency?: boolean;
  }) => Promise<Change>;
  readonly onRollback?: (input: {
    readonly releaseId: string;
    readonly expectedPointerRevision: string;
  }) => Promise<void>;
  readonly onPublishStaging?: (expectedRevision: Revision) => Promise<void>;
}

interface NewChangeForm {
  readonly name: string;
  readonly description: string;
  readonly baseBranch: "main" | "staging";
  readonly collaborators: string;
  readonly targetDate: string;
  readonly emergency: boolean;
}

export function DashboardApp(props: DashboardAppProps): ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: 0 },
          queries: { staleTime: 15_000, retry: 1 },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <DashboardContent {...props} />
    </QueryClientProvider>
  );
}

function DashboardContent(props: DashboardAppProps): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  const { control, getValues, watch } = useForm<NewChangeForm>({
    defaultValues: {
      name: "",
      description: "",
      baseBranch: "main",
      collaborators: "",
      targetDate: "",
      emergency: false,
    },
    mode: "onChange",
  });
  const name = watch("name");
  const [releaseOperation, setReleaseOperation] = useState<"idle" | "working" | "complete">("idle");
  const active = props.changes.filter((change) => change.status !== "archived");
  const needsReview = active.filter((change) =>
    ["in_review", "changes_requested"].includes(change.status),
  );
  const staged = active.filter((change) => change.status === "staging");
  const productionPointer = props.pointers?.find((pointer) => pointer.environment === "production");

  useEffect(() => {
    setHydrated(true);
  }, []);

  const createChangeMutation = useMutation({
    mutationFn: props.onCreateChange,
    onSuccess(change) {
      window.location.assign(`/cms/changes/${encodeURIComponent(change.id)}`);
    },
  });

  function createChange(): void {
    const values = getValues();
    if (values.name.trim().length < 3 || createChangeMutation.isPending) return;
    createChangeMutation.mutate({
      name: values.name.trim(),
      ...(values.description.trim().length === 0 ? {} : { description: values.description.trim() }),
      ...(values.baseBranch === "main" ? {} : { baseBranch: values.baseBranch }),
      ...(values.collaborators.trim().length === 0
        ? {}
        : {
            collaborators: values.collaborators
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          }),
      ...(values.targetDate === "" ? {} : { targetDate: values.targetDate }),
      ...(values.emergency ? { emergency: true } : {}),
    });
  }

  return (
    <main className="cms-app cms-dashboard" data-cms-hydrated={hydrated}>
      <header className="cms-dashboard__header">
        <div>
          <span className="cms-login__eyebrow">Git-native visual CMS</span>
          <h1>{props.projectName}</h1>
          <p>Welcome back, {props.actorName}. Choose a Change or prepare a new one.</p>
        </div>
        <nav aria-label="CMS sections">
          <a href="/cms/changes">Changes</a>
          <a href="/cms/staging">Staging</a>
          <a href="/cms/releases">Releases</a>
          <a href="/cms/assets">Assets</a>
          <a href="/cms/team">Team</a>
          <a href="/cms/settings">Settings</a>
          <a href="/api/cms/auth/github/start">Switch account</a>
        </nav>
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
                      {change.emergency === true && <small>Emergency Change</small>}
                    </span>
                    <StatusBadge tone={statusTone(change.status)}>
                      {change.status.replaceAll("_", " ")}
                    </StatusBadge>
                    <time dateTime={change.updatedAt}>{formatCmsTimestamp(change.updatedAt)}</time>
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
            <Controller
              name="name"
              control={control}
              rules={{ required: true, minLength: 3 }}
              render={({ field }) => (
                <TextField label="Name" value={field.value} onChange={field.onChange} />
              )}
            />
            <Controller
              name="description"
              control={control}
              render={({ field }) => (
                <TextField label="Description" value={field.value} onChange={field.onChange} />
              )}
            />
            <Controller
              name="baseBranch"
              control={control}
              render={({ field }) => (
                <label className="cms-field">
                  <span className="cms-field__label">Base</span>
                  <select
                    className="cms-field__input"
                    value={field.value}
                    disabled={watch("emergency")}
                    onChange={field.onChange}
                  >
                    <option value="main">Production</option>
                    <option value="staging">Staging</option>
                  </select>
                </label>
              )}
            />
            <Controller
              name="collaborators"
              control={control}
              render={({ field }) => (
                <TextField label="Collaborators" value={field.value} onChange={field.onChange} />
              )}
            />
            <small>GitHub users or team:slug, separated by commas.</small>
            <Controller
              name="targetDate"
              control={control}
              render={({ field }) => (
                <label className="cms-field">
                  <span className="cms-field__label">Target date (optional)</span>
                  <input
                    className="cms-field__input"
                    type="date"
                    value={field.value}
                    onChange={field.onChange}
                  />
                </label>
              )}
            />
            <Controller
              name="emergency"
              control={control}
              render={({ field }) => (
                <label className="cms-emergency-toggle">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(event) => field.onChange(event.currentTarget.checked)}
                  />
                  <span>
                    <strong>Emergency Change</strong>
                    <small>Review directly into Production, then forward-sync Staging.</small>
                  </span>
                </label>
              )}
            />
            {createChangeMutation.error !== null && (
              <p role="alert">
                {createChangeMutation.error instanceof Error
                  ? createChangeMutation.error.message
                  : "The Change could not be created."}
              </p>
            )}
            <Button
              tone="primary"
              onPress={createChange}
              isDisabled={createChangeMutation.isPending || name.trim().length < 3}
            >
              {createChangeMutation.isPending ? "Creating…" : "Create Change"}
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

function DocumentButtons(props: {
  readonly items: readonly DocumentSummary[];
  readonly currentId: string;
  readonly onNavigate?: (documentId: string, type: string) => void;
}): ReactElement {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 38,
    overscan: 8,
  });
  if (props.items.length <= 50) {
    return (
      <>
        {props.items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={item.id === props.currentId ? "is-current" : ""}
            onClick={() => props.onNavigate?.(item.id, item.type)}
          >
            {item.title}
            <span>›</span>
          </button>
        ))}
      </>
    );
  }
  return (
    <div
      ref={parent}
      className="cms-virtual-documents"
      style={{ height: Math.min(380, props.items.length * 38) }}
      aria-label={`${String(props.items.length)} content items`}
    >
      <div className="cms-virtual-documents__track" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = props.items[row.index];
          if (item === undefined) return null;
          return (
            <button
              type="button"
              key={item.id}
              className={item.id === props.currentId ? "is-current" : ""}
              style={{ transform: `translateY(${String(row.start)}px)` }}
              onClick={() => props.onNavigate?.(item.id, item.type)}
            >
              {item.title}
              <span>›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function collectAssetIds(value: unknown, ids = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, ids);
    return ids;
  }
  if (typeof value !== "object" || value === null) return ids;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.id === "string" && record.id.startsWith("ast_")) ids.add(record.id);
  for (const nested of Object.values(record)) collectAssetIds(nested, ids);
  return ids;
}

function fieldLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

const RESERVED_DOCUMENT_FIELDS = new Set([
  "title",
  "route",
  "sections",
  "seo",
  "locales",
  "redirectFrom",
]);

export function inferEditorFieldManifest(
  name: string,
  value: unknown,
  depth = 0,
): EditorFieldManifest {
  const common = { name, label: fieldLabel(name) };
  if (depth >= 5) return { ...common, kind: "json" };
  if (typeof value === "string") {
    if (/slug$/iu.test(name)) return { ...common, kind: "slug" };
    if (/(?:At|Date|Time)$/u.test(name) && !Number.isNaN(Date.parse(value))) {
      return { ...common, kind: "datetime" };
    }
    return { ...common, kind: "text" };
  }
  if (typeof value === "number") return { ...common, kind: "number" };
  if (typeof value === "boolean") return { ...common, kind: "boolean" };
  if (Array.isArray(value)) {
    const values: readonly unknown[] = value;
    const example = values.find((item) => item !== null && item !== undefined);
    return {
      ...common,
      kind: "list",
      of:
        example === undefined
          ? { name: "item", label: "Item", kind: "json" }
          : inferEditorFieldManifest("item", example, depth + 1),
    };
  }
  if (typeof value === "object" && value !== null) {
    if (assetReference(value) !== undefined) return { ...common, kind: "asset" };
    const record = value as Readonly<Record<string, unknown>>;
    if (record.type === "root" && Array.isArray(record.children)) {
      return { ...common, kind: "rich-text" };
    }
    return {
      ...common,
      kind: "object",
      fields: Object.entries(record).map(([nestedName, nestedValue]) =>
        inferEditorFieldManifest(nestedName, nestedValue, depth + 1),
      ),
    };
  }
  return { ...common, kind: "json" };
}

type EditorAssetPickerTarget =
  | {
      readonly scope: "section";
      readonly sectionId: string;
      readonly field: EditorFieldManifest;
      readonly path: readonly string[];
    }
  | {
      readonly scope: "document";
      readonly field: EditorFieldManifest;
      readonly path: readonly string[];
    };

function assetReference(value: unknown): AssetReference | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.id !== "string" ||
    !record.id.startsWith("ast_") ||
    typeof record.fileName !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.url !== "string"
  ) {
    return undefined;
  }
  return {
    id: record.id as AssetReference["id"],
    fileName: record.fileName,
    mimeType: record.mimeType,
    url: record.url,
    ...(typeof record.altText === "string" ? { altText: record.altText } : {}),
  };
}

function assetMatchesAccept(asset: Asset, accept: readonly string[] | undefined): boolean {
  if (accept === undefined || accept.length === 0) return true;
  const extension = `.${asset.fileName.split(".").at(-1)?.toLocaleLowerCase() ?? ""}`;
  return accept.some((value) => {
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized.endsWith("/*")) {
      return asset.mimeType.toLocaleLowerCase().startsWith(normalized.slice(0, -1));
    }
    return normalized.startsWith(".")
      ? extension === normalized
      : asset.mimeType.toLocaleLowerCase() === normalized;
  });
}

function editorFieldEntries(
  section: EditableSection,
  template: EditorSectionTemplate | undefined,
): readonly [string, unknown][] {
  const names = new Set([
    ...(template?.fields?.map((field) => field.name) ?? []),
    ...Object.keys(section).filter((name) => !["id", "type", "version"].includes(name)),
  ]);
  return [...names].map((name) => [name, section[name]]);
}

const DEFAULT_SECTION_TEMPLATES: readonly EditorSectionTemplate[] = [
  {
    type: "hero",
    label: "Hero",
    category: "Introduction",
    description: "A primary statement with supporting copy.",
    defaults: {
      heading: "A clear headline",
      description: "Add supporting context here.",
      media: null,
    },
    fields: [
      { name: "heading", kind: "text", label: "Heading", required: true },
      { name: "description", kind: "text", label: "Description" },
      {
        name: "media",
        kind: "asset",
        label: "Hero media",
        description: "Choose an image from the project asset storage.",
        accept: ["image/*"],
      },
    ],
  },
  {
    type: "proof",
    label: "Proof",
    category: "Evidence",
    description: "A focused proof point or editorial callout.",
    defaults: { heading: "Why this matters", description: "Explain the supporting evidence." },
    fields: [
      { name: "heading", kind: "text", label: "Heading", required: true },
      { name: "description", kind: "text", label: "Description" },
    ],
  },
  {
    type: "pricingGrid",
    label: "Pricing grid",
    category: "Commerce",
    description: "Plans sourced from the plans collection.",
    defaults: { heading: "Choose a plan", bindings: { plans: { collection: "plans" } } },
    fields: [
      { name: "heading", kind: "text", label: "Heading", required: true },
      { name: "bindings", kind: "json", label: "Bindings" },
    ],
  },
];

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
  emergency = false,
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
      return {
        action: "stage",
        label: emergency ? "Publish Emergency Change" : "Add to staging",
      };
    case "staging":
      return { action: "publish", label: "Publish live" };
    case "published":
    case "archived":
      return undefined;
  }
}

function conflictKey(conflict: Pick<ChangeConflict, "documentId" | "path">): string {
  return `${conflict.documentId}:${conflict.path}`;
}

function conflictValue(value: unknown): string {
  if (value === undefined) return "Removed";
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
  } catch {
    return "Unserializable value";
  }
}

export function EditorApp(props: EditorAppProps): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [navigationWidth, setNavigationWidth] = useState(248);
  const [inspectorWidth, setInspectorWidth] = useState(324);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewContext, setPreviewContext] = useState({
    locale: props.locale ?? "en-US",
    market: "default",
    audience: "anonymous",
    at: "",
  });
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
  const [sectionSearch, setSectionSearch] = useState("");
  const [sectionFavorites, setSectionFavorites] = useState<readonly string[]>([]);
  const [recentSections, setRecentSections] = useState<readonly string[]>([]);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [newDocumentType, setNewDocumentType] = useState("pages");
  const [documentOperation, setDocumentOperation] = useState<"idle" | "working" | "error">("idle");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewScreenshots, setReviewScreenshots] = useState<
    Partial<Record<EditorUiState["viewport"], string>>
  >({});
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewAttachSelection, setReviewAttachSelection] = useState(true);
  const [reviewComments, setReviewComments] = useState(props.review?.comments ?? []);
  const [reviewAssignment, setReviewAssignment] = useState<ReviewAssignment>(
    props.review?.assignment ?? { users: [], teams: [] },
  );
  const [reviewerUsers, setReviewerUsers] = useState(
    (props.review?.assignment.users ?? []).join(", "),
  );
  const [reviewerTeams, setReviewerTeams] = useState(
    (props.review?.assignment.teams ?? []).join(", "),
  );
  const [reviewOperation, setReviewOperation] = useState<"idle" | "working" | "error">("idle");
  const [conflictChoices, setConflictChoices] = useState<
    Readonly<Record<string, ChangeConflictResolution["choice"]>>
  >({});
  const [conflictOperation, setConflictOperation] = useState<
    "idle" | "working" | "complete" | "error"
  >("idle");
  const [conflictNote, setConflictNote] = useState<string | undefined>();
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [assetPickerTarget, setAssetPickerTarget] = useState<EditorAssetPickerTarget | undefined>();
  const [assetSearch, setAssetSearch] = useState("");
  const [assetLimit, setAssetLimit] = useState(50);
  const [assets, setAssets] = useState(props.assets ?? []);
  const [assetFile, setAssetFile] = useState<File | undefined>();
  const [assetOperation, setAssetOperation] = useState<"idle" | "working" | "error">("idle");
  const [assetUsage, setAssetUsage] = useState<
    | { readonly id: Asset["id"]; readonly state: "loading" }
    | { readonly id: Asset["id"]; readonly state: "complete"; readonly paths: readonly string[] }
    | undefined
  >();
  const [documentSearch, setDocumentSearch] = useState("");
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleAction, setScheduleAction] = useState<ContentScheduleAction>("publish");
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
  const documentFieldEntries = useMemo(() => {
    const configured = new Map(
      (props.documentFields ?? []).map((field) => [field.name, field] as const),
    );
    const entries = Object.entries(document).filter(
      ([name]) => !RESERVED_DOCUMENT_FIELDS.has(name),
    );
    const seen = new Set(entries.map(([name]) => name));
    return [
      ...(props.documentFields ?? [])
        .filter((field) => !RESERVED_DOCUMENT_FIELDS.has(field.name))
        .map((field) => [field, document[field.name]] as const),
      ...entries
        .filter(([name]) => !configured.has(name))
        .map(([name, value]) => [inferEditorFieldManifest(name, value), value] as const),
    ].filter(([field]) => seen.has(field.name) || configured.has(field.name));
  }, [document, props.documentFields]);
  previewDocumentRef.current = props.previewDocument?.data ?? document;
  previewContentRef.current = props.contentDocuments;
  const sections = document.sections ?? [];
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const documents = props.documents ?? [];
  const visibleDocuments = documents.filter((item) =>
    `${item.title} ${item.type}`.toLocaleLowerCase().includes(documentSearch.toLocaleLowerCase()),
  );
  const reusableDocuments = (props.contentDocuments ?? []).filter(
    (candidate) => candidate.type === "reusable-blocks",
  );
  const configuredSectionTemplates = props.sectionTemplates ?? DEFAULT_SECTION_TEMPLATES;
  const firstReusableData =
    reusableDocuments[0] !== undefined &&
    typeof reusableDocuments[0].data === "object" &&
    reusableDocuments[0].data !== null &&
    !Array.isArray(reusableDocuments[0].data)
      ? (reusableDocuments[0].data as Readonly<Record<string, unknown>>)
      : {};
  const firstReusableSlug =
    typeof firstReusableData.slug === "string" ? firstReusableData.slug : reusableDocuments[0]?.id;
  const sectionTemplates =
    reusableDocuments.length === 0 ||
    configuredSectionTemplates.some((template) => template.type === "reference")
      ? configuredSectionTemplates
      : [
          ...configuredSectionTemplates,
          {
            type: "reference",
            label: "Reusable block",
            category: "Reusable",
            description: "Connect this page to a centrally managed group of sections.",
            usageGuidance:
              "Use a reusable block for content that must stay synchronized across many pages.",
            defaults: {
              ...(firstReusableSlug === undefined
                ? {}
                : { ref: `reusable-blocks/${firstReusableSlug}` }),
              overrides: {},
            },
            fields: [
              {
                name: "overrides",
                kind: "json",
                label: "Instance overrides",
                description: "Values here affect only this page instance.",
              },
            ],
          } satisfies EditorSectionTemplate,
        ];
  const visibleSectionTemplates = useMemo(() => {
    const query = sectionSearch.trim().toLocaleLowerCase();
    const rank = (template: EditorSectionTemplate): number => {
      const favorite = sectionFavorites.includes(template.type) ? 0 : 1;
      const recent = recentSections.indexOf(template.type);
      return favorite * 10_000 + (recent < 0 ? 1_000 : recent);
    };
    return [...sectionTemplates]
      .filter(
        (template) =>
          query.length === 0 ||
          `${template.label} ${template.category} ${template.description} ${template.usageGuidance ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .sort(
        (left, right) =>
          rank(left) - rank(right) ||
          left.category.localeCompare(right.category) ||
          left.label.localeCompare(right.label),
      );
  }, [recentSections, sectionFavorites, sectionSearch, sectionTemplates]);
  const selectedIndex = sections.findIndex((section) => section.id === selectedSectionId);
  const selectedSection = selectedIndex < 0 ? undefined : sections[selectedIndex];
  const selectedTemplate = sectionTemplates.find(
    (template) => template.type === selectedSection?.type,
  );
  const selectedReusableReference =
    selectedSection?.type === "reference" && typeof selectedSection.ref === "string"
      ? selectedSection.ref
      : undefined;
  const selectedReusableDocument =
    selectedReusableReference === undefined
      ? undefined
      : reusableDocuments.find((candidate) => {
          const data =
            typeof candidate.data === "object" &&
            candidate.data !== null &&
            !Array.isArray(candidate.data)
              ? (candidate.data as Readonly<Record<string, unknown>>)
              : {};
          const slug = selectedReusableReference.replace(/^reusable-blocks\//u, "");
          return (
            candidate.id === selectedReusableReference ||
            candidate.id === slug ||
            data.slug === slug ||
            data.path === selectedReusableReference
          );
        });
  const filteredAssets = useMemo(() => {
    const query = assetSearch.trim().toLocaleLowerCase();
    return [...assets]
      .filter((asset) => assetMatchesAccept(asset, assetPickerTarget?.field.accept))
      .filter(
        (asset) =>
          query.length === 0 ||
          `${asset.fileName} ${asset.mimeType} ${asset.checksum} ${asset.altText ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  }, [assetPickerTarget?.field.accept, assetSearch, assets]);
  const visibleAssets = filteredAssets.slice(0, assetLimit);
  const [semanticChanges, setSemanticChanges] = useState<readonly SemanticChange[]>(() =>
    props.baseDocument === undefined ? [] : semanticDiff(props.baseDocument.data, document),
  );
  const conflicts = useMemo(
    () =>
      props.conflicts ??
      (props.baseDocument === undefined || props.productionDocument === undefined
        ? []
        : mergeDocuments(
            props.baseDocument.data,
            document,
            props.productionDocument.data,
          ).conflicts.map((conflict) => ({
            documentId: props.document.id,
            path: conflict.path,
            base: conflict.base,
            change: conflict.ours,
            staging: conflict.theirs,
            scope: "field" as const,
          }))),
    [document, props.baseDocument, props.conflicts, props.document.id, props.productionDocument],
  );
  const changedAssetCount = collectAssetIds(document).size;
  const seoChangeCount = semanticChanges.filter((change) =>
    /(?:^|\/)(?:seo|title|description|canonical|robots|social)(?:\/|$)/iu.test(change.path),
  ).length;
  const redirectChangeCount = semanticChanges.filter((change) =>
    /(?:^|\/)(?:slug|route|redirects?)(?:\/|$)/iu.test(change.path),
  ).length;
  const blockingCheckCount =
    props.review?.checks.filter(
      (check) =>
        check.required && !(check.status === "completed" && check.conclusion === "success"),
    ).length ?? 0;
  const editable = changeStatus === "draft" || changeStatus === "changes_requested";
  const reactId = useId();
  const sessionId = useMemo(() => `cms-${reactId.replaceAll(":", "")}`, [reactId]);

  useEffect(() => {
    setHydrated(true);
    try {
      setSectionFavorites(
        JSON.parse(localStorage.getItem("git-native-cms.section-favorites") ?? "[]") as string[],
      );
      setRecentSections(
        JSON.parse(localStorage.getItem("git-native-cms.section-recent") ?? "[]") as string[],
      );
    } catch {
      setSectionFavorites([]);
      setRecentSections([]);
    }
  }, []);

  useEffect(() => {
    setAssetLimit(50);
  }, [assetPickerTarget?.field.accept, assetSearch]);

  useEffect(() => {
    if (props.baseDocument === undefined) {
      setSemanticChanges([]);
      return;
    }
    let active = true;
    void semanticDiffInWorker(props.baseDocument.data, document)
      .then((changes) => {
        if (active) setSemanticChanges(changes);
      })
      .catch(() => {
        if (active) setSemanticChanges(semanticDiff(props.baseDocument?.data, document));
      });
    return () => {
      active = false;
    };
  }, [document, props.baseDocument]);

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
        if (value.type === "preview.navigation") {
          setWorkflowNote(`Preview navigated to ${value.payload.path}.`);
        }
        if (value.type === "preview.validation-error") {
          setWorkflowState("error");
          setWorkflowNote(`${value.payload.path}: ${value.payload.message}`);
        }
        if (value.type === "preview.screenshot-ready") {
          setReviewScreenshots((current) => ({
            ...current,
            [value.payload.viewport]: value.payload.dataUrl,
          }));
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
          capabilities: [
            "patches",
            "selection",
            "inline-editing",
            "navigation",
            "screenshots",
            "viewport-context",
            "simulation-context",
          ],
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

  useEffect(() => {
    if (!previewConnected) return;
    const dimensions = {
      desktop: { width: 1440, height: 900 },
      tablet: { width: 820, height: 1180 },
      mobile: { width: 390, height: 844 },
    } as const;
    previewPort.current?.postMessage({
      protocolVersion: "1.0.0",
      type: "editor.set-viewport-context",
      timestamp: new Date().toISOString(),
      payload: {
        viewport,
        ...dimensions[viewport],
        deviceScaleFactor: window.devicePixelRatio,
      },
    });
  }, [previewConnected, viewport]);

  useEffect(() => {
    if (!previewConnected) return;
    previewPort.current?.postMessage({
      protocolVersion: "1.0.0",
      type: "editor.set-preview-context",
      timestamp: new Date().toISOString(),
      payload: {
        locale: previewContext.locale,
        market: previewContext.market,
        audience: previewContext.audience,
        ...(previewContext.at.length === 0
          ? {}
          : { at: new Date(previewContext.at).toISOString() }),
        featureFlags: {},
      },
    });
  }, [previewConnected, previewContext]);

  useEffect(() => {
    if (!reviewOpen || !previewConnected) return;
    setReviewScreenshots({});
    for (const reviewViewport of ["desktop", "tablet", "mobile"] as const) {
      previewPort.current?.postMessage({
        protocolVersion: "1.0.0",
        type: "editor.request-screenshot",
        requestId: globalThis.crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: { viewport: reviewViewport, fullPage: true },
      });
    }
  }, [previewConnected, reviewOpen]);

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

  function rememberSection(type: string): void {
    setRecentSections((current) => {
      const next = [type, ...current.filter((value) => value !== type)].slice(0, 6);
      localStorage.setItem("git-native-cms.section-recent", JSON.stringify(next));
      return next;
    });
  }

  function toggleSectionFavorite(type: string): void {
    setSectionFavorites((current) => {
      const next = current.includes(type)
        ? current.filter((value) => value !== type)
        : [...current, type];
      localStorage.setItem("git-native-cms.section-favorites", JSON.stringify(next));
      return next;
    });
  }

  function sectionCompatibility(template: EditorSectionTemplate): string | undefined {
    if (
      template.constraints?.allowedParents !== undefined &&
      !template.constraints.allowedParents.includes("page")
    ) {
      return "This section is not compatible with pages.";
    }
    const count = sections.filter((section) => section.type === template.type).length;
    if (
      template.constraints?.maxInstances !== undefined &&
      count >= template.constraints.maxInstances
    ) {
      return `This page already uses the maximum of ${String(template.constraints.maxInstances)}.`;
    }
    return undefined;
  }

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
    updateSectionFieldAtPath([name], value);
  }

  function updateSectionFieldAtPath(path: readonly string[], value: unknown): void {
    if (selectedIndex < 0) return;
    const fieldName = path.at(-1) ?? "field";
    addPatch({
      op: "set",
      path: contentPath(`/sections/${selectedIndex}/${path.map(pointerSegment).join("/")}`),
      value,
      metadata: patchMetadata(`Update ${fieldLabel(fieldName)}`),
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

  function reusableSections(): readonly EditableSection[] {
    const data =
      selectedReusableDocument !== undefined &&
      typeof selectedReusableDocument.data === "object" &&
      selectedReusableDocument.data !== null &&
      !Array.isArray(selectedReusableDocument.data)
        ? (selectedReusableDocument.data as Readonly<Record<string, unknown>>)
        : {};
    return Array.isArray(data.sections)
      ? data.sections.filter(
          (value): value is EditableSection =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Readonly<Record<string, unknown>>).id === "string" &&
            typeof (value as Readonly<Record<string, unknown>>).type === "string",
        )
      : [];
  }

  function detachReusableBlock(): void {
    if (selectedSection?.type !== "reference") return;
    const source = reusableSections();
    if (source.length === 0) return;
    updateSectionField("detachedSections", structuredClone(source));
    updateSectionField("detached", true);
  }

  function copyReusableBlockIntoPage(): void {
    if (selectedSection?.type !== "reference" || selectedIndex < 0) return;
    const copied = reusableSections().map((section) => ({
      ...structuredClone(section),
      id: `sec_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    }));
    if (copied.length === 0) return;
    updateDocumentValue(
      "/sections",
      [...sections.slice(0, selectedIndex), ...copied, ...sections.slice(selectedIndex + 1)],
      "Copy reusable block into page",
    );
    selectSection(copied[0]?.id);
  }

  function addSection(template: EditorSectionTemplate, variant?: string): void {
    if (sectionCompatibility(template) !== undefined) return;
    const id = `sec_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const index = template.constraints?.recommendedPosition === "first" ? 0 : sections.length;
    addPatch({
      op: "insert",
      path: contentPath("/sections"),
      index,
      value: {
        id,
        type: template.type,
        version: 1,
        ...template.defaults,
        ...(variant === undefined || template.variantField === undefined
          ? {}
          : { [template.variantField]: variant }),
      },
      metadata: patchMetadata(`Add ${template.label} section`),
    });
    rememberSection(template.type);
    setSectionLibraryOpen(false);
    setSectionSearch("");
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
      const path =
        reviewAttachSelection && selectedIndex >= 0 ? `/sections/${selectedIndex}` : undefined;
      await props.onAddReviewComment(body, path);
      setReviewComments((current) => [
        ...current,
        {
          id: globalThis.crypto.randomUUID(),
          author: "You",
          body,
          createdAt: new Date().toISOString(),
          resolved: false,
          ...(path === undefined ? {} : { path }),
        },
      ]);
      setReviewDraft("");
      setReviewOperation("idle");
    } catch {
      setReviewOperation("error");
    }
  }

  async function toggleReviewComment(comment: ReviewComment): Promise<void> {
    if (props.onResolveReviewComment === undefined || reviewOperation === "working") return;
    setReviewOperation("working");
    try {
      await props.onResolveReviewComment({
        commentId: comment.id,
        resolved: !comment.resolved,
      });
      setReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === comment.id ? { ...candidate, resolved: !candidate.resolved } : candidate,
        ),
      );
      setReviewOperation("idle");
    } catch {
      setReviewOperation("error");
    }
  }

  async function assignReviewers(): Promise<void> {
    if (props.onAssignReviewers === undefined || reviewOperation === "working") return;
    const assignment = {
      users: reviewerUsers
        .split(",")
        .map((value) => value.trim().replace(/^@/u, ""))
        .filter(Boolean),
      teams: reviewerTeams
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    if (assignment.users.length + assignment.teams.length === 0) return;
    setReviewOperation("working");
    try {
      await props.onAssignReviewers(assignment);
      setReviewAssignment(assignment);
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

  async function resolveConflicts(): Promise<void> {
    if (
      props.onResolveConflicts === undefined ||
      conflicts.length === 0 ||
      conflicts.some((conflict) => conflictChoices[conflictKey(conflict)] === undefined) ||
      conflictOperation === "working" ||
      patches.length > 0
    ) {
      return;
    }
    setConflictOperation("working");
    setConflictNote(undefined);
    try {
      const result = await props.onResolveConflicts({
        expectedRevision: revision,
        resolutions: conflicts.map((conflict) => ({
          documentId: conflict.documentId,
          path: conflict.path,
          choice: conflictChoices[conflictKey(conflict)] as ChangeConflictResolution["choice"],
        })),
      });
      setRevision(result.revision);
      setChangeStatus(result.status);
      setConflictOperation("complete");
      setConflictNote(
        "Conflicts resolved. Approval was reset so the merged result can be reviewed.",
      );
    } catch (error) {
      setConflictOperation("error");
      setConflictNote(
        error instanceof Error
          ? error.message
          : "The conflicts could not be resolved. Refresh and try again.",
      );
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

  function openAssetLibrary(target?: EditorAssetPickerTarget): void {
    setAssetPickerTarget(target);
    setAssetSearch("");
    setAssetLibraryOpen(true);
  }

  function closeAssetLibrary(): void {
    setAssetLibraryOpen(false);
    setAssetPickerTarget(undefined);
    setAssetSearch("");
  }

  function chooseAsset(asset: Asset): void {
    if (
      assetPickerTarget === undefined ||
      !assetMatchesAccept(asset, assetPickerTarget.field.accept)
    ) {
      return;
    }
    const source =
      assetPickerTarget.scope === "document"
        ? document
        : selectedSection?.id === assetPickerTarget.sectionId
          ? selectedSection
          : undefined;
    if (source === undefined) return;
    const current = assetReference(valueAtPath(source, assetPickerTarget.path));
    const reference = {
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      url: asset.url,
      ...(current?.altText === undefined
        ? asset.altText === undefined
          ? {}
          : { altText: asset.altText }
        : { altText: current.altText }),
    } satisfies AssetReference;
    if (assetPickerTarget.scope === "document") {
      updateDocumentValue(
        `/${assetPickerTarget.path.map(pointerSegment).join("/")}`,
        reference,
        `Update ${assetPickerTarget.field.label}`,
      );
    } else {
      updateSectionFieldAtPath(assetPickerTarget.path, reference);
    }
    closeAssetLibrary();
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

  async function updateAssetMetadata(
    id: Asset["id"],
    input: {
      readonly altText: string | null;
      readonly focalPoint: { x: number; y: number } | null;
    },
  ): Promise<void> {
    if (props.onUpdateAsset === undefined || assetOperation === "working") return;
    setAssetOperation("working");
    try {
      const result = await props.onUpdateAsset({
        assetId: id,
        altText: input.altText,
        focalPoint: input.focalPoint,
        expectedRevision: revision,
      });
      setRevision(result.revision);
      setAssets((current) =>
        current.map((asset) => (asset.id === result.asset.id ? result.asset : asset)),
      );
      setAssetOperation("idle");
    } catch {
      setAssetOperation("error");
    }
  }

  const nextWorkflowAction = workflowAction(changeStatus, props.change.emergency === true);

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

      <div
        className={`cms-editor-grid${inspectorOpen ? "" : " is-inspector-hidden"}`}
        style={{
          gridTemplateColumns: inspectorOpen
            ? `${String(navigationWidth)}px 5px minmax(420px, 1fr) 5px ${String(inspectorWidth)}px`
            : `${String(navigationWidth)}px 5px minmax(420px, 1fr)`,
        }}
      >
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
            <div
              className="cms-section-library"
              role="dialog"
              aria-modal="true"
              aria-labelledby="section-library"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSectionLibraryOpen(false);
                  setSectionSearch("");
                }
              }}
            >
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
              <label className="cms-section-library__search">
                <span className="cms-visually-hidden">Search registered sections</span>
                <input
                  autoFocus
                  type="search"
                  value={sectionSearch}
                  placeholder="Search sections, categories or guidance…"
                  onChange={(event) => setSectionSearch(event.currentTarget.value)}
                />
              </label>
              {visibleSectionTemplates.length === 0 ? (
                <div className="cms-section-library__empty">
                  <strong>No compatible sections found</strong>
                  <small>Try a different term or adjust the current page structure.</small>
                </div>
              ) : (
                <ul>
                  {visibleSectionTemplates.map((template) => {
                    const compatibility = sectionCompatibility(template);
                    const favorite = sectionFavorites.includes(template.type);
                    const recent = recentSections.includes(template.type);
                    return (
                      <li key={template.type}>
                        <article>
                          <div
                            className="cms-section-library__thumbnail"
                            style={
                              template.thumbnailUrl === undefined
                                ? undefined
                                : { backgroundImage: `url("${template.thumbnailUrl}")` }
                            }
                            aria-label={`${template.label} preview thumbnail`}
                          >
                            {template.thumbnailUrl === undefined && (
                              <>
                                <span />
                                <span />
                                <span />
                              </>
                            )}
                          </div>
                          <div className="cms-section-library__content">
                            <div>
                              <span>{template.category}</span>
                              {favorite && <small>Favorite</small>}
                              {recent && <small>Recent</small>}
                            </div>
                            <strong>{template.label}</strong>
                            <p>{template.description}</p>
                            <small>
                              {template.usageGuidance ??
                                (template.constraints?.recommendedPosition === "first"
                                  ? "Works best at the beginning of a page."
                                  : template.constraints?.recommendedPosition === "last"
                                    ? "Works best at the end of a page."
                                    : "Use where this content pattern best supports the story.")}
                            </small>
                            {compatibility !== undefined && (
                              <p className="cms-section-library__warning" role="status">
                                {compatibility}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            className="cms-section-library__favorite"
                            aria-label={`${favorite ? "Remove" : "Add"} ${template.label} ${
                              favorite ? "from" : "to"
                            } favorites`}
                            aria-pressed={favorite}
                            onClick={() => toggleSectionFavorite(template.type)}
                          >
                            {favorite ? "★" : "☆"}
                          </button>
                          <div className="cms-section-library__actions">
                            {template.variants !== undefined && template.variants.length > 0 ? (
                              template.variants.map((variant) => (
                                <button
                                  key={variant.value}
                                  type="button"
                                  disabled={compatibility !== undefined}
                                  onClick={() => addSection(template, variant.value)}
                                >
                                  Add {template.label} · {variant.label}
                                </button>
                              ))
                            ) : (
                              <button
                                type="button"
                                disabled={compatibility !== undefined}
                                onClick={() => addSection(template)}
                              >
                                Add {template.label}
                              </button>
                            )}
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
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
                  <DocumentButtons
                    items={items}
                    currentId={props.document.id}
                    {...(props.onNavigateDocument === undefined
                      ? {}
                      : { onNavigate: props.onNavigateDocument })}
                  />
                </details>
              );
            })}
            {props.onCreateDocument !== undefined && editable && (
              <button type="button" onClick={() => setDocumentCreatorOpen(true)}>
                Create content
                <span>＋</span>
              </button>
            )}
            <button type="button" onClick={() => openAssetLibrary()}>
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
            <div
              className="cms-asset-library"
              role="dialog"
              aria-modal="true"
              aria-labelledby="asset-library"
              onKeyDown={(event) => {
                if (event.key === "Escape") closeAssetLibrary();
              }}
            >
              <header>
                <div>
                  <span className="cms-login__eyebrow">Content-addressed storage</span>
                  <h2 id="asset-library">
                    {assetPickerTarget === undefined
                      ? "Asset library"
                      : `Choose ${assetPickerTarget.field.label}`}
                  </h2>
                  <p>
                    {assetPickerTarget === undefined
                      ? "Browse files stored independently from content and releases."
                      : "Select a compatible file. The Change stores a stable content-addressed reference."}
                  </p>
                </div>
                <button type="button" aria-label="Close assets" onClick={closeAssetLibrary}>
                  ×
                </button>
              </header>
              <label className="cms-asset-search">
                <span>Find an asset</span>
                <input
                  type="search"
                  value={assetSearch}
                  placeholder="Search by file name, format or checksum"
                  autoFocus
                  onChange={(event) => setAssetSearch(event.currentTarget.value)}
                />
              </label>
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
              {visibleAssets.length === 0 ? (
                <div className="cms-asset-empty">
                  <strong>{assets.length === 0 ? "No assets yet" : "No compatible assets"}</strong>
                  <p>
                    {assets.length === 0
                      ? "Upload the first file to make it available to media-enabled blocks."
                      : "Change the search or upload a file accepted by this field."}
                  </p>
                </div>
              ) : (
                <ul className="cms-asset-grid">
                  {visibleAssets.map((asset) => {
                    const targetValue =
                      assetPickerTarget === undefined
                        ? undefined
                        : assetReference(
                            valueAtPath(
                              assetPickerTarget.scope === "document" ? document : selectedSection,
                              assetPickerTarget.path,
                            ),
                          );
                    const selected = targetValue?.id === asset.id;
                    return (
                      <li key={asset.id} className={selected ? "is-selected" : ""}>
                        <div className="cms-asset-preview">
                          {asset.mimeType.startsWith("image/") ? (
                            <img src={asset.url} alt="" />
                          ) : (
                            <span className="cms-asset-file" aria-hidden="true">
                              {asset.mimeType === "application/pdf" ? "PDF" : "FILE"}
                            </span>
                          )}
                          <span>{asset.mimeType.split("/").at(-1)?.toUpperCase()}</span>
                        </div>
                        <div className="cms-asset-meta">
                          <strong>{asset.fileName}</strong>
                          <small>
                            {(asset.size / 1024).toFixed(1)} KB · {asset.checksum.slice(0, 12)}
                          </small>
                          {(asset.width !== undefined || asset.height !== undefined) && (
                            <small>
                              {asset.width ?? "?"} × {asset.height ?? "?"} px
                              {asset.focalPoint === undefined
                                ? ""
                                : ` · focal ${Math.round(asset.focalPoint.x * 100)}% / ${Math.round(
                                    asset.focalPoint.y * 100,
                                  )}%`}
                            </small>
                          )}
                          {(asset.variants?.length ?? 0) > 0 && (
                            <small>
                              {asset.variants
                                ?.map(
                                  (variant) =>
                                    `${variant.name ?? variant.format} ${String(variant.width)}×${String(variant.height)}`,
                                )
                                .join(" · ")}
                            </small>
                          )}
                        </div>
                        {props.onUpdateAsset !== undefined && editable && (
                          <details className="cms-asset-edit">
                            <summary>Edit metadata</summary>
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                const values = new FormData(event.currentTarget);
                                const rawAltText = values.get("altText");
                                const rawFocalX = values.get("focalX");
                                const rawFocalY = values.get("focalY");
                                const altText =
                                  typeof rawAltText === "string" ? rawAltText.trim() : "";
                                const focalX =
                                  typeof rawFocalX === "string" ? rawFocalX.trim() : "";
                                const focalY =
                                  typeof rawFocalY === "string" ? rawFocalY.trim() : "";
                                const focalPoint =
                                  focalX.length === 0 || focalY.length === 0
                                    ? null
                                    : { x: Number(focalX), y: Number(focalY) };
                                void updateAssetMetadata(asset.id, {
                                  altText: altText.length === 0 ? null : altText,
                                  focalPoint,
                                });
                              }}
                            >
                              <label>
                                Alternative text
                                <textarea name="altText" defaultValue={asset.altText ?? ""} />
                              </label>
                              {asset.mimeType.startsWith("image/") && (
                                <fieldset>
                                  <legend>Focal point (0–1)</legend>
                                  <label>
                                    Horizontal
                                    <input
                                      name="focalX"
                                      type="number"
                                      min="0"
                                      max="1"
                                      step="0.01"
                                      defaultValue={asset.focalPoint?.x}
                                    />
                                  </label>
                                  <label>
                                    Vertical
                                    <input
                                      name="focalY"
                                      type="number"
                                      min="0"
                                      max="1"
                                      step="0.01"
                                      defaultValue={asset.focalPoint?.y}
                                    />
                                  </label>
                                </fieldset>
                              )}
                              <Button
                                tone="primary"
                                type="submit"
                                isDisabled={assetOperation === "working"}
                              >
                                Save metadata
                              </Button>
                            </form>
                          </details>
                        )}
                        <div className="cms-asset-actions">
                          {assetPickerTarget !== undefined && (
                            <Button
                              tone={selected ? "primary" : "neutral"}
                              onPress={() => chooseAsset(asset)}
                            >
                              {selected ? "Selected" : "Use asset"}
                            </Button>
                          )}
                          <a href={asset.url} target="_blank" rel="noreferrer">
                            Open original
                          </a>
                          {props.onFindAssetUsages !== undefined && (
                            <button
                              type="button"
                              onClick={() => {
                                setAssetUsage({ id: asset.id, state: "loading" });
                                void props
                                  .onFindAssetUsages?.(asset.id)
                                  .then((paths) =>
                                    setAssetUsage({
                                      id: asset.id,
                                      state: "complete",
                                      paths: paths ?? [],
                                    }),
                                  )
                                  .catch(() =>
                                    setAssetUsage({
                                      id: asset.id,
                                      state: "complete",
                                      paths: [],
                                    }),
                                  );
                              }}
                            >
                              {assetUsage?.id === asset.id && assetUsage.state === "loading"
                                ? "Checking…"
                                : "Usages"}
                            </button>
                          )}
                          {props.onDeleteAsset !== undefined && editable && (
                            <button
                              type="button"
                              aria-label={`Delete ${asset.fileName}`}
                              onClick={() => void deleteAsset(asset.id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                        {assetUsage?.id === asset.id && assetUsage.state === "complete" && (
                          <p className="cms-asset-usages" aria-live="polite">
                            {assetUsage.paths.length === 0
                              ? "Not used by active content or immutable releases."
                              : `Used in ${assetUsage.paths.join(", ")}.`}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {filteredAssets.length > visibleAssets.length && (
                <Button onPress={() => setAssetLimit((current) => current + 50)}>
                  Load 50 more · {String(filteredAssets.length - visibleAssets.length)} remaining
                </Button>
              )}
            </div>
          )}
        </nav>
        <Splitter
          label="Resize content navigation"
          value={navigationWidth}
          min={190}
          max={440}
          onChange={setNavigationWidth}
        />

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
            <label className="cms-preview-zoom">
              <span>Zoom</span>
              <select
                value={previewZoom}
                onChange={(event) => setPreviewZoom(Number(event.currentTarget.value))}
              >
                {[50, 75, 90, 100, 110, 125].map((value) => (
                  <option value={value} key={value}>
                    {value}%
                  </option>
                ))}
              </select>
            </label>
            <details className="cms-preview-context">
              <summary>Simulate</summary>
              <div>
                <label>
                  Locale
                  <select
                    value={previewContext.locale}
                    onChange={(event) =>
                      setPreviewContext((current) => ({
                        ...current,
                        locale: event.currentTarget.value,
                      }))
                    }
                  >
                    <option value="en-US">English · US</option>
                    <option value="pl-PL">Polski · Polska</option>
                  </select>
                </label>
                <label>
                  Market
                  <select
                    value={previewContext.market}
                    onChange={(event) =>
                      setPreviewContext((current) => ({
                        ...current,
                        market: event.currentTarget.value,
                      }))
                    }
                  >
                    <option value="default">Default</option>
                    <option value="us">United States</option>
                    <option value="pl">Poland</option>
                  </select>
                </label>
                <label>
                  Audience
                  <select
                    value={previewContext.audience}
                    onChange={(event) =>
                      setPreviewContext((current) => ({
                        ...current,
                        audience: event.currentTarget.value,
                      }))
                    }
                  >
                    <option value="anonymous">Anonymous</option>
                    <option value="customer">Customer</option>
                    <option value="member">Member</option>
                  </select>
                </label>
                <label>
                  Date and time
                  <input
                    type="datetime-local"
                    value={previewContext.at}
                    onChange={(event) =>
                      setPreviewContext((current) => ({
                        ...current,
                        at: event.currentTarget.value,
                      }))
                    }
                  />
                </label>
              </div>
            </details>
            <a
              className="cms-canvas-toolbar__standalone"
              href={props.previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open standalone
            </a>
            <button type="button" onClick={() => iframe.current?.contentWindow?.location.reload()}>
              Reload
            </button>
          </div>
          <div
            className={`cms-preview-stage cms-preview-stage--${viewport}`}
            style={{ "--cms-preview-zoom": previewZoom / 100 } as CSSProperties}
          >
            <iframe
              ref={iframe}
              title={`Preview of ${document.title ?? "page"}`}
              src={`${props.previewUrl}${props.previewUrl.includes("?") ? "&" : "?"}cmsSession=${encodeURIComponent(sessionId)}`}
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          </div>
        </main>

        {inspectorOpen && (
          <>
            <Splitter
              label="Resize inspector"
              value={inspectorWidth}
              min={260}
              max={520}
              direction={-1}
              onChange={setInspectorWidth}
            />
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
                    {documentFieldEntries.length > 0 && (
                      <section
                        className="cms-document-fields"
                        aria-labelledby="cms-document-fields"
                      >
                        <div>
                          <span className="cms-field__label">Structured content</span>
                          <h3 id="cms-document-fields">Document fields</h3>
                        </div>
                        {documentFieldEntries.map(([field, value]) => (
                          <SchemaFieldEditor
                            key={field.name}
                            field={field}
                            value={value}
                            disabled={!editable}
                            assets={assets}
                            documents={documents}
                            path={[field.name]}
                            {...(props.fieldEditorRegistry === undefined
                              ? {}
                              : { registry: props.fieldEditorRegistry })}
                            onChange={(next) =>
                              updateDocumentValue(
                                `/${pointerSegment(field.name)}`,
                                next,
                                `Update ${field.label}`,
                              )
                            }
                            onOpenAsset={(assetField, path) =>
                              openAssetLibrary({
                                scope: "document",
                                field: assetField,
                                path,
                              })
                            }
                          />
                        ))}
                      </section>
                    )}
                    <TextField
                      label="Search title"
                      value={
                        typeof (document.seo as Readonly<Record<string, unknown>> | undefined)
                          ?.title === "string"
                          ? String(
                              (document.seo as Readonly<Record<string, unknown>> | undefined)
                                ?.title,
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
                              .catch(() =>
                                setTranslationJobNote("Translation job could not start."),
                              )
                              .finally(() => setTranslationJobBusy(false));
                          }}
                        >
                          Send to translation provider
                        </button>
                      )}
                      {translationJobId !== undefined &&
                        props.onReadTranslationJob !== undefined && (
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
                            setScheduleAction(event.currentTarget.value as ContentScheduleAction)
                          }
                        >
                          <option value="publish">Publish</option>
                          <option value="unpublish">Unpublish</option>
                          <option value="availability-start">Availability starts</option>
                          <option value="availability-end">Availability ends</option>
                          <option value="visibility-start">Visibility starts</option>
                          <option value="visibility-end">Visibility ends</option>
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
                    {editorFieldEntries(selectedSection, selectedTemplate).map(([name, value]) => {
                      const field = selectedTemplate?.fields?.find(
                        (candidate) => candidate.name === name,
                      );
                      const inferredKind =
                        typeof value === "string"
                          ? "text"
                          : typeof value === "number"
                            ? "number"
                            : typeof value === "boolean"
                              ? "boolean"
                              : typeof value === "object" &&
                                  value !== null &&
                                  !Array.isArray(value) &&
                                  (value as Readonly<Record<string, unknown>>).type === "root"
                                ? "rich-text"
                                : "json";
                      const resolvedField = field ?? {
                        name,
                        kind: inferredKind,
                        label: fieldLabel(name),
                      };
                      return (
                        <SchemaFieldEditor
                          key={name}
                          field={resolvedField}
                          value={value}
                          disabled={!editable}
                          assets={assets}
                          documents={documents}
                          path={[name]}
                          {...(props.fieldEditorRegistry === undefined
                            ? {}
                            : { registry: props.fieldEditorRegistry })}
                          onChange={(next) => updateSectionField(name, next)}
                          onOpenAsset={(assetField, path) =>
                            openAssetLibrary({
                              scope: "section",
                              sectionId: selectedSection.id,
                              field: assetField,
                              path,
                            })
                          }
                        />
                      );
                    })}
                  </div>
                  {selectedSection.type === "reference" && (
                    <section className="cms-reusable-block-editor">
                      <div>
                        <strong>Reusable block</strong>
                        <small>
                          Connected instances inherit future edits. Overrides remain local to this
                          page.
                        </small>
                      </div>
                      <label className="cms-field">
                        <span className="cms-field__label">Source</span>
                        <select
                          className="cms-field__input"
                          value={typeof selectedSection.ref === "string" ? selectedSection.ref : ""}
                          disabled={!editable || selectedSection.detached === true}
                          onChange={(event) => {
                            updateSectionField("ref", event.currentTarget.value);
                            updateSectionField("detached", false);
                          }}
                        >
                          <option value="">Choose reusable block…</option>
                          {reusableDocuments.map((candidate) => {
                            const data =
                              typeof candidate.data === "object" &&
                              candidate.data !== null &&
                              !Array.isArray(candidate.data)
                                ? (candidate.data as Readonly<Record<string, unknown>>)
                                : {};
                            const slug =
                              typeof data.slug === "string" ? data.slug : String(candidate.id);
                            const title =
                              typeof data.title === "string"
                                ? data.title
                                : slug.replaceAll("-", " ");
                            return (
                              <option key={candidate.id} value={`reusable-blocks/${slug}`}>
                                {title}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      {typeof selectedSection.ref === "string" &&
                        selectedReusableDocument === undefined && (
                          <p role="alert">The referenced reusable block could not be resolved.</p>
                        )}
                      {selectedReusableDocument !== undefined && (
                        <div className="cms-reusable-block-editor__actions">
                          {props.onNavigateDocument !== undefined && (
                            <Button
                              onPress={() =>
                                props.onNavigateDocument?.(
                                  selectedReusableDocument.id,
                                  "reusable-blocks",
                                )
                              }
                            >
                              Open source
                            </Button>
                          )}
                          {selectedSection.detached === true ? (
                            <Button
                              onPress={() => updateSectionField("detached", false)}
                              isDisabled={!editable}
                            >
                              Reconnect
                            </Button>
                          ) : (
                            <Button onPress={detachReusableBlock} isDisabled={!editable}>
                              Detach with local copy
                            </Button>
                          )}
                          <Button onPress={copyReusableBlockIntoPage} isDisabled={!editable}>
                            Copy as sections
                          </Button>
                        </div>
                      )}
                      {selectedSection.detached !== true &&
                        selectedReusableDocument !== undefined && (
                          <p role="status">
                            Editing the source can affect every page that references this block. Use
                            overrides for instance-specific copy.
                          </p>
                        )}
                    </section>
                  )}
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
          </>
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
          <section className="cms-review-panel__summary" aria-label="Change summary">
            <h3>Change summary</h3>
            <dl>
              <div>
                <dt>Documents</dt>
                <dd>
                  {props.review?.summary.changedDocumentIds.length ??
                    (semanticChanges.length > 0 ? 1 : 0)}
                </dd>
              </div>
              <div>
                <dt>Field changes</dt>
                <dd>{semanticChanges.length}</dd>
              </div>
              <div>
                <dt>Assets</dt>
                <dd>{changedAssetCount}</dd>
              </div>
              <div>
                <dt>Affected usages</dt>
                <dd>{props.review?.summary.affectedUsages ?? 0}</dd>
              </div>
              <div>
                <dt>SEO / redirects</dt>
                <dd>{seoChangeCount + redirectChangeCount}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd>
                  {(props.review?.summary.warnings ?? 0) + conflicts.length + blockingCheckCount}
                </dd>
              </div>
            </dl>
          </section>
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
            <div className="cms-review-panel__responsive-shots">
              {(["desktop", "tablet", "mobile"] as const).map((reviewViewport) => (
                <figure key={reviewViewport}>
                  {reviewScreenshots[reviewViewport] === undefined ? (
                    <div role="status">Capturing {reviewViewport}…</div>
                  ) : (
                    <img
                      src={reviewScreenshots[reviewViewport]}
                      alt={`Captured ${reviewViewport} Change preview`}
                    />
                  )}
                  <figcaption>{reviewViewport}</figcaption>
                </figure>
              ))}
            </div>
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
                <p>
                  Staging and this Change edited the same content. Choose the value that should
                  survive for every conflict.
                </p>
                <ul>
                  {conflicts.map((conflict) => (
                    <li key={conflictKey(conflict)}>
                      <div className="cms-conflict__path">
                        <span>{conflict.documentId}</span>
                        <code>{conflict.path || "Whole document"}</code>
                      </div>
                      <div className="cms-conflict__values">
                        <div>
                          <small>This Change</small>
                          <output>{conflictValue(conflict.change)}</output>
                        </div>
                        <div>
                          <small>Staging</small>
                          <output>{conflictValue(conflict.staging)}</output>
                        </div>
                      </div>
                      {props.onResolveConflicts !== undefined && (
                        <div className="cms-conflict__choices" role="group" aria-label="Resolution">
                          <Button
                            aria-pressed={conflictChoices[conflictKey(conflict)] === "change"}
                            onPress={() =>
                              setConflictChoices((current) => ({
                                ...current,
                                [conflictKey(conflict)]: "change",
                              }))
                            }
                          >
                            Keep this Change
                          </Button>
                          <Button
                            aria-pressed={conflictChoices[conflictKey(conflict)] === "staging"}
                            onPress={() =>
                              setConflictChoices((current) => ({
                                ...current,
                                [conflictKey(conflict)]: "staging",
                              }))
                            }
                          >
                            Use Staging
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {props.onResolveConflicts !== undefined && (
                  <Button
                    tone="primary"
                    onPress={() => void resolveConflicts()}
                    isDisabled={
                      conflictOperation === "working" ||
                      patches.length > 0 ||
                      conflicts.some(
                        (conflict) => conflictChoices[conflictKey(conflict)] === undefined,
                      )
                    }
                  >
                    {conflictOperation === "working"
                      ? "Resolving…"
                      : `Resolve ${String(conflicts.length)} conflict(s)`}
                  </Button>
                )}
                {conflictNote !== undefined && (
                  <p role={conflictOperation === "error" ? "alert" : "status"}>{conflictNote}</p>
                )}
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
            <h3>Reviewers</h3>
            <p>
              {reviewAssignment.users.length + reviewAssignment.teams.length === 0
                ? "No reviewers assigned."
                : [
                    ...reviewAssignment.users.map((user) => `@${user}`),
                    ...reviewAssignment.teams.map((team) => `team:${team}`),
                  ].join(" · ")}
            </p>
            {props.onAssignReviewers !== undefined && (
              <div className="cms-review-panel__reviewers">
                <label>
                  GitHub users
                  <input
                    value={reviewerUsers}
                    onChange={(event) => setReviewerUsers(event.currentTarget.value)}
                    placeholder="@octocat, @reviewer"
                  />
                </label>
                <label>
                  GitHub teams
                  <input
                    value={reviewerTeams}
                    onChange={(event) => setReviewerTeams(event.currentTarget.value)}
                    placeholder="editors, legal"
                  />
                </label>
                <Button
                  onPress={() => void assignReviewers()}
                  isDisabled={
                    reviewOperation === "working" ||
                    reviewerUsers.trim().length + reviewerTeams.trim().length === 0
                  }
                >
                  Assign reviewers
                </Button>
              </div>
            )}
            <h3>Conversation</h3>
            {reviewComments.length === 0 ? (
              <p>No review comments yet.</p>
            ) : (
              <ol>
                {reviewComments.map((comment) => (
                  <li key={comment.id} className={comment.resolved ? "is-resolved" : undefined}>
                    <strong>@{comment.author}</strong>
                    <p>{comment.body}</p>
                    {comment.path !== undefined && <code>{comment.path}</code>}
                    <time dateTime={comment.createdAt}>
                      {formatCmsTimestamp(comment.createdAt)}
                    </time>
                    {props.onResolveReviewComment !== undefined && (
                      <button
                        type="button"
                        onClick={() => void toggleReviewComment(comment)}
                        disabled={reviewOperation === "working"}
                      >
                        {comment.resolved ? "Reopen thread" : "Resolve thread"}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {props.onAddReviewComment !== undefined && (
              <>
                <label className="cms-review-panel__visual-comment">
                  <input
                    type="checkbox"
                    checked={reviewAttachSelection}
                    disabled={selectedIndex < 0}
                    onChange={(event) => setReviewAttachSelection(event.currentTarget.checked)}
                  />
                  <span>
                    Attach to{" "}
                    {selectedIndex < 0
                      ? "a selected section"
                      : `section ${selectedIndex + 1} on the canvas`}
                  </span>
                </label>
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
          <div className="cms-review-panel__timeline">
            <h3>Activity</h3>
            {(props.review?.timeline.length ?? 0) === 0 ? (
              <p>No auditable Change activity yet.</p>
            ) : (
              <ol>
                {props.review?.timeline.map((event) => (
                  <li key={`${event.requestId}:${event.timestamp}:${event.type}`}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{event.type.replaceAll(".", " ")}</strong>
                      <small>
                        {event.actorId} · {event.source}
                      </small>
                      {event.details !== undefined && (
                        <details>
                          <summary>Details</summary>
                          <code>{JSON.stringify(event.details)}</code>
                        </details>
                      )}
                    </div>
                    <time dateTime={event.timestamp}>{formatCmsTimestamp(event.timestamp)}</time>
                  </li>
                ))}
              </ol>
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
