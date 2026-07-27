import { canonicalJson, yamlCodec } from "@git-native-cms/content-codecs";
import {
  CmsError,
  isoTimestamp,
  type Actor,
  type AssetId,
  type Change,
  type ChangeStatus,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type ReleaseId,
  type Revision,
} from "@git-native-cms/core";
import { applyPatches, mergeDocuments, type ContentPatch } from "@git-native-cms/document-model";
import { buildChangeBranchName, changeCommitMessage } from "@git-native-cms/git";
import { importXliff } from "@git-native-cms/localization";
import { buildReferenceGraph, buildSearchIndex } from "@git-native-cms/search";
import { auditSeo, buildHreflang, buildSitemap, type SeoMetadata } from "@git-native-cms/seo";
import type { AuthorizationService } from "@git-native-cms/permissions";
import type {
  AuditSink,
  Asset,
  AssetStore,
  AssetProcessorPort,
  AssetUsagePort,
  Clock,
  ContentRepository,
  DocumentSummary,
  EnvironmentPointer,
  GitProvider,
  IdGenerator,
  IdempotencyStore,
  PullRequest,
  PublicationNotifierPort,
  ReleaseBuilderPort,
  ReviewComment,
  ReviewPort,
  ReleaseStore,
  SchedulerPort,
  StoredRelease,
  TranslationProvider,
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
  readonly assetStore?: AssetStore;
  readonly assetUsage?: AssetUsagePort;
  readonly assetProcessor?: AssetProcessorPort;
  readonly scheduler?: SchedulerPort;
  readonly publicationNotifier?: PublicationNotifierPort;
  readonly translationProvider?: TranslationProvider;
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
    if (!["draft", "changes_requested"].includes(command.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_006",
        message: "Documents can only be edited while a Change is editable.",
        category: "conflict",
        retryable: false,
      });
    }
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

export interface CreateDocumentCommand {
  readonly change: Change;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: unknown;
  readonly expectedRevision: Revision;
  readonly idempotencyKey: string;
}

export class CreateDocumentHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(command: CreateDocumentCommand, context: RequestContext): Promise<ContentDocument> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: command.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!["draft", "changes_requested"].includes(command.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_006",
        message: "Documents can only be created while a Change is editable.",
        category: "conflict",
        retryable: false,
      });
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(command.type) || command.schemaVersion < 1) {
      throw new CmsError({
        code: "CMS_DOCUMENT_012",
        message: "Document type and schema version are invalid.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const document: ContentDocument = {
        id: this.dependencies.ids.documentId(),
        type: command.type,
        schemaVersion: command.schemaVersion,
        revision: command.expectedRevision,
        data: structuredClone(command.data),
      };
      const revision = await this.dependencies.content.writeDocuments({
        ref: command.change.branchName,
        documents: [document],
        expectedRevision: command.expectedRevision,
        message: changeCommitMessage(command.change, `Create ${document.type}/${document.id}`),
        actor: context.actor,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const created = { ...document, revision };
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "document.created",
        document.id,
        { changeId: command.change.id, type: document.type },
      );
      return created;
    });
  }
}

export class DeleteDocumentHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    command: {
      readonly change: Change;
      readonly documentId: DocumentId;
      readonly expectedRevision: Revision;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly documentId: DocumentId; readonly revision: Revision }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: command.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!["draft", "changes_requested"].includes(command.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_006",
        message: "Documents can only be deleted while a Change is editable.",
        category: "conflict",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const current = await this.dependencies.content.readDocument({
        ref: command.change.branchName,
        documentId: command.documentId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (current.revision !== command.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The document changed before it could be deleted.",
          category: "conflict",
          retryable: true,
        });
      }
      const revision = await this.dependencies.content.deleteDocuments({
        ref: command.change.branchName,
        documentIds: [command.documentId],
        expectedRevision: command.expectedRevision,
        actor: context.actor,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "document.deleted",
        command.documentId,
        { changeId: command.change.id },
      );
      return { documentId: command.documentId, revision };
    });
  }
}

