import type {
  Asset,
  AuditEvent,
  AssetStore,
  EnvironmentPointer,
  Page,
  ReviewComment,
  ReleaseStore,
  SessionRecord,
  SessionStore,
  StoredRelease,
} from "@git-native-cms/application";
import type {
  Actor,
  AssetId,
  ContentDocument,
  DocumentId,
  GitCommitSha,
  ReleaseId,
  Revision,
} from "@git-native-cms/core";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryGitProvider,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";
import { describe, expect, it } from "vitest";
import {
  AssetStoreContract,
  AssetProcessorPortContract,
  AssetUsagePortContract,
  AuditSinkContract,
  ClockContract,
  contractPassed,
  ContentRepositoryContract,
  DeploymentPortContract,
  FrameworkAdapterContract,
  GitProviderContract,
  IdentityProviderContract,
  IdempotencyStoreContract,
  IdGeneratorContract,
  PublicationNotifierPortContract,
  RateLimitPortContract,
  ReleaseBuilderPortContract,
  ReleaseStoreContract,
  RevalidationPortContract,
  ReviewPortContract,
  SchedulerPortContract,
  RendererContract,
  SessionStoreContract,
  TranslationProviderContract,
  WebhookReplayStoreContract,
} from "./contracts.js";

const actor: Actor = {
  id: "act_contract" as Actor["id"],
  githubId: 1,
  login: "contract",
  displayName: "Contract Adapter",
  roles: ["administrator"],
  source: "cli",
};

function expectContract(results: Awaited<ReturnType<typeof RendererContract>>): void {
  expect(
    contractPassed(results),
    results
      .filter((result) => !result.passed)
      .map((result) => `${result.name}: ${result.details ?? "failed"}`)
      .join("\n"),
  ).toBe(true);
}

class ContractAssetStore implements AssetStore {
  private readonly assets = new Map<AssetId, Asset>();

  async createUpload(input: Parameters<AssetStore["createUpload"]>[0]) {
    return {
      uploadId: "upl_contract",
      url: "https://uploads.example.test/upl_contract",
      headers: { "content-type": input.mimeType },
    };
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    const id = `ast_${input.checksum.slice(0, 24)}` as AssetId;
    const asset =
      this.assets.get(id) ??
      ({
        id,
        fileName: "proof.png",
        mimeType: "image/png",
        size: 4,
        checksum: input.checksum,
        url: `https://assets.example.test/${input.checksum}/proof.png`,
      } satisfies Asset);
    this.assets.set(id, asset);
    return asset;
  }

  async readAsset(id: AssetId): Promise<Asset | undefined> {
    return this.assets.get(id);
  }

  async updateAssetMetadata(
    input: Parameters<AssetStore["updateAssetMetadata"]>[0],
  ): Promise<Asset> {
    const current = this.assets.get(input.id);
    if (current === undefined) throw new Error("asset missing");
    const stable = { ...current };
    delete stable.altText;
    delete stable.focalPoint;
    const asset: Asset = {
      ...stable,
      ...(input.altText === undefined ? {} : { altText: input.altText }),
      ...(input.focalPoint === undefined ? {} : { focalPoint: input.focalPoint }),
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  async deleteAsset(id: AssetId): Promise<void> {
    this.assets.delete(id);
  }

  async listAssets(): Promise<Page<Asset>> {
    return { items: [...this.assets.values()] };
  }
}

class ContractReleaseStore implements ReleaseStore {
  private readonly releases = new Map<ReleaseId, StoredRelease>();
  private readonly pointers = new Map<EnvironmentPointer["environment"], EnvironmentPointer>();

  async writeRelease(release: StoredRelease): Promise<void> {
    const current = this.releases.get(release.id);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(release)) {
      throw new Error("immutable release changed");
    }
    this.releases.set(release.id, structuredClone(release));
  }

  async readRelease(id: ReleaseId): Promise<StoredRelease | undefined> {
    return this.releases.get(id);
  }

  async listReleases(): Promise<{ readonly items: readonly StoredRelease[] }> {
    return { items: [...this.releases.values()] };
  }

  async readPointer(
    environment: EnvironmentPointer["environment"],
  ): Promise<EnvironmentPointer | undefined> {
    return this.pointers.get(environment);
  }

  async compareAndSwapPointer(
    input: Parameters<ReleaseStore["compareAndSwapPointer"]>[0],
  ): Promise<EnvironmentPointer> {
    const current = this.pointers.get(input.next.environment);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new Error("stale pointer");
    }
    this.pointers.set(input.next.environment, input.next);
    return input.next;
  }
}

class ContractSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async read(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async write(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

describe("shared adapter contracts", () => {
  it("exercises GitProvider", async () => {
    expectContract(
      await GitProviderContract({
        provider: new MemoryGitProvider(),
        baseRef: "main",
        branch: "contract/git-provider",
        actor,
      }),
    );
  });

  it("exercises AssetStore", async () => {
    expectContract(
      await AssetStoreContract({
        store: new ContractAssetStore(),
        fileName: "proof.png",
        mimeType: "image/png",
        size: 4,
        checksum: "a".repeat(64),
        actor,
        put: async () => undefined,
      }),
    );
  });

  it("exercises ReleaseStore", async () => {
    const release: StoredRelease = {
      id: "rel_0123456789abcdef01234567" as ReleaseId,
      manifest: { formatVersion: 1 },
      files: { "manifest.json": '{"formatVersion":1}' },
    };
    expectContract(
      await ReleaseStoreContract({
        store: new ContractReleaseStore(),
        release,
        pointer: {
          environment: "production",
          releaseId: release.id,
          revision: "contract-pointer-1",
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
      }),
    );
  });

  it("exercises SessionStore", async () => {
    expectContract(
      await SessionStoreContract({
        store: new ContractSessionStore(),
        session: {
          id: "ses_contract",
          actor,
          csrfSecret: "csrf-contract",
          createdAt: "2026-07-27T12:00:00.000Z",
          expiresAt: "2026-07-27T20:00:00.000Z",
          idleExpiresAt: "2026-07-27T13:00:00.000Z",
        },
      }),
    );
  });

  it("exercises framework and renderer boundaries", async () => {
    expectContract(
      await FrameworkAdapterContract({
        handle: async () =>
          Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }),
      }),
    );
    expectContract(await RendererContract({ render: () => "<main>Published content</main>" }));
  });

  it("exercises every remaining application capability port", async () => {
    const revision = "rev_contract" as Revision;
    const document: ContentDocument = {
      id: "doc_contract" as DocumentId,
      type: "pages",
      schemaVersion: 1,
      revision,
      data: { title: "Contract" },
    };
    expectContract(
      await ContentRepositoryContract({
        repository: new MemoryContentRepository(),
        ref: "contract/content",
        expectedRevision: revision,
        document,
        actor,
      }),
    );

    const comments: ReviewComment[] = [];
    let reviewers = { users: [] as string[], teams: [] as string[] };
    expectContract(
      await ReviewPortContract({
        review: {
          async addComment(input) {
            const comment = {
              id: `comment-${String(comments.length + 1)}`,
              author: actor.login,
              body: input.body,
              createdAt: "2026-07-27T12:00:00.000Z",
              resolved: false,
            };
            comments.push(comment);
            return comment;
          },
          async listComments() {
            return comments;
          },
          async resolveComment(input) {
            const index = comments.findIndex((comment) => comment.id === input.commentId);
            const current = comments[index];
            if (current === undefined) throw new Error("comment missing");
            const updated = { ...current, resolved: input.resolved };
            comments[index] = updated;
            return updated;
          },
          async assignReviewers(input) {
            reviewers = { users: [...input.users], teams: [...input.teams] };
            return reviewers;
          },
          async listReviewers() {
            return reviewers;
          },
          async listChecks() {
            return [
              { name: "contract", status: "completed", conclusion: "success", required: true },
            ];
          },
        },
        pullRequestNumber: 1,
        ref: "a".repeat(40) as GitCommitSha,
      }),
    );

    const releaseId = "rel_contract_builder" as ReleaseId;
    expectContract(
      await ReleaseBuilderPortContract({
        builder: {
          async build() {
            return {
              id: releaseId,
              manifest: { releaseId },
              files: { "manifest.json": "{}", "checksums.json": "{}" },
            };
          },
        },
        gitCommit: "b".repeat(40) as GitCommitSha,
        registryDigest: `sha256:${"c".repeat(64)}`,
      }),
    );
    const asset: Asset = {
      id: "ast_contract" as AssetId,
      fileName: "contract.png",
      mimeType: "image/png",
      size: 8,
      checksum: "d".repeat(64),
      url: "https://assets.example.test/contract.png",
    };
    expectContract(
      await AssetUsagePortContract({
        usage: {
          async usages() {
            return ["content/pages/contract.yaml"];
          },
          async isReleased() {
            return true;
          },
        },
        assetId: asset.id,
        expectedPath: "content/pages/contract.yaml",
        released: true,
      }),
    );
    expectContract(
      await AssetProcessorPortContract({
        processor: {
          async process(value) {
            return value;
          },
        },
        asset,
      }),
    );

    const deployments = new Map<string, { deploymentId: string; url: string }>();
    expectContract(
      await DeploymentPortContract({
        deployment: {
          async deploy(input) {
            const result = deployments.get(input.idempotencyKey) ?? {
              deploymentId: "deployment-contract",
              url: "https://deployment.example.test",
            };
            deployments.set(input.idempotencyKey, result);
            return result;
          },
        },
        releaseId,
        revision: "e".repeat(40) as GitCommitSha,
      }),
    );
    expectContract(await RevalidationPortContract({ revalidation: { async revalidate() {} } }));
    expectContract(
      await PublicationNotifierPortContract({
        notifier: { async notify() {} },
        releaseId,
        revision: "f".repeat(40) as GitCommitSha,
      }),
    );

    expectContract(
      await TranslationProviderContract({
        provider: {
          async createJob() {
            return { jobId: "translation-contract" };
          },
          async readJob() {
            return { status: "complete", xliff: '<xliff version="2.0"></xliff>' };
          },
        },
      }),
    );
    const deliveries = new Set<string>();
    expectContract(
      await WebhookReplayStoreContract({
        store: {
          async claim(deliveryId) {
            if (deliveries.has(deliveryId)) return false;
            deliveries.add(deliveryId);
            return true;
          },
        },
      }),
    );
    let consumed = false;
    expectContract(
      await RateLimitPortContract({
        rateLimit: {
          async consume() {
            const allowed = !consumed;
            consumed = true;
            return {
              allowed,
              remaining: 0,
              resetAt: "2026-07-27T12:01:00.000Z",
            };
          },
        },
      }),
    );
    expectContract(
      await SchedulerPortContract({
        scheduler: {
          workflow(input) {
            return {
              path: `.github/workflows/${input.scheduleId}.yaml`,
              content: JSON.stringify(input),
            };
          },
        },
      }),
    );
    expectContract(await IdempotencyStoreContract({ store: new MemoryIdempotencyStore() }));
    const audit = new MemoryAuditSink();
    expectContract(
      await AuditSinkContract({
        sink: audit,
        readEvents: async (): Promise<readonly AuditEvent[]> => audit.events,
      }),
    );
    expectContract(
      await IdentityProviderContract({
        provider: {
          async resolve() {
            return {
              externalId: "42",
              login: "contract",
              displayName: "Contract User",
              capabilities: { push: true },
              teams: ["DMTcorp/editors"],
            };
          },
        },
      }),
    );
    expectContract(await ClockContract({ clock: new FixedClock() }));
    expectContract(await IdGeneratorContract({ ids: new DeterministicIds() }));
  });
});
