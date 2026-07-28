import {
  CmsError,
  createPrefixedId,
  type Actor,
  type ChangeId,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type Revision,
} from "@git-native-cms/core";
import type {
  AuditEvent,
  AuditQueryPort,
  AuditSink,
  Clock,
  ContentRepository,
  DocumentSummary,
  GitFile,
  GitProvider,
  GitRef,
  IdGenerator,
  IdempotencyStore,
  Page,
  PullRequest,
  ProjectConfig,
  RegistryLock,
} from "@git-native-cms/application";

export class FixedClock implements Clock {
  constructor(private current: Date = new Date("2026-07-27T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class DeterministicIds implements IdGenerator {
  private sequence = 0;
  changeId(): ChangeId {
    this.sequence += 1;
    return createPrefixedId<"ChangeId">("chg", {
      now: this.sequence,
      random: new Uint8Array(10),
    });
  }
  documentId(): DocumentId {
    this.sequence += 1;
    return createPrefixedId<"DocumentId">("doc", {
      now: this.sequence,
      random: new Uint8Array(10),
    });
  }
  scheduleId(): string {
    this.sequence += 1;
    return createPrefixedId<"ScheduleId">("sch", {
      now: this.sequence,
      random: new Uint8Array(10),
    });
  }
  requestId(): string {
    this.sequence += 1;
    return `req_${this.sequence}`;
  }
  suffix(): string {
    this.sequence += 1;
    return this.sequence.toString(36).padStart(4, "0");
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly values = new Map<string, unknown>();
  async read<TResult>(key: string): Promise<TResult | undefined> {
    return this.values.get(key) as TResult | undefined;
  }
  async write<TResult>(key: string, result: TResult): Promise<void> {
    this.values.set(key, structuredClone(result));
  }
}

export class MemoryAuditSink implements AuditSink, AuditQueryPort {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async list(input: {
    readonly resourceId?: string;
    readonly limit?: number;
  }): Promise<readonly AuditEvent[]> {
    return this.events
      .filter((event) => input.resourceId === undefined || event.resourceId === input.resourceId)
      .slice(-(input.limit ?? 100))
      .reverse()
      .map((event) => structuredClone(event));
  }
}

interface BranchState {
  sha: GitCommitSha;
  files: Map<string, string>;
}

export class MemoryGitProvider implements GitProvider {
  private counter = 2;
  private readonly branches = new Map<string, BranchState>();
  private readonly snapshots = new Map<GitCommitSha, Map<string, string>>();
  private readonly pullRequests = new Map<number, PullRequest>();
  private readonly mergedSnapshots = new Map<
    number,
    {
      readonly base: string;
      readonly before: Map<string, string>;
      readonly head: Map<string, string>;
    }
  >();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.branches.set("main", {
      sha: "0000000000000000000000000000000000000001" as GitCommitSha,
      files: new Map(Object.entries(initial)),
    });
    this.branches.set("staging", {
      sha: "0000000000000000000000000000000000000002" as GitCommitSha,
      files: new Map(Object.entries(initial)),
    });
    for (const branch of this.branches.values()) {
      this.snapshots.set(branch.sha, new Map(branch.files));
    }
  }

  private nextSha(): GitCommitSha {
    this.counter += 1;
    return this.counter.toString(16).padStart(40, "0") as GitCommitSha;
  }

  private branch(name: string): BranchState {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new Error(`Unknown branch ${name}.`);
    return branch;
  }

  private filesAt(ref: string): Map<string, string> {
    const branch = this.branches.get(ref);
    if (branch !== undefined) return branch.files;
    const snapshot = this.snapshots.get(ref as GitCommitSha);
    if (snapshot !== undefined) return snapshot;
    throw new Error(`Unknown branch or revision ${ref}.`);
  }

  async resolveRef(ref: string): Promise<GitRef> {
    const branch = this.branches.get(ref);
    if (branch !== undefined) return { name: ref, sha: branch.sha };
    if (this.snapshots.has(ref as GitCommitSha)) {
      return { name: ref, sha: ref as GitCommitSha };
    }
    throw new Error(`Unknown branch or revision ${ref}.`);
  }

  async listBranches(input: { readonly prefix?: string }): Promise<readonly GitRef[]> {
    return [...this.branches.entries()]
      .filter(([name]) => input.prefix === undefined || name.startsWith(input.prefix))
      .map(([name, branch]) => ({ name, sha: branch.sha }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createBranch(input: {
    readonly branch: string;
    readonly from: GitCommitSha;
  }): Promise<GitRef> {
    const existing = this.branches.get(input.branch);
    if (existing !== undefined) return { name: input.branch, sha: existing.sha };
    const source = this.snapshots.get(input.from);
    if (source === undefined) throw new Error(`Unknown source revision ${input.from}.`);
    this.branches.set(input.branch, { sha: input.from, files: new Map(source) });
    return { name: input.branch, sha: input.from };
  }

  async deleteBranch(input: { readonly branch: string }): Promise<void> {
    this.branches.delete(input.branch);
  }

  async readFile(input: {
    readonly ref: string;
    readonly path: string;
  }): Promise<GitFile | undefined> {
    const content = this.filesAt(input.ref).get(input.path);
    return content === undefined ? undefined : { path: input.path, content };
  }

  async listFiles(input: {
    readonly ref: string;
    readonly prefix: string;
  }): Promise<readonly GitFile[]> {
    return [...this.filesAt(input.ref).entries()]
      .filter(([path]) => path.startsWith(input.prefix))
      .map(([path, content]) => ({ path, content }));
  }

  async commitFiles(input: {
    readonly branch: string;
    readonly expectedSha: GitCommitSha;
    readonly files: readonly { readonly path: string; readonly content: string | null }[];
  }): Promise<GitRef> {
    const branch = this.branch(input.branch);
    if (branch.sha !== input.expectedSha) {
      throw new CmsError({
        code: "CMS_GIT_012",
        message: "The branch moved while committing.",
        category: "conflict",
        retryable: true,
      });
    }
    for (const file of input.files) {
      if (file.content === null) branch.files.delete(file.path);
      else branch.files.set(file.path, file.content);
    }
    branch.sha = this.nextSha();
    this.snapshots.set(branch.sha, new Map(branch.files));
    return { name: input.branch, sha: branch.sha };
  }

  async createPullRequest(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<PullRequest> {
    const existing = [...this.pullRequests.values()].find(
      (pullRequest) =>
        pullRequest.head === input.head &&
        pullRequest.base === input.base &&
        pullRequest.state === "open",
    );
    if (existing !== undefined) return existing;
    const number = this.pullRequests.size + 1;
    const pullRequest: PullRequest = {
      number,
      url: `https://example.test/pull/${number}`,
      head: input.head,
      base: input.base,
      state: "open",
    };
    this.pullRequests.set(number, pullRequest);
    return pullRequest;
  }

  async createRevertPullRequest(input: {
    readonly pullRequestNumber: number;
    readonly title: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): Promise<PullRequest> {
    const snapshot = this.mergedSnapshots.get(input.pullRequestNumber);
    if (snapshot === undefined) throw new Error("Pull request has not been merged.");
    const branchName = `revert-${String(input.pullRequestNumber)}`;
    const base = this.branch(snapshot.base);
    const reverted = new Map(base.files);
    const paths = new Set([...snapshot.before.keys(), ...snapshot.head.keys()]);
    for (const path of paths) {
      if (snapshot.before.get(path) === snapshot.head.get(path)) continue;
      const previous = snapshot.before.get(path);
      if (previous === undefined) reverted.delete(path);
      else reverted.set(path, previous);
    }
    const sha = this.nextSha();
    this.branches.set(branchName, {
      sha,
      files: reverted,
    });
    this.snapshots.set(sha, new Map(reverted));
    return this.createPullRequest({ head: branchName, base: snapshot.base });
  }

  async approvePullRequest(): Promise<void> {}

  pullRequest(number: number): PullRequest | undefined {
    const pullRequest = this.pullRequests.get(number);
    return pullRequest === undefined ? undefined : structuredClone(pullRequest);
  }

  async mergePullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitCommitSha;
  }): Promise<GitRef> {
    const pullRequest = this.pullRequests.get(input.number);
    if (pullRequest === undefined) throw new Error("Pull request does not exist.");
    const head = this.branch(pullRequest.head);
    if (head.sha !== input.expectedHeadSha) throw new Error("Pull request head changed.");
    const base = this.branch(pullRequest.base);
    this.mergedSnapshots.set(input.number, {
      base: pullRequest.base,
      before: new Map(base.files),
      head: new Map(head.files),
    });
    base.files = new Map(head.files);
    base.sha = this.nextSha();
    this.snapshots.set(base.sha, new Map(base.files));
    this.pullRequests.set(input.number, { ...pullRequest, state: "merged" });
    return { name: pullRequest.base, sha: base.sha };
  }
}

export class MemoryContentRepository implements ContentRepository {
  private revisionCounter = 1;
  private readonly byRef = new Map<string, Map<DocumentId, ContentDocument>>();
  private readonly mutations = new Map<
    string,
    { readonly fingerprint: string; readonly revision: Revision }
  >();

  seed(ref: string, document: ContentDocument): void {
    const documents = this.byRef.get(ref) ?? new Map();
    documents.set(document.id, structuredClone(document));
    this.byRef.set(ref, documents);
  }

  async listDocuments(input: {
    readonly ref: string;
    readonly type?: string;
  }): Promise<Page<DocumentSummary>> {
    const documents = [...(this.byRef.get(input.ref)?.values() ?? [])].filter(
      (document) => input.type === undefined || document.type === input.type,
    );
    return {
      items: documents.map((document) => ({
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
      })),
    };
  }

  async readDocument(input: {
    readonly ref: string;
    readonly documentId: DocumentId;
  }): Promise<ContentDocument> {
    const document = this.byRef.get(input.ref)?.get(input.documentId);
    if (document === undefined) throw new Error(`Unknown document ${input.documentId}.`);
    return structuredClone(document);
  }

  async writeDocuments(input: {
    readonly ref: string;
    readonly documents: readonly ContentDocument[];
    readonly expectedRevision: Revision;
    readonly idempotencyKey: string;
  }): Promise<Revision> {
    const fingerprint = JSON.stringify({
      operation: "write",
      ref: input.ref,
      documents: input.documents,
      expectedRevision: input.expectedRevision,
    });
    const previous = this.mutations.get(input.idempotencyKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error("Idempotency key was reused for a different content write.");
      }
      return previous.revision;
    }
    const documents = this.byRef.get(input.ref) ?? new Map();
    for (const document of input.documents) {
      if (document.revision !== input.expectedRevision) {
        throw new Error("Document revision changed.");
      }
    }
    this.revisionCounter += 1;
    const revision = `sha_content_${this.revisionCounter}` as Revision;
    for (const document of input.documents) {
      documents.set(document.id, { ...structuredClone(document), revision });
    }
    this.byRef.set(input.ref, documents);
    this.mutations.set(input.idempotencyKey, { fingerprint, revision });
    return revision;
  }

  async deleteDocuments(input: {
    readonly ref: string;
    readonly documentIds: readonly DocumentId[];
    readonly expectedRevision: Revision;
    readonly idempotencyKey: string;
  }): Promise<Revision> {
    const fingerprint = JSON.stringify({
      operation: "delete",
      ref: input.ref,
      documentIds: input.documentIds,
      expectedRevision: input.expectedRevision,
    });
    const previous = this.mutations.get(input.idempotencyKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error("Idempotency key was reused for a different content delete.");
      }
      return previous.revision;
    }
    const documents = this.byRef.get(input.ref) ?? new Map();
    for (const id of input.documentIds) documents.delete(id);
    this.revisionCounter += 1;
    const revision = `sha_content_${this.revisionCounter}` as Revision;
    this.mutations.set(input.idempotencyKey, { fingerprint, revision });
    return revision;
  }

  async readProjectConfig(): Promise<ProjectConfig> {
    return { configVersion: 1, defaultLocale: "en-US" };
  }

  async readRegistryLock(): Promise<RegistryLock> {
    return { registryDigest: `sha256:${"0".repeat(64)}`, schemaVersion: 1 };
  }
}

export const testActor: Actor = {
  id: "actor_test" as Actor["id"],
  githubId: 1,
  login: "editor",
  displayName: "Test Editor",
  roles: ["administrator"],
  source: "ui",
};
