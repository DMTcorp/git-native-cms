import {
  createCmsApplication,
  type Asset,
  type AuditEvent,
  type ContentRepository,
  type DocumentSummary,
  type EnvironmentPointer,
  type GitProvider,
  type Page,
  type ReleaseStore,
  type ReviewAssignment,
  type ReviewCheck,
  type ReviewComment,
  type ReviewPort,
  type StoredRelease,
} from "@git-native-cms/application";
import { canonicalJson } from "@git-native-cms/content-codecs";
import {
  CmsError,
  type Actor,
  type Change,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type ReleaseId,
  type Revision,
} from "@git-native-cms/core";
import type {
  HostedCmsRuntime,
  HostedEditablePage,
  HostedEditorState,
} from "@git-native-cms/hosted-runtime";
import { AuthorizationService } from "@git-native-cms/permissions";
import { deterministicReleaseBuilder } from "@git-native-cms/release-builder";
import { createCmsServer } from "@git-native-cms/server";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryGitProvider,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";

const registryDigest = `sha256:${"0".repeat(64)}`;

function cloneDocuments(
  documents: ReadonlyMap<DocumentId, ContentDocument>,
): Map<DocumentId, ContentDocument> {
  return new Map([...documents.entries()].map(([id, document]) => [id, structuredClone(document)]));
}

class CoupledContentRepository implements ContentRepository {
  private readonly refs = new Map<string, Map<DocumentId, ContentDocument>>();
  private readonly snapshots = new Map<string, Map<DocumentId, ContentDocument>>();
  private readonly mutations = new Map<string, Revision>();

  constructor(private readonly git: GitProvider) {}

  async seed(ref: string, documents: readonly ContentDocument[]): Promise<void> {
    const revision = (await this.git.resolveRef(ref)).sha;
    const values = new Map(
      documents.map((document) => [
        document.id,
        { ...structuredClone(document), revision } satisfies ContentDocument,
      ]),
    );
    this.refs.set(ref, values);
    this.snapshots.set(revision, cloneDocuments(values));
  }

  copyRevision(revision: GitCommitSha, target: string): void {
    const source = this.snapshots.get(revision);
    if (source !== undefined) this.refs.set(target, cloneDocuments(source));
  }

  recordRevision(ref: string, revision: GitCommitSha): void {
    const documents = this.refs.get(ref);
    if (documents === undefined) return;
    const revised = new Map(
      [...documents.entries()].map(([id, document]) => [
        id,
        { ...structuredClone(document), revision } satisfies ContentDocument,
      ]),
    );
    this.refs.set(ref, revised);
    this.snapshots.set(revision, cloneDocuments(revised));
  }

  mergeRef(source: string, target: string, revision: GitCommitSha): void {
    const documents = this.refs.get(source);
    if (documents === undefined) return;
    const merged = new Map(
      [...documents.entries()].map(([id, document]) => [
        id,
        { ...structuredClone(document), revision } satisfies ContentDocument,
      ]),
    );
    this.refs.set(target, merged);
    this.snapshots.set(revision, cloneDocuments(merged));
  }

  private async documents(ref: string): Promise<Map<DocumentId, ContentDocument>> {
    const branch = this.refs.get(ref);
    if (branch !== undefined) {
      const revision = (await this.git.resolveRef(ref)).sha;
      return new Map(
        [...branch.entries()].map(([id, document]) => [
          id,
          { ...structuredClone(document), revision } satisfies ContentDocument,
        ]),
      );
    }
    const snapshot = this.snapshots.get(ref);
    if (snapshot !== undefined) return cloneDocuments(snapshot);
    throw new Error(`Unknown content ref ${ref}.`);
  }

