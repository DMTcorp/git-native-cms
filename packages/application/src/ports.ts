import type {
  Actor,
  AssetId,
  Change,
  ContentDocument,
  DocumentId,
  GitCommitSha,
  ReleaseId,
  Revision,
} from "@git-native-cms/core";

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: string;
}

export interface GitRef {
  readonly name: string;
  readonly sha: GitCommitSha;
}

export interface GitFile {
  readonly path: string;
  readonly content: string;
  readonly sha?: GitCommitSha;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly state: "open" | "closed" | "merged";
}

export interface GitProvider {
  resolveRef(ref: string, signal?: AbortSignal): Promise<GitRef>;
  createBranch(input: {
    readonly branch: string;
    readonly from: GitCommitSha;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<GitRef>;
  deleteBranch(input: { readonly branch: string; readonly signal?: AbortSignal }): Promise<void>;
  readFile(input: {
    readonly ref: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<GitFile | undefined>;
  listFiles(input: {
    readonly ref: string;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly GitFile[]>;
  commitFiles(input: {
    readonly branch: string;
    readonly expectedSha: GitCommitSha;
    readonly files: readonly { readonly path: string; readonly content: string | null }[];
    readonly message: string;
    readonly author: Actor;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<GitRef>;
  createPullRequest(input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<PullRequest>;
  approvePullRequest(input: {
    readonly number: number;
    readonly actor: Actor;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  mergePullRequest(input: {
    readonly number: number;
    readonly strategy: "squash" | "merge";
    readonly expectedHeadSha: GitCommitSha;
    readonly signal?: AbortSignal;
  }): Promise<GitRef>;
}

export interface ReviewComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly createdAt: string;
}

export interface ReviewCheck {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "cancelled" | "skipped" | "neutral";
  readonly required: boolean;
  readonly url?: string;
}

export interface ReviewPort {
  addComment(input: {
    readonly pullRequestNumber: number;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
    readonly signal?: AbortSignal;
  }): Promise<ReviewComment>;
  listComments(pullRequestNumber: number, signal?: AbortSignal): Promise<readonly ReviewComment[]>;
  listChecks(ref: GitCommitSha, signal?: AbortSignal): Promise<readonly ReviewCheck[]>;
}

export interface DocumentSummary {
  readonly id: DocumentId;
  readonly type: string;
  readonly title: string;
  readonly path: string;
  readonly revision: Revision;
}

export interface ContentRepository {
  listDocuments(input: {
    readonly ref: string;
    readonly type?: string;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<DocumentSummary>>;
  readDocument(input: {
    readonly ref: string;
    readonly documentId: DocumentId;
    readonly signal?: AbortSignal;
  }): Promise<ContentDocument>;
  writeDocuments(input: {
    readonly ref: string;
    readonly documents: readonly ContentDocument[];
    readonly expectedRevision: Revision;
    readonly message: string;
    readonly actor: Actor;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<Revision>;
  deleteDocuments(input: {
    readonly ref: string;
    readonly documentIds: readonly DocumentId[];
    readonly expectedRevision: Revision;
    readonly actor: Actor;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<Revision>;
}

export interface StoredRelease {
  readonly id: ReleaseId;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
}

export interface EnvironmentPointer {
  readonly environment: "preview" | "staging" | "production";
  readonly releaseId: ReleaseId;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface ReleaseStore {
  writeRelease(release: StoredRelease, signal?: AbortSignal): Promise<void>;
  readRelease(id: ReleaseId, signal?: AbortSignal): Promise<StoredRelease | undefined>;
  readPointer(
    environment: EnvironmentPointer["environment"],
    signal?: AbortSignal,
  ): Promise<EnvironmentPointer | undefined>;
  compareAndSwapPointer(input: {
    readonly next: EnvironmentPointer;
    readonly expectedRevision?: string;
    readonly signal?: AbortSignal;
  }): Promise<EnvironmentPointer>;
}

export interface Asset {
  readonly id: AssetId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
  readonly url: string;
}

export interface AssetStore {
  createUpload(input: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number;
    readonly actor: Actor;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }>;
  finalizeUpload(input: {
    readonly uploadId: string;
    readonly checksum: string;
    readonly signal?: AbortSignal;
  }): Promise<Asset>;
  readAsset(id: AssetId, signal?: AbortSignal): Promise<Asset | undefined>;
  deleteAsset(id: AssetId, signal?: AbortSignal): Promise<void>;
  listAssets(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<Asset>>;
}

export interface SessionRecord {
  readonly id: string;
  readonly actor: Actor;
  readonly csrfSecret: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export interface SessionStore {
  read(id: string): Promise<SessionRecord | undefined>;
  write(session: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface DeploymentPort {
  deploy(input: {
    readonly environment: "preview" | "staging" | "production";
    readonly releaseId: ReleaseId;
    readonly revision: GitCommitSha;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly deploymentId: string; readonly url?: string }>;
}

export interface RevalidationPort {
  revalidate(input: {
    readonly environment: "preview" | "staging" | "production";
    readonly tags: readonly string[];
    readonly paths: readonly string[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface TranslationProvider {
  createJob(input: {
    readonly sourceLocale: string;
    readonly targetLocale: string;
    readonly xliff: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly jobId: string }>;
  readJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "queued" | "working" }
    | { readonly status: "complete"; readonly xliff: string }
    | { readonly status: "failed"; readonly message: string }
  >;
}

export interface WebhookReplayStore {
  claim(deliveryId: string, expiresAt: string): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  changeId(): Change["id"];
  requestId(): string;
  suffix(): string;
}

export interface IdempotencyStore {
  read<TResult>(key: string): Promise<TResult | undefined>;
  write<TResult>(key: string, result: TResult): Promise<void>;
}

export interface AuditEvent {
  readonly type: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly source: Actor["source"];
  readonly timestamp: string;
  readonly resourceId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}