export class ImportTranslationHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly documentId: DocumentId;
      readonly targetLocale: string;
      readonly xliff: string;
      readonly expectedRevision: Revision;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ContentDocument> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(input.targetLocale)) {
      throw new CmsError({
        code: "CMS_LOCALE_001",
        message: "Target locale must use a language or language-market code.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const document = await this.dependencies.content.readDocument({
        ref: input.change.branchName,
        documentId: input.documentId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (document.revision !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The document changed before the translation could be imported.",
          category: "conflict",
          retryable: true,
        });
      }
      const data = recordValue(document.data);
      const locales = recordValue(data.locales);
      const fields = Object.fromEntries(
        importXliff(input.xliff)
          .filter((unit) => unit.target !== undefined)
          .map((unit) => [unit.id, unit.target]),
      );
      const next: ContentDocument = {
        ...document,
        data: {
          ...data,
          locales: {
            ...locales,
            [input.targetLocale]: {
              status: "translated",
              sourceRevision: document.revision,
              fields,
            },
          },
        },
      };
      const revision = await this.dependencies.content.writeDocuments({
        ref: input.change.branchName,
        documents: [next],
        expectedRevision: input.expectedRevision,
        message: changeCommitMessage(
          input.change,
          `Import ${input.targetLocale} translation for ${document.id}`,
        ),
        actor: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "translation.imported",
        document.id,
        { locale: input.targetLocale, units: Object.keys(fields).length },
      );
      return { ...next, revision };
    });
  }
}

function configuredTranslationProvider(dependencies: CommandDependencies): TranslationProvider {
  if (dependencies.translationProvider === undefined) {
    throw new CmsError({
      code: "CMS_TRANSLATION_010",
      message: "No translation provider is configured.",
      category: "configuration",
      retryable: false,
    });
  }
  return dependencies.translationProvider;
}

export class CreateTranslationJobHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly documentId: DocumentId;
      readonly sourceLocale: string;
      readonly targetLocale: string;
      readonly xliff: string;
      readonly expectedRevision: Revision;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly jobId: string }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(input.sourceLocale) ||
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(input.targetLocale) ||
      input.sourceLocale === input.targetLocale
    ) {
      throw new CmsError({
        code: "CMS_LOCALE_001",
        message: "Translation jobs require different, valid source and target locales.",
        category: "validation",
        retryable: false,
      });
    }
    const document = await this.dependencies.content.readDocument({
      ref: input.change.branchName,
      documentId: input.documentId,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (document.revision !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_CHANGE_003",
        message: "The document changed before the translation job could be created.",
        category: "conflict",
        retryable: true,
      });
    }
    const provider = configuredTranslationProvider(this.dependencies);
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const result = await provider.createJob({
        sourceLocale: input.sourceLocale,
        targetLocale: input.targetLocale,
        xliff: input.xliff,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "translation.job-created",
        input.documentId,
        { jobId: result.jobId, targetLocale: input.targetLocale },
      );
      return result;
    });
  }
}

