import { yamlCodec } from "@git-native-cms/content-codecs";
import {
  CmsError,
  isoTimestamp,
  type Actor,
  type Change,
  type ChangeStatus,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type ReleaseId,
  type Revision,
} from "@git-native-cms/core";
import { applyPatches, type ContentPatch } from "@git-native-cms/document-model";
import { buildChangeBranchName, changeCommitMessage } from "@git-native-cms/git";
import type { AuthorizationService } from "@git-native-cms/permissions";
import type {
  AuditSink,
  Clock,
  ContentRepository,
  DocumentSummary,
  GitProvider,
  IdGenerator,
  IdempotencyStore,
  PullRequest,
  ReleaseBuilderPort,
  ReviewComment,
  ReviewPort,
  ReleaseStore,
  StoredRelease,
} from "./ports.js";

export * from "./ports.js";

export interface RequestContext {
  readonly actor: Actor;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface CommandDependencies {
  readonly git: GitProvider;
  readonly content: ContentRepository;
  readonly authorization: AuthorizationService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditSink;
  readonly releaseStore?: ReleaseStore;
  readonly releaseBuilder?: ReleaseBuilderPort;
  readonly review?: ReviewPort;
  readonly mainBranch?: string;
  readonly stagingBranch?: string;
}

async function once<TResult>(
  store: IdempotencyStore,
  key: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const existing = await store.read<TResult>(key);
  if (existing !== undefined) return existing;
  const result = await operation();
  await store.write(key, result);
  return result;
}

async function audit(
  sink: AuditSink,
  clock: Clock,
  context: RequestContext,
  type: string,
  resourceId?: string,
  details?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await sink.write({
    type,
    actorId: context.actor.id,
    requestId: context.requestId,
    source: context.actor.source,
    timestamp: clock.now().toISOString(),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(details === undefined ? {} : { details }),
  });
}

function mainBranch(dependencies: CommandDependencies): string {
  return dependencies.mainBranch ?? "main";
}

function stagingBranch(dependencies: CommandDependencies): string {
  return dependencies.stagingBranch ?? "staging";
}

async function persistChange(input: {
  readonly dependencies: CommandDependencies;
  readonly change: Change;
  readonly status: ChangeStatus;
  readonly expectedRevision: GitCommitSha;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly context: RequestContext;
  readonly pullRequest?: PullRequest;
}): Promise<{ readonly change: Change; readonly revision: GitCommitSha }> {
  const change: Change = {
    ...input.change,
    status: input.status,
    ...(input.pullRequest === undefined
      ? {}
      : {
          pullRequestNumber: input.pullRequest.number,
          pullRequestUrl: input.pullRequest.url,
        }),
    updatedAt: isoTimestamp(input.dependencies.clock.now()),
  };
  const committed = await input.dependencies.git.commitFiles({
    branch: input.change.branchName,
    expectedSha: input.expectedRevision,
    files: [{ path: ".cms/change.yaml", content: yamlCodec.serialize(change) }],
    message: changeCommitMessage(change, `Move Change to ${input.status}`),
    author: input.actor,
    idempotencyKey: input.idempotencyKey,
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
  });
  return { change, revision: committed.sha };
}

export interface ChangeTransitionResult {
  readonly change: Change;
  readonly revision: GitCommitSha;
  readonly pullRequest?: PullRequest;
}

export interface CreateChangeCommand {
  readonly name: string;
  readonly description?: string;
  readonly baseBranch?: string;
  readonly idempotencyKey: string;
  readonly emergency?: boolean;
}

export class CreateChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(command: CreateChangeCommand, context: RequestContext): Promise<Change> {
    this.dependencies.authorization.assert(context.actor, "change.create");
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const baseBranch = command.baseBranch ?? mainBranch(this.dependencies);
      const base = await this.dependencies.git.resolveRef(baseBranch, context.signal);
      const id = this.dependencies.ids.changeId();
      const now = isoTimestamp(this.dependencies.clock.now());
      const branchName = buildChangeBranchName({
        actor: context.actor,
        name: command.name,
        suffix: this.dependencies.ids.suffix(),
        ...(command.emergency === undefined ? {} : { emergency: command.emergency }),
      });
      const change: Change = {
        id,
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        ownerId: context.actor.id,
        baseBranch,
        baseCommit: base.sha,
        branchName,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      const branch = await this.dependencies.git.createBranch({
        branch: branchName,
        from: base.sha,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await this.dependencies.git.commitFiles({
        branch: branchName,
        expectedSha: branch.sha,
        files: [{ path: ".cms/change.yaml", content: yamlCodec.serialize(change) }],
        message: changeCommitMessage(change, `Create Change "${change.name}"`),
        author: context.actor,
        idempotencyKey: `${command.idempotencyKey}:metadata`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(this.dependencies.audit, this.dependencies.clock, context, "change.created", id, {
        branchName,
      });
      return change;
    });
  }
}

export interface UpdateDocumentCommand {
  readonly change: Change;
  readonly documentId: DocumentId;
  readonly expectedRevision: Revision;
  readonly patches: readonly ContentPatch[];
  readonly idempotencyKey: string;
}

export class UpdateDocumentHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(command: UpdateDocumentCommand, context: RequestContext): Promise<ContentDocument> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: command.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const document = await this.dependencies.content.readDocument({
        ref: command.change.branchName,
        documentId: command.documentId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (document.revision !== command.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The document changed since it was opened. Refresh or resolve the conflict.",
          category: "conflict",
          retryable: true,
          context: {
            expectedRevision: command.expectedRevision,
            actualRevision: document.revision,
          },
        });
      }
      const data = applyPatches(document.data, command.patches);
      const next = { ...document, data };
      const revision = await this.dependencies.content.writeDocuments({
        ref: command.change.branchName,
        documents: [next],
        expectedRevision: command.expectedRevision,
        message: changeCommitMessage(command.change, `Update ${document.type}/${document.id}`),
        actor: context.actor,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const updated = { ...next, revision };
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "document.updated",
        document.id,
        { changeId: command.change.id, patches: command.patches.length },
      );
      return updated;
    });
  }
}

