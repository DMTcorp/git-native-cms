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
import {
  applyPatch,
  applyPatches,
  contentPath,
  mergeDocuments,
  parseContentPath,
  type ContentPatch,
  type ContentPath,
} from "@git-native-cms/document-model";
import { buildChangeBranchName, changeCommitMessage } from "@git-native-cms/git";
import { importXliff } from "@git-native-cms/localization";
import { buildReferenceGraph, buildSearchIndex } from "@git-native-cms/search";
import { auditSeo, buildHreflang, buildSitemap, type SeoMetadata } from "@git-native-cms/seo";
import {
  parsePermissionConfiguration,
  type AuthorizationService,
  type TeamRoleMapping,
} from "@git-native-cms/permissions";
import type {
  AuditSink,
  AuditEvent,
  AuditQueryPort,
  Asset,
  AssetStore,
  AssetProcessorPort,
  AssetUsagePort,
  Clock,
  ContentRepository,
  ContentScheduleAction,
  DocumentSummary,
  EnvironmentPointer,
  GitProvider,
  IdGenerator,
  IdempotencyStore,
  PullRequest,
  PublicationNotifierPort,
  PreviewSession,
  PreviewSessionPort,
  ReleaseBuilderPort,
  ReviewAssignment,
  ReviewComment,
  ReviewPort,
  ReleaseStore,
  SchedulerPort,
  StoredRelease,
  TeamInvitation,
  TeamMember,
  TeamProvisioningPort,
  OrganizationTeam,
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
  readonly auditQuery?: AuditQueryPort;
  readonly releaseStore?: ReleaseStore;
  readonly releaseBuilder?: ReleaseBuilderPort;
  readonly review?: ReviewPort;
  readonly assetStore?: AssetStore;
  readonly assetUsage?: AssetUsagePort;
  readonly assetProcessor?: AssetProcessorPort;
  readonly scheduler?: SchedulerPort;
  readonly publicationNotifier?: PublicationNotifierPort;
  readonly previewSessions?: PreviewSessionPort;
  readonly teamProvisioning?: TeamProvisioningPort;
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

export interface ChangeConflict {
  readonly documentId: DocumentId;
  readonly path: ContentPath;
  readonly base: unknown;
  readonly change: unknown;
  readonly staging: unknown;
  readonly scope: "field" | "document";
}

export interface ChangeConflictResolution {
  readonly documentId: DocumentId;
  readonly path: ContentPath;
  readonly choice: "change" | "staging";
}

export interface CreateChangeCommand {
  readonly name: string;
  readonly description?: string;
  readonly baseBranch?: string;
  readonly collaborators?: readonly string[];
  readonly targetDate?: string;
  readonly idempotencyKey: string;
  readonly emergency?: boolean;
}

export class CreateChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(command: CreateChangeCommand, context: RequestContext): Promise<Change> {
    this.dependencies.authorization.assert(context.actor, "change.create");
    const name = command.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new CmsError({
        code: "CMS_CHANGE_010",
        message: "Change name must contain between 2 and 120 characters.",
        category: "validation",
        retryable: false,
      });
    }
    const collaborators = [
      ...new Set(
        (command.collaborators ?? [])
          .map((value) => value.trim().replace(/^@/u, ""))
          .filter(Boolean),
      ),
    ];
    if (
      collaborators.length > 20 ||
      collaborators.some(
        (value) =>
          value.length > 100 ||
          !/^(?:team:)?[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u.test(value),
      )
    ) {
      throw new CmsError({
        code: "CMS_CHANGE_012",
        message: "Collaborators must contain at most 20 GitHub users or team:slug values.",
        category: "validation",
        retryable: false,
      });
    }
    const targetDateValue =
      command.targetDate === undefined
        ? undefined
        : new Date(`${command.targetDate}T00:00:00.000Z`);
    if (
      command.targetDate !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(command.targetDate) ||
        targetDateValue === undefined ||
        !Number.isFinite(targetDateValue.getTime()) ||
        !targetDateValue.toISOString().startsWith(command.targetDate))
    ) {
      throw new CmsError({
        code: "CMS_CHANGE_013",
        message: "The target date must use YYYY-MM-DD.",
        category: "validation",
        retryable: false,
      });
    }
    const requestedBaseBranch =
      command.emergency === true
        ? mainBranch(this.dependencies)
        : (command.baseBranch ?? mainBranch(this.dependencies));
    if (
      requestedBaseBranch !== mainBranch(this.dependencies) &&
      requestedBaseBranch !== stagingBranch(this.dependencies)
    ) {
      throw new CmsError({
        code: "CMS_CHANGE_014",
        message: "A Change can only start from the configured Production or Staging branch.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, command.idempotencyKey, async () => {
      const baseBranch = requestedBaseBranch;
      const base = await this.dependencies.git.resolveRef(baseBranch, context.signal);
      const id = this.dependencies.ids.changeId();
      const now = isoTimestamp(this.dependencies.clock.now());
      const branchName = buildChangeBranchName({
        actor: context.actor,
        name,
        suffix: this.dependencies.ids.suffix(),
        ...(command.emergency === undefined ? {} : { emergency: command.emergency }),
      });
      const change: Change = {
        id,
        name,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(collaborators.length === 0 ? {} : { collaborators }),
        ...(command.targetDate === undefined ? {} : { targetDate: command.targetDate }),
        ...(command.emergency === true ? { emergency: true } : {}),
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

export class UpdateChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly name?: string;
      readonly description?: string | null;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly change: Change; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!["draft", "changes_requested"].includes(input.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_005",
        message: "Only an editable Change can be updated.",
        category: "conflict",
        retryable: false,
      });
    }
    const name = input.name?.trim();
    if (name !== undefined && (name.length < 2 || name.length > 120)) {
      throw new CmsError({
        code: "CMS_CHANGE_010",
        message: "Change name must contain between 2 and 120 characters.",
        category: "validation",
        retryable: false,
      });
    }
    if (
      input.description !== undefined &&
      input.description !== null &&
      input.description.length > 4_000
    ) {
      throw new CmsError({
        code: "CMS_CHANGE_011",
        message: "Change description cannot exceed 4,000 characters.",
        category: "validation",
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
          message: "The Change moved before its details could be updated.",
          category: "conflict",
          retryable: true,
        });
      }
      const stable = { ...input.change };
      delete stable.description;
      const change: Change = {
        ...stable,
        ...(input.description === undefined
          ? input.change.description === undefined
            ? {}
            : { description: input.change.description }
          : input.description === null || input.description.trim().length === 0
            ? {}
            : { description: input.description.trim() }),
        ...(name === undefined ? {} : { name }),
        updatedAt: isoTimestamp(this.dependencies.clock.now()),
      };
      const committed = await this.dependencies.git.commitFiles({
        branch: change.branchName,
        expectedSha: input.expectedRevision,
        files: [{ path: ".cms/change.yaml", content: yamlCodec.serialize(change) }],
        message: changeCommitMessage(change, `Update Change "${change.name}"`),
        author: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.updated",
        change.id,
      );
      return { change, revision: committed.sha };
    });
  }
}

export class DeleteChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly changeId: Change["id"] }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (input.change.status !== "draft" || input.change.pullRequestNumber !== undefined) {
      throw new CmsError({
        code: "CMS_CHANGE_012",
        message:
          "Only a draft Change without a pull request can be deleted; archive reviewed work.",
        category: "conflict",
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
          message: "The Change moved before it could be deleted.",
          category: "conflict",
          retryable: true,
        });
      }
      await this.dependencies.git.deleteBranch({
        branch: input.change.branchName,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.deleted",
        input.change.id,
      );
      return { changeId: input.change.id };
    });
  }
}