export class ReadTranslationJobHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: { readonly change: Change; readonly jobId: string },
    context: RequestContext,
  ): ReturnType<TranslationProvider["readJob"]> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!/^[a-zA-Z0-9._:-]{1,200}$/u.test(input.jobId)) {
      throw new CmsError({
        code: "CMS_TRANSLATION_011",
        message: "Translation job ID is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    return configuredTranslationProvider(this.dependencies).readJob(input.jobId, context.signal);
  }
}

function configuredAssetStore(dependencies: CommandDependencies): AssetStore {
  if (dependencies.assetStore === undefined) {
    throw new CmsError({
      code: "CMS_ASSET_010",
      message: "Asset storage is not configured.",
      category: "configuration",
      retryable: false,
    });
  }
  return dependencies.assetStore;
}

export class CreateAssetUploadHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly fileName: string;
      readonly mimeType: string;
      readonly size: number;
      readonly checksum: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }> {
    this.dependencies.authorization.assert(context.actor, "asset.upload");
    return once(this.dependencies.idempotency, input.idempotencyKey, () =>
      configuredAssetStore(this.dependencies).createUpload({
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.size,
        checksum: input.checksum,
        actor: context.actor,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
  }
}

export class FinalizeAssetUploadHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly uploadId: string;
      readonly checksum: string;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly asset: Asset; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "asset.upload");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      let asset = await configuredAssetStore(this.dependencies).finalizeUpload({
        uploadId: input.uploadId,
        checksum: input.checksum,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (this.dependencies.assetProcessor !== undefined && asset.mimeType.startsWith("image/")) {
        asset = await this.dependencies.assetProcessor.process(asset, context.signal);
      }
      const current = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change moved before asset metadata could be saved.",
          category: "conflict",
          retryable: true,
        });
      }
      const committed = await this.dependencies.git.commitFiles({
        branch: input.change.branchName,
        expectedSha: input.expectedRevision,
        files: [
          {
            path: `.cms/assets/${asset.id}.yaml`,
            content: yamlCodec.serialize(asset),
          },
        ],
        message: changeCommitMessage(input.change, `Add asset ${asset.fileName}`),
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:metadata`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "asset.finalized",
        asset.id,
        { changeId: input.change.id, checksum: asset.checksum },
      );
      return { asset, revision: committed.sha };
    });
  }
}

export class DeleteAssetHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly assetId: AssetId;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly assetId: AssetId; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "asset.delete");
    const usage = this.dependencies.assetUsage;
    if (usage === undefined) {
      throw new CmsError({
        code: "CMS_ASSET_010",
        message: "Asset usage tracking is not configured.",
        category: "configuration",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const [usages, released] = await Promise.all([
        usage.usages(input.assetId, context.signal),
        usage.isReleased(input.assetId, context.signal),
      ]);
      if (usages.length > 0 || released) {
        throw new CmsError({
          code: "CMS_ASSET_009",
          message: "This asset is still used by content or an immutable release.",
          category: "conflict",
          retryable: false,
          context: { usages, released },
        });
      }
      const committed = await this.dependencies.git.commitFiles({
        branch: input.change.branchName,
        expectedSha: input.expectedRevision,
        files: [{ path: `.cms/assets/${input.assetId}.yaml`, content: null }],
        message: changeCommitMessage(input.change, `Delete asset ${input.assetId}`),
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:metadata`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await configuredAssetStore(this.dependencies).deleteAsset(input.assetId, context.signal);
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "asset.deleted",
        input.assetId,
        { changeId: input.change.id },
      );
      return { assetId: input.assetId, revision: committed.sha };
    });
  }
}

export interface ContentSchedule {
  readonly id: string;
  readonly changeId: Change["id"];
  readonly action: "publish" | "unpublish";
  readonly documentIds: readonly DocumentId[];
  readonly executeAt: string;
  readonly status: "scheduled" | "executed";
  readonly createdBy: Actor["id"];
  readonly createdAt: string;
  readonly executedAt?: string;
  readonly releaseId?: ReleaseId;
}