export interface SubmitChangeCommand {
  readonly change: Change;
  readonly expectedRevision: GitCommitSha;
  readonly idempotencyKey: string;
}

export class SubmitChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    command: SubmitChangeCommand,
    context: RequestContext,
  ): Promise<ChangeTransitionResult> {
    this.dependencies.authorization.assert(context.actor, "change.submit", {
      ownerId: command.change.ownerId,
      policy: { ownerOnly: ["change.submit"] },
    });
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const current = await this.dependencies.git.resolveRef(
        command.change.branchName,
        context.signal,
      );
      if (current.sha !== command.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change has a newer version. Refresh before sending it for review.",
          category: "conflict",
          retryable: true,
        });
      }
      const pullRequest = await this.dependencies.git.createPullRequest({
        head: command.change.branchName,
        base: stagingBranch(this.dependencies),
        title: command.change.name,
        body: `${command.change.description ?? ""}\n\nChange-ID: ${command.change.id}`,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const transitioned = await persistChange({
        dependencies: this.dependencies,
        change: command.change,
        status: "in_review",
        expectedRevision: current.sha,
        actor: context.actor,
        idempotencyKey: `${command.idempotencyKey}:status`,
        context,
        pullRequest,
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.submitted",
        command.change.id,
        { pullRequest: pullRequest.number },
      );
      return { ...transitioned, pullRequest };
    });
  }
}

