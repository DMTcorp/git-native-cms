import type {
  DeploymentPort,
  RevalidationPort,
  TranslationProvider,
  WebhookReplayStore,
} from "@git-native-cms/application";
import { CmsError, type GitCommitSha, type ReleaseId } from "@git-native-cms/core";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly body: Uint8Array;
  readonly signature: string | null;
}): Promise<boolean> {
  if (input.signature === null || !input.signature.startsWith("sha256=")) return false;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const body = Uint8Array.from(input.body);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, body));
  return constantTimeEqual(input.signature, `sha256=${toHex(digest)}`);
}

export class MemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly deliveries = new Map<string, number>();

  async claim(deliveryId: string, expiresAt: string): Promise<boolean> {
    const now = Date.now();
    for (const [id, expiry] of this.deliveries) {
      if (expiry <= now) this.deliveries.delete(id);
    }
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, new Date(expiresAt).getTime());
    return true;
  }
}

export async function receiveSignedWebhook(input: {
  readonly secret: string;
  readonly body: Uint8Array;
  readonly signature: string | null;
  readonly deliveryId: string | null;
  readonly replayStore: WebhookReplayStore;
  readonly now?: Date;
  readonly maximumBytes?: number;
}): Promise<Readonly<Record<string, unknown>>> {
  if (input.body.byteLength > (input.maximumBytes ?? 1_048_576)) {
    throw new CmsError({
      code: "CMS_WEBHOOK_003",
      message: "The webhook payload is too large.",
      category: "validation",
      retryable: false,
    });
  }
  if (!(await verifyWebhookSignature(input))) {
    throw new CmsError({
      code: "CMS_WEBHOOK_001",
      message: "The webhook signature is invalid.",
      category: "authentication",
      retryable: false,
    });
  }
  if (input.deliveryId === null || input.deliveryId.length === 0) {
    throw new CmsError({
      code: "CMS_WEBHOOK_002",
      message: "The webhook delivery ID is missing.",
      category: "validation",
      retryable: false,
    });
  }
  const now = input.now ?? new Date();
  const claimed = await input.replayStore.claim(
    input.deliveryId,
    new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  );
  if (!claimed) {
    throw new CmsError({
      code: "CMS_WEBHOOK_004",
      message: "This webhook delivery was already processed.",
      category: "conflict",
      retryable: false,
    });
  }
  const value = JSON.parse(new TextDecoder().decode(input.body)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_WEBHOOK_005",
      message: "The webhook payload must be a JSON object.",
      category: "validation",
      retryable: false,
    });
  }
  return value as Readonly<Record<string, unknown>>;
}

export class PublicationIntegrationService {
  constructor(
    private readonly deployment: DeploymentPort,
    private readonly revalidation: RevalidationPort,
  ) {}

  async notify(input: {
    readonly environment: "preview" | "staging" | "production";
    readonly releaseId: ReleaseId;
    readonly revision: GitCommitSha;
    readonly tags: readonly string[];
    readonly paths: readonly string[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly deploymentId: string; readonly url?: string }> {
    const deployment = await this.deployment.deploy({
      environment: input.environment,
      releaseId: input.releaseId,
      revision: input.revision,
      idempotencyKey: `${input.idempotencyKey}:deploy`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await this.revalidation.revalidate({
      environment: input.environment,
      tags: [...new Set(input.tags)].sort(),
      paths: [...new Set(input.paths)].sort(),
      idempotencyKey: `${input.idempotencyKey}:revalidate`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return deployment;
  }
}

export class TranslationIntegrationService {
  constructor(private readonly provider: TranslationProvider) {}

  createJob(
    input: Parameters<TranslationProvider["createJob"]>[0],
  ): Promise<{ readonly jobId: string }> {
    return this.provider.createJob(input);
  }

  readJob(jobId: string, signal?: AbortSignal): ReturnType<TranslationProvider["readJob"]> {
    return this.provider.readJob(jobId, signal);
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function createScheduledPublicationWorkflow(input: {
  readonly name: string;
  readonly cron: string;
  readonly environment: "staging" | "production";
  readonly nodeVersion?: string;
  readonly pnpmVersion?: string;
}): string {
  if (!/^(\S+\s+){4}\S+$/.test(input.cron)) {
    throw new CmsError({
      code: "CMS_SCHEDULE_001",
      message: "A five-field UTC cron expression is required.",
      category: "validation",
      retryable: false,
    });
  }
  const environment = input.environment;
  return [
    `name: ${yamlString(input.name)}`,
    "on:",
    "  schedule:",
    `    - cron: ${yamlString(input.cron)}`,
    "  workflow_dispatch:",
    "concurrency:",
    `  group: cms-publish-${environment}`,
    "  cancel-in-progress: false",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "jobs:",
    "  publish:",
    `    environment: ${environment}`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - uses: pnpm/action-setup@v4`,
    "        with:",
    `          version: ${yamlString(input.pnpmVersion ?? "11")}`,
    "      - uses: actions/setup-node@v4",
    "        with:",
    `          node-version: ${yamlString(input.nodeVersion ?? "22")}`,
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    `      - run: pnpm cms publish --environment ${environment} --idempotency-key schedule-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    "",
  ].join("\n");
}