export class CommitChangeHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly documents: readonly {
        readonly documentId: DocumentId;
        readonly patches: readonly ContentPatch[];
      }[];
      readonly expectedRevision: Revision;
      readonly message?: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly documents: readonly ContentDocument[]; readonly revision: Revision }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!["draft", "changes_requested"].includes(input.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_005",
        message: "Only an editable Change can save a version.",
        category: "conflict",
        retryable: false,
      });
    }
    if (input.documents.length === 0 || input.documents.length > 100) {
      throw new CmsError({
        code: "CMS_DOCUMENT_010",
        message: "A version must contain between 1 and 100 changed documents.",
        category: "validation",
        retryable: false,
      });
    }
    if (
      new Set(input.documents.map((document) => document.documentId)).size !==
      input.documents.length
    ) {
      throw new CmsError({
        code: "CMS_DOCUMENT_011",
        message: "A version cannot contain the same document more than once.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const documents = await Promise.all(
        input.documents.map(async (update) => {
          const current = await this.dependencies.content.readDocument({
            ref: input.change.branchName,
            documentId: update.documentId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          if (current.revision !== input.expectedRevision) {
            throw new CmsError({
              code: "CMS_CHANGE_003",
              message: "A document changed before this version could be saved.",
              category: "conflict",
              retryable: true,
              context: { documentId: update.documentId },
            });
          }
          return { ...current, data: applyPatches(current.data, update.patches) };
        }),
      );
      const revision = await this.dependencies.content.writeDocuments({
        ref: input.change.branchName,
        documents,
        expectedRevision: input.expectedRevision,
        message:
          input.message?.trim() ||
          changeCommitMessage(input.change, `Save version (${documents.length} documents)`),
        actor: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const saved = documents.map((document) => ({ ...document, revision }));
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.version-saved",
        input.change.id,
        { documents: documents.map((document) => document.id), revision },
      );
      return { documents: saved, revision };
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

export class ReceiveAssetUploadHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly uploadId: string;
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly token?: string;
    },
    context: RequestContext,
  ): Promise<void> {
    this.dependencies.authorization.assert(context.actor, "asset.upload");
    const store = configuredAssetStore(this.dependencies);
    if (store.uploadBytes === undefined) {
      throw new CmsError({
        code: "CMS_ASSET_011",
        message: "This asset adapter only accepts direct signed storage uploads.",
        category: "configuration",
        retryable: false,
      });
    }
    await store.uploadBytes({
      ...input,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
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

export class UpdateAssetHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly assetId: AssetId;
      readonly altText?: string | null;
      readonly focalPoint?: { readonly x: number; readonly y: number } | null;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly asset: Asset; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "asset.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["asset.edit"] },
    });
    if (
      input.altText !== undefined &&
      input.altText !== null &&
      input.altText.trim().length > 1_000
    ) {
      throw new CmsError({
        code: "CMS_ASSET_012",
        message: "Asset alternative text cannot exceed 1,000 characters.",
        category: "validation",
        retryable: false,
      });
    }
    if (
      input.focalPoint !== undefined &&
      input.focalPoint !== null &&
      (![input.focalPoint.x, input.focalPoint.y].every(Number.isFinite) ||
        input.focalPoint.x < 0 ||
        input.focalPoint.x > 1 ||
        input.focalPoint.y < 0 ||
        input.focalPoint.y > 1)
    ) {
      throw new CmsError({
        code: "CMS_ASSET_013",
        message: "Asset focal point coordinates must be numbers between 0 and 1.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const store = configuredAssetStore(this.dependencies);
      const existing = await store.readAsset(input.assetId, context.signal);
      if (existing === undefined) {
        throw new CmsError({
          code: "CMS_ASSET_404",
          message: "The selected asset does not exist.",
          category: "validation",
          retryable: false,
        });
      }
      const currentRef = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (currentRef.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change moved before asset metadata could be updated.",
          category: "conflict",
          retryable: true,
        });
      }
      const stableAsset = { ...existing };
      delete stableAsset.altText;
      delete stableAsset.focalPoint;
      const asset: Asset = {
        ...stableAsset,
        ...(input.altText === undefined
          ? existing.altText === undefined
            ? {}
            : { altText: existing.altText }
          : input.altText === null || input.altText.trim().length === 0
            ? {}
            : { altText: input.altText.trim() }),
        ...(input.focalPoint === undefined
          ? existing.focalPoint === undefined
            ? {}
            : { focalPoint: existing.focalPoint }
          : input.focalPoint === null
            ? {}
            : { focalPoint: input.focalPoint }),
      };
      const stored = await store.updateAssetMetadata({
        id: asset.id,
        ...(asset.altText === undefined ? {} : { altText: asset.altText }),
        ...(asset.focalPoint === undefined ? {} : { focalPoint: asset.focalPoint }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      let committed: Awaited<ReturnType<GitProvider["commitFiles"]>>;
      try {
        committed = await this.dependencies.git.commitFiles({
          branch: input.change.branchName,
          expectedSha: input.expectedRevision,
          files: [
            {
              path: `.cms/assets/${stored.id}.yaml`,
              content: yamlCodec.serialize(stored),
            },
          ],
          message: changeCommitMessage(input.change, `Update asset ${stored.fileName}`),
          author: context.actor,
          idempotencyKey: `${input.idempotencyKey}:metadata`,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      } catch (cause) {
        try {
          await store.updateAssetMetadata({
            id: existing.id,
            ...(existing.altText === undefined ? {} : { altText: existing.altText }),
            ...(existing.focalPoint === undefined ? {} : { focalPoint: existing.focalPoint }),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
        } catch (compensationCause) {
          throw new CmsError({
            code: "CMS_ASSET_014",
            message:
              "Asset metadata could not be committed or restored. Retry after refreshing the Change.",
            category: "storage",
            retryable: true,
            context: { assetId: existing.id },
            cause: new AggregateError([cause, compensationCause]),
          });
        }
        throw cause;
      }
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "asset.updated",
        asset.id,
        { changeId: input.change.id },
      );
      return { asset: stored, revision: committed.sha };
    });
  }
}

function configuredPreviewSessions(dependencies: CommandDependencies): PreviewSessionPort {
  if (dependencies.previewSessions === undefined) {
    throw new CmsError({
      code: "CMS_PREVIEW_002",
      message: "Preview sessions are not configured.",
      category: "configuration",
      retryable: false,
    });
  }
  return dependencies.previewSessions;
}

function assertPreviewOwner(session: PreviewSession, context: RequestContext): void {
  if (session.actorId !== context.actor.id) {
    throw new CmsError({
      code: "CMS_PREVIEW_003",
      message: "This preview session belongs to another actor.",
      category: "authorization",
      retryable: false,
    });
  }
}

export class CreatePreviewSessionHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly frontendRef: string;
      readonly locale: string;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<PreviewSession> {
    this.dependencies.authorization.assert(context.actor, "project.read");
    if (
      input.frontendRef.trim().length === 0 ||
      input.frontendRef.length > 200 ||
      !/^[a-zA-Z0-9._/@:-]+$/u.test(input.frontendRef)
    ) {
      throw new CmsError({
        code: "CMS_PREVIEW_004",
        message: "The preview frontend ref is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u.test(input.locale)) {
      throw new CmsError({
        code: "CMS_PREVIEW_005",
        message: "The preview locale is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const session = await configuredPreviewSessions(this.dependencies).issue({
        actorId: context.actor.id,
        changeId: input.change.id,
        frontendRef: input.frontendRef,
        locale: input.locale,
        now: this.dependencies.clock.now(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "preview.session-created",
        session.id,
        { changeId: input.change.id, frontendRef: input.frontendRef, locale: input.locale },
      );
      return session;
    });
  }
}

export class ReadPreviewSessionHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: { readonly id: string; readonly token: string },
    context: RequestContext,
  ): Promise<PreviewSession> {
    this.dependencies.authorization.assert(context.actor, "project.read");
    const session = await configuredPreviewSessions(this.dependencies).verify({
      id: input.id,
      token: input.token,
      now: this.dependencies.clock.now(),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    assertPreviewOwner(session, context);
    return session;
  }
}

export class RefreshPreviewSessionHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: { readonly id: string; readonly token: string; readonly idempotencyKey: string },
    context: RequestContext,
  ): Promise<PreviewSession> {
    this.dependencies.authorization.assert(context.actor, "project.read");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const current = await configuredPreviewSessions(this.dependencies).verify({
        id: input.id,
        token: input.token,
        now: this.dependencies.clock.now(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      assertPreviewOwner(current, context);
      const refreshed = await configuredPreviewSessions(this.dependencies).refresh({
        id: input.id,
        token: input.token,
        now: this.dependencies.clock.now(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "preview.session-refreshed",
        refreshed.id,
        { previousSessionId: input.id, changeId: refreshed.changeId },
      );
      return refreshed;
    });
  }
}

function configuredTeamProvisioning(dependencies: CommandDependencies): TeamProvisioningPort {
  if (dependencies.teamProvisioning === undefined) {
    throw new CmsError({
      code: "CMS_TEAM_003",
      message: "GitHub organization team provisioning is not configured.",
      category: "configuration",
      retryable: false,
    });
  }
  return dependencies.teamProvisioning;
}

function isValidInvitationEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  let atIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
    if (character === "@") {
      if (atIndex !== -1) return false;
      atIndex = index;
    }
  }
  if (atIndex <= 0 || atIndex > 64 || atIndex === value.length - 1) return false;
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  if (
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length > 253 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    !domain.includes(".")
  ) {
    return false;
  }
  return domain
    .split(".")
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"),
    );
}

export class ReadTeamDirectoryHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(context: RequestContext): Promise<{
    readonly members: readonly TeamMember[];
    readonly teams: readonly OrganizationTeam[];
  }> {
    this.dependencies.authorization.assert(context.actor, "team.manage");
    const provisioning = configuredTeamProvisioning(this.dependencies);
    const [members, teams] = await Promise.all([
      provisioning.listMembers(context.signal),
      provisioning.listTeams(context.signal),
    ]);
    return { members, teams };
  }
}

export class InviteTeamMemberHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly email?: string;
      readonly inviteeId?: number;
      readonly role: "direct_member" | "admin";
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<TeamInvitation> {
    this.dependencies.authorization.assert(context.actor, "team.manage");
    if (input.email !== undefined && !isValidInvitationEmail(input.email)) {
      throw new CmsError({
        code: "CMS_TEAM_004",
        message: "A valid invitation email address is required.",
        category: "validation",
        retryable: false,
      });
    }
    if (
      (input.email === undefined) === (input.inviteeId === undefined) ||
      (input.inviteeId !== undefined &&
        (!Number.isSafeInteger(input.inviteeId) || input.inviteeId <= 0))
    ) {
      throw new CmsError({
        code: "CMS_TEAM_001",
        message: "Invite exactly one valid GitHub user ID or email address.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const invitation = await configuredTeamProvisioning(this.dependencies).invite({
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.inviteeId === undefined ? {} : { inviteeId: input.inviteeId }),
        role: input.role,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "team.member-invited",
        invitation.id,
        { role: invitation.role },
      );
      return invitation;
    });
  }
}

export class AddTeamMemberHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly teamSlug: string;
      readonly username: string;
      readonly role: "member" | "maintainer";
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<void> {
    this.dependencies.authorization.assert(context.actor, "team.manage");
    if (
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/u.test(input.username) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(input.teamSlug)
    ) {
      throw new CmsError({
        code: "CMS_TEAM_005",
        message: "GitHub username or team slug is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    await once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      await configuredTeamProvisioning(this.dependencies).addMemberToTeam({
        teamSlug: input.teamSlug,
        username: input.username,
        role: input.role,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "team.member-added",
        input.username,
        { team: input.teamSlug, role: input.role },
      );
    });
  }
}

export class UpdateTeamRoleMappingsHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly mappings: readonly TeamRoleMapping[];
      readonly customRoles?: readonly {
        readonly name: string;
        readonly actions: readonly string[];
      }[];
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly pullRequest: PullRequest; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "team.manage");
    if (
      input.mappings.length > 100 ||
      input.mappings.some(
        (mapping) =>
          mapping.team.trim().length === 0 ||
          mapping.roles.length === 0 ||
          mapping.roles.some((role) => String(role).trim().length === 0),
      )
    ) {
      throw new CmsError({
        code: "CMS_TEAM_006",
        message: "Team role mappings must contain a team and at least one role.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const main = await this.dependencies.git.resolveRef(
        mainBranch(this.dependencies),
        context.signal,
      );
      if (main.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "Main changed before permissions could be updated.",
          category: "conflict",
          retryable: true,
        });
      }
      const branch = `cms-permissions/${this.dependencies.ids.suffix()}`;
      const currentPermissions = await this.dependencies.git.readFile({
        ref: mainBranch(this.dependencies),
        path: ".cms/permissions.yaml",
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const customRoles =
        input.customRoles ??
        (currentPermissions === undefined
          ? []
          : parsePermissionConfiguration(yamlCodec.parse(currentPermissions.content)).customRoles);
      const validated = parsePermissionConfiguration({
        version: 1,
        customRoles,
        mappings: input.mappings,
      });
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
            path: ".cms/permissions.yaml",
            content: yamlCodec.serialize({
              version: 1,
              customRoles: validated.customRoles.map((role) => ({
                name: String(role.name),
                actions: [...role.actions].sort(),
              })),
              mappings: [...validated.mappings]
                .map((mapping) => ({
                  team: mapping.team,
                  roles: [...mapping.roles].map(String).sort(),
                }))
                .sort((left, right) => left.team.localeCompare(right.team)),
            }),
          },
        ],
        message: "Update CMS team role mappings",
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:commit`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const pullRequest = await this.dependencies.git.createPullRequest({
        head: branch,
        base: mainBranch(this.dependencies),
        title: "Update CMS permissions",
        body: "Update the audited GitHub team to CMS role mappings in `.cms/permissions.yaml`.",
        idempotencyKey: `${input.idempotencyKey}:pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "team.role-mappings-updated",
        branch,
        { pullRequest: pullRequest.number, mappings: input.mappings.length },
      );
      return { pullRequest, revision: committed.sha };
    });
  }
}