export class ApproveChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
      readonly body?: string;
    },
    context: RequestContext,
  ): Promise<ChangeTransitionResult> {
    this.dependencies.authorization.assert(context.actor, "change.approve");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const current = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change has a newer version. Refresh before approving it.",
          category: "conflict",
          retryable: true,
        });
      }
      const transitioned = await persistChange({
        dependencies: this.dependencies,
        change: input.change,
        status: "approved",
        expectedRevision: current.sha,
        actor: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        context,
      });
      let mirroredToGitHub = true;
      try {
        await this.dependencies.git.approvePullRequest({
          number: input.pullRequestNumber,
          actor: context.actor,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      } catch {
        mirroredToGitHub = false;
      }
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.approved",
        input.change.id,
        { mirroredToGitHub },
      );
      return transitioned;
    });
  }
}

export class ReviewChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly body: string;
      readonly path?: string;
      readonly line?: number;
    },
    context: RequestContext,
  ): Promise<ReviewComment> {
    this.dependencies.authorization.assert(context.actor, "change.review");
    if (this.dependencies.review === undefined) {
      throw new CmsError({
        code: "CMS_REVIEW_001",
        message: "No review adapter is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    const comment = await this.dependencies.review.addComment({
      pullRequestNumber: input.pullRequestNumber,
      body: input.body,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    await audit(
      this.dependencies.audit,
      this.dependencies.clock,
      context,
      "review.comment-added",
      input.change.id,
      { commentId: comment.id },
    );
    return comment;
  }
}

export class AddChangeToStagingHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ChangeTransitionResult> {
    this.dependencies.authorization.assert(context.actor, "staging.add");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const checks = await this.dependencies.review?.listChecks(
        input.expectedRevision,
        context.signal,
      );
      const blocking =
        checks?.filter(
          (check) =>
            check.required && (check.status !== "completed" || check.conclusion !== "success"),
        ) ?? [];
      if (blocking.length > 0) {
        throw new CmsError({
          code: "CMS_REVIEW_008",
          message: "Required checks must pass before a Change can enter Staging.",
          category: "conflict",
          retryable: true,
          context: { checks: blocking.map((check) => check.name) },
        });
      }
      const result = await this.dependencies.git.mergePullRequest({
        number: input.pullRequestNumber,
        strategy: "squash",
        expectedHeadSha: input.expectedRevision,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const change: Change = {
        ...input.change,
        status: "staging",
        updatedAt: isoTimestamp(this.dependencies.clock.now()),
      };
      const recorded = await this.dependencies.git.commitFiles({
        branch: stagingBranch(this.dependencies),
        expectedSha: result.sha,
        files: [
          {
            path: `.cms/changes/${change.id}.yaml`,
            content: yamlCodec.serialize(change),
          },
        ],
        message: `Record ${change.name} on Staging\n\nChange-ID: ${change.id}`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await this.dependencies.git.deleteBranch({
        branch: input.change.branchName,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.added-to-staging",
        input.change.id,
        { revision: recorded.sha },
      );
      return { change, revision: recorded.sha };
    });
  }
}

function changeMetadata(source: string): Change | undefined {
  const value = yamlCodec.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Change>;
  return typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.ownerId === "string" &&
    typeof candidate.branchName === "string" &&
    candidate.status === "staging"
    ? (candidate as Change)
    : undefined;
}

async function markStagedChangesPublished(input: {
  readonly dependencies: CommandDependencies;
  readonly revision: GitCommitSha;
  readonly context: RequestContext;
  readonly idempotencyKey: string;
}): Promise<GitCommitSha> {
  const branch = stagingBranch(input.dependencies);
  const files = await input.dependencies.git.listFiles({
    ref: branch,
    prefix: ".cms/changes/",
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
  });
  const changes = files.flatMap((file) => {
    const change = changeMetadata(file.content);
    return change === undefined ? [] : [{ path: file.path, change }];
  });
  if (changes.length === 0) return input.revision;
  const committed = await input.dependencies.git.commitFiles({
    branch,
    expectedSha: input.revision,
    files: changes.map(({ path, change }) => ({
      path,
      content: yamlCodec.serialize({
        ...change,
        status: "published",
        updatedAt: isoTimestamp(input.dependencies.clock.now()),
      } satisfies Change),
    })),
    message: `Prepare ${changes.length} Change(s) for publication`,
    author: input.context.actor,
    idempotencyKey: `${input.idempotencyKey}:published-status`,
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
  });
  return committed.sha;
}

export class PromoteStagingHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly expectedRevision: GitCommitSha;
      readonly title: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly mainRevision: GitCommitSha; readonly stagingRevision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const staging = await this.dependencies.git.resolveRef(
        stagingBranch(this.dependencies),
        context.signal,
      );
      if (staging.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_PUBLISH_003",
          message: "Staging changed while the release was being prepared.",
          category: "conflict",
          retryable: true,
        });
      }
      const preparedRevision = await markStagedChangesPublished({
        dependencies: this.dependencies,
        revision: staging.sha,
        context,
        idempotencyKey: input.idempotencyKey,
      });
      const releasePullRequest = await this.dependencies.git.createPullRequest({
        head: stagingBranch(this.dependencies),
        base: mainBranch(this.dependencies),
        title: input.title,
        body: `Release staged content.\n\nStaging-Revision: ${preparedRevision}`,
        idempotencyKey: `${input.idempotencyKey}:release-pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const main = await this.dependencies.git.mergePullRequest({
        number: releasePullRequest.number,
        strategy: "merge",
        expectedHeadSha: preparedRevision,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const syncPullRequest = await this.dependencies.git.createPullRequest({
        head: mainBranch(this.dependencies),
        base: stagingBranch(this.dependencies),
        title: `Sync main after ${input.title}`,
        body: `Synchronize the release merge back into Staging.\n\nMain-Revision: ${main.sha}`,
        idempotencyKey: `${input.idempotencyKey}:sync-pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const synchronized = await this.dependencies.git.mergePullRequest({
        number: syncPullRequest.number,
        strategy: "merge",
        expectedHeadSha: main.sha,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "staging.promoted",
        main.sha,
        { releasePullRequest: releasePullRequest.number, syncPullRequest: syncPullRequest.number },
      );
      return { mainRevision: main.sha, stagingRevision: synchronized.sha };
    });
  }
}

export interface BuildAndPublishReleaseCommand {
  readonly ref: string;
  readonly expectedRevision: GitCommitSha;
  readonly environment: "preview" | "staging" | "production";
  readonly configVersion: number;
  readonly registryDigest: string;
  readonly schemaVersion: number;
  readonly expectedPointerRevision?: string;
  readonly idempotencyKey: string;
}

function releasePath(path: string): string {
  return path.replace(/\.(?:yaml|yml|md|mdx)$/u, ".json");
}

function releaseDocumentValue(document: ContentDocument): unknown {
  if (typeof document.data !== "object" || document.data === null || Array.isArray(document.data)) {
    return {
      id: document.id,
      type: document.type,
      schemaVersion: document.schemaVersion,
      value: document.data,
    };
  }
  return {
    id: document.id,
    type: document.type,
    schemaVersion: document.schemaVersion,
    ...(document.data as Readonly<Record<string, unknown>>),
  };
}

export class BuildAndPublishReleaseHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: BuildAndPublishReleaseCommand,
    context: RequestContext,
  ): Promise<StoredRelease> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    const store = this.dependencies.releaseStore;
    const builder = this.dependencies.releaseBuilder;
    if (store === undefined || builder === undefined) {
      throw new CmsError({
        code: "CMS_STORAGE_001",
        message: "Release building and storage must be configured before publication.",
        category: "configuration",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const ref = await this.dependencies.git.resolveRef(input.ref, context.signal);
      if (ref.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_PUBLISH_003",
          message: "Content changed while the immutable release was being built.",
          category: "conflict",
          retryable: true,
        });
      }
      const summaries: DocumentSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.dependencies.content.listDocuments({
          ref: input.ref,
          ...(cursor === undefined ? {} : { cursor }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        summaries.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const documents = await Promise.all(
        summaries.map(async (summary) => {
          const document = await this.dependencies.content.readDocument({
            ref: input.ref,
            documentId: summary.id,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          return {
            path: releasePath(summary.path),
            value: releaseDocumentValue(document),
            tags: [`document:${document.id}`, `type:${document.type}`],
          };
        }),
      );
      const release = await builder.build({
        gitCommit: ref.sha,
        configVersion: input.configVersion,
        registryDigest: input.registryDigest,
        schemaVersion: input.schemaVersion,
        documents,
      });
      await store.writeRelease(release, context.signal);
      const verified = await store.readRelease(release.id, context.signal);
      if (verified?.files["manifest.json"] !== release.files["manifest.json"]) {
        throw new CmsError({
          code: "CMS_PUBLISH_006",
          message: "The immutable release failed verification.",
          category: "storage",
          retryable: true,
        });
      }
      await store.compareAndSwapPointer({
        next: {
          environment: input.environment,
          releaseId: release.id,
          revision: release.id,
          updatedAt: this.dependencies.clock.now().toISOString(),
        },
        ...(input.expectedPointerRevision === undefined
          ? {}
          : { expectedRevision: input.expectedPointerRevision }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "release.built-and-published",
        release.id,
        {
          environment: input.environment,
          revision: ref.sha,
          documents: documents.length,
        },
      );
      return release;
    });
  }
}

export interface PublishStagingCommand {
  readonly expectedStagingRevision: GitCommitSha;
  readonly title: string;
  readonly configVersion: number;
  readonly registryDigest: string;
  readonly schemaVersion: number;
  readonly expectedPointerRevision?: string;
  readonly idempotencyKey: string;
}

export class PublishStagingHandler {
  private readonly promote: PromoteStagingHandler;
  private readonly buildAndPublish: BuildAndPublishReleaseHandler;

  constructor(private readonly dependencies: CommandDependencies) {
    this.promote = new PromoteStagingHandler(dependencies);
    this.buildAndPublish = new BuildAndPublishReleaseHandler(dependencies);
  }

  async execute(
    input: PublishStagingCommand,
    context: RequestContext,
  ): Promise<{
    readonly mainRevision: GitCommitSha;
    readonly stagingRevision: GitCommitSha;
    readonly release: StoredRelease;
  }> {
    const promoted = await this.promote.execute(
      {
        expectedRevision: input.expectedStagingRevision,
        title: input.title,
        idempotencyKey: `${input.idempotencyKey}:promote`,
      },
      context,
    );
    const release = await this.buildAndPublish.execute(
      {
        ref: mainBranch(this.dependencies),
        expectedRevision: promoted.mainRevision,
        environment: "production",
        configVersion: input.configVersion,
        registryDigest: input.registryDigest,
        schemaVersion: input.schemaVersion,
        ...(input.expectedPointerRevision === undefined
          ? {}
          : { expectedPointerRevision: input.expectedPointerRevision }),
        idempotencyKey: `${input.idempotencyKey}:release`,
      },
      context,
    );
    return { ...promoted, release };
  }
}

export class PublishReleaseHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly release: StoredRelease;
      readonly environment: "preview" | "staging" | "production";
      readonly expectedPointerRevision?: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<void> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    const store = this.dependencies.releaseStore;
    if (store === undefined) {
      throw new CmsError({
        code: "CMS_STORAGE_001",
        message: "No release store is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    await once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      await store.writeRelease(input.release, context.signal);
      const verified = await store.readRelease(input.release.id, context.signal);
      if (
        verified?.files["manifest.json"] === undefined ||
        verified.files["manifest.json"] !== input.release.files["manifest.json"]
      ) {
        throw new CmsError({
          code: "CMS_PUBLISH_006",
          message: "The immutable release failed verification.",
          category: "storage",
          retryable: true,
        });
      }
      await store.compareAndSwapPointer({
        next: {
          environment: input.environment,
          releaseId: input.release.id,
          revision: input.idempotencyKey,
          updatedAt: this.dependencies.clock.now().toISOString(),
        },
        ...(input.expectedPointerRevision === undefined
          ? {}
          : { expectedRevision: input.expectedPointerRevision }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "release.published",
        input.release.id,
        { environment: input.environment },
      );
    });
  }
}

export class RollbackReleaseHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly releaseId: ReleaseId;
      readonly expectedPointerRevision: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<PullRequest> {
    this.dependencies.authorization.assert(context.actor, "release.rollback");
    const store = this.dependencies.releaseStore;
    if (store === undefined) {
      throw new CmsError({
        code: "CMS_STORAGE_001",
        message: "No release store is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    const release = await store.readRelease(input.releaseId, context.signal);
    if (release === undefined) {
      throw new CmsError({
        code: "CMS_PUBLISH_008",
        message: "The selected release does not exist.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      await store.compareAndSwapPointer({
        next: {
          environment: "production",
          releaseId: input.releaseId,
          revision: input.idempotencyKey,
          updatedAt: this.dependencies.clock.now().toISOString(),
        },
        expectedRevision: input.expectedPointerRevision,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const main = await this.dependencies.git.resolveRef(
        mainBranch(this.dependencies),
        context.signal,
      );
      const branch = `rollback/${input.releaseId}-${this.dependencies.ids.suffix()}`;
      const created = await this.dependencies.git.createBranch({
        branch,
        from: main.sha,
        idempotencyKey: `${input.idempotencyKey}:branch`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const committed = await this.dependencies.git.commitFiles({
        branch,
        expectedSha: created.sha,
        files: [
          {
            path: ".cms/rollback.yaml",
            content: yamlCodec.serialize({
              releaseId: input.releaseId,
              previousPointerRevision: input.expectedPointerRevision,
              requestedBy: context.actor.login,
              requestedAt: this.dependencies.clock.now().toISOString(),
            }),
          },
        ],
        message: `Record rollback to ${input.releaseId}`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:commit`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const pullRequest = await this.dependencies.git.createPullRequest({
        head: branch,
        base: mainBranch(this.dependencies),
        title: `Audit rollback to ${input.releaseId}`,
        body: `Production was atomically restored to ${input.releaseId} before this audit PR was opened.`,
        idempotencyKey: `${input.idempotencyKey}:pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "release.rolled-back",
        input.releaseId,
        { pointerFirst: true, auditPullRequest: pullRequest.number, revision: committed.sha },
      );
      return pullRequest;
    });
  }
}

export interface CmsApplication {
  readonly createChange: CreateChangeHandler;
  readonly updateDocument: UpdateDocumentHandler;
  readonly submitChange: SubmitChangeHandler;
  readonly reviewChange: ReviewChangeHandler;
  readonly approveChange: ApproveChangeHandler;
  readonly addChangeToStaging: AddChangeToStagingHandler;
  readonly promoteStaging: PromoteStagingHandler;
  readonly buildAndPublishRelease: BuildAndPublishReleaseHandler;
  readonly publishStaging: PublishStagingHandler;
  readonly publishRelease: PublishReleaseHandler;
  readonly rollbackRelease: RollbackReleaseHandler;
}

export function createCmsApplication(dependencies: CommandDependencies): CmsApplication {
  return {
    createChange: new CreateChangeHandler(dependencies),
    updateDocument: new UpdateDocumentHandler(dependencies),
    submitChange: new SubmitChangeHandler(dependencies),
    reviewChange: new ReviewChangeHandler(dependencies),
    approveChange: new ApproveChangeHandler(dependencies),
    addChangeToStaging: new AddChangeToStagingHandler(dependencies),
    promoteStaging: new PromoteStagingHandler(dependencies),
    buildAndPublishRelease: new BuildAndPublishReleaseHandler(dependencies),
    publishStaging: new PublishStagingHandler(dependencies),
    publishRelease: new PublishReleaseHandler(dependencies),
    rollbackRelease: new RollbackReleaseHandler(dependencies),
  };
}
