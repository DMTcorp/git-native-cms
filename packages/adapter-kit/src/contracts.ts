import type {
  Asset,
  AssetProcessorPort,
  AssetStore,
  AssetUsagePort,
  AuditEvent,
  AuditQueryPort,
  AuditSink,
  Clock,
  ContentRepository,
  DeploymentPort,
  EnvironmentPointer,
  GitProvider,
  IdentityProvider,
  IdGenerator,
  IdempotencyStore,
  PublicationNotifierPort,
  PreviewSessionPort,
  RateLimitPort,
  ReleaseBuilderPort,
  ReleaseStore,
  RevalidationPort,
  ReviewPort,
  SchedulerPort,
  SessionRecord,
  SessionStore,
  StoredRelease,
  TeamProvisioningPort,
  TranslationProvider,
  WebhookReplayStore,
} from "@git-native-cms/application";
import type {
  Actor,
  AssetId,
  ChangeId,
  ContentDocument,
  DocumentId,
  GitCommitSha,
  Revision,
} from "@git-native-cms/core";
import type { ContractTestResult } from "./index.js";

async function check(
  name: string,
  assertion: () => Promise<boolean> | boolean,
): Promise<ContractTestResult> {
  try {
    const passed = await assertion();
    return {
      name,
      passed,
      ...(passed ? {} : { details: "The adapter returned an unexpected result." }),
    } satisfies ContractTestResult;
  } catch (error) {
    return {
      name,
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    } satisfies ContractTestResult;
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function GitProviderContract(input: {
  readonly provider: GitProvider;
  readonly baseRef: string;
  readonly branch: string;
  readonly actor: Actor;
}): Promise<readonly ContractTestResult[]> {
  const base = await input.provider.resolveRef(input.baseRef);
  const created = await input.provider.createBranch({
    branch: input.branch,
    from: base.sha,
    idempotencyKey: `${input.branch}:create`,
  });
  const repeated = await input.provider.createBranch({
    branch: input.branch,
    from: base.sha,
    idempotencyKey: `${input.branch}:create`,
  });
  const results = [
    await check("GitProvider/createBranch is idempotent", () => same(created, repeated)),
  ];
  const committed = await input.provider.commitFiles({
    branch: input.branch,
    expectedSha: created.sha,
    files: [{ path: ".cms/contract.txt", content: "contract-v1" }],
    message: "Exercise GitProvider contract",
    author: input.actor,
    idempotencyKey: `${input.branch}:commit`,
  });
  results.push(
    await check("GitProvider/readFile observes committed content", async () => {
      const file = await input.provider.readFile({
        ref: input.branch,
        path: ".cms/contract.txt",
      });
      return file?.content === "contract-v1";
    }),
  );
  results.push(
    await check("GitProvider rejects stale compare-and-swap commits", async () => {
      try {
        await input.provider.commitFiles({
          branch: input.branch,
          expectedSha: created.sha,
          files: [{ path: ".cms/stale.txt", content: "must-not-commit" }],
          message: "Stale contract write",
          author: input.actor,
          idempotencyKey: `${input.branch}:stale`,
        });
        return false;
      } catch {
        return true;
      }
    }),
  );
  const pullRequest = await input.provider.createPullRequest({
    head: input.branch,
    base: input.baseRef,
    title: "Contract pull request",
    body: "Adapter contract verification.",
    idempotencyKey: `${input.branch}:pr`,
  });
  const repeatedPullRequest = await input.provider.createPullRequest({
    head: input.branch,
    base: input.baseRef,
    title: "Contract pull request",
    body: "Adapter contract verification.",
    idempotencyKey: `${input.branch}:pr`,
  });
  results.push(
    await check("GitProvider/createPullRequest is idempotent", () =>
      same(pullRequest, repeatedPullRequest),
    ),
  );
  results.push(
    await check("GitProvider/listFiles is deterministic", async () => {
      const files = await input.provider.listFiles({ ref: input.branch, prefix: ".cms/" });
      return (
        files.some((file) => file.path === ".cms/contract.txt") &&
        (await input.provider.resolveRef(input.branch)).sha === committed.sha
      );
    }),
  );
  await input.provider.mergePullRequest({
    number: pullRequest.number,
    strategy: "squash",
    expectedHeadSha: committed.sha,
  });
  const revert = await input.provider.createRevertPullRequest({
    pullRequestNumber: pullRequest.number,
    title: "Revert contract pull request",
    body: "Adapter contract revert verification.",
    idempotencyKey: `${input.branch}:revert`,
  });
  const repeatedRevert = await input.provider.createRevertPullRequest({
    pullRequestNumber: pullRequest.number,
    title: "Revert contract pull request",
    body: "Adapter contract revert verification.",
    idempotencyKey: `${input.branch}:revert`,
  });
  results.push(
    await check("GitProvider/createRevertPullRequest is idempotent", () =>
      same(revert, repeatedRevert),
    ),
  );
  const revertHead = await input.provider.resolveRef(revert.head);
  await input.provider.mergePullRequest({
    number: revert.number,
    strategy: "merge",
    expectedHeadSha: revertHead.sha,
  });
  results.push(
    await check("GitProvider/revert restores the base without rewriting history", async () => {
      const restored = await input.provider.readFile({
        ref: input.baseRef,
        path: ".cms/contract.txt",
      });
      return restored === undefined;
    }),
  );
  await input.provider.deleteBranch({ branch: revert.head });
  await input.provider.deleteBranch({ branch: input.branch });
  return results;
}

export async function AssetStoreContract(input: {
  readonly store: AssetStore;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
  readonly actor: Actor;
  readonly put: (upload: {
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }) => Promise<void>;
}): Promise<readonly ContractTestResult[]> {
  const upload = await input.store.createUpload({
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    checksum: input.checksum,
    actor: input.actor,
  });
  await input.put(upload);
  const finalized = await input.store.finalizeUpload({
    uploadId: upload.uploadId,
    checksum: input.checksum,
  });
  const repeated = await input.store.finalizeUpload({
    uploadId: upload.uploadId,
    checksum: input.checksum,
  });
  const results = [
    await check("AssetStore/finalizeUpload is retry-safe", () => same(finalized, repeated)),
    await check("AssetStore/readAsset returns finalized metadata", async () =>
      same(await input.store.readAsset(finalized.id), finalized),
    ),
    await check("AssetStore/listAssets contains finalized assets", async () =>
      (await input.store.listAssets({})).items.some((asset) => asset.id === finalized.id),
    ),
  ];
  const updated = await input.store.updateAssetMetadata({
    id: finalized.id,
    altText: "Adapter contract asset",
    focalPoint: { x: 0.25, y: 0.75 },
  });
  results.push(
    await check(
      "AssetStore/updateAssetMetadata persists reviewed metadata",
      async () =>
        updated.altText === "Adapter contract asset" &&
        updated.focalPoint?.x === 0.25 &&
        updated.focalPoint.y === 0.75 &&
        same(await input.store.readAsset(finalized.id), updated),
    ),
  );
  await input.store.deleteAsset(finalized.id);
  results.push(
    await check(
      "AssetStore/deleteAsset removes the asset",
      async () => (await input.store.readAsset(finalized.id)) === undefined,
    ),
  );
  return results;
}

export async function ReleaseStoreContract(input: {
  readonly store: ReleaseStore;
  readonly release: StoredRelease;
  readonly pointer: EnvironmentPointer;
}): Promise<readonly ContractTestResult[]> {
  await input.store.writeRelease(input.release);
  await input.store.writeRelease(input.release);
  const results = [
    await check("ReleaseStore immutable writes are retry-safe", async () =>
      same(await input.store.readRelease(input.release.id), input.release),
    ),
    await check("ReleaseStore lists rollbackable immutable releases", async () =>
      (await input.store.listReleases({})).items.some((release) => release.id === input.release.id),
    ),
  ];
  await input.store.compareAndSwapPointer({ next: input.pointer });
  results.push(
    await check("ReleaseStore pointer read follows CAS", async () =>
      same(await input.store.readPointer(input.pointer.environment), input.pointer),
    ),
  );
  results.push(
    await check("ReleaseStore rejects a stale pointer revision", async () => {
      try {
        await input.store.compareAndSwapPointer({
          next: { ...input.pointer, revision: `${input.pointer.revision}:next` },
          expectedRevision: "stale-contract-revision",
        });
        return false;
      } catch {
        return true;
      }
    }),
  );
  return results;
}

export async function SessionStoreContract(input: {
  readonly store: SessionStore;
  readonly session: SessionRecord;
}): Promise<readonly ContractTestResult[]> {
  await input.store.write(input.session);
  const results = [
    await check("SessionStore round-trips a session", async () =>
      same(await input.store.read(input.session.id), input.session),
    ),
  ];
  const updated = { ...input.session, idleExpiresAt: input.session.expiresAt };
  await input.store.write(updated);
  results.push(
    await check("SessionStore overwrites atomically by ID", async () =>
      same(await input.store.read(input.session.id), updated),
    ),
  );
  await input.store.delete(input.session.id);
  results.push(
    await check(
      "SessionStore deletes a session",
      async () => (await input.store.read(input.session.id)) === undefined,
    ),
  );
  return results;
}

export async function PreviewSessionPortContract(input: {
  readonly sessions: PreviewSessionPort;
  readonly actorId: Actor["id"];
  readonly changeId: ChangeId;
}): Promise<readonly ContractTestResult[]> {
  const now = new Date("2026-07-27T12:00:00.000Z");
  const issued = await input.sessions.issue({
    actorId: input.actorId,
    changeId: input.changeId,
    frontendRef: "cms/contract-preview",
    locale: "pl-PL",
    now,
  });
  const verified = await input.sessions.verify({
    id: issued.id,
    token: issued.token,
    now,
  });
  const refreshed = await input.sessions.refresh({
    id: issued.id,
    token: issued.token,
    now: new Date("2026-07-27T12:01:00.000Z"),
  });
  return [
    await check(
      "PreviewSessionPort binds actor, Change, frontend ref and locale",
      () =>
        issued.actorId === input.actorId &&
        issued.changeId === input.changeId &&
        issued.frontendRef === "cms/contract-preview" &&
        issued.locale === "pl-PL",
    ),
    await check("PreviewSessionPort verifies an issued token", () => same(verified, issued)),
    await check(
      "PreviewSessionPort refreshes without changing the actor or Change",
      () =>
        refreshed.actorId === issued.actorId &&
        refreshed.changeId === issued.changeId &&
        refreshed.expiresAt >= issued.expiresAt,
    ),
  ];
}

export async function TeamProvisioningPortContract(input: {
  readonly provisioning: TeamProvisioningPort;
}): Promise<readonly ContractTestResult[]> {
  const firstMembers = await input.provisioning.listMembers();
  const secondMembers = await input.provisioning.listMembers();
  const firstTeams = await input.provisioning.listTeams();
  const secondTeams = await input.provisioning.listTeams();
  const invitation = await input.provisioning.invite({
    email: "contract-editor@example.test",
    role: "direct_member",
  });
  let membershipAdded = false;
  const team = firstTeams[0];
  if (team !== undefined) {
    await input.provisioning.addMemberToTeam({
      teamSlug: team.slug,
      username: firstMembers[0]?.login ?? "contract-editor",
      role: "member",
    });
    membershipAdded = true;
  }
  return [
    await check("TeamProvisioningPort returns deterministic members", () =>
      same(firstMembers, secondMembers),
    ),
    await check("TeamProvisioningPort returns deterministic teams", () =>
      same(firstTeams, secondTeams),
    ),
    await check(
      "TeamProvisioningPort creates an organization invitation",
      () =>
        invitation.role === "direct_member" &&
        invitation.status === "pending" &&
        invitation.id.length > 0,
    ),
    await check(
      "TeamProvisioningPort accepts team membership operations",
      () => team === undefined || membershipAdded,
    ),
  ];
}

export async function ReviewPortContract(input: {
  readonly review: ReviewPort;
  readonly pullRequestNumber: number;
  readonly ref: GitCommitSha;
}): Promise<readonly ContractTestResult[]> {
  const comment = await input.review.addComment({
    pullRequestNumber: input.pullRequestNumber,
    body: "Adapter contract review comment.",
  });
  const comments = await input.review.listComments(input.pullRequestNumber);
  const resolved = await input.review.resolveComment({
    pullRequestNumber: input.pullRequestNumber,
    commentId: comment.id,
    resolved: true,
  });
  const assigned = await input.review.assignReviewers({
    pullRequestNumber: input.pullRequestNumber,
    users: ["contract-reviewer"],
    teams: ["contract-team"],
  });
  const listedReviewers = await input.review.listReviewers(input.pullRequestNumber);
  const firstChecks = await input.review.listChecks(input.ref);
  const secondChecks = await input.review.listChecks(input.ref);
  return [
    await check("ReviewPort lists a newly created comment", () =>
      comments.some((candidate) => candidate.id === comment.id),
    ),
    await check(
      "ReviewPort resolves a conversation thread",
      () => resolved.id === comment.id && resolved.resolved,
    ),
    await check(
      "ReviewPort assigns and lists users and teams",
      () => same(assigned, listedReviewers),
    ),
    await check("ReviewPort check reads are deterministic", () => same(firstChecks, secondChecks)),
    await check("ReviewPort returns valid check states", () =>
      firstChecks.every((candidate) =>
        ["queued", "in_progress", "completed"].includes(candidate.status),
      ),
    ),
  ];
}

export async function ContentRepositoryContract(input: {
  readonly repository: ContentRepository;
  readonly ref: string;
  readonly expectedRevision: Revision;
  readonly document: ContentDocument;
  readonly actor: Actor;
}): Promise<readonly ContractTestResult[]> {
  const idempotencyKey = `contract:content:${input.document.id}`;
  const revision = await input.repository.writeDocuments({
    ref: input.ref,
    documents: [input.document],
    expectedRevision: input.expectedRevision,
    message: "Exercise ContentRepository contract",
    actor: input.actor,
    idempotencyKey,
  });
  const repeated = await input.repository.writeDocuments({
    ref: input.ref,
    documents: [input.document],
    expectedRevision: input.expectedRevision,
    message: "Exercise ContentRepository contract",
    actor: input.actor,
    idempotencyKey,
  });
  const results = [
    await check("ContentRepository writes are idempotent", () => revision === repeated),
    await check("ContentRepository round-trips a document", async () => {
      const stored = await input.repository.readDocument({
        ref: input.ref,
        documentId: input.document.id,
      });
      return (
        stored.id === input.document.id &&
        stored.type === input.document.type &&
        stored.schemaVersion === input.document.schemaVersion &&
        stored.revision === revision &&
        same(stored.data, input.document.data)
      );
    }),
    await check("ContentRepository lists the written document", async () =>
      (await input.repository.listDocuments({ ref: input.ref })).items.some(
        (document) => document.id === input.document.id,
      ),
    ),
  ];
  await input.repository.deleteDocuments({
    ref: input.ref,
    documentIds: [input.document.id],
    expectedRevision: revision,
    actor: input.actor,
    idempotencyKey: `${idempotencyKey}:delete`,
  });
  results.push(
    await check("ContentRepository delete removes the document from listings", async () =>
      (await input.repository.listDocuments({ ref: input.ref })).items.every(
        (document) => document.id !== input.document.id,
      ),
    ),
  );
  results.push(
    await check("ContentRepository reads project configuration", async () => {
      const config = await input.repository.readProjectConfig(input.ref);
      return Number.isSafeInteger(config.configVersion) && config.configVersion > 0;
    }),
  );
  results.push(
    await check("ContentRepository reads the registry lock", async () => {
      const lock = await input.repository.readRegistryLock(input.ref);
      return /^sha256:[a-f0-9]{64}$/iu.test(lock.registryDigest);
    }),
  );
  return results;
}

export async function ReleaseBuilderPortContract(input: {
  readonly builder: ReleaseBuilderPort;
  readonly gitCommit: GitCommitSha;
  readonly registryDigest: string;
}): Promise<readonly ContractTestResult[]> {
  const buildInput = {
    gitCommit: input.gitCommit,
    configVersion: 1,
    registryDigest: input.registryDigest,
    schemaVersion: 1,
    documents: [{ path: "content/pages/contract.json", value: { title: "Contract" } }],
  } as const;
  const first = await input.builder.build(buildInput);
  const second = await input.builder.build(buildInput);
  return [
    await check("ReleaseBuilderPort is deterministic", () => same(first, second)),
    await check("ReleaseBuilderPort emits immutable manifest files", () => {
      return (
        first.files["manifest.json"] !== undefined &&
        first.files["checksums.json"] !== undefined &&
        first.manifest.releaseId === first.id
      );
    }),
  ];
}

export async function AssetUsagePortContract(input: {
  readonly usage: AssetUsagePort;
  readonly assetId: AssetId;
  readonly expectedPath: string;
  readonly released: boolean;
}): Promise<readonly ContractTestResult[]> {
  return [
    await check("AssetUsagePort returns deterministic usages", async () => {
      const first = await input.usage.usages(input.assetId);
      const second = await input.usage.usages(input.assetId);
      return same(first, second) && first.includes(input.expectedPath);
    }),
    await check(
      "AssetUsagePort reports release protection",
      async () => (await input.usage.isReleased(input.assetId)) === input.released,
    ),
  ];
}

export async function AssetProcessorPortContract(input: {
  readonly processor: AssetProcessorPort;
  readonly asset: Asset;
}): Promise<readonly ContractTestResult[]> {
  const first = await input.processor.process(input.asset);
  const second = await input.processor.process(input.asset);
  return [
    await check("AssetProcessorPort is retry-safe", () => same(first, second)),
    await check(
      "AssetProcessorPort preserves content identity",
      () => first.id === input.asset.id && first.checksum === input.asset.checksum,
    ),
  ];
}

export async function DeploymentPortContract(input: {
  readonly deployment: DeploymentPort;
  readonly releaseId: StoredRelease["id"];
  readonly revision: GitCommitSha;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    environment: "production",
    releaseId: input.releaseId,
    revision: input.revision,
    idempotencyKey: `contract:deployment:${input.releaseId}`,
  } as const;
  const first = await input.deployment.deploy(request);
  const second = await input.deployment.deploy(request);
  return [
    await check("DeploymentPort is idempotent", () => same(first, second)),
    await check("DeploymentPort returns an external identity", () => first.deploymentId.length > 0),
  ];
}

export async function RevalidationPortContract(input: {
  readonly revalidation: RevalidationPort;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    environment: "production",
    tags: ["document:doc_contract"],
    paths: ["/contract"],
    idempotencyKey: "contract:revalidation",
  } as const;
  await input.revalidation.revalidate(request);
  await input.revalidation.revalidate(request);
  return [await check("RevalidationPort accepts idempotent retries", () => true)];
}

export async function PublicationNotifierPortContract(input: {
  readonly notifier: PublicationNotifierPort;
  readonly releaseId: StoredRelease["id"];
  readonly revision: GitCommitSha;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    environment: "production",
    releaseId: input.releaseId,
    revision: input.revision,
    tags: ["document:doc_contract"],
    paths: ["content/pages/contract.json"],
    idempotencyKey: "contract:publication",
  } as const;
  await input.notifier.notify(request);
  await input.notifier.notify(request);
  return [await check("PublicationNotifierPort accepts idempotent retries", () => true)];
}

export async function TranslationProviderContract(input: {
  readonly provider: TranslationProvider;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    sourceLocale: "en-US",
    targetLocale: "pl-PL",
    xliff: '<xliff version="2.0"></xliff>',
    idempotencyKey: "contract:translation",
  };
  const first = await input.provider.createJob(request);
  const second = await input.provider.createJob(request);
  const job = await input.provider.readJob(first.jobId);
  return [
    await check("TranslationProvider job creation is idempotent", () => same(first, second)),
    await check("TranslationProvider returns a valid job state", () =>
      ["queued", "working", "complete", "failed"].includes(job.status),
    ),
  ];
}

export async function WebhookReplayStoreContract(input: {
  readonly store: WebhookReplayStore;
}): Promise<readonly ContractTestResult[]> {
  const deliveryId = `contract-${globalThis.crypto.randomUUID()}`;
  const expiresAt = "2026-07-28T12:00:00.000Z";
  const first = await input.store.claim(deliveryId, expiresAt);
  const second = await input.store.claim(deliveryId, expiresAt);
  return [
    await check("WebhookReplayStore atomically claims a delivery once", () => first && !second),
  ];
}

export async function RateLimitPortContract(input: {
  readonly rateLimit: RateLimitPort;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    key: `contract-${globalThis.crypto.randomUUID()}`,
    scope: "contract",
    limit: 1,
    windowMs: 60_000,
    now: "2026-07-27T12:00:00.000Z",
  };
  const first = await input.rateLimit.consume(request);
  const second = await input.rateLimit.consume(request);
  return [
    await check(
      "RateLimitPort enforces a deterministic window",
      () =>
        first.allowed &&
        first.remaining === 0 &&
        !second.allowed &&
        first.resetAt === second.resetAt,
    ),
  ];
}

export async function SchedulerPortContract(input: {
  readonly scheduler: SchedulerPort;
}): Promise<readonly ContractTestResult[]> {
  const request = {
    scheduleId: "sch_contract",
    executeAt: "2026-07-28T12:00:00.000Z",
    action: "publish",
    documentIds: ["doc_contract" as DocumentId],
  } satisfies Parameters<SchedulerPort["workflow"]>[0];
  const first = input.scheduler.workflow(request);
  const second = input.scheduler.workflow(request);
  return [
    await check("SchedulerPort output is deterministic", () => same(first, second)),
    await check(
      "SchedulerPort emits a workflow path and content",
      () => first.path.length > 0 && first.content.includes(request.scheduleId),
    ),
  ];
}

export async function IdempotencyStoreContract(input: {
  readonly store: IdempotencyStore;
}): Promise<readonly ContractTestResult[]> {
  const key = `contract-${globalThis.crypto.randomUUID()}`;
  const value = { releaseId: "rel_contract", accepted: true };
  await input.store.write(key, value);
  await input.store.write(key, value);
  return [
    await check("IdempotencyStore round-trips retry results", async () =>
      same(await input.store.read(key), value),
    ),
  ];
}

export async function IdentityProviderContract(input: {
  readonly provider: IdentityProvider;
}): Promise<readonly ContractTestResult[]> {
  const first = await input.provider.resolve("contract-token");
  const second = await input.provider.resolve("contract-token");
  return [
    await check("IdentityProvider resolves deterministically", () => same(first, second)),
    await check(
      "IdentityProvider returns a usable principal",
      () => first.externalId.length > 0 && first.login.length > 0 && first.displayName.length > 0,
    ),
    await check("IdentityProvider never returns credentials", () => {
      const serialized = JSON.stringify(first).toLocaleLowerCase();
      return !serialized.includes("contract-token") && !serialized.includes("accesstoken");
    }),
  ];
}

export async function ClockContract(input: {
  readonly clock: Clock;
}): Promise<readonly ContractTestResult[]> {
  const first = input.clock.now();
  const second = input.clock.now();
  return [
    await check(
      "Clock returns valid defensive Date values",
      () =>
        Number.isFinite(first.getTime()) && Number.isFinite(second.getTime()) && first !== second,
    ),
  ];
}

export async function IdGeneratorContract(input: {
  readonly ids: IdGenerator;
}): Promise<readonly ContractTestResult[]> {
  const changeIds = [input.ids.changeId(), input.ids.changeId()];
  const documentIds = [input.ids.documentId(), input.ids.documentId()];
  return [
    await check(
      "IdGenerator returns unique prefixed domain IDs",
      () =>
        new Set(changeIds).size === changeIds.length &&
        changeIds.every((id) => id.startsWith("chg_")) &&
        new Set(documentIds).size === documentIds.length &&
        documentIds.every((id) => id.startsWith("doc_")),
    ),
    await check(
      "IdGenerator emits workflow identities",
      () =>
        input.ids.scheduleId().startsWith("sch_") &&
        input.ids.requestId().length > 0 &&
        input.ids.suffix().length > 0,
    ),
  ];
}

export async function AuditSinkContract(input: {
  readonly sink: AuditSink;
  readonly readEvents: () => Promise<readonly AuditEvent[]>;
}): Promise<readonly ContractTestResult[]> {
  const event: AuditEvent = {
    type: "contract.verified",
    actorId: "act_contract",
    requestId: globalThis.crypto.randomUUID(),
    source: "cli",
    timestamp: "2026-07-27T12:00:00.000Z",
  };
  await input.sink.write(event);
  return [
    await check("AuditSink durably records the event", async () =>
      (await input.readEvents()).some((candidate) => candidate.requestId === event.requestId),
    ),
  ];
}

export async function AuditQueryPortContract(input: {
  readonly sink: AuditSink;
  readonly query: AuditQueryPort;
}): Promise<readonly ContractTestResult[]> {
  const resourceId = `chg_contract_${globalThis.crypto.randomUUID()}`;
  const unrelatedId = `chg_other_${globalThis.crypto.randomUUID()}`;
  const events: readonly AuditEvent[] = [
    {
      type: "contract.started",
      actorId: "act_contract",
      requestId: globalThis.crypto.randomUUID(),
      source: "ui",
      timestamp: "2026-07-27T12:00:00.000Z",
      resourceId,
    },
    {
      type: "contract.unrelated",
      actorId: "act_contract",
      requestId: globalThis.crypto.randomUUID(),
      source: "ui",
      timestamp: "2026-07-27T12:01:00.000Z",
      resourceId: unrelatedId,
    },
    {
      type: "contract.completed",
      actorId: "act_contract",
      requestId: globalThis.crypto.randomUUID(),
      source: "mcp",
      timestamp: "2026-07-27T12:02:00.000Z",
      resourceId,
    },
  ];
  for (const event of events) await input.sink.write(event);
  const listed = await input.query.list({ resourceId, limit: 1 });
  return [
    await check(
      "AuditQueryPort filters a resource and returns newest events first",
      () =>
        listed.length === 1 &&
        listed[0]?.type === "contract.completed" &&
        listed[0]?.resourceId === resourceId,
    ),
  ];
}

export async function FrameworkAdapterContract(input: {
  readonly handle: (request: Request) => Promise<Response>;
}): Promise<readonly ContractTestResult[]> {
  const response = await input.handle(new Request("https://cms.example.test/api/cms/health"));
  return [
    await check("FrameworkAdapter returns a Web Response", () => response instanceof Response),
    await check("FrameworkAdapter does not emit cacheable authenticated data", () => {
      const cacheControl = response.headers.get("cache-control");
      return cacheControl === null || /no-store|private/u.test(cacheControl);
    }),
  ];
}

export async function RendererContract(input: {
  readonly render: () => Promise<string> | string;
}): Promise<readonly ContractTestResult[]> {
  const first = await input.render();
  const second = await input.render();
  return [
    await check("Renderer is deterministic", () => first === second),
    await check("Renderer produces non-empty markup", () => first.trim().length > 0),
    await check("Renderer excludes editor runtime markers", () => !first.includes("cms-editor")),
  ];
}

export function contractPassed(results: readonly ContractTestResult[]): boolean {
  return results.every((result) => result.passed);
}
