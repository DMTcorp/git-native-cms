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

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

interface BranchState {
  sha: GitCommitSha;
  files: Map<string, string>;
}

export class MemoryGitProvider implements GitProvider {
  private counter = 1;
  private readonly branches = new Map<string, BranchState>();
  private readonly pullRequests = new Map<number, PullRequest>();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.branches.set("main", {
      sha: "sha_main_1" as GitCommitSha,
      files: new Map(Object.entries(initial)),
    });
    this.branches.set("staging", {
      sha: "sha_staging_1" as GitCommitSha,
      files: new Map(Object.entries(initial)),
    });
  }

  private branch(name: string): BranchState {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new Error(`Unknown branch ${name}.`);
    return branch;
  }

  async resolveRef(ref: string): Promise<GitRef> {
    return { name: ref, sha: this.branch(ref).sha };
  }

  async createBranch(input: {
    readonly branch: string;
    readonly from: GitCommitSha;
  }): Promise<GitRef> {
    const existing = this.branches.get(input.branch);
    if (existing !== undefined) return { name: input.branch, sha: existing.sha };
    const source = [...this.branches.values()].find((branch) => branch.sha === input.from);
    if (source === undefined) throw new Error(`Unknown source revision ${input.from}.`);
    this.branches.set(input.branch, { sha: source.sha, files: new Map(source.files) });
    return { name: input.branch, sha: source.sha };
  }

  async deleteBranch(input: { readonly branch: string }): Promise<void> {
    this.branches.delete(input.branch);
  }

  async readFile(input: {
    readonly ref: string;
    readonly path: string;
  }): Promise<GitFile | undefined> {
    const content = this.branch(input.ref).files.get(input.path);
    return content === undefined ? undefined : { path: input.path, content };
  }

  async listFiles(input: {
    readonly ref: string;
    readonly prefix: string;
  }): Promise<readonly GitFile[]> {
    return [...this.branch(input.ref).files.entries()]
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
    this.counter += 1;
    branch.sha = `sha_${this.counter}` as GitCommitSha;
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

  async approvePullRequest(): Promise<void> {}

  async mergePullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitCommitSha;
  }): Promise<GitRef> {
    const pullRequest = this.pullRequests.get(input.number);
    if (pullRequest === undefined) throw new Error("Pull request does not exist.");
    const head = this.branch(pullRequest.head);
    if (head.sha !== input.expectedHeadSha) throw new Error("Pull request head changed.");
    const base = this.branch(pullRequest.base);
    base.files = new Map(head.files);
    this.counter += 1;
    base.sha = `sha_${this.counter}` as GitCommitSha;
    this.pullRequests.set(input.number, { ...pullRequest, state: "merged" });
    return { name: pullRequest.base, sha: base.sha };
  }
}

export class MemoryContentRepository implements ContentRepository {
  private revisionCounter = 1;
  private readonly byRef = new Map<string, Map<DocumentId, ContentDocument>>();

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
  }): Promise<Revision> {
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
    return revision;
  }

  async deleteDocuments(input: {
    readonly ref: string;
    readonly documentIds: readonly DocumentId[];
  }): Promise<Revision> {
    const documents = this.byRef.get(input.ref) ?? new Map();
    for (const id of input.documentIds) documents.delete(id);
    this.revisionCounter += 1;
    return `sha_content_${this.revisionCounter}` as Revision;
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
