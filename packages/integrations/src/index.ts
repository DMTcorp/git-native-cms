import type {
  DeploymentPort,
  RevalidationPort,
  SchedulerPort,
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
  }): Promise<void> {
    await this.deployment.deploy({
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
  }
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && [0, 2, 168].includes(second)) ||
    (first === 198 && [18, 19, 51].includes(second)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function privateNetworkHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal" ||
    normalized.includes(":") ||
    privateIpv4(normalized)
  );
}

function integrationUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new CmsError({
      code: "CMS_INTEGRATION_001",
      message: "Integration endpoints must use HTTPS.",
      category: "configuration",
      retryable: false,
    });
  }
  if (privateNetworkHost(url.hostname)) {
    throw new CmsError({
      code: "CMS_INTEGRATION_003",
      message:
        "Integration endpoints cannot target local, private, metadata, or reserved networks.",
      category: "configuration",
      retryable: false,
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CmsError({
      code: "CMS_INTEGRATION_001",
      message: "Integration endpoint credentials must be passed separately.",
      category: "configuration",
      retryable: false,
    });
  }
  return url;
}

async function integrationRequest(input: {
  readonly url: string;
  readonly token?: string;
  readonly method?: "GET" | "POST";
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}): Promise<Readonly<Record<string, unknown>>> {
  const idempotencyKey =
    typeof input.body?.idempotencyKey === "string" ? input.body.idempotencyKey : "";
  const response = await fetch(integrationUrl(input.url), {
    method: input.method ?? "POST",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey.length === 0 ? {} : { "idempotency-key": idempotencyKey }),
      ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: "error",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new CmsError({
      code: "CMS_INTEGRATION_002",
      message: `Integration endpoint returned HTTP ${response.status}.`,
      category: "network",
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    const value = (await response.json()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  }
  return {};
}

export class HttpDeploymentAdapter implements DeploymentPort {
  constructor(
    private readonly options: {
      readonly url: string;
      readonly token?: string;
    },
  ) {}

  async deploy(
    input: Parameters<DeploymentPort["deploy"]>[0],
  ): Promise<{ readonly deploymentId: string; readonly url?: string }> {
    const result = await integrationRequest({
      url: this.options.url,
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
      body: {
        environment: input.environment,
        releaseId: input.releaseId,
        revision: input.revision,
        idempotencyKey: input.idempotencyKey,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const deploymentId =
      typeof result.deploymentId === "string" && result.deploymentId.length > 0
        ? result.deploymentId
        : input.idempotencyKey;
    return {
      deploymentId,
      ...(typeof result.url === "string" ? { url: result.url } : {}),
    };
  }
}

export class HttpRevalidationAdapter implements RevalidationPort {
  constructor(
    private readonly options: {
      readonly url: string;
      readonly token?: string;
    },
  ) {}

  async revalidate(input: Parameters<RevalidationPort["revalidate"]>[0]): Promise<void> {
    await integrationRequest({
      url: this.options.url,
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
      body: {
        environment: input.environment,
        tags: input.tags,
        paths: input.paths,
        idempotencyKey: input.idempotencyKey,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

function integrationChildUrl(base: string, child: string): string {
  const url = integrationUrl(base);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${child.replace(/^\//u, "")}`;
  return url.toString();
}

export class HttpTranslationProvider implements TranslationProvider {
  constructor(
    private readonly options: {
      readonly url: string;
      readonly token?: string;
    },
  ) {}

  async createJob(
    input: Parameters<TranslationProvider["createJob"]>[0],
  ): Promise<{ readonly jobId: string }> {
    const result = await integrationRequest({
      url: integrationChildUrl(this.options.url, "jobs"),
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
      body: {
        sourceLocale: input.sourceLocale,
        targetLocale: input.targetLocale,
        xliff: input.xliff,
        idempotencyKey: input.idempotencyKey,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (typeof result.jobId !== "string" || result.jobId.length === 0) {
      throw new CmsError({
        code: "CMS_TRANSLATION_012",
        message: "Translation provider did not return a job ID.",
        category: "network",
        retryable: false,
      });
    }
    return { jobId: result.jobId };
  }

  async readJob(jobId: string, signal?: AbortSignal): ReturnType<TranslationProvider["readJob"]> {
    const result = await integrationRequest({
      url: integrationChildUrl(this.options.url, `jobs/${encodeURIComponent(jobId)}`),
      method: "GET",
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "queued" || result.status === "working") {
      return { status: result.status };
    }
    if (result.status === "complete" && typeof result.xliff === "string") {
      return { status: "complete", xliff: result.xliff };
    }
    if (result.status === "failed" && typeof result.message === "string") {
      return { status: "failed", message: result.message };
    }
    throw new CmsError({
      code: "CMS_TRANSLATION_013",
      message: "Translation provider returned an invalid job status.",
      category: "network",
      retryable: false,
    });
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

export class GitHubActionsScheduler implements SchedulerPort {
  workflow(input: Parameters<SchedulerPort["workflow"]>[0]): {
    readonly path: string;
    readonly content: string;
  } {
    const date = new Date(input.executeAt);
    if (Number.isNaN(date.getTime()) || !/^sch_[A-Z0-9]+$/u.test(input.scheduleId)) {
      throw new CmsError({
        code: "CMS_SCHEDULE_002",
        message: "Schedule identifier or execution time is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    return {
      path: ".github/workflows/cms-schedules.yml",
      content: createScheduleExecutorWorkflow(),
    };
  }
}

export function createScheduleExecutorWorkflow(): string {
  return [
    "name: CMS schedule executor",
    "on:",
    "  schedule:",
    '    - cron: "*/5 * * * *"',
    "  workflow_dispatch:",
    "concurrency:",
    "  group: cms-schedule-executor",
    "  cancel-in-progress: false",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  execute:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Execute due schedules",
    "        run: |",
    "          curl --fail-with-body --silent --show-error \\",
    "            --request POST \\",
    '            --header "authorization: Bearer $CMS_SCHEDULE_TOKEN" \\',
    '            --header "content-type: application/json" \\',
    '            --header "idempotency-key: schedule-${{ github.run_id }}-${{ github.run_attempt }}" \\',
    '            --data \'{"configVersion":1,"schemaVersion":1}\' \\',
    '            "$CMS_SCHEDULE_ENDPOINT"',
    "        env:",
    "          CMS_SCHEDULE_ENDPOINT: ${{ secrets.CMS_SCHEDULE_ENDPOINT }}",
    "          CMS_SCHEDULE_TOKEN: ${{ secrets.CMS_SCHEDULE_TOKEN }}",
    "",
  ].join("\n");
}
