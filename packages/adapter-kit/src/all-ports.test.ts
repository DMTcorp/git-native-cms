import type {
  Asset,
  AuditEvent,
  DeploymentPort,
  PublicationNotifierPort,
  PreviewSession,
  RateLimitPort,
  RevalidationPort,
  ReviewCheck,
  ReviewComment,
  ReviewPort,
  SchedulerPort,
  TranslationProvider,
  WebhookReplayStore,
} from "@git-native-cms/application";
import type {
  AssetId,
  ContentDocument,
  DocumentId,
  GitCommitSha,
  ReleaseId,
  Revision,
} from "@git-native-cms/core";
import {
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";
import { describe, expect, it } from "vitest";
import {
  AssetProcessorPortContract,
  AssetUsagePortContract,
  AuditQueryPortContract,
  AuditSinkContract,
  ContentRepositoryContract,
  contractPassed,
  DeploymentPortContract,
  IdempotencyStoreContract,
  PublicationNotifierPortContract,
  RateLimitPortContract,
  ReleaseBuilderPortContract,
  RevalidationPortContract,
  ReviewPortContract,
  SchedulerPortContract,
  PreviewSessionPortContract,
  TeamProvisioningPortContract,
  TranslationProviderContract,
  WebhookReplayStoreContract,
} from "./contracts.js";

const revision = "1".repeat(40) as GitCommitSha;
const releaseId = "rel_0123456789abcdef01234567" as ReleaseId;
const asset: Asset = {
  id: "ast_0123456789abcdef01234567" as AssetId,
  fileName: "contract.png",
  mimeType: "image/png",
  size: 4,
  checksum: "a".repeat(64),
  url: "https://assets.example.test/contract.png",
};

function passed(results: readonly { readonly passed: boolean; readonly details?: string }[]): void {
  expect(
    contractPassed(
      results.map((result, index) => ({
        name: `contract-${index}`,
        ...result,
      })),
    ),
    results
      .filter((result) => !result.passed)
      .map((result) => result.details ?? "contract failed")
      .join("\n"),
  ).toBe(true);
}

class ContractReviewPort implements ReviewPort {
  readonly comments: ReviewComment[] = [];
  private assignment = { users: [] as string[], teams: [] as string[] };
  readonly checks: ReviewCheck[] = [
    { name: "contract", status: "completed", conclusion: "success", required: true },
  ];

  async addComment(input: Parameters<ReviewPort["addComment"]>[0]): Promise<ReviewComment> {
    const comment: ReviewComment = {
      id: `comment-${this.comments.length + 1}`,
      author: "contract",
      body: input.body,
      createdAt: "2026-07-27T12:00:00.000Z",
      resolved: false,
    };
    this.comments.push(comment);
    return comment;
  }

  async listComments(): Promise<readonly ReviewComment[]> {
    return this.comments;
  }

  async resolveComment(
    input: Parameters<ReviewPort["resolveComment"]>[0],
  ): Promise<ReviewComment> {
    const index = this.comments.findIndex((comment) => comment.id === input.commentId);
    const current = this.comments[index];
    if (current === undefined) throw new Error("comment missing");
    const updated = { ...current, resolved: input.resolved };
    this.comments[index] = updated;
    return updated;
  }

  async assignReviewers(
    input: Parameters<ReviewPort["assignReviewers"]>[0],
  ): Promise<{ readonly users: readonly string[]; readonly teams: readonly string[] }> {
    this.assignment = { users: [...input.users], teams: [...input.teams] };
    return this.assignment;
  }

  async listReviewers(): Promise<{
    readonly users: readonly string[];
    readonly teams: readonly string[];
  }> {
    return this.assignment;
  }

  async listChecks(): Promise<readonly ReviewCheck[]> {
    return this.checks;
  }
}

class ContractDeploymentPort implements DeploymentPort {
  private readonly results = new Map<string, { deploymentId: string; url: string }>();

  async deploy(input: Parameters<DeploymentPort["deploy"]>[0]) {
    const result = this.results.get(input.idempotencyKey) ?? {
      deploymentId: "deployment-contract",
      url: "https://deployment.example.test",
    };
    this.results.set(input.idempotencyKey, result);
    return result;
  }
}

class ContractTranslationProvider implements TranslationProvider {
  async createJob() {
    return { jobId: "translation-contract" };
  }

  async readJob() {
    return { status: "complete" as const, xliff: '<xliff version="2.0"></xliff>' };
  }
}

class ContractWebhookReplayStore implements WebhookReplayStore {
  private readonly deliveries = new Set<string>();

  async claim(deliveryId: string): Promise<boolean> {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    return true;
  }
}

class ContractRateLimitPort implements RateLimitPort {
  private readonly counts = new Map<string, number>();

  async consume(input: Parameters<RateLimitPort["consume"]>[0]) {
    const windowStart = Math.floor(new Date(input.now).getTime() / input.windowMs) * input.windowMs;
    const key = `${input.scope}:${input.key}:${windowStart}`;
    const count = this.counts.get(key) ?? 0;
    const allowed = count < input.limit;
    if (allowed) this.counts.set(key, count + 1);
    return {
      allowed,
      remaining: Math.max(0, input.limit - count - (allowed ? 1 : 0)),
      resetAt: new Date(windowStart + input.windowMs).toISOString(),
    };
  }
}

const revalidation: RevalidationPort = {
  revalidate: async () => undefined,
};
const notifier: PublicationNotifierPort = {
  notify: async () => undefined,
};
const scheduler: SchedulerPort = {
  workflow: (input) => ({
    path: `.github/workflows/cms-${input.scheduleId}.yml`,
    content: `name: ${input.scheduleId}\naction: ${input.action}\n`,
  }),
};

describe("all application capability port contracts", () => {
  it("covers review and logical content repository adapters", async () => {
    passed(
      await ReviewPortContract({
        review: new ContractReviewPort(),
        pullRequestNumber: 1,
        ref: revision,
      }),
    );
    const repository = new MemoryContentRepository();
    const document: ContentDocument = {
      id: "doc_contract" as DocumentId,
      type: "pages",
      schemaVersion: 1,
      revision: "sha_content_1" as Revision,
      data: { title: "Contract" },
    };
    passed(
      await ContentRepositoryContract({
        repository,
        ref: "contract",
        expectedRevision: document.revision,
        document,
        actor: {
          id: "act_contract" as never,
          githubId: 1,
          login: "contract",
          displayName: "Contract",
          roles: ["administrator"],
          source: "cli",
        },
      }),
    );
  });

  it("covers release, asset, deployment and publication adapters", async () => {
    passed(
      await ReleaseBuilderPortContract({
        builder: {
          build: async (input) => {
            const manifest = {
              releaseId,
              gitCommit: input.gitCommit,
              registryDigest: input.registryDigest,
            };
            return {
              id: releaseId,
              manifest,
              files: {
                "manifest.json": JSON.stringify(manifest),
                "checksums.json": "{}",
              },
            };
          },
        },
        gitCommit: revision,
        registryDigest: `sha256:${"a".repeat(64)}`,
      }),
    );
    passed(
      await AssetUsagePortContract({
        usage: {
          usages: async () => ["content/pages/contract.json#/hero/image"],
          isReleased: async () => true,
        },
        assetId: asset.id,
        expectedPath: "content/pages/contract.json#/hero/image",
        released: true,
      }),
    );
    passed(
      await AssetProcessorPortContract({
        processor: { process: async (value) => ({ ...value, variants: [] }) },
        asset,
      }),
    );
    passed(
      await DeploymentPortContract({
        deployment: new ContractDeploymentPort(),
        releaseId,
        revision,
      }),
    );
    passed(await RevalidationPortContract({ revalidation }));
    passed(await PublicationNotifierPortContract({ notifier, releaseId, revision }));
  });

  it("covers translation, replay, rate-limit, scheduler and state adapters", async () => {
    passed(await TranslationProviderContract({ provider: new ContractTranslationProvider() }));
    passed(await WebhookReplayStoreContract({ store: new ContractWebhookReplayStore() }));
    passed(await RateLimitPortContract({ rateLimit: new ContractRateLimitPort() }));
    passed(await SchedulerPortContract({ scheduler }));
    passed(await IdempotencyStoreContract({ store: new MemoryIdempotencyStore() }));
    const audit = new MemoryAuditSink();
    passed(
      await AuditSinkContract({
        sink: audit,
        readEvents: async (): Promise<readonly AuditEvent[]> => audit.events,
      }),
    );
    passed(await AuditQueryPortContract({ sink: audit, query: audit }));
  });

  it("covers preview session and GitHub organization provisioning adapters", async () => {
    let previewSession: PreviewSession = {
      id: "prv_contract",
      actorId: "act_contract" as PreviewSession["actorId"],
      changeId: "chg_contract" as PreviewSession["changeId"],
      frontendRef: "cms/contract-preview",
      locale: "pl-PL",
      createdAt: "2026-07-27T12:00:00.000Z",
      expiresAt: "2026-07-27T12:05:00.000Z",
      token: "contract-token",
    };
    passed(
      await PreviewSessionPortContract({
        sessions: {
          async issue(input) {
            previewSession = {
              ...previewSession,
              actorId: input.actorId,
              changeId: input.changeId,
              frontendRef: input.frontendRef,
              locale: input.locale,
              createdAt: input.now.toISOString(),
            };
            return previewSession;
          },
          async verify() {
            return previewSession;
          },
          async refresh(input) {
            previewSession = {
              ...previewSession,
              id: "prv_contract_refreshed",
              createdAt: input.now.toISOString(),
              expiresAt: "2026-07-27T12:06:00.000Z",
              token: "contract-token-refreshed",
            };
            return previewSession;
          },
        },
        actorId: previewSession.actorId,
        changeId: previewSession.changeId,
      }),
    );

    const memberships: string[] = [];
    passed(
      await TeamProvisioningPortContract({
        provisioning: {
          async listMembers() {
            return [
              {
                id: "1",
                login: "contract-editor",
                displayName: "Contract Editor",
                organizationRole: "member",
              },
            ];
          },
          async listTeams() {
            return [{ id: "1", slug: "editors", name: "Editors" }];
          },
          async invite(input) {
            return {
              id: "1",
              role: input.role,
              ...(input.email === undefined ? {} : { email: input.email }),
              status: "pending",
            };
          },
          async addMemberToTeam(input) {
            memberships.push(`${input.teamSlug}:${input.username}:${input.role}`);
          },
        },
      }),
    );
    expect(memberships).toEqual(["editors:contract-editor:member"]);
  });
});