  async listDocuments(input: {
    readonly ref: string;
    readonly type?: string;
  }): Promise<Page<DocumentSummary>> {
    const documents = [...(await this.documents(input.ref)).values()].filter(
      (document) => input.type === undefined || document.type === input.type,
    );
    return {
      items: documents
        .map((document) => ({
          id: document.id,
          type: document.type,
          title:
            typeof document.data === "object" &&
            document.data !== null &&
            "title" in document.data &&
            typeof document.data.title === "string"
              ? document.data.title
              : document.id,
          path: `content/${document.type}/${document.id}/index.yaml`,
          revision: document.revision,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async readDocument(input: {
    readonly ref: string;
    readonly documentId: DocumentId;
  }): Promise<ContentDocument> {
    const document = (await this.documents(input.ref)).get(input.documentId);
    if (document === undefined) throw new Error(`Unknown document ${input.documentId}.`);
    return document;
  }

  async writeDocuments(input: {
    readonly ref: string;
    readonly documents: readonly ContentDocument[];
    readonly expectedRevision: Revision;
    readonly message: string;
    readonly actor: Actor;
    readonly idempotencyKey: string;
  }): Promise<Revision> {
    const previous = this.mutations.get(input.idempotencyKey);
    if (previous !== undefined) return previous;
    const current = await this.git.resolveRef(input.ref);
    if (current.sha !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_GIT_012",
        message: "The content branch moved while saving.",
        category: "conflict",
        retryable: true,
      });
    }
    const existing = this.refs.get(input.ref) ?? new Map<DocumentId, ContentDocument>();
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: current.sha,
      files: input.documents.map((document) => ({
        path: `content/${document.type}/${document.id}/index.yaml`,
        content: canonicalJson(document),
      })),
      message: input.message,
      author: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    for (const document of input.documents) {
      existing.set(document.id, { ...structuredClone(document), revision: committed.sha });
    }
    for (const [id, document] of existing) {
      existing.set(id, { ...document, revision: committed.sha });
    }
    this.refs.set(input.ref, existing);
    this.snapshots.set(committed.sha, cloneDocuments(existing));
    this.mutations.set(input.idempotencyKey, committed.sha);
    return committed.sha;
  }

  async deleteDocuments(input: {
    readonly ref: string;
    readonly documentIds: readonly DocumentId[];
    readonly expectedRevision: Revision;
    readonly actor: Actor;
    readonly idempotencyKey: string;
  }): Promise<Revision> {
    const previous = this.mutations.get(input.idempotencyKey);
    if (previous !== undefined) return previous;
    const current = await this.git.resolveRef(input.ref);
    if (current.sha !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_GIT_012",
        message: "The content branch moved while deleting.",
        category: "conflict",
        retryable: true,
      });
    }
    const existing = this.refs.get(input.ref) ?? new Map<DocumentId, ContentDocument>();
    const files = input.documentIds.map((id) => {
      const document = existing.get(id);
      return {
        path: `content/${document?.type ?? "documents"}/${id}/index.yaml`,
        content: null,
      };
    });
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: current.sha,
      files,
      message: `Delete ${String(input.documentIds.length)} content document(s)`,
      author: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    for (const id of input.documentIds) existing.delete(id);
    for (const [id, document] of existing) {
      existing.set(id, { ...document, revision: committed.sha });
    }
    this.refs.set(input.ref, existing);
    this.snapshots.set(committed.sha, cloneDocuments(existing));
    this.mutations.set(input.idempotencyKey, committed.sha);
    return committed.sha;
  }

  async readProjectConfig(): Promise<{
    readonly configVersion: number;
    readonly defaultLocale: string;
  }> {
    return { configVersion: 1, defaultLocale: "en-US" };
  }

  async readRegistryLock(): Promise<{
    readonly registryDigest: string;
    readonly schemaVersion: number;
  }> {
    return { registryDigest, schemaVersion: 1 };
  }
}

class CoupledGitProvider extends MemoryGitProvider {
  private content?: CoupledContentRepository;

  connect(content: CoupledContentRepository): void {
    this.content = content;
  }

  override async createBranch(
    input: Parameters<GitProvider["createBranch"]>[0],
  ): Promise<Awaited<ReturnType<GitProvider["createBranch"]>>> {
    const branch = await super.createBranch(input);
    this.content?.copyRevision(input.from, input.branch);
    return branch;
  }