export interface ContentSchedule {
  readonly id: string;
  readonly changeId: Change["id"];
  readonly action: ContentScheduleAction;
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
      readonly action: ContentScheduleAction;
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
    [
      "publish",
      "unpublish",
      "availability-start",
      "availability-end",
      "visibility-start",
      "visibility-end",
    ].includes(schedule.action ?? "") &&
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

async function applyScheduledWindows(input: {
  readonly dependencies: CommandDependencies;
  readonly schedules: readonly ContentSchedule[];
  readonly revision: GitCommitSha;
  readonly idempotencyKey: string;
  readonly context: RequestContext;
}): Promise<GitCommitSha> {
  const schedules = input.schedules
    .filter(
      (schedule) =>
        schedule.action.startsWith("availability-") || schedule.action.startsWith("visibility-"),
    )
    .sort(
      (left, right) =>
        left.executeAt.localeCompare(right.executeAt) || left.id.localeCompare(right.id),
    );
  if (schedules.length === 0) return input.revision;
  const branch = stagingBranch(input.dependencies);
  const documentIds = [...new Set(schedules.flatMap((schedule) => schedule.documentIds))].sort();
  const documents = await Promise.all(
    documentIds.map((documentId) =>
      input.dependencies.content.readDocument({
        ref: branch,
        documentId,
        ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
      }),
    ),
  );
  const updated = documents.map((document) => {
    const data =
      typeof document.data === "object" && document.data !== null && !Array.isArray(document.data)
        ? (document.data as Readonly<Record<string, unknown>>)
        : {};
    let next = data;
    for (const schedule of schedules.filter((candidate) =>
      candidate.documentIds.includes(document.id),
    )) {
      const field = schedule.action.startsWith("availability-")
        ? "availability"
        : "visibilitySchedule";
      const current =
        typeof next[field] === "object" && next[field] !== null && !Array.isArray(next[field])
          ? (next[field] as Readonly<Record<string, unknown>>)
          : {};
      const boundary = schedule.action.endsWith("-start") ? "from" : "until";
      next = { ...next, [field]: { ...current, [boundary]: schedule.executeAt } };
    }
    return { ...document, data: next };
  });
  return input.dependencies.content.writeDocuments({
    ref: branch,
    documents: updated,
    expectedRevision: input.revision,
    message: `Apply ${schedules.length} scheduled availability/visibility rule(s)`,
    actor: input.context.actor,
    idempotencyKey: `${input.idempotencyKey}:windows`,
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
      const unpublishRevision = await applyScheduledUnpublishes({
        dependencies: this.dependencies,
        schedules: [schedule],
        revision: staging.sha,
        idempotencyKey: input.idempotencyKey,
        context,
      });
      const publicationRevision = await applyScheduledWindows({
        dependencies: this.dependencies,
        schedules: [schedule],
        revision: unpublishRevision,
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
      const unpublishRevision = await applyScheduledUnpublishes({
        dependencies: this.dependencies,
        schedules: due.map(({ schedule }) => schedule),
        revision: staging.sha,
        idempotencyKey: `scheduled-batch:${batchKey}`,
        context,
      });
      const publicationRevision = await applyScheduledWindows({
        dependencies: this.dependencies,
        schedules: due.map(({ schedule }) => schedule),
        revision: unpublishRevision,
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
        base:
          command.change.emergency === true
            ? mainBranch(this.dependencies)
            : stagingBranch(this.dependencies),
        title: command.change.name,
        body: `${command.change.description ?? ""}\n\nChange-ID: ${command.change.id}`,
        idempotencyKey: command.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (
        this.dependencies.review !== undefined &&
        (command.change.collaborators?.length ?? 0) > 0
      ) {
        await this.dependencies.review.assignReviewers({
          pullRequestNumber: pullRequest.number,
          users:
            command.change.collaborators
              ?.filter((value) => !value.startsWith("team:"))
              .map((value) => value.replace(/^@/u, "")) ?? [],
          teams:
            command.change.collaborators
              ?.filter((value) => value.startsWith("team:"))
              .map((value) => value.slice("team:".length)) ?? [],
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      }
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

export class ResolveReviewCommentHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly commentId: string;
      readonly resolved: boolean;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ReviewComment> {
    this.dependencies.authorization.assert(context.actor, "change.review");
    const review = this.dependencies.review;
    if (review === undefined) {
      throw new CmsError({
        code: "CMS_REVIEW_001",
        message: "No review adapter is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    if (input.commentId.trim().length === 0) {
      throw new CmsError({
        code: "CMS_REVIEW_010",
        message: "A review comment ID is required.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const comment = await review.resolveComment({
        pullRequestNumber: input.pullRequestNumber,
        commentId: input.commentId,
        resolved: input.resolved,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        input.resolved ? "review.thread-resolved" : "review.thread-reopened",
        input.change.id,
        { commentId: input.commentId, pullRequest: input.pullRequestNumber },
      );
      return comment;
    });
  }
}

export class AssignReviewersHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly pullRequestNumber: number;
      readonly users: readonly string[];
      readonly teams: readonly string[];
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<ReviewAssignment> {
    this.dependencies.authorization.assert(context.actor, "change.review");
    const review = this.dependencies.review;
    if (review === undefined) {
      throw new CmsError({
        code: "CMS_REVIEW_001",
        message: "No review adapter is configured.",
        category: "configuration",
        retryable: false,
      });
    }
    const username = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/u;
    const team = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
    if (
      input.users.length + input.teams.length === 0 ||
      input.users.length + input.teams.length > 30 ||
      input.users.some((value) => !username.test(value)) ||
      input.teams.some((value) => !team.test(value))
    ) {
      throw new CmsError({
        code: "CMS_REVIEW_011",
        message: "Assign one to thirty valid GitHub users or teams.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const assignment = await review.assignReviewers({
        pullRequestNumber: input.pullRequestNumber,
        users: [...new Set(input.users)].sort(),
        teams: [...new Set(input.teams)].sort(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "review.reviewers-assigned",
        input.change.id,
        {
          pullRequest: input.pullRequestNumber,
          users: assignment.users,
          teams: assignment.teams,
        },
      );
      return assignment;
    });
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

const STAGING_LOCK_PATH = ".cms/staging-lock.yaml";

export interface StagingBatchLock {
  readonly batchRevision: GitCommitSha;
  readonly lockedBy: Actor["id"];
  readonly lockedAt: string;
  readonly checklist: readonly string[];
}

function parseStagingBatchLock(source: string | undefined): StagingBatchLock | undefined {
  if (source === undefined) return undefined;
  const value = yamlCodec.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const lock = value as Partial<StagingBatchLock>;
  return typeof lock.batchRevision === "string" &&
    typeof lock.lockedBy === "string" &&
    typeof lock.lockedAt === "string" &&
    Array.isArray(lock.checklist) &&
    lock.checklist.every((item) => typeof item === "string")
    ? (lock as StagingBatchLock)
    : undefined;
}

export class ReadStagingBatchHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(context: RequestContext): Promise<{
    readonly revision: GitCommitSha;
    readonly lock?: StagingBatchLock;
  }> {
    const branch = stagingBranch(this.dependencies);
    const ref = await this.dependencies.git.resolveRef(branch, context.signal);
    const file = await this.dependencies.git.readFile({
      ref: branch,
      path: STAGING_LOCK_PATH,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const lock = parseStagingBatchLock(file?.content);
    return { revision: ref.sha, ...(lock === undefined ? {} : { lock }) };
  }
}

export class ReadAuditTimelineHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: { readonly resourceId: string; readonly limit?: number },
    context: RequestContext,
  ): Promise<readonly AuditEvent[]> {
    if (input.resourceId.trim().length === 0) {
      throw new CmsError({
        code: "CMS_AUDIT_001",
        message: "An audit resource is required.",
        category: "validation",
        retryable: false,
      });
    }
    return (
      (await this.dependencies.auditQuery?.list({
        resourceId: input.resourceId,
        limit: Math.max(1, Math.min(200, input.limit ?? 100)),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })) ?? []
    );
  }
}

export class LockStagingBatchHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly expectedRevision: GitCommitSha;
      readonly checklist: readonly string[];
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly lock: StagingBatchLock; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    if (
      input.checklist.length === 0 ||
      input.checklist.length > 50 ||
      input.checklist.some((item) => item.trim().length === 0 || item.length > 200)
    ) {
      throw new CmsError({
        code: "CMS_STAGING_010",
        message: "Complete at least one valid release check before locking Staging.",
        category: "validation",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const branch = stagingBranch(this.dependencies);
      const current = await this.dependencies.git.resolveRef(branch, context.signal);
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_STAGING_011",
          message: "Staging changed before the release candidate could be locked.",
          category: "conflict",
          retryable: true,
        });
      }
      const existing = await this.dependencies.git.readFile({
        ref: branch,
        path: STAGING_LOCK_PATH,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (existing !== undefined) {
        throw new CmsError({
          code: "CMS_STAGING_012",
          message: "Staging is already locked for release testing.",
          category: "conflict",
          retryable: true,
        });
      }
      const lock: StagingBatchLock = {
        batchRevision: current.sha,
        lockedBy: context.actor.id,
        lockedAt: isoTimestamp(this.dependencies.clock.now()),
        checklist: [...new Set(input.checklist.map((item) => item.trim()))].sort(),
      };
      const committed = await this.dependencies.git.commitFiles({
        branch,
        expectedSha: current.sha,
        files: [{ path: STAGING_LOCK_PATH, content: yamlCodec.serialize(lock) }],
        message: "Lock Staging release candidate",
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:lock`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "staging.locked",
        committed.sha,
        { batchRevision: lock.batchRevision, checklist: lock.checklist },
      );
      return { lock, revision: committed.sha };
    });
  }
}

export class UnlockStagingBatchHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const branch = stagingBranch(this.dependencies);
      const current = await this.dependencies.git.resolveRef(branch, context.signal);
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_STAGING_011",
          message: "Staging changed before the release candidate could be unlocked.",
          category: "conflict",
          retryable: true,
        });
      }
      const existing = await this.dependencies.git.readFile({
        ref: branch,
        path: STAGING_LOCK_PATH,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (existing === undefined) return { revision: current.sha };
      const committed = await this.dependencies.git.commitFiles({
        branch,
        expectedSha: current.sha,
        files: [{ path: STAGING_LOCK_PATH, content: null }],
        message: "Unlock Staging release candidate",
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:unlock`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "staging.unlocked",
        committed.sha,
      );
      return { revision: committed.sha };
    });
  }
}

export class RemoveChangeFromStagingHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly expectedRevision: GitCommitSha;
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{
    readonly change: Change;
    readonly revision: GitCommitSha;
    readonly pullRequest: PullRequest;
  }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    if (input.change.status !== "staging" || input.change.pullRequestNumber === undefined) {
      throw new CmsError({
        code: "CMS_STAGING_014",
        message: "Only a staged Change with a completed review can be removed.",
        category: "validation",
        retryable: false,
      });
    }
    const originalPullRequestNumber = input.change.pullRequestNumber;
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const branch = stagingBranch(this.dependencies);
      const [current, lock] = await Promise.all([
        this.dependencies.git.resolveRef(branch, context.signal),
        this.dependencies.git.readFile({
          ref: branch,
          path: STAGING_LOCK_PATH,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      ]);
      if (lock !== undefined) {
        throw new CmsError({
          code: "CMS_STAGING_013",
          message: "Unlock the tested release candidate before removing a Change.",
          category: "conflict",
          retryable: true,
        });
      }
      if (current.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_STAGING_011",
          message: "Staging changed before the selected Change could be removed.",
          category: "conflict",
          retryable: true,
        });
      }
      const pullRequest = await this.dependencies.git.createRevertPullRequest({
        pullRequestNumber: originalPullRequestNumber,
        title: `Remove ${input.change.name} from Staging`,
        body: [
          `Revert Change ${input.change.id} before the next Production release.`,
          "",
          `Change-ID: ${input.change.id}`,
        ].join("\n"),
        idempotencyKey: `${input.idempotencyKey}:revert-pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const revertHead = await this.dependencies.git.resolveRef(pullRequest.head, context.signal);
      const reverted = await this.dependencies.git.mergePullRequest({
        number: pullRequest.number,
        strategy: "merge",
        expectedHeadSha: revertHead.sha,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const change: Change = {
        ...input.change,
        status: "archived",
        updatedAt: isoTimestamp(this.dependencies.clock.now()),
      };
      const recorded = await this.dependencies.git.commitFiles({
        branch,
        expectedSha: reverted.sha,
        files: [
          {
            path: `.cms/changes/${change.id}.yaml`,
            content: yamlCodec.serialize(change),
          },
        ],
        message: `Record removal of ${change.name} from Staging\n\nChange-ID: ${change.id}`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.removed-from-staging",
        change.id,
        { pullRequestNumber: pullRequest.number, revision: recorded.sha },
      );
      return { change, revision: recorded.sha, pullRequest };
    });
  }
}

interface ChangeDocumentMerge {
  readonly documentId: DocumentId;
  readonly base?: ContentDocument;
  readonly change?: ContentDocument;
  readonly staging?: ContentDocument;
  readonly candidate?: ContentDocument;
  readonly conflicts: readonly ChangeConflict[];
}

function sameDocument(
  left: ContentDocument | undefined,
  right: ContentDocument | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.type === right.type &&
    left.schemaVersion === right.schemaVersion &&
    canonicalJson(left.data) === canonicalJson(right.data)
  );
}

async function readOptionalDocument(input: {
  readonly dependencies: CommandDependencies;
  readonly ref: string;
  readonly documentId: DocumentId;
  readonly signal?: AbortSignal;
}): Promise<ContentDocument | undefined> {
  return input.dependencies.content
    .readDocument({
      ref: input.ref,
      documentId: input.documentId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    .catch(() => undefined);
}

async function listAllDocumentIds(input: {
  readonly dependencies: CommandDependencies;
  readonly refs: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<readonly DocumentId[]> {
  const ids = new Set<DocumentId>();
  for (const ref of input.refs) {
    let cursor: string | undefined;
    do {
      const page = await input.dependencies.content.listDocuments({
        ref,
        ...(cursor === undefined ? {} : { cursor }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      for (const document of page.items) ids.add(document.id);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return [...ids].sort();
}

function documentConflict(input: {
  readonly documentId: DocumentId;
  readonly base?: ContentDocument;
  readonly change?: ContentDocument;
  readonly staging?: ContentDocument;
}): ChangeConflict {
  return {
    documentId: input.documentId,
    path: "" as ContentPath,
    base: input.base?.data,
    change: input.change?.data,
    staging: input.staging?.data,
    scope: "document",
  };
}

function mergeDocumentVersions(input: {
  readonly documentId: DocumentId;
  readonly base?: ContentDocument;
  readonly change?: ContentDocument;
  readonly staging?: ContentDocument;
}): ChangeDocumentMerge {
  const { documentId, base, change, staging } = input;
  if (base === undefined) {
    if (change === undefined) {
      return {
        documentId,
        ...(staging === undefined ? {} : { staging, candidate: staging }),
        conflicts: [],
      };
    }
    if (staging === undefined || sameDocument(change, staging)) {
      return {
        documentId,
        change,
        ...(staging === undefined ? {} : { staging }),
        candidate: change,
        conflicts: [],
      };
    }
    return {
      documentId,
      change,
      staging,
      candidate: change,
      conflicts: [documentConflict({ documentId, change, staging })],
    };
  }

  if (change === undefined) {
    if (staging === undefined) {
      return { documentId, base, conflicts: [] };
    }
    if (sameDocument(base, staging)) {
      return { documentId, base, staging, conflicts: [] };
    }
    return {
      documentId,
      base,
      staging,
      conflicts: [documentConflict({ documentId, base, staging })],
    };
  }
  if (staging === undefined) {
    if (sameDocument(base, change)) {
      return { documentId, base, change, conflicts: [] };
    }
    return {
      documentId,
      base,
      change,
      candidate: change,
      conflicts: [documentConflict({ documentId, base, change })],
    };
  }

  const changeMetadataChanged =
    change.type !== base.type || change.schemaVersion !== base.schemaVersion;
  const stagingMetadataChanged =
    staging.type !== base.type || staging.schemaVersion !== base.schemaVersion;
  if (
    changeMetadataChanged &&
    stagingMetadataChanged &&
    (change.type !== staging.type || change.schemaVersion !== staging.schemaVersion)
  ) {
    return {
      documentId,
      base,
      change,
      staging,
      candidate: change,
      conflicts: [documentConflict({ documentId, base, change, staging })],
    };
  }

  const merged = mergeDocuments(base.data, change.data, staging.data);
  const metadataSource = stagingMetadataChanged ? staging : change;
  return {
    documentId,
    base,
    change,
    staging,
    candidate: {
      ...metadataSource,
      id: documentId,
      revision: change.revision,
      data: merged.document,
    },
    conflicts: merged.conflicts.map((conflict) => ({
      documentId,
      path: conflict.path,
      base: conflict.base,
      change: conflict.ours,
      staging: conflict.theirs,
      scope: "field",
    })),
  };
}

async function inspectChangeConflicts(input: {
  readonly dependencies: CommandDependencies;
  readonly change: Change;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly stagingRevision: GitCommitSha;
  readonly documents: readonly ChangeDocumentMerge[];
}> {
  const stagingRef = await input.dependencies.git.resolveRef(
    stagingBranch(input.dependencies),
    input.signal,
  );
  const ids = await listAllDocumentIds({
    dependencies: input.dependencies,
    refs: [input.change.baseCommit, input.change.branchName, stagingBranch(input.dependencies)],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const documents = await Promise.all(
    ids.map(async (documentId) => {
      const [base, change, staging] = await Promise.all([
        readOptionalDocument({
          dependencies: input.dependencies,
          ref: input.change.baseCommit,
          documentId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
        readOptionalDocument({
          dependencies: input.dependencies,
          ref: input.change.branchName,
          documentId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
        readOptionalDocument({
          dependencies: input.dependencies,
          ref: stagingBranch(input.dependencies),
          documentId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      ]);
      return mergeDocumentVersions({
        documentId,
        ...(base === undefined ? {} : { base }),
        ...(change === undefined ? {} : { change }),
        ...(staging === undefined ? {} : { staging }),
      });
    }),
  );
  return { stagingRevision: stagingRef.sha, documents };
}

function valueAtPath(
  value: unknown,
  path: ContentPath,
): { readonly exists: boolean; readonly value: unknown } {
  let current = value;
  for (const segment of parseContentPath(path)) {
    if (typeof current !== "object" || current === null) {
      return { exists: false, value: undefined };
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(segment)) return { exists: false, value: undefined };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, segment)) return { exists: false, value: undefined };
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return { exists: true, value: current };
}

export class ReadChangeConflictsHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: { readonly change: Change },
    context: RequestContext,
  ): Promise<{
    readonly conflicts: readonly ChangeConflict[];
    readonly stagingRevision: GitCommitSha;
  }> {
    this.dependencies.authorization.assert(context.actor, "project.read");
    const inspected = await inspectChangeConflicts({
      dependencies: this.dependencies,
      change: input.change,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return {
      conflicts: inspected.documents.flatMap((document) => document.conflicts),
      stagingRevision: inspected.stagingRevision,
    };
  }
}

export class ResolveChangeConflictsHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly change: Change;
      readonly expectedRevision: GitCommitSha;
      readonly resolutions: readonly ChangeConflictResolution[];
      readonly idempotencyKey: string;
    },
    context: RequestContext,
  ): Promise<{ readonly change: Change; readonly revision: GitCommitSha }> {
    this.dependencies.authorization.assert(context.actor, "change.edit", {
      ownerId: input.change.ownerId,
      policy: { ownerOnly: ["change.edit"] },
    });
    if (!["draft", "changes_requested", "in_review", "approved"].includes(input.change.status)) {
      throw new CmsError({
        code: "CMS_CHANGE_016",
        message: "Conflicts can only be resolved before a Change enters Staging.",
        category: "conflict",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const branch = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      if (branch.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Change moved before its conflicts could be resolved.",
          category: "conflict",
          retryable: true,
        });
      }
      const inspected = await inspectChangeConflicts({
        dependencies: this.dependencies,
        change: input.change,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const allConflicts = inspected.documents.flatMap((document) => document.conflicts);
      if (allConflicts.length === 0) {
        throw new CmsError({
          code: "CMS_CHANGE_017",
          message: "This Change has no semantic conflicts with Staging.",
          category: "validation",
          retryable: false,
        });
      }
      const resolutions = input.resolutions.map((resolution) => {
        if (resolution.choice !== "change" && resolution.choice !== "staging") {
          throw new CmsError({
            code: "CMS_CHANGE_018",
            message: "A conflict resolution must choose this Change or Staging.",
            category: "validation",
            retryable: false,
          });
        }
        return { ...resolution, path: contentPath(resolution.path) };
      });
      const knownConflicts = new Set(
        allConflicts.map((conflict) => `${conflict.documentId}:${conflict.path}`),
      );
      const choices = new Map<string, ChangeConflictResolution["choice"]>();
      for (const resolution of resolutions) {
        const key = `${resolution.documentId}:${resolution.path}`;
        if (choices.has(key) || !knownConflicts.has(key)) {
          throw new CmsError({
            code: "CMS_CHANGE_018",
            message: `Conflict ${key} is unknown or has more than one resolution.`,
            category: "validation",
            retryable: false,
          });
        }
        choices.set(key, resolution.choice);
      }
      const unresolved = allConflicts.filter(
        (conflict) => !choices.has(`${conflict.documentId}:${conflict.path}`),
      );
      if (unresolved.length > 0) {
        throw new CmsError({
          code: "CMS_CHANGE_019",
          message: "Choose a value for every semantic conflict before continuing.",
          category: "validation",
          retryable: false,
          context: {
            paths: unresolved.map((conflict) => `${conflict.documentId}${conflict.path}`),
          },
        });
      }

      const finalDocuments = new Map<DocumentId, ContentDocument | undefined>();
      for (const merged of inspected.documents) {
        let candidate = merged.candidate;
        const wholeDocumentConflict = merged.conflicts.find(
          (conflict) => conflict.scope === "document",
        );
        if (wholeDocumentConflict !== undefined) {
          candidate =
            choices.get(`${merged.documentId}:${wholeDocumentConflict.path}`) === "staging"
              ? merged.staging
              : merged.change;
        } else if (candidate !== undefined) {
          let data = candidate.data;
          for (const conflict of merged.conflicts) {
            if (choices.get(`${merged.documentId}:${conflict.path}`) !== "staging") continue;
            const stagingValue = valueAtPath(merged.staging?.data, conflict.path);
            data = applyPatch(
              data,
              stagingValue.exists
                ? {
                    op: "set",
                    path: conflict.path,
                    value: stagingValue.value,
                    metadata: {
                      id: `resolve-${merged.documentId}-${conflict.path}`,
                      actorId: context.actor.id,
                      createdAt: this.dependencies.clock.now().toISOString(),
                      source: "editor",
                    },
                  }
                : {
                    op: "unset",
                    path: conflict.path,
                    metadata: {
                      id: `resolve-${merged.documentId}-${conflict.path}`,
                      actorId: context.actor.id,
                      createdAt: this.dependencies.clock.now().toISOString(),
                      source: "editor",
                    },
                  },
            );
          }
          candidate = { ...candidate, data };
        }
        finalDocuments.set(merged.documentId, candidate);
      }

      let contentRevision = branch.sha;
      const writes = inspected.documents.flatMap((merged) => {
        const candidate = finalDocuments.get(merged.documentId);
        return candidate !== undefined && !sameDocument(candidate, merged.change)
          ? [{ ...candidate, revision: contentRevision }]
          : [];
      });
      if (writes.length > 0) {
        contentRevision = await this.dependencies.content.writeDocuments({
          ref: input.change.branchName,
          documents: writes,
          expectedRevision: contentRevision,
          message: `Resolve ${String(allConflicts.length)} conflict(s) with Staging`,
          actor: context.actor,
          idempotencyKey: `${input.idempotencyKey}:documents`,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      }
      const deletions = inspected.documents
        .filter(
          (merged) =>
            merged.change !== undefined && finalDocuments.get(merged.documentId) === undefined,
        )
        .map((merged) => merged.documentId);
      if (deletions.length > 0) {
        contentRevision = await this.dependencies.content.deleteDocuments({
          ref: input.change.branchName,
          documentIds: deletions,
          expectedRevision: contentRevision,
          actor: context.actor,
          idempotencyKey: `${input.idempotencyKey}:deletions`,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      }

      const current = await this.dependencies.git.resolveRef(
        input.change.branchName,
        context.signal,
      );
      const change: Change = {
        ...input.change,
        baseBranch: stagingBranch(this.dependencies),
        baseCommit: inspected.stagingRevision,
        status: input.change.status === "approved" ? "in_review" : input.change.status,
        updatedAt: isoTimestamp(this.dependencies.clock.now()),
      };
      const committed = await this.dependencies.git.commitFiles({
        branch: input.change.branchName,
        expectedSha: current.sha,
        files: [{ path: ".cms/change.yaml", content: yamlCodec.serialize(change) }],
        message: changeCommitMessage(change, "Resolve semantic conflicts with Staging"),
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:metadata`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "change.conflicts-resolved",
        change.id,
        {
          revision: committed.sha,
          stagingRevision: inspected.stagingRevision,
          resolutions: resolutions.map((resolution) => ({
            documentId: resolution.documentId,
            path: resolution.path,
            choice: resolution.choice,
          })),
          approvalReset: input.change.status === "approved",
        },
      );
      return { change, revision: committed.sha };
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
      const lock = await this.dependencies.git.readFile({
        ref: stagingBranch(this.dependencies),
        path: STAGING_LOCK_PATH,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (lock !== undefined) {
        throw new CmsError({
          code: "CMS_STAGING_013",
          message: "Staging is locked while the current release candidate is being tested.",
          category: "conflict",
          retryable: true,
        });
      }
      const inspected = await inspectChangeConflicts({
        dependencies: this.dependencies,
        change: input.change,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const conflicts = inspected.documents.flatMap((document) =>
        document.conflicts.map((conflict) => `${conflict.documentId}${conflict.path}`),
      );
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
  const stagingLock = await input.dependencies.git.readFile({
    ref: branch,
    path: STAGING_LOCK_PATH,
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
  });
  const committed = await input.dependencies.git.commitFiles({
    branch,
    expectedSha: input.revision,
    files: [
      ...changes.map(({ path, change }) => ({
        path,
        content: yamlCodec.serialize({
          ...change,
          status: "published",
          updatedAt: isoTimestamp(input.dependencies.clock.now()),
        } satisfies Change),
      })),
      ...(stagingLock === undefined ? [] : [{ path: STAGING_LOCK_PATH, content: null }]),
    ],
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

export interface PublishEmergencyChangeCommand {
  readonly change: Change;
  readonly pullRequestNumber: number;
  readonly expectedRevision: GitCommitSha;
  readonly configVersion: number;
  readonly registryDigest: string;
  readonly schemaVersion: number;
  readonly expectedPointerRevision?: string;
  readonly idempotencyKey: string;
}

export class PublishEmergencyChangeHandler {
  private readonly buildAndPublish: BuildAndPublishReleaseHandler;

  constructor(private readonly dependencies: CommandDependencies) {
    this.buildAndPublish = new BuildAndPublishReleaseHandler(dependencies);
  }

  async execute(
    input: PublishEmergencyChangeCommand,
    context: RequestContext,
  ): Promise<{
    readonly change: Change;
    readonly revision: GitCommitSha;
    readonly stagingRevision: GitCommitSha;
    readonly release: StoredRelease;
  }> {
    this.dependencies.authorization.assert(context.actor, "staging.publish");
    if (input.change.emergency !== true || input.change.status !== "approved") {
      throw new CmsError({
        code: "CMS_CHANGE_012",
        message: "Only an approved Emergency Change can use the direct Production path.",
        category: "conflict",
        retryable: false,
      });
    }
    return once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      const head = await this.dependencies.git.resolveRef(input.change.branchName, context.signal);
      if (head.sha !== input.expectedRevision) {
        throw new CmsError({
          code: "CMS_CHANGE_003",
          message: "The Emergency Change moved while publication was being prepared.",
          category: "conflict",
          retryable: true,
        });
      }
      const checks = await this.dependencies.review?.listChecks(head.sha, context.signal);
      const blocking =
        checks?.filter(
          (check) =>
            check.required && (check.status !== "completed" || check.conclusion !== "success"),
        ) ?? [];
      if (blocking.length > 0) {
        throw new CmsError({
          code: "CMS_REVIEW_008",
          message: "Required checks must pass before an Emergency Change can be published.",
          category: "conflict",
          retryable: true,
          context: { checks: blocking.map((check) => check.name) },
        });
      }
      const merged = await this.dependencies.git.mergePullRequest({
        number: input.pullRequestNumber,
        strategy: "squash",
        expectedHeadSha: head.sha,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const change: Change = {
        ...input.change,
        status: "published",
        updatedAt: isoTimestamp(this.dependencies.clock.now()),
      };
      const recorded = await this.dependencies.git.commitFiles({
        branch: mainBranch(this.dependencies),
        expectedSha: merged.sha,
        files: [
          {
            path: `.cms/changes/${change.id}.yaml`,
            content: yamlCodec.serialize(change),
          },
        ],
        message: changeCommitMessage(change, `Record Emergency Change "${change.name}"`),
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:status`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const release = await this.buildAndPublish.execute(
        {
          ref: mainBranch(this.dependencies),
          expectedRevision: recorded.sha,
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
      const syncPullRequest = await this.dependencies.git.createPullRequest({
        head: mainBranch(this.dependencies),
        base: stagingBranch(this.dependencies),
        title: `Forward-sync Emergency Change: ${change.name}`,
        body: `Synchronize Emergency Change ${change.id} from Production into Staging.\n\nMain-Revision: ${recorded.sha}`,
        idempotencyKey: `${input.idempotencyKey}:sync-pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const synchronized = await this.dependencies.git.mergePullRequest({
        number: syncPullRequest.number,
        strategy: "merge",
        expectedHeadSha: recorded.sha,
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
        "change.emergency-published",
        change.id,
        {
          releaseId: release.id,
          mainRevision: recorded.sha,
          stagingRevision: synchronized.sha,
          syncPullRequest: syncPullRequest.number,
        },
      );
      return {
        change,
        revision: recorded.sha,
        stagingRevision: synchronized.sha,
        release,
      };
    });
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

export class RevalidateReleaseHandler {
  constructor(private readonly dependencies: CommandDependencies) {}

  async execute(
    input: {
      readonly releaseId: ReleaseId;
      readonly environment: "preview" | "staging" | "production";
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
    const release = await store.readRelease(input.releaseId, context.signal);
    if (release === undefined) {
      throw new CmsError({
        code: "CMS_PUBLISH_008",
        message: "The selected release does not exist.",
        category: "validation",
        retryable: false,
      });
    }
    await once(this.dependencies.idempotency, input.idempotencyKey, async () => {
      if (this.dependencies.publicationNotifier === undefined) {
        throw new CmsError({
          code: "CMS_INTEGRATION_001",
          message: "No publication revalidation adapter is configured.",
          category: "configuration",
          retryable: false,
        });
      }
      await notifyPublication({
        notifier: this.dependencies.publicationNotifier,
        release,
        environment: input.environment,
        idempotencyKey: input.idempotencyKey,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "release.revalidated",
        release.id,
        { environment: input.environment },
      );
    });
  }
}

function rollbackRepositoryFiles(release: StoredRelease): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  const files: { path: string; content: string }[] = [];
  for (const [path, source] of Object.entries(release.files)) {
    if (!path.startsWith("content/") || !path.endsWith(".json")) continue;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      continue;
    }
    const record = recordValue(value);
    if (
      typeof record.id !== "string" ||
      typeof record.type !== "string" ||
      typeof record.schemaVersion !== "number"
    ) {
      continue;
    }
    files.push({
      path: `${path.slice(0, -".json".length)}.yaml`,
      content: yamlCodec.serialize(record),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export interface RollbackReleaseResult {
  readonly pullRequest: PullRequest;
  readonly stagingPullRequest: PullRequest;
  readonly revision: GitCommitSha;
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
  ): Promise<RollbackReleaseResult> {
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
      const currentContent = await this.dependencies.git.listFiles({
        ref: mainBranch(this.dependencies),
        prefix: "content/",
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const targetContent = rollbackRepositoryFiles(release);
      const targetPaths = new Set(targetContent.map((file) => file.path));
      const committed = await this.dependencies.git.commitFiles({
        branch,
        expectedSha: created.sha,
        files: [
          ...currentContent
            .filter((file) => !targetPaths.has(file.path))
            .map((file) => ({ path: file.path, content: null })),
          ...targetContent,
          {
            path: ".cms/rollback.yaml",
            content: yamlCodec.serialize({
              releaseId: input.releaseId,
              releaseRevision: releaseManifestDetails(release).revision,
              previousPointerRevision: input.expectedPointerRevision,
              requestedBy: context.actor.login,
              requestedAt: this.dependencies.clock.now().toISOString(),
              restoredDocuments: targetContent.length,
            }),
          },
        ],
        message: `Reconcile repository with rollback ${input.releaseId}`,
        author: context.actor,
        idempotencyKey: `${input.idempotencyKey}:commit`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const pullRequest = await this.dependencies.git.createPullRequest({
        head: branch,
        base: mainBranch(this.dependencies),
        title: `Reconcile Production with rollback ${input.releaseId}`,
        body: `Production was atomically restored to ${input.releaseId} before this repository reconciliation PR was opened.\n\nThe content tree is restored from the immutable release and remains fully auditable.`,
        idempotencyKey: `${input.idempotencyKey}:pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const stagingBranchName = `rollback-staging/${input.releaseId}-${this.dependencies.ids.suffix()}`;
      await this.dependencies.git.createBranch({
        branch: stagingBranchName,
        from: committed.sha,
        idempotencyKey: `${input.idempotencyKey}:staging-branch`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const stagingPullRequest = await this.dependencies.git.createPullRequest({
        head: stagingBranchName,
        base: stagingBranch(this.dependencies),
        title: `Synchronize Staging after rollback ${input.releaseId}`,
        body: `Apply the same repository reconciliation as Production so the next release cannot accidentally reintroduce reverted content.`,
        idempotencyKey: `${input.idempotencyKey}:staging-pr`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      await audit(
        this.dependencies.audit,
        this.dependencies.clock,
        context,
        "release.rolled-back",
        input.releaseId,
        {
          pointerFirst: true,
          reconciliationPullRequest: pullRequest.number,
          stagingPullRequest: stagingPullRequest.number,
          revision: committed.sha,
          restoredDocuments: targetContent.length,
        },
      );
      return { pullRequest, stagingPullRequest, revision: committed.sha };
    });
  }
}

export interface CmsApplication {
  readonly createChange: CreateChangeHandler;
  readonly updateChange: UpdateChangeHandler;
  readonly deleteChange: DeleteChangeHandler;
  readonly commitChange: CommitChangeHandler;
  readonly createDocument: CreateDocumentHandler;
  readonly updateDocument: UpdateDocumentHandler;
  readonly deleteDocument: DeleteDocumentHandler;
  readonly importTranslation: ImportTranslationHandler;
  readonly createTranslationJob: CreateTranslationJobHandler;
  readonly readTranslationJob: ReadTranslationJobHandler;
  readonly createAssetUpload: CreateAssetUploadHandler;
  readonly receiveAssetUpload: ReceiveAssetUploadHandler;
  readonly finalizeAssetUpload: FinalizeAssetUploadHandler;
  readonly updateAsset: UpdateAssetHandler;
  readonly deleteAsset: DeleteAssetHandler;
  readonly createPreviewSession: CreatePreviewSessionHandler;
  readonly readPreviewSession: ReadPreviewSessionHandler;
  readonly refreshPreviewSession: RefreshPreviewSessionHandler;
  readonly readTeamDirectory: ReadTeamDirectoryHandler;
  readonly inviteTeamMember: InviteTeamMemberHandler;
  readonly addTeamMember: AddTeamMemberHandler;
  readonly updateTeamRoleMappings: UpdateTeamRoleMappingsHandler;
  readonly scheduleContent: ScheduleContentHandler;
  readonly executeSchedule: ExecuteScheduleHandler;
  readonly executeDueSchedules: ExecuteDueSchedulesHandler;
  readonly submitChange: SubmitChangeHandler;
  readonly reviewChange: ReviewChangeHandler;
  readonly resolveReviewComment: ResolveReviewCommentHandler;
  readonly assignReviewers: AssignReviewersHandler;
  readonly requestChanges: RequestChangesHandler;
  readonly archiveChange: ArchiveChangeHandler;
  readonly readStagingBatch: ReadStagingBatchHandler;
  readonly readAuditTimeline: ReadAuditTimelineHandler;
  readonly lockStagingBatch: LockStagingBatchHandler;
  readonly unlockStagingBatch: UnlockStagingBatchHandler;
  readonly removeChangeFromStaging: RemoveChangeFromStagingHandler;
  readonly approveChange: ApproveChangeHandler;
  readonly readChangeConflicts: ReadChangeConflictsHandler;
  readonly resolveChangeConflicts: ResolveChangeConflictsHandler;
  readonly addChangeToStaging: AddChangeToStagingHandler;
  readonly promoteStaging: PromoteStagingHandler;
  readonly buildAndPublishRelease: BuildAndPublishReleaseHandler;
  readonly publishStaging: PublishStagingHandler;
  readonly publishEmergencyChange: PublishEmergencyChangeHandler;
  readonly publishRelease: PublishReleaseHandler;
  readonly revalidateRelease: RevalidateReleaseHandler;
  readonly rollbackRelease: RollbackReleaseHandler;
}

export function createCmsApplication(dependencies: CommandDependencies): CmsApplication {
  return {
    createChange: new CreateChangeHandler(dependencies),
    updateChange: new UpdateChangeHandler(dependencies),
    deleteChange: new DeleteChangeHandler(dependencies),
    commitChange: new CommitChangeHandler(dependencies),
    createDocument: new CreateDocumentHandler(dependencies),
    updateDocument: new UpdateDocumentHandler(dependencies),
    deleteDocument: new DeleteDocumentHandler(dependencies),
    importTranslation: new ImportTranslationHandler(dependencies),
    createTranslationJob: new CreateTranslationJobHandler(dependencies),
    readTranslationJob: new ReadTranslationJobHandler(dependencies),
    createAssetUpload: new CreateAssetUploadHandler(dependencies),
    receiveAssetUpload: new ReceiveAssetUploadHandler(dependencies),
    finalizeAssetUpload: new FinalizeAssetUploadHandler(dependencies),
    updateAsset: new UpdateAssetHandler(dependencies),
    deleteAsset: new DeleteAssetHandler(dependencies),
    createPreviewSession: new CreatePreviewSessionHandler(dependencies),
    readPreviewSession: new ReadPreviewSessionHandler(dependencies),
    refreshPreviewSession: new RefreshPreviewSessionHandler(dependencies),
    readTeamDirectory: new ReadTeamDirectoryHandler(dependencies),
    inviteTeamMember: new InviteTeamMemberHandler(dependencies),
    addTeamMember: new AddTeamMemberHandler(dependencies),
    updateTeamRoleMappings: new UpdateTeamRoleMappingsHandler(dependencies),
    scheduleContent: new ScheduleContentHandler(dependencies),
    executeSchedule: new ExecuteScheduleHandler(dependencies),
    executeDueSchedules: new ExecuteDueSchedulesHandler(dependencies),
    submitChange: new SubmitChangeHandler(dependencies),
    reviewChange: new ReviewChangeHandler(dependencies),
    resolveReviewComment: new ResolveReviewCommentHandler(dependencies),
    assignReviewers: new AssignReviewersHandler(dependencies),
    requestChanges: new RequestChangesHandler(dependencies),
    archiveChange: new ArchiveChangeHandler(dependencies),
    readStagingBatch: new ReadStagingBatchHandler(dependencies),
    readAuditTimeline: new ReadAuditTimelineHandler(dependencies),
    lockStagingBatch: new LockStagingBatchHandler(dependencies),
    unlockStagingBatch: new UnlockStagingBatchHandler(dependencies),
    removeChangeFromStaging: new RemoveChangeFromStagingHandler(dependencies),
    approveChange: new ApproveChangeHandler(dependencies),
    readChangeConflicts: new ReadChangeConflictsHandler(dependencies),
    resolveChangeConflicts: new ResolveChangeConflictsHandler(dependencies),
    addChangeToStaging: new AddChangeToStagingHandler(dependencies),
    promoteStaging: new PromoteStagingHandler(dependencies),
    buildAndPublishRelease: new BuildAndPublishReleaseHandler(dependencies),
    publishStaging: new PublishStagingHandler(dependencies),
    publishEmergencyChange: new PublishEmergencyChangeHandler(dependencies),
    publishRelease: new PublishReleaseHandler(dependencies),
    revalidateRelease: new RevalidateReleaseHandler(dependencies),
    rollbackRelease: new RollbackReleaseHandler(dependencies),
  };
}