export class ScheduleContentHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly action: "publish" | "unpublish";
      readonly documentIds: readonly DocumentId[];
      readonly executeAt: string;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly schedule: ContentSchedule; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    const scheduler = this.dependencies.scheduler;
    if (scheduler === undefined) {
      throw new CmsError({
        code: "CMS_SCHEDULE_010",
        message: "No scheduler adapter is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    const executeAt = new Date(input.executeAt);
    if (
      Number.isNaN(executeAt.getTime()) ||
      executeAt.getTime() <= this.dependencies.clock.now().getTime()
    ) {
      throw new CmsError({
        code: "CMS_SCHEDULE_002",
        message: "Scheduled publication time must be a valid future UTC timestamp.",
        category: "validation",
        retryable: false,
      });
    }
    if (input.documentIds.length === 0) {
      throw new CmsError({
        code: "CMS_SCHEDULE_003",
        message: "At least one document must be scheduled.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const id = this.dependencies.ids.scheduleId();
      const schedule: ContentSchedule = {
        id,
        changeId: input.change.id,
        action: input.action,
        documentIds: [...new Set(input.documentIds)].sort(),
        executeAt: executeAt.toISOString(),
        status: "scheduled",
        createdBy: context.actor.id,
        createdAt: this.dependencies.clock.now().toISOString(),
      };
      const workflow = scheduler.workflow({
        scheduleId: id,
        executeAt: schedule.executeAt,
        action: input.action,
        documentIds: schedule.documentIds,
      });
      const committed = await this.dependencies.git.commitFiles({
        branch: input.change.branchName,
        expectedSha: input.expectedRevision,
        files: [
          {
            path: `.cms/schedules/${id}.yaml`,
            content: yamlCodec.serialize(schedule),
          },
          { path: workflow.path, content: workflow.content },
        ],
        message: changeCommitMessage(
          input.change,
          `Schedule ${input.action} for ${schedule.executeAt}`,
        ),
        author: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "schedule.created",
        id,
        { action: input.action, executeAt: schedule.executeAt },
      );
      return { schedule, revision: committed.sha };
    });
  }
}

function contentSchedule(source: string): ContentSchedule | undefined {
  const value = yamlCodec.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const schedule = value as Partial<ContentSchedule>;
  return typeof schedule.id === "string" &&
    typeof schedule.changeId === "string" &&
    (schedule.action === "publish" || schedule.action === "unpublish") &&
    Array.isArray(schedule.documentIds) &&
    schedule.documentIds.every((id) => typeof id === "string") &&
    typeof schedule.executeAt === "string" &&
    (schedule.status === "scheduled" || schedule.status === "executed") &&
    typeof schedule.createdBy === "string" &&
    typeof schedule.createdAt === "string"
    ? (schedule as ContentSchedule)
    : undefined;
}

async function applyScheduledUnpublishes(input: {
  readonly dependencies: CommandDependencies;
  readonly schedules: readonly ContentSchedule[];
  readonly revision: GitCommitSha;
  readonly idempotencyKey: string;
  readonly context: RequestContext;
}): Promise<GitCommitSha> {
  const documentIds = [
    ...new Set(
      input.schedules
        .filter((schedule) => schedule.action === "unpublish")
        .flatMap((schedule) => schedule.documentIds),
    ),
  ].sort();
  if (documentIds.length === 0) return input.revision;
  return input.dependencies.content.deleteDocuments({
    ref: stagingBranch(input.dependencies),
    documentIds,
    expectedRevision: input.revision,
    actor: input.context.actor,
    idempotencyKey: `${input.idempotencyKey}:unpublish`,
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
  });
}

export class ExecuteScheduleHandler {
  private readonly publish: PublishStagingHandler;

  constructor(private readonly dependencies: CommandDependencies) {
    this.publish = new PublishStagingHandler(dependencies);
  }

  async execute(
    input: {
      readonly scheduleId: string;
      readonly expectedAt: string;
      readonly configVersion: number;
      readonly registryDigest: string;
      readonly schemaVersion: number;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{
    readonly status: "executed" | "already-executed" | "not-due";
    readonly schedule: ContentSchedule;
    readonly releaseId?: ReleaseId;
  }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    const branch = stagingBranch(this.dependencies);
    const path = `.cms/schedules/${input.scheduleId}.yaml`;
    const file = await this.dependencies.git.readFile({
      ref: branch,
      path,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const schedule = file === undefined ? undefined : contentSchedule(file.content);
    if (schedule === undefined || schedule.id !== input.scheduleId) {
      throw new CmsError({
        code: "CMS_SCHEDULE_404",
        message: "The scheduled publication was not found on Staging.",
        category: "validation",
        retryable: false,
      });
    }
    if (schedule.executeAt !== new Date(input.expectedAt).toISOString()) {
      throw new CmsError({
        code: "CMS_SCHEDULE_004",
        message: "The scheduled time does not match the audited schedule.",
        category: "conflict",
        retryable: false,
      });
    }
    if (schedule.status === "executed") {
      return {
        status: "already-executed",
        schedule,
        ...(schedule.releaseId === undefined ? {} : { releaseId: schedule.releaseId }),
      };
    }
    if (new Date(schedule.executeAt).getTime() > this.dependencies.clock.now().getTime()) {
      return { status: "not-due", schedule };
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const staging = await this.dependencies.git.resolveRef(branch, context.signal);
      const publicationRevision = await applyScheduledUnpublishes({
        dependencies: this.dependencies,
        schedules: [schedule],
        revision: staging.sha,
        idempotencyKey: input.idempotencyKey,
        context,
      });
      const publication = await this.publish.execute(
        {
          expectedStagingRevision: publicationRevision,
          title: `Scheduled ${schedule.action} ${schedule.id}`,
          configVersion: input.configVersion,
          registryDigest: input.registryDigest,
          schemaVersion: input.schemaVersion,
          idempotencyKey: `${input.idempotencyKey}:publication`,
        },
        context,
      );
      const current = await this.dependencies.git.resolveRef(branch, context.signal);
      const executed: ContentSchedule = {
        ...schedule,
        status: "executed",
        executedAt: this.dependencies.clock.now().toISOString(),
        releaseId: publication.release.id,
      };
      await this.dependencies.git.commitFiles({
        branch,
        expectedSha: current.sha,
        files: [{ path, content: yamlCodec.serialize(executed) }],
        message: `Record execution of ${schedule.id}`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "schedule.executed",
        schedule.id,
        { action: schedule.action, releaseId: publication.release.id },
      );
      return { status: "executed" as const, schedule: executed, releaseId: publication.release.id };
    });
  }
}

export class ExecuteDueSchedulesHandler {
  private readonly publish: PublishStagingHandler;

  constructor(private readonly dependencies: CommandDependencies) {
    this.publish = new PublishStagingHandler(dependencies);
  }

  async execute(
    input: {
      readonly configVersion: number;
      readonly registryDigest: string;
      readonly schemaVersion: number;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{
    readonly status: "executed" | "nothing-due";
    readonly schedules: readonly ContentSchedule[];
    readonly releaseId?: ReleaseId;
  }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    const branch = stagingBranch(this.dependencies);
    const files = await this.dependencies.git.listFiles({
      ref: branch,
      prefix: ".cms/schedules/",
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const now = this.dependencies.clock.now().getTime();
    const due = files
      .flatMap((file) => {
        try {
          const schedule = contentSchedule(file.content);
          return schedule === undefined ? [] : [{ path: file.path, schedule }];
        } catch {
          return [];
        }
      })
      .filter(
        ({ schedule }) =>
          schedule.status === "scheduled" && new Date(schedule.executeAt).getTime() <= now,
      )
      .sort((left, right) => left.schedule.executeAt.localeCompare(right.schedule.executeAt))
      .slice(0, 50);
    if (due.length === 0) return { status: "nothing-due", schedules: [] };
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const staging = await this.dependencies.git.resolveRef(branch, context.signal);
      const batchKey = due
        .map(({ schedule }) => schedule.id)
        .sort()
        .join(",");
      const publicationRevision = await applyScheduledUnpublishes({
        dependencies: this.dependencies,
        schedules: due.map(({ schedule }) => schedule),
        revision: staging.sha,
        idempotencyKey: `scheduled-batch:${batchKey}`,
        context,
      });
      const publication = await this.publish.execute(
        {
          expectedStagingRevision: publicationRevision,
          title: `Scheduled publication (${due.length})`,
          configVersion: input.configVersion,
          registryDigest: input.registryDigest,
          schemaVersion: input.schemaVersion,
          idempotencyKey: `scheduled-batch:${batchKey}`,
        },
        context,
      );
      const executedAt = this.dependencies.clock.now().toISOString();
      const schedules = due.map(({ schedule }) => ({
        ...schedule,
        status: "executed" as const,
        executedAt,
        releaseId: publication.release.id,
      }));
      const current = await this.dependencies.git.resolveRef(branch, context.signal);
      await this.dependencies.git.commitFiles({
        branch,
        expectedSha: current.sha,
        files: due.map(({ path }, index) => ({
          path,
          content: yamlCodec.serialize(schedules[index]),
        })),
        message: `Record execution of ${due.length} scheduled publication(s)`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      for (const schedule of schedules) {
        await audit(
          this.dependencies.audit,
          this.dependencies.clock,
          context,
          "schedule.executed",
          schedule.id,
          { action: schedule.action, releaseId: publication.release.id, batch: batchKey },
        );
      }
      return {
        status: "executed" as const,
        schedules,
        releaseId: publication.release.id,
      };
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
    if (input.change.ownerId === context.actor.id) {
      throw new CmsError({
        code: "CMS_REVIEW_009",
        message: "A Change must be approved by someone other than its owner.",
        category: "authorization",
        retryable: false,
      });
    }
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
      await this.dependencies.git.approvePullRequest({
        number: input.pullRequestNumber,
        actor: context.actor,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const transitioned = await persistChange({
        dependencies: this.dependencies,
        change: input.change,
        status: "approved",
        expectedRevision: current.sha,
        actor: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        context,
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.approved",
        input.change.id,
        { pullRequest: input.pullRequestNumber },
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

export class RequestChangesHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly expectedRevision: GitCommitSha;
      readonly body: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ChangeTransitionResult> {
    this.dependencies.authorization.assert(context.actor, "change.review");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const current = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change has a newer version. Refresh before requesting changes.",
          category: "conflict",
          retryable: true,
        });
      }
      if (this.dependencies.review !== undefined) {
        await this.dependencies.review.addComment({
          pullRequestNumber: input.pullRequestNumber,
          body: `Changes requested: ${input.body}`,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      }
      const transitioned = await persistChange({
        dependencies: this.dependencies,
        change: input.change,
        status: "changes_requested",
        expectedRevision: current.sha,
        actor: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        context,
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.changes-requested",
        input.change.id,
        { pullRequestNumber: input.pullRequestNumber },
      );
      return transitioned;
    });
  }
}

export class ArchiveChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ChangeTransitionResult> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const current = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change has a newer version. Refresh before archiving it.",
          category: "conflict",
          retryable: true,
        });
      }
      const transitioned = await persistChange({
        dependencies: this.dependencies,
        change: input.change,
        status: "archived",
        expectedRevision: current.sha,
        actor: context.actor,
        idempotencyKey: input.idempotencyKey,
        context,
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.archived",
        input.change.id,
      );
      return transitioned;
    });
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
      const changedDocuments = await this.dependencies.content.listDocuments({
        ref: input.change.branchName,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const conflicts: string[] = [];
      for (const summary of changedDocuments.items) {
        const [base, ours, theirs] = await Promise.all([
          this.dependencies.content
            .readDocument({
              ref: input.change.baseCommit,
              documentId: summary.id,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
            .catch(() => undefined),
          this.dependencies.content.readDocument({
            ref: input.change.branchName,
            documentId: summary.id,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
          this.dependencies.content
            .readDocument({
              ref: stagingBranch(this.dependencies),
              documentId: summary.id,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
            .catch(() => undefined),
        ]);
        if (base === undefined || theirs === undefined) continue;
        conflicts.push(
          ...mergeDocuments(base.data, ours.data, theirs.data).conflicts.map(
            (conflict) => `${summary.id}${conflict.path}`,
          ),
        );
      }
      if (conflicts.length > 0) {
        throw new CmsError({
          code: "CMS_CHANGE_009",
          message: "Resolve semantic conflicts with Staging before adding this Change.",
          category: "conflict",
          retryable: true,
          context: { paths: conflicts },
        });
      }
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

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function releaseManifestDetails(release: StoredRelease): {
  readonly revision: GitCommitSha;
  readonly tags: readonly string[];
  readonly paths: readonly string[];
} {
  const manifest = recordValue(release.manifest);
  if (typeof manifest.gitCommit !== "string" || manifest.gitCommit.length === 0) {
    throw new CmsError({
      code: "CMS_PUBLISH_010",
      message: "The release manifest does not contain its Git revision.",
      category: "validation",
      retryable: false,
    });
  }
  return {
    revision: manifest.gitCommit as GitCommitSha,
    tags: Array.isArray(manifest.tags)
      ? manifest.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    paths: Object.keys(release.files)
      .filter((path) => path !== "manifest.json" && path !== "checksums.json")
      .sort(),
  };
}

async function switchReleasePointer(input: {
  readonly store: ReleaseStore;
  readonly release: StoredRelease;
  readonly environment: EnvironmentPointer["environment"];
  readonly expectedPointerRevision?: string;
  readonly pointerRevision: string;
  readonly updatedAt: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const current = await input.store.readPointer(input.environment, input.signal);
  if (current?.releaseId === input.release.id && current.revision === input.pointerRevision) {
    return;
  }
  await input.store.compareAndSwapPointer({
    next: {
      environment: input.environment,
      releaseId: input.release.id,
      revision: input.pointerRevision,
      updatedAt: input.updatedAt,
    },
    ...(input.expectedPointerRevision === undefined
      ? {}
      : { expectedRevision: input.expectedPointerRevision }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function notifyPublication(input: {
  readonly notifier: PublicationNotifierPort | undefined;
  readonly release: StoredRelease;
  readonly environment: EnvironmentPointer["environment"];
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (input.notifier === undefined) return;
  const details = releaseManifestDetails(input.release);
  await input.notifier.notify({
    environment: input.environment,
    releaseId: input.release.id,
    revision: details.revision,
    tags: details.tags,
    paths: details.paths,
    idempotencyKey: input.idempotencyKey,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function publicationArtifacts(
  documents: readonly {
    readonly summary: DocumentSummary;
    readonly document: ContentDocument;
    readonly value: unknown;
  }[],
): {
  readonly redirects: Readonly<Record<string, string>>;
  readonly artifacts: Readonly<Record<string, string>>;
} {
  const settings = documents.find((entry) => entry.document.type === "settings");
  const siteUrl =
    typeof recordValue(settings?.document.data).siteUrl === "string"
      ? String(recordValue(settings?.document.data).siteUrl).replace(/\/$/u, "")
      : "";
  const redirects: Record<string, string> = {};
  const pages: {
    canonical: string;
    hreflang?: Readonly<Record<string, string>>;
    include?: boolean;
  }[] = [];
  const seoEntries: { path: string; metadata: SeoMetadata }[] = [];
  const localeManifest: Record<string, unknown> = {};
  for (const entry of documents) {
    const data = recordValue(entry.document.data);
    const route = recordValue(data.route);
    const path = typeof route.path === "string" ? route.path : undefined;
    const seo = recordValue(data.seo) as SeoMetadata;
    const declaredRedirects = recordValue(data.redirects);
    for (const [source, target] of Object.entries(declaredRedirects)) {
      if (typeof target === "string") redirects[source] = target;
    }
    const redirectFrom = Array.isArray(data.redirectFrom)
      ? data.redirectFrom
      : typeof data.redirectFrom === "string"
        ? [data.redirectFrom]
        : [];
    if (path !== undefined) {
      for (const source of redirectFrom) {
        if (typeof source === "string" && source !== path) redirects[source] = path;
      }
    }
    const locales = recordValue(data.locales);
    if (Object.keys(locales).length > 0) {
      localeManifest[entry.document.id] = locales;
    }
    if (entry.document.type !== "pages" || path === undefined) continue;
    const localizedRoutes = Object.fromEntries(
      Object.entries(locales).flatMap(([locale, value]) => {
        const localizedRoute = recordValue(recordValue(value).route);
        return typeof localizedRoute.path === "string"
          ? [[locale, localizedRoute.path] as const]
          : [];
      }),
    );
    const hreflang =
      Object.keys(localizedRoutes).length === 0
        ? undefined
        : buildHreflang({
            baseUrl: siteUrl,
            routes: { "en-US": path, ...localizedRoutes },
            defaultLocale: "en-US",
          });
    const canonical = typeof seo.canonical === "string" ? seo.canonical : `${siteUrl}${path}`;
    pages.push({
      canonical,
      ...(hreflang === undefined ? {} : { hreflang }),
      include: seo.sitemap !== false && seo.robots?.index !== false,
    });
    seoEntries.push({
      path,
      metadata: { ...seo, ...(hreflang === undefined ? {} : { hreflang }) },
    });
  }
  const searchIndex = buildSearchIndex(
    documents.map((entry) => ({
      id: entry.document.id,
      type: entry.document.type,
      title: entry.summary.title,
      path: entry.summary.path,
      value: entry.value,
    })),
  );
  const referenceGraph = buildReferenceGraph(searchIndex.documents);
  return {
    redirects,
    artifacts: {
      "content-index.json": canonicalJson(
        documents
          .map((entry) => ({
            id: entry.document.id,
            type: entry.document.type,
            title: entry.summary.title,
            path: releasePath(entry.summary.path),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      ),
      "sitemap.xml": buildSitemap(pages),
      "search-index.json": canonicalJson(searchIndex),
      "content-graph.json": canonicalJson(referenceGraph),
      "locales.json": canonicalJson(localeManifest),
      "seo-diagnostics.json": canonicalJson(auditSeo(seoEntries)),
    },
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
      const sourceDocuments = await Promise.all(
        summaries.map(async (summary) => {
          const document = await this.dependencies.content.readDocument({
            ref: input.ref,
            documentId: summary.id,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          return { summary, document, value: releaseDocumentValue(document) };
        }),
      );
      const generated = publicationArtifacts(sourceDocuments);
      const documents = sourceDocuments.map(({ summary, document, value }) => ({
        path: releasePath(summary.path),
        value,
        tags: [`document:${document.id}`, `type:${document.type}`],
      }));
      const release = await builder.build({
        gitCommit: ref.sha,
        configVersion: input.configVersion,
        registryDigest: input.registryDigest,
        schemaVersion: input.schemaVersion,
        documents,
        redirects: generated.redirects,
        artifacts: generated.artifacts,
      });
      await store.writeRelease(release, context.signal);
      const verified = await store.readRelease(release.id, context.signal);
      if (
        verified === undefined ||
        Object.keys(verified.files).length !== Object.keys(release.files).length ||
        !Object.entries(release.files).every(([path, content]) => verified.files[path] === content)
      ) {
        throw new CmsError({
          code: "CMS_PUBLISH_006",
          message: "The immutable release failed verification.",
          category: "storage",
          retryable: true,
        });
      }
      await switchReleasePointer({
        store,
        release,
        environment: input.environment,
        pointerRevision: release.id,
        updatedAt: this.dependencies.clock.now().toISOString(),
        ...(input.expectedPointerRevision === undefined
          ? {}
          : { expectedPointerRevision: input.expectedPointerRevision }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await notifyPublication({
        notifier: this.dependencies.publicationNotifier,
        release,
        environment: input.environment,
        idempotencyKey: `${input.idempotencyKey}:notify`,
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
        verified === undefined ||
        Object.keys(verified.files).length !== Object.keys(input.release.files).length ||
        !Object.entries(input.release.files).every(
          ([path, content]) => verified.files[path] === content,
        )
      ) {
        throw new CmsError({
          code: "CMS_PUBLISH_006",
          message: "The immutable release failed verification.",
          category: "storage",
          retryable: true,
        });
      }
      await switchReleasePointer({
        store,
        release: input.release,
        environment: input.environment,
        pointerRevision: input.idempotencyKey,
        updatedAt: this.dependencies.clock.now().toISOString(),
        ...(input.expectedPointerRevision === undefined
          ? {}
          : { expectedPointerRevision: input.expectedPointerRevision }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await notifyPublication({
        notifier: this.dependencies.publicationNotifier,
        release: input.release,
        environment: input.environment,
        idempotencyKey: `${input.idempotencyKey}:notify`,
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
      await switchReleasePointer({
        store,
        release,
        environment: "production",
        expectedPointerRevision: input.expectedPointerRevision,
        pointerRevision: input.idempotencyKey,
        updatedAt: this.dependencies.clock.now().toISOString(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await notifyPublication({
        notifier: this.dependencies.publicationNotifier,
        release,
        environment: "production",
        idempotencyKey: `${input.idempotencyKey}:notify`,
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
  readonly createDocument: CreateDocumentHandler;
  readonly updateDocument: UpdateDocumentHandler;
  readonly deleteDocument: DeleteDocumentHandler;
  readonly importTranslation: ImportTranslationHandler;
  readonly createTranslationJob: CreateTranslationJobHandler;
  readonly readTranslationJob: ReadTranslationJobHandler;
  readonly createAssetUpload: CreateAssetUploadHandler;
  readonly finalizeAssetUpload: FinalizeAssetUploadHandler;
  readonly deleteAsset: DeleteAssetHandler;
  readonly scheduleContent: ScheduleContentHandler;
  readonly executeSchedule: ExecuteScheduleHandler;
  readonly executeDueSchedules: ExecuteDueSchedulesHandler;
  readonly submitChange: SubmitChangeHandler;
  readonly reviewChange: ReviewChangeHandler;
  readonly requestChanges: RequestChangesHandler;
  readonly archiveChange: ArchiveChangeHandler;
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
    createDocument: new CreateDocumentHandler(dependencies),
    updateDocument: new UpdateDocumentHandler(dependencies),
    deleteDocument: new DeleteDocumentHandler(dependencies),
    importTranslation: new ImportTranslationHandler(dependencies),
    createTranslationJob: new CreateTranslationJobHandler(dependencies),
    readTranslationJob: new ReadTranslationJobHandler(dependencies),
    createAssetUpload: new CreateAssetUploadHandler(dependencies),
    finalizeAssetUpload: new FinalizeAssetUploadHandler(dependencies),
    deleteAsset: new DeleteAssetHandler(dependencies),
    scheduleContent: new ScheduleContentHandler(dependencies),
    executeSchedule: new ExecuteScheduleHandler(dependencies),
    executeDueSchedules: new ExecuteDueSchedulesHandler(dependencies),
    submitChange: new SubmitChangeHandler(dependencies),
    reviewChange: new ReviewChangeHandler(dependencies),
    requestChanges: new RequestChangesHandler(dependencies),
    archiveChange: new ArchiveChangeHandler(dependencies),
    approveChange: new ApproveChangeHandler(dependencies),
    addChangeToStaging: new AddChangeToStagingHandler(dependencies),
    promoteStaging: new PromoteStagingHandler(dependencies),
    buildAndPublishRelease: new BuildAndPublishReleaseHandler(dependencies),
    publishStaging: new PublishStagingHandler(dependencies),
    publishRelease: new PublishReleaseHandler(dependencies),
    rollbackRelease: new RollbackReleaseHandler(dependencies),
  };
}