  override async commitFiles(
    input: Parameters<GitProvider["commitFiles"]>[0],
  ): Promise<Awaited<ReturnType<GitProvider["commitFiles"]>>> {
    const committed = await super.commitFiles(input);
    this.content?.recordRevision(input.branch, committed.sha);
    return committed;
  }

  override async mergePullRequest(
    input: Parameters<GitProvider["mergePullRequest"]>[0],
  ): Promise<Awaited<ReturnType<GitProvider["mergePullRequest"]>>> {
    const pullRequest = this.pullRequest(input.number);
    const merged = await super.mergePullRequest(input);
    if (pullRequest !== undefined) {
      this.content?.mergeRef(pullRequest.head, pullRequest.base, merged.sha);
    }
    return merged;
  }
}

class MemoryReviewPort implements ReviewPort {
  private readonly comments = new Map<number, ReviewComment[]>();
  private readonly assignments = new Map<number, ReviewAssignment>();

  async addComment(input: {
    readonly pullRequestNumber: number;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
  }): Promise<ReviewComment> {
    const values = this.comments.get(input.pullRequestNumber) ?? [];
    const comment: ReviewComment = {
      id: `comment_${String(values.length + 1)}`,
      author: "sandbox-reviewer",
      body: input.body,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.line === undefined ? {} : { line: input.line }),
      createdAt: new Date("2026-07-27T12:00:00.000Z").toISOString(),
      resolved: false,
    };
    values.push(comment);
    this.comments.set(input.pullRequestNumber, values);
    return structuredClone(comment);
  }

  async listComments(pullRequestNumber: number): Promise<readonly ReviewComment[]> {
    return structuredClone(this.comments.get(pullRequestNumber) ?? []);
  }

  async resolveComment(input: {
    readonly pullRequestNumber: number;
    readonly commentId: string;
    readonly resolved: boolean;
  }): Promise<ReviewComment> {
    const values = this.comments.get(input.pullRequestNumber) ?? [];
    const index = values.findIndex((comment) => comment.id === input.commentId);
    if (index < 0) throw new Error("Review comment not found.");
    const existing = values[index];
    if (existing === undefined) throw new Error("Review comment not found.");
    const comment = { ...existing, resolved: input.resolved };
    values[index] = comment;
    return structuredClone(comment);
  }

  async assignReviewers(input: {
    readonly pullRequestNumber: number;
    readonly users: readonly string[];
    readonly teams: readonly string[];
  }): Promise<ReviewAssignment> {
    const assignment = {
      users: [...new Set(input.users)].sort(),
      teams: [...new Set(input.teams)].sort(),
    };
    this.assignments.set(input.pullRequestNumber, assignment);
    return structuredClone(assignment);
  }

  async listReviewers(pullRequestNumber: number): Promise<ReviewAssignment> {
    return structuredClone(this.assignments.get(pullRequestNumber) ?? { users: [], teams: [] });
  }

  async listChecks(ref?: GitCommitSha, signal?: AbortSignal): Promise<readonly ReviewCheck[]> {
    void ref;
    void signal;
    return [
      {
        name: "Content validation",
        status: "completed",
        conclusion: "success",
        required: true,
      },
      {
        name: "Preview render",
        status: "completed",
        conclusion: "success",
        required: true,
      },
    ];
  }
}

class MemoryReleaseStore implements ReleaseStore {
  private readonly releases = new Map<ReleaseId, StoredRelease>();
  private readonly environments = new Map<EnvironmentPointer["environment"], EnvironmentPointer>();

  async writeRelease(release: StoredRelease): Promise<void> {
    const existing = this.releases.get(release.id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(release)) {
      throw new Error("An immutable release cannot be overwritten.");
    }
    this.releases.set(release.id, structuredClone(release));
  }

