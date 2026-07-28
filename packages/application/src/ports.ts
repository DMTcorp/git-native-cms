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
  listBranches(input: {
    readonly prefix?: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly GitRef[]>;
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
    readonly files: readonly {
      readonly path: string;
      readonly content: string | null;
      readonly encoding?: "utf-8" | "base64";
    }[];
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
  createRevertPullRequest(input: {
    readonly pullRequestNumber: number;
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
  readonly resolved: boolean;
}

export interface ReviewAssignment {
  readonly users: readonly string[];
  readonly teams: readonly string[];
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
  resolveComment(input: {
    readonly pullRequestNumber: number;
    readonly commentId: string;
    readonly resolved: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ReviewComment>;
  assignReviewers(input: {
    readonly pullRequestNumber: number;
    readonly users: readonly string[];
    readonly teams: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<ReviewAssignment>;
  listReviewers(
    pullRequestNumber: number,
    signal?: AbortSignal,
  ): Promise<ReviewAssignment>;
  listChecks(ref: GitCommitSha, signal?: AbortSignal): Promise<readonly ReviewCheck[]>;
}

export interface DocumentSummary {
  readonly id: DocumentId;
  readonly type: string;
  readonly title: string;
  readonly path: string;
  readonly revision: Revision;
}

export interface ProjectConfig {
  readonly configVersion: number;
  readonly defaultLocale?: string;
  readonly [key: string]: unknown;
}

export interface RegistryLock {
  readonly registryDigest: string;
  readonly schemaVersion?: number;
  readonly [key: string]: unknown;
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
  readProjectConfig(ref: string, signal?: AbortSignal): Promise<ProjectConfig>;
  readRegistryLock(ref: string, signal?: AbortSignal): Promise<RegistryLock>;
}

export interface StoredRelease {
  readonly id: ReleaseId;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
}

export interface ReleaseBuildDocument {
  readonly path: string;
  readonly value: unknown;
  readonly tags?: readonly string[];
}

export interface ReleaseBuilderPort {
  build(input: {
    readonly gitCommit: GitCommitSha;
    readonly configVersion: number;
    readonly registryDigest: string;
    readonly schemaVersion: number;
    readonly documents: readonly ReleaseBuildDocument[];
    readonly redirects?: Readonly<Record<string, string>>;
    readonly artifacts?: Readonly<Record<string, string>>;
  }): Promise<StoredRelease>;
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
  listReleases(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<StoredRelease>>;
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
  readonly altText?: string;
  readonly width?: number;
  readonly height?: number;
  readonly focalPoint?: {
    readonly x: number;
    readonly y: number;
  };
  readonly variants?: readonly {
    readonly name?: string;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly url: string;
  }[];
}

export interface AssetReference {
  readonly id: AssetId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly url: string;
  readonly altText?: string;
}

export interface AssetStore {
  createUpload(input: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number;
    readonly checksum: string;
    readonly actor: Actor;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }>;
  uploadBytes?(input: {
    readonly uploadId: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly token?: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  finalizeUpload(input: {
    readonly uploadId: string;
    readonly checksum: string;
    readonly signal?: AbortSignal;
  }): Promise<Asset>;
  readAsset(id: AssetId, signal?: AbortSignal): Promise<Asset | undefined>;
  updateAssetMetadata(input: {
    readonly id: AssetId;
    readonly altText?: string;
    readonly focalPoint?: {
      readonly x: number;
      readonly y: number;
    };
    readonly signal?: AbortSignal;
  }): Promise<Asset>;
  deleteAsset(id: AssetId, signal?: AbortSignal): Promise<void>;
  listAssets(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<Asset>>;
}

export interface PreviewSession {
  readonly id: string;
  readonly actorId: Actor["id"];
  readonly changeId: Change["id"];
  readonly frontendRef: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly token: string;
}

export interface PreviewSessionPort {
  issue(input: {
    readonly actorId: Actor["id"];
    readonly changeId: Change["id"];
    readonly frontendRef: string;
    readonly locale: string;
    readonly now: Date;
    readonly signal?: AbortSignal;
  }): Promise<PreviewSession>;
  verify(input: {
    readonly id: string;
    readonly token: string;
    readonly now: Date;
    readonly signal?: AbortSignal;
  }): Promise<PreviewSession>;
  refresh(input: {
    readonly id: string;
    readonly token: string;
    readonly now: Date;
    readonly signal?: AbortSignal;
  }): Promise<PreviewSession>;
}

export interface AssetUsagePort {
  usages(id: AssetId, signal?: AbortSignal): Promise<readonly string[]>;
  isReleased(id: AssetId, signal?: AbortSignal): Promise<boolean>;
}

export interface AssetProcessorPort {
  process(asset: Asset, signal?: AbortSignal): Promise<Asset>;
}

export interface SessionRecord {
  readonly id: string;
  readonly actor: Actor;
  readonly githubAccessToken?: string;
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

export interface IdentityProfile {
  readonly externalId: string;
  readonly login: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly teams: readonly string[];
}

export interface IdentityProvider {
  resolve(accessToken: string, signal?: AbortSignal): Promise<IdentityProfile>;
}

export interface TeamMember {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly organizationRole: "member" | "admin";
}

export interface OrganizationTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface TeamInvitation {
  readonly id: string;
  readonly email?: string;
  readonly login?: string;
  readonly role: "direct_member" | "admin";
  readonly status: "pending";
}

export interface TeamProvisioningPort {
  listMembers(signal?: AbortSignal): Promise<readonly TeamMember[]>;
  listTeams(signal?: AbortSignal): Promise<readonly OrganizationTeam[]>;
  invite(input: {
    readonly email?: string;
    readonly inviteeId?: number;
    readonly role: "direct_member" | "admin";
    readonly signal?: AbortSignal;
  }): Promise<TeamInvitation>;
  addMemberToTeam(input: {
    readonly teamSlug: string;
    readonly username: string;
    readonly role: "member" | "maintainer";
    readonly signal?: AbortSignal;
  }): Promise<void>;
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

export interface PublicationNotifierPort {
  notify(input: {
    readonly environment: "preview" | "staging" | "production";
    readonly releaseId: ReleaseId;
    readonly revision: GitCommitSha;
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

export interface RateLimitPort {
  consume(input: {
    readonly key: string;
    readonly scope: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly now: string;
  }): Promise<{
    readonly allowed: boolean;
    readonly remaining: number;
    readonly resetAt: string;
  }>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  changeId(): Change["id"];
  documentId(): DocumentId;
  scheduleId(): string;
  requestId(): string;
  suffix(): string;
}

export type ContentScheduleAction =
  | "publish"
  | "unpublish"
  | "availability-start"
  | "availability-end"
  | "visibility-start"
  | "visibility-end";

export interface SchedulerPort {
  workflow(input: {
    readonly scheduleId: string;
    readonly executeAt: string;
    readonly action: ContentScheduleAction;
    readonly documentIds: readonly DocumentId[];
  }): { readonly path: string; readonly content: string };
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

export interface AuditQueryPort {
  list(input: {
    readonly resourceId?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly AuditEvent[]>;
}