  async readRelease(id: ReleaseId): Promise<StoredRelease | undefined> {
    const release = this.releases.get(id);
    return release === undefined ? undefined : structuredClone(release);
  }

  async listReleases(
    input: {
      readonly cursor?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Page<StoredRelease>> {
    void input;
    return {
      items: [...this.releases.values()]
        .sort((left, right) => String(right.id).localeCompare(String(left.id)))
        .map((release) => structuredClone(release)),
    };
  }

  async readPointer(
    environment: EnvironmentPointer["environment"],
  ): Promise<EnvironmentPointer | undefined> {
    const pointer = this.environments.get(environment);
    return pointer === undefined ? undefined : structuredClone(pointer);
  }

  async compareAndSwapPointer(input: {
    readonly next: EnvironmentPointer;
    readonly expectedRevision?: string;
  }): Promise<EnvironmentPointer> {
    const current = this.environments.get(input.next.environment);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_STORAGE_409",
        message: "The environment pointer changed.",
        category: "conflict",
        retryable: true,
      });
    }
    this.environments.set(input.next.environment, structuredClone(input.next));
    return structuredClone(input.next);
  }

  pointers(): readonly EnvironmentPointer[] {
    return [...this.environments.values()].map((pointer) => structuredClone(pointer));
  }
}

export interface MemoryHostedRuntimeInput {
  readonly actor: Actor;
  readonly reviewer?: Actor;
  readonly initialChange?: Change;
  readonly documents: readonly ContentDocument[];
  readonly assets?: readonly Asset[];
  readonly projectName: string;
  readonly stagingUrl?: string;
  readonly productionUrl?: string;
}

const sharedRuntimes = globalThis as typeof globalThis & {
  __gitNativeCmsMemoryRuntimes?: Map<string, HostedCmsRuntime>;
};

function documentRef(change: Change): string {
  if (change.status === "published") return "main";
  if (change.status === "staging") return "staging";
  return change.branchName;
}

function isChange(value: unknown): value is Change {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

function isHostedCmsRuntime(value: unknown): value is HostedCmsRuntime {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.handle === "function" && typeof record.editorState === "function";
}

export function createMemoryHostedRuntime(input: MemoryHostedRuntimeInput): HostedCmsRuntime {
  const runtimes =
    sharedRuntimes.__gitNativeCmsMemoryRuntimes ??
    (sharedRuntimes.__gitNativeCmsMemoryRuntimes = new Map());
  const cached: unknown = runtimes.get(input.projectName);
  if (isHostedCmsRuntime(cached)) return cached;
  const git = new CoupledGitProvider();
  const content = new CoupledContentRepository(git);
  git.connect(content);
  const audit = new MemoryAuditSink();
  const review = new MemoryReviewPort();
  const releases = new MemoryReleaseStore();
  const changes = new Map<string, Change>();
  const assets = [...(input.assets ?? [])];
  let initialized: Promise<void> | undefined;
  let application: ReturnType<typeof createCmsApplication>;
  let server: ReturnType<typeof createCmsServer>;

  const reviewer: Actor =
    input.reviewer ??
    ({
      ...input.actor,
      id: `${String(input.actor.id)}_reviewer` as Actor["id"],
      login: `${input.actor.login}-reviewer`,
      displayName: `${input.actor.displayName} Reviewer`,
      roles: ["publisher"],
    } satisfies Actor);

  async function listPointers(): Promise<readonly EnvironmentPointer[]> {
    return releases.pointers();
  }

  async function ensureInitialized(): Promise<void> {
    initialized ??= (async () => {
      await content.seed("main", input.documents);
      await content.seed("staging", input.documents);
      if (input.initialChange !== undefined) {
        const main = await git.resolveRef("main");
        await git.createBranch({
          branch: input.initialChange.branchName,
          from: main.sha,
          idempotencyKey: "fixture:initial-change",
        });
        changes.set(input.initialChange.id, {
          ...input.initialChange,
          baseCommit: main.sha,
        });
      }

      application = createCmsApplication({
        git,
        content,
        authorization: new AuthorizationService(),
        clock: new FixedClock(),
        ids: new DeterministicIds(),
        idempotency: new MemoryIdempotencyStore(),
        audit,
        auditQuery: audit,
        review,
        releaseStore: releases,
        releaseBuilder: deterministicReleaseBuilder,
      });
      server = createCmsServer({
        application,
        actorForRequest: async (request) =>
          new URL(request.url).pathname.endsWith("/approve") ? reviewer : input.actor,
        verifyCsrf: async (request) => request.headers.get("x-csrf-token") === "sandbox",
        verifyConfirmation: async (token) => token === "sandbox-confirmation",
        queries: {
          bootstrap: async () => ({
            actor: input.actor,
            project: { name: input.projectName, locales: ["en-US", "pl-PL"] },
            capabilities: { preview: true, github: true, releases: true },
          }),
          staging: async () => ({
            revision: (await git.resolveRef("staging")).sha,
            changes: [...changes.values()].filter((change) => change.status === "staging"),
            pointer: await releases.readPointer("staging"),
          }),
          listChanges: async () => [...changes.values()].map((change) => structuredClone(change)),
          getChange: async (id) => {
            const change = changes.get(id);
            if (change === undefined) throw new Error(`Unknown Change ${id}.`);
            return structuredClone(change);
          },
          listDocuments: async (changeId) => {
            const change = changes.get(changeId);
            if (change === undefined) throw new Error(`Unknown Change ${changeId}.`);
            return content.listDocuments({ ref: documentRef(change) });
          },
          getDocument: async (changeId, documentId) => {
            const change = changes.get(changeId);
            if (change === undefined) throw new Error(`Unknown Change ${changeId}.`);
            return content.readDocument({ ref: documentRef(change), documentId });
          },
          listReleases: async () => (await releases.listReleases({})).items,
          listAssets: async () => ({ items: assets }),
          getAsset: async (id) => {
            const asset = assets.find((candidate) => candidate.id === id);
            if (asset === undefined) throw new Error("Asset not found.");
            return asset;
          },
          assetUsages: async () => [],
          search: async () => [],
          findUsages: async () => [],
          exportTranslation: async () => "",
        },
      });

      const main = await git.resolveRef("main");
      await application.buildAndPublishRelease.execute(
        {
          ref: "main",
          expectedRevision: main.sha,
          environment: "production",
          configVersion: 1,
          registryDigest,
          schemaVersion: 1,
          idempotencyKey: "fixture:initial-release",
        },
        { actor: input.actor, requestId: "fixture_initial_release" },
      );
    })();
    return initialized;
  }

  async function editorState(
    _request: Request | string | null,
    path = "",
  ): Promise<HostedEditorState> {
    await ensureInitialized();
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    const changeId =
      segments[0] === "changes" && segments[1] !== undefined ? segments[1] : undefined;
    if (changeId === undefined) {
      const requestedView = segments[0];
      const view =
        requestedView === "staging" ||
        requestedView === "releases" ||
        requestedView === "assets" ||
        requestedView === "settings" ||
        requestedView === "developer"
          ? requestedView
          : "dashboard";
      const staging = await application.readStagingBatch.execute({
        actor: input.actor,
        requestId: "fixture_staging",
      });
      return {
        authenticated: true,
        view,
        actor: input.actor,
        changes: [...changes.values()],
        releases: (await releases.listReleases({})).items,
        pointers: await listPointers(),
        assets,
        stagingRevision: staging.revision,
        ...(staging.lock === undefined ? {} : { stagingLock: staging.lock }),
        registryDigest,
        stagingUrl: input.stagingUrl ?? "/",
        productionUrl: input.productionUrl ?? "/",
        csrfToken: "sandbox",
        projectName: input.projectName,
      };
    }
    const change = changes.get(changeId);
    if (change === undefined) throw new Error(`Unknown Change ${changeId}.`);
    const ref = documentRef(change);
    const summaries = await content.listDocuments({ ref });
    const requestedId =
      segments[2] === "documents" && segments[3] !== undefined
        ? (segments[3] as DocumentId)
        : undefined;
    const documentId =
      requestedId ??
      summaries.items.find((summary) => summary.id === input.documents[0]?.id)?.id ??
      summaries.items[0]?.id;
    if (documentId === undefined) throw new Error("The fixture has no content documents.");
    const contentDocuments = (await Promise.all(
      summaries.items.map((summary) => content.readDocument({ ref, documentId: summary.id })),
    )) as readonly ContentDocument<HostedEditablePage>[];
    const document = (await content.readDocument({
      ref,
      documentId,
    })) as ContentDocument<HostedEditablePage>;
    const previewDocument =
      contentDocuments.find((candidate) => candidate.type === "pages") ?? document;
    const pullRequestNumber = change.pullRequestNumber;
    const comments =
      pullRequestNumber === undefined ? [] : await review.listComments(pullRequestNumber);
    const checks =
      pullRequestNumber === undefined ? [] : await review.listChecks(change.baseCommit);
    const assignment =
      pullRequestNumber === undefined
        ? { users: [], teams: [] }
        : await review.listReviewers(pullRequestNumber);
    const timeline = await audit.list({ resourceId: change.id });
    const conflictState = await application.readChangeConflicts.execute(
      { change },
      { actor: input.actor, requestId: "fixture_conflicts" },
    );
    const baseContentDocuments = (await Promise.all(
      summaries.items.map((summary) =>
        content
          .readDocument({ ref: change.baseCommit, documentId: summary.id })
          .catch(() => undefined),
      ),
    )) as readonly (ContentDocument<HostedEditablePage> | undefined)[];
    const baseDocument = baseContentDocuments.find((candidate) => candidate?.id === documentId);
    const productionDocument = (await content
      .readDocument({ ref: "main", documentId })
      .catch(() => undefined)) as ContentDocument<HostedEditablePage> | undefined;
    const changedDocumentIds = contentDocuments
      .filter((candidate, index) => {
        const base = baseContentDocuments[index];
        return base === undefined || canonicalJson(base.data) !== canonicalJson(candidate.data);
      })
      .map((candidate) => candidate.id);
    return {
      authenticated: true,
      view: "workspace",
      actor: input.actor,
      change,
      document,
      ...(baseDocument === undefined ? {} : { baseDocument }),
      ...(productionDocument === undefined ? {} : { productionDocument }),
      conflicts: conflictState.conflicts,
      documents: summaries.items,
      contentDocuments,
      previewDocument,
      assets,
      review: {
        comments,
        checks,
        assignment,
        timeline,
        summary: {
          changedDocumentIds,
          affectedUsages: 0,
          warnings: 0,
        },
      },
      translationProviderAvailable: false,
      registryDigest,
      csrfToken: "sandbox",
      projectName: input.projectName,
    };
  }

  const runtime: HostedCmsRuntime = {
    async handle(request): Promise<Response> {
      await ensureInitialized();
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/cms/confirmations") {
        return Response.json({ token: "sandbox-confirmation" });
      }
      const response = await server.handle(request);
      const envelope = (await response
        .clone()
        .json()
        .catch(() => undefined)) as
        { readonly payload?: Readonly<Record<string, unknown>> } | undefined;
      const changed = envelope?.payload?.change;
      if (isChange(changed)) changes.set(changed.id, structuredClone(changed));
      if (request.method === "POST" && url.pathname === "/api/cms/changes") {
        const created = envelope?.payload?.change;
        if (isChange(created)) changes.set(created.id, structuredClone(created));
      }
      if (request.method === "POST" && url.pathname === "/api/cms/staging/publish" && response.ok) {
        for (const [id, change] of changes) {
          if (change.status === "staging") changes.set(id, { ...change, status: "published" });
        }
      }
      return response;
    },
    editorState,
  };
  runtimes.set(input.projectName, runtime);
  return runtime;
}

export type { AuditEvent };
