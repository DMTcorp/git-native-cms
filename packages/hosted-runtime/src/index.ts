import { S3Client } from "@aws-sdk/client-s3";
import {
  createCmsApplication,
  type CmsApplication,
  type AuditEvent,
  type AuditQueryPort,
  type AuditSink,
  type Asset,
  type AssetProcessorPort,
  type AssetStore,
  type ChangeConflict,
  type Clock,
  type DocumentSummary,
  type EnvironmentPointer,
  type IdGenerator,
  type IdempotencyStore,
  type ReviewCheck,
  type ReviewComment,
  type ReviewAssignment,
  type StagingBatchLock,
  type SessionRecord,
  type StoredRelease,
  type ReleaseStore,
  type SessionStore,
  type TeamMember,
  type OrganizationTeam,
} from "@git-native-cms/application";
import {
  createGitHubOAuthAttempt,
  csrfMatches,
  exchangeGitHubOAuthCode,
  revokeGitHubOAuthToken,
  verifyOAuthState,
  type OAuthAttempt,
} from "@git-native-cms/auth";
import { S3AssetStore, buildAssetUsageGraph } from "@git-native-cms/assets";
import { canonicalJson, yamlCodec } from "@git-native-cms/content-codecs";
import { GitContentRepository } from "@git-native-cms/content-repository";
import {
  CmsError,
  createPrefixedId,
  type Actor,
  type ActorId,
  type AssetId,
  type Change,
  type ChangeId,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type RoleName,
} from "@git-native-cms/core";
import { S3ReleaseStore } from "@git-native-cms/delivery";
import {
  createGitHubAppRequester,
  GitHubGitProvider,
  GitHubIdentityProvider,
  GitHubReviewPort,
  GitHubTeamProvisioning,
} from "@git-native-cms/github";
import { S3ImageAssetProcessor } from "@git-native-cms/image-pipeline";
import {
  GitHubActionsScheduler,
  HttpDeploymentAdapter,
  HttpRevalidationAdapter,
  HttpTranslationProvider,
  MemoryWebhookReplayStore,
  PublicationIntegrationService,
  receiveSignedWebhook,
} from "@git-native-cms/integrations";
import { exportXliff } from "@git-native-cms/localization";
import { handleMcpHttp, type CmsMcpQueries, type ConfirmationService } from "@git-native-cms/mcp";
import { consoleLogger, measured, type CmsLogger } from "@git-native-cms/observability";
import {
  AuthorizationService,
  effectiveRoles,
  parsePermissionConfiguration,
  type CustomRoleDefinition,
  type TeamRoleMapping,
} from "@git-native-cms/permissions";
import { deterministicReleaseBuilder } from "@git-native-cms/release-builder";
import { buildReferenceGraph, buildSearchIndex, search } from "@git-native-cms/search";
import { createCmsServer, type CmsServer } from "@git-native-cms/server";
import {
  readSessionCookie,
  RotatingCookieSessionService,
  SignedPreviewSessionService,
} from "@git-native-cms/sessions";
import { EncryptJWT, jwtDecrypt } from "jose";
import {
  S3AuditSink,
  S3ConfirmationReplayStore,
  S3IdempotencyStore,
  MemoryRateLimitStore,
  S3RateLimitStore,
  S3WebhookReplayStore,
} from "./runtime-state.js";

const AUTH_PATH = "/api/cms/auth/github";
const WEBHOOK_PATH = "/api/cms/webhooks/github";
const MCP_PATH = "/api/cms/mcp";
const CONFIRMATION_PATH = "/api/cms/confirmations";
const SCHEDULE_EXECUTION_PATH = "/api/cms/schedules/execute";
const HOME_DOCUMENT_ID = "doc_home" as DocumentId;

export interface HostedRuntimeEnvironment {
  readonly [key: string]: string | undefined;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET?: string;
  readonly GITHUB_WEBHOOK_SECRET?: string;
  readonly GITHUB_API_BASE_URL?: string;
  readonly GITHUB_WEB_BASE_URL?: string;
  readonly CMS_GITHUB_TEAM_ROLES?: string;
  readonly CMS_SESSION_SECRET?: string;
  readonly CMS_S3_ENDPOINT?: string;
  readonly CMS_S3_REGION?: string;
  readonly CMS_S3_ACCESS_KEY_ID?: string;
  readonly CMS_S3_SECRET_ACCESS_KEY?: string;
  readonly CMS_RELEASES_BUCKET?: string;
  readonly CMS_ASSETS_BUCKET?: string;
  readonly CMS_STATE_BUCKET?: string;
  readonly CMS_PUBLIC_ASSETS_URL?: string;
  readonly CMS_PUBLIC_RELEASES_URL?: string;
  readonly CMS_STAGING_SITE_URL?: string;
  readonly CMS_PRODUCTION_SITE_URL?: string;
  readonly CMS_DEPLOYMENT_HOOK_URL?: string;
  readonly CMS_REVALIDATION_URL?: string;
  readonly CMS_INTEGRATION_TOKEN?: string;
  readonly CMS_TRANSLATION_PROVIDER_URL?: string;
  readonly CMS_TRANSLATION_PROVIDER_TOKEN?: string;
  readonly CMS_SCHEDULE_TOKEN?: string;
  readonly CMS_MCP_TOKEN?: string;
  readonly CMS_REGISTRY_DIGEST?: string;
}

export interface HostedEditableSection {
  readonly id: string;
  readonly type: string;
  readonly heading?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface HostedEditablePage {
  readonly title?: string;
  readonly route?: { readonly path?: string };
  readonly sections?: readonly HostedEditableSection[];
  readonly [key: string]: unknown;
}

export type HostedEditorState =
  | {
      readonly authenticated: false;
      readonly loginUrl: string;
      readonly projectName: string;
    }
  | {
      readonly authenticated: true;
      readonly view: "dashboard";
      readonly actor: Actor;
      readonly changes: readonly Change[];
      readonly releases: readonly StoredRelease[];
      readonly pointers: readonly EnvironmentPointer[];
      readonly assets: readonly Asset[];
      readonly stagingRevision: GitCommitSha;
      readonly stagingLock?: StagingBatchLock;
      readonly registryDigest: string;
      readonly stagingUrl: string;
      readonly productionUrl: string;
      readonly csrfToken: string;
      readonly projectName: string;
    }
  | {
      readonly authenticated: true;
      readonly view: "staging" | "releases" | "assets" | "settings" | "developer";
      readonly actor: Actor;
      readonly changes: readonly Change[];
      readonly releases: readonly StoredRelease[];
      readonly pointers: readonly EnvironmentPointer[];
      readonly assets: readonly Asset[];
      readonly stagingRevision: GitCommitSha;
      readonly stagingLock?: StagingBatchLock;
      readonly registryDigest: string;
      readonly stagingUrl: string;
      readonly productionUrl: string;
      readonly csrfToken: string;
      readonly projectName: string;
    }
  | {
      readonly authenticated: true;
      readonly view: "team";
      readonly actor: Actor;
      readonly organization: string;
      readonly members: readonly TeamMember[];
      readonly teams: readonly OrganizationTeam[];
      readonly customRoles: readonly CustomRoleDefinition[];
      readonly mainRevision: GitCommitSha;
      readonly csrfToken: string;
      readonly projectName: string;
    }
  | {
      readonly authenticated: true;
      readonly view: "workspace";
      readonly actor: Actor;
      readonly change: Change;
      readonly document: ContentDocument<HostedEditablePage>;
      readonly baseDocument?: ContentDocument<HostedEditablePage>;
      readonly productionDocument?: ContentDocument<HostedEditablePage>;
      readonly conflicts: readonly ChangeConflict[];
      readonly documents: readonly DocumentSummary[];
      readonly contentDocuments: readonly ContentDocument[];
      readonly previewDocument: ContentDocument<HostedEditablePage>;
      readonly assets: readonly Asset[];
      readonly review: {
        readonly comments: readonly ReviewComment[];
        readonly checks: readonly ReviewCheck[];
        readonly assignment: ReviewAssignment;
        readonly timeline: readonly AuditEvent[];
        readonly summary: {
          readonly changedDocumentIds: readonly string[];
          readonly affectedUsages: number;
          readonly warnings: number;
        };
      };
      readonly translationProviderAvailable: boolean;
      readonly registryDigest: string;
      readonly csrfToken: string;
      readonly projectName: string;
    };

export interface HostedCmsRuntime {
  handle(request: Request): Promise<Response>;
  editorState(request: Request | string | null, path?: string): Promise<HostedEditorState>;
}

interface RuntimeConfiguration {
  readonly appId: number;
  readonly privateKey: string;
  readonly installationId: number;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly webhookSecret: string;
  readonly sessionSecret: string;
  readonly registryDigest: string;
  readonly githubApiBaseUrl: string;
  readonly githubWebBaseUrl: string;
  readonly teamRoleMappings: readonly TeamRoleMapping[];
  readonly customRoles: readonly CustomRoleDefinition[];
}

interface InitializedRuntime {
  readonly application: CmsApplication;
  readonly server: CmsServer;
  readonly git: GitHubGitProvider;
  readonly sessions: RotatingCookieSessionService;
  readonly listChanges: (actor: Actor) => Promise<readonly Change[]>;
  readonly getChange: (id: string, actor: Actor) => Promise<Change>;
  readonly contentRef: (change: Change) => string;
  readonly listReleases: () => Promise<readonly StoredRelease[]>;
  readonly listPointers: () => Promise<readonly EnvironmentPointer[]>;
  readonly stagingRevision: () => Promise<GitCommitSha>;
  readonly listAssets: () => Promise<readonly Asset[]>;
  readonly content: GitContentRepository;
  readonly review: GitHubReviewPort;
  readonly identity: GitHubIdentityProvider;
  readonly config: RuntimeConfiguration;
  readonly replayStore: MemoryWebhookReplayStore | S3WebhookReplayStore;
  readonly confirmationStore: ConfirmationReplayStore;
  readonly rateLimitStore: MemoryRateLimitStore | S3RateLimitStore;
}

function required(
  environment: HostedRuntimeEnvironment,
  key: keyof HostedRuntimeEnvironment,
): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new CmsError({
      code: "CMS_CONFIGURATION_001",
      message: `${key} is required for the hosted CMS runtime.`,
      category: "configuration",
      retryable: false,
    });
  }
  return value;
}

function configuration(environment: HostedRuntimeEnvironment): RuntimeConfiguration {
  const appId = Number(required(environment, "GITHUB_APP_ID"));
  const installationId = Number(required(environment, "GITHUB_APP_INSTALLATION_ID"));
  if (!Number.isSafeInteger(appId) || !Number.isSafeInteger(installationId)) {
    throw new CmsError({
      code: "CMS_CONFIGURATION_001",
      message: "GitHub App and installation IDs must be integers.",
      category: "configuration",
      retryable: false,
    });
  }
  const registryDigest = required(environment, "CMS_REGISTRY_DIGEST");
  if (!/^sha256:[a-f0-9]{64}$/iu.test(registryDigest)) {
    throw new CmsError({
      code: "CMS_CONFIGURATION_001",
      message: "CMS_REGISTRY_DIGEST must be a SHA-256 digest.",
      category: "configuration",
      retryable: false,
    });
  }
  const sessionSecret = required(environment, "CMS_SESSION_SECRET");
  const scheduleToken = required(environment, "CMS_SCHEDULE_TOKEN");
  const mcpToken = required(environment, "CMS_MCP_TOKEN");
  if (sessionSecret.length < 32 || scheduleToken.length < 32 || mcpToken.length < 32) {
    throw new CmsError({
      code: "CMS_CONFIGURATION_002",
      message: "Session, scheduler and MCP secrets must each contain at least 32 characters.",
      category: "configuration",
      retryable: false,
    });
  }
  for (const storageKey of [
    "CMS_S3_ENDPOINT",
    "CMS_S3_ACCESS_KEY_ID",
    "CMS_S3_SECRET_ACCESS_KEY",
    "CMS_RELEASES_BUCKET",
    "CMS_ASSETS_BUCKET",
    "CMS_STATE_BUCKET",
    "CMS_PUBLIC_ASSETS_URL",
    "CMS_PUBLIC_RELEASES_URL",
  ] as const) {
    required(environment, storageKey);
  }
  let teamRoleMappings: readonly TeamRoleMapping[] = [];
  if (environment.CMS_GITHUB_TEAM_ROLES !== undefined) {
    try {
      const parsed = JSON.parse(environment.CMS_GITHUB_TEAM_ROLES) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected an array.");
      teamRoleMappings = parsed.map((value) => {
        if (typeof value !== "object" || value === null) throw new Error("Invalid team mapping.");
        const mapping = value as Readonly<Record<string, unknown>>;
        if (
          typeof mapping.team !== "string" ||
          !Array.isArray(mapping.roles) ||
          !mapping.roles.every((role) => typeof role === "string")
        ) {
          throw new Error("Invalid team mapping.");
        }
        return { team: mapping.team, roles: mapping.roles as readonly RoleName[] };
      });
    } catch (cause) {
      throw new CmsError({
        code: "CMS_CONFIGURATION_003",
        message: "CMS_GITHUB_TEAM_ROLES must be a JSON array of team-to-role mappings.",
        category: "configuration",
        retryable: false,
        cause,
      });
    }
  }
  return {
    appId,
    privateKey: required(environment, "GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n"),
    installationId,
    oauthClientId: required(environment, "GITHUB_OAUTH_CLIENT_ID"),
    oauthClientSecret: required(environment, "GITHUB_OAUTH_CLIENT_SECRET"),
    webhookSecret: required(environment, "GITHUB_WEBHOOK_SECRET"),
    sessionSecret,
    registryDigest,
    githubApiBaseUrl: environment.GITHUB_API_BASE_URL ?? "https://api.github.com",
    githubWebBaseUrl: environment.GITHUB_WEB_BASE_URL ?? "https://github.com",
    teamRoleMappings,
    customRoles: [],
  };
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

class RuntimeIds implements IdGenerator {
  changeId(): ChangeId {
    return createPrefixedId<"ChangeId">("chg");
  }
  documentId(): DocumentId {
    return createPrefixedId<"DocumentId">("doc");
  }
  scheduleId(): string {
    return createPrefixedId<"ScheduleId">("sch");
  }
  requestId(): string {
    return `req_${globalThis.crypto.randomUUID()}`;
  }
  suffix(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  }
}

class RuntimeIdempotencyStore implements IdempotencyStore {
  private readonly values = new Map<string, unknown>();
  async read<TResult>(key: string): Promise<TResult | undefined> {
    return this.values.get(key) as TResult | undefined;
  }
  async write<TResult>(key: string, value: TResult): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

class RuntimeAuditSink implements AuditSink, AuditQueryPort {
  readonly recent: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.recent.push(structuredClone(event));
    if (this.recent.length > 500) this.recent.shift();
  }

  async list(input: {
    readonly resourceId?: string;
    readonly limit?: number;
  }): Promise<readonly AuditEvent[]> {
    return this.recent
      .filter((event) => input.resourceId === undefined || event.resourceId === input.resourceId)
      .slice(-(input.limit ?? 100))
      .reverse()
      .map((event) => structuredClone(event));
  }
}

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const [candidate, ...parts] = entry.trim().split("=");
    if (candidate === name) return parts.join("=") || undefined;
  }
  return undefined;
}

function oauthCookie(token: string, maxAge = 600): string {
  return [
    `cms_oauth=${token}`,
    `Path=${AUTH_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

async function oauthKey(secret: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`oauth-attempt:${secret}`),
    ),
  );
}

async function confirmationKey(secret: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`confirmation:${secret}`),
    ),
  );
}

async function issueConfirmation(input: {
  readonly secret: string;
  readonly actorId: string;
  readonly action: "publish" | "rollback";
}): Promise<string> {
  return new EncryptJWT({ action: input.action })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuer("git-native-cms-confirmation")
    .setSubject(input.actorId)
    .setJti(globalThis.crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .encrypt(await confirmationKey(input.secret));
}

interface ConfirmationReplayStore {
  claim(tokenId: string, expiresAt: string): Promise<boolean>;
}

class MemoryConfirmationReplayStore implements ConfirmationReplayStore {
  private readonly claimed = new Map<string, number>();

  async claim(tokenId: string, expiresAt: string): Promise<boolean> {
    const now = Date.now();
    for (const [id, expiry] of this.claimed) {
      if (expiry <= now) this.claimed.delete(id);
    }
    if (this.claimed.has(tokenId)) return false;
    this.claimed.set(tokenId, new Date(expiresAt).getTime());
    return true;
  }
}

async function verifyConfirmationToken(input: {
  readonly secret: string;
  readonly token: string | undefined;
  readonly actorId: string;
  readonly action: "publish" | "rollback";
  readonly replayStore: ConfirmationReplayStore;
}): Promise<boolean> {
  if (input.token === undefined) return false;
  try {
    const verified = await jwtDecrypt(input.token, await confirmationKey(input.secret), {
      issuer: "git-native-cms-confirmation",
      subject: input.actorId,
    });
    if (
      verified.payload.action !== input.action ||
      typeof verified.payload.jti !== "string" ||
      typeof verified.payload.exp !== "number"
    ) {
      return false;
    }
    return await input.replayStore.claim(
      verified.payload.jti,
      new Date(verified.payload.exp * 1000).toISOString(),
    );
  } catch {
    return false;
  }
}

async function encodeAttempt(attempt: OAuthAttempt, secret: string): Promise<string> {
  return new EncryptJWT({ attempt })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuer("git-native-cms-oauth")
    .setIssuedAt()
    .setExpirationTime(Math.floor(new Date(attempt.expiresAt).getTime() / 1000))
    .encrypt(await oauthKey(secret));
}

async function decodeAttempt(token: string, secret: string): Promise<OAuthAttempt> {
  const result = await jwtDecrypt(token, await oauthKey(secret), {
    issuer: "git-native-cms-oauth",
  });
  const attempt = result.payload.attempt;
  if (typeof attempt !== "object" || attempt === null) {
    throw new Error("OAuth attempt is missing.");
  }
  return attempt as unknown as OAuthAttempt;
}

function actorId(githubId: number): ActorId {
  return `act_${String(githubId).padStart(26, "0").slice(-26)}` as ActorId;
}

function rolesFor(permissions: Readonly<Record<string, boolean>>): readonly RoleName[] {
  if (permissions.admin === true) return ["administrator"];
  if (permissions.maintain === true) return ["editor", "publisher"];
  if (permissions.push === true) return ["editor"];
  if (permissions.triage === true) return ["reviewer"];
  return ["viewer"];
}

function serviceActor(input: {
  readonly name: "scheduler" | "mcp";
  readonly roles: readonly RoleName[];
  readonly source: Actor["source"];
}): Actor {
  const suffix = input.name === "scheduler" ? "1" : "2";
  return {
    id: `act_${suffix.padStart(26, "0")}` as ActorId,
    githubId: 0,
    login: `cms-${input.name}`,
    displayName: `CMS ${input.name}`,
    roles: input.roles,
    source: input.source,
  };
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function secretMatches(expected: string | undefined, received: string | undefined): boolean {
  return expected !== undefined && received !== undefined && csrfMatches(expected, received);
}

function changeFrom(value: unknown): Change | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.ownerId !== "string" ||
    typeof record.baseBranch !== "string" ||
    typeof record.baseCommit !== "string" ||
    typeof record.branchName !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }
  return record as unknown as Change;
}

function safeLogin(login: string): string {
  return (
    login
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || "editor"
  );
}

function translatableUnits(
  value: unknown,
  path = "",
): readonly { readonly id: string; readonly source: string }[] {
  if (typeof value === "string") return [{ id: path || "/", source: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => translatableUnits(item, `${path}/${index}`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([key]) => key !== "locales")
    .flatMap(([key, child]) =>
      translatableUnits(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    );
}

function responseError(error: unknown): Response {
  const cmsError =
    error instanceof CmsError
      ? error
      : new CmsError({
          code: "CMS_HOSTED_500",
          message: "The hosted CMS runtime could not complete this request.",
          category: "internal",
          retryable: false,
          cause: error,
        });
  const status =
    cmsError.category === "authentication"
      ? 401
      : cmsError.category === "authorization"
        ? 403
        : cmsError.category === "configuration"
          ? 503
          : 500;
  return Response.json({ error: cmsError.toJSON() }, { status });
}

async function rateLimitResponse(
  store: MemoryRateLimitStore | S3RateLimitStore,
  input: {
    readonly key: string;
    readonly scope: string;
    readonly limit: number;
  },
): Promise<Response | undefined> {
  const rate = await store.consume({
    ...input,
    windowMs: 60_000,
    now: new Date().toISOString(),
  });
  if (rate.allowed) return undefined;
  const retryAfter = Math.max(1, Math.ceil((new Date(rate.resetAt).getTime() - Date.now()) / 1000));
  return Response.json(
    {
      error: {
        code: "CMS_RATE_LIMIT_001",
        message: "Too many CMS requests. Retry after the current window.",
        category: "authorization",
        retryable: true,
      },
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfter),
      },
    },
  );
}

export function createHostedCmsRuntime(options: {
  readonly origin: string;
  readonly projectName: string;
  readonly environment: HostedRuntimeEnvironment;
  readonly logger?: CmsLogger;
  readonly registryManifest?: readonly {
    readonly name: string;
    readonly version: number;
    readonly label: string;
  }[];
  readonly contentTypes?: readonly {
    readonly name: string;
    readonly version: number;
    readonly label: string;
  }[];
  readonly adapters?: {
    readonly assetStore?: AssetStore;
    readonly assetProcessor?: AssetProcessorPort;
    readonly releaseStore?: ReleaseStore;
    readonly sessionStore?: SessionStore;
  };
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly mainBranch?: string;
    readonly stagingBranch?: string;
    readonly homeDocumentId?: string;
  };
}): HostedCmsRuntime {
  let initialized: Promise<InitializedRuntime> | undefined;
  const mainBranch = options.repository.mainBranch ?? "main";
  const stagingBranch = options.repository.stagingBranch ?? "staging";
  const homeDocumentId = (options.repository.homeDocumentId ?? HOME_DOCUMENT_ID) as DocumentId;
  const logger = options.logger ?? consoleLogger();

  const initialize = async (): Promise<InitializedRuntime> => {
    const config = configuration(options.environment);
    const requester = await createGitHubAppRequester({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
      baseUrl: config.githubApiBaseUrl,
    });
    const git = new GitHubGitProvider({
      requester,
      owner: options.repository.owner,
      repository: options.repository.name,
    });
    const permissionsFile = await git
      .readFile({ ref: mainBranch, path: ".cms/permissions.yaml" })
      .catch(() => undefined);
    const gitPermissions =
      permissionsFile === undefined
        ? { mappings: [], customRoles: [] }
        : parsePermissionConfiguration(yamlCodec.parse(permissionsFile.content));
    const teamRoleMappings = [
      ...new Map(
        [...config.teamRoleMappings, ...gitPermissions.mappings].map((mapping) => [
          mapping.team,
          mapping,
        ]),
      ).values(),
    ];
    const runtimeConfig: RuntimeConfiguration = {
      ...config,
      teamRoleMappings,
      customRoles: gitPermissions.customRoles,
    };
    const content = new GitContentRepository(git);
    const identity = new GitHubIdentityProvider({
      owner: options.repository.owner,
      repository: options.repository.name,
      baseUrl: config.githubApiBaseUrl,
    });
    const teamProvisioning = new GitHubTeamProvisioning({
      requester,
      organization: options.repository.owner,
    });
    const clock = new SystemClock();
    const ids = new RuntimeIds();
    const sessions = new RotatingCookieSessionService(config.sessionSecret, {
      secure: true,
      ...(options.adapters?.sessionStore === undefined
        ? {}
        : { store: options.adapters.sessionStore }),
      revokeGitHubToken: (accessToken) =>
        revokeGitHubOAuthToken({
          clientId: config.oauthClientId,
          clientSecret: config.oauthClientSecret,
          accessToken,
          apiBaseUrl: config.githubApiBaseUrl,
        }),
    });
    const s3 =
      options.environment.CMS_S3_ENDPOINT === undefined ||
      options.environment.CMS_S3_ACCESS_KEY_ID === undefined ||
      options.environment.CMS_S3_SECRET_ACCESS_KEY === undefined ||
      options.environment.CMS_RELEASES_BUCKET === undefined
        ? undefined
        : new S3Client({
            endpoint: options.environment.CMS_S3_ENDPOINT,
            region: options.environment.CMS_S3_REGION ?? "auto",
            credentials: {
              accessKeyId: options.environment.CMS_S3_ACCESS_KEY_ID,
              secretAccessKey: options.environment.CMS_S3_SECRET_ACCESS_KEY,
            },
          });
    const releaseStore =
      options.adapters?.releaseStore ??
      (s3 === undefined
        ? undefined
        : new S3ReleaseStore({
            client: s3,
            bucket: options.environment.CMS_RELEASES_BUCKET as string,
          }));
    const assetStore =
      options.adapters?.assetStore ??
      (s3 === undefined ||
      options.environment.CMS_ASSETS_BUCKET === undefined ||
      options.environment.CMS_PUBLIC_ASSETS_URL === undefined
        ? undefined
        : new S3AssetStore({
            client: s3,
            bucket: options.environment.CMS_ASSETS_BUCKET,
            publicBaseUrl: options.environment.CMS_PUBLIC_ASSETS_URL,
          }));
    const assetProcessor =
      options.adapters?.assetProcessor ??
      (s3 === undefined ||
      options.environment.CMS_ASSETS_BUCKET === undefined ||
      options.environment.CMS_PUBLIC_ASSETS_URL === undefined
        ? undefined
        : new S3ImageAssetProcessor({
            client: s3,
            bucket: options.environment.CMS_ASSETS_BUCKET,
            publicBaseUrl: options.environment.CMS_PUBLIC_ASSETS_URL,
          }));
    const publicationNotifier =
      options.environment.CMS_DEPLOYMENT_HOOK_URL === undefined ||
      options.environment.CMS_REVALIDATION_URL === undefined
        ? undefined
        : new PublicationIntegrationService(
            new HttpDeploymentAdapter({
              url: options.environment.CMS_DEPLOYMENT_HOOK_URL,
              ...(options.environment.CMS_INTEGRATION_TOKEN === undefined
                ? {}
                : { token: options.environment.CMS_INTEGRATION_TOKEN }),
            }),
            new HttpRevalidationAdapter({
              url: options.environment.CMS_REVALIDATION_URL,
              ...(options.environment.CMS_INTEGRATION_TOKEN === undefined
                ? {}
                : { token: options.environment.CMS_INTEGRATION_TOKEN }),
            }),
          );
    const translationProvider =
      options.environment.CMS_TRANSLATION_PROVIDER_URL === undefined
        ? undefined
        : new HttpTranslationProvider({
            url: options.environment.CMS_TRANSLATION_PROVIDER_URL,
            ...(options.environment.CMS_TRANSLATION_PROVIDER_TOKEN === undefined
              ? {}
              : { token: options.environment.CMS_TRANSLATION_PROVIDER_TOKEN }),
          });
    const stateOptions =
      s3 === undefined || options.environment.CMS_STATE_BUCKET === undefined
        ? undefined
        : { client: s3, bucket: options.environment.CMS_STATE_BUCKET };
    const idempotency =
      stateOptions === undefined
        ? new RuntimeIdempotencyStore()
        : new S3IdempotencyStore(stateOptions);
    const auditSink =
      stateOptions === undefined ? new RuntimeAuditSink() : new S3AuditSink(stateOptions);
    const replayStore =
      stateOptions === undefined
        ? new MemoryWebhookReplayStore()
        : new S3WebhookReplayStore(stateOptions);
    const confirmationStore =
      stateOptions === undefined
        ? new MemoryConfirmationReplayStore()
        : new S3ConfirmationReplayStore(stateOptions);
    const rateLimitStore =
      stateOptions === undefined ? new MemoryRateLimitStore() : new S3RateLimitStore(stateOptions);
    const review = new GitHubReviewPort({
      requester,
      owner: options.repository.owner,
      repository: options.repository.name,
    });
    const assetUsage = {
      async usages(id: AssetId): Promise<readonly string[]> {
        const branches = await git.listBranches({ prefix: "cms/" });
        const refs = [
          ...new Set([mainBranch, stagingBranch, ...branches.map((branch) => branch.name)]),
        ];
        const usages: string[] = [];
        for (const ref of refs) {
          const files = await git.listFiles({ ref, prefix: "content/" }).catch(() => []);
          const graph = buildAssetUsageGraph(
            files.map((file) => {
              try {
                return yamlCodec.parse(file.content);
              } catch {
                return undefined;
              }
            }),
          );
          for (const usage of graph.find((candidate) => candidate.assetId === id)?.paths ?? []) {
            usages.push(`${ref}:${usage}`);
          }
        }
        return [...new Set(usages)].sort();
      },
      async isReleased(id: AssetId): Promise<boolean> {
        const releases = await listReleases();
        return releases.some((release) =>
          Object.values(release.files).some((file) => file.includes(`"${id}"`)),
        );
      },
    };
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(gitPermissions.customRoles),
      clock,
      ids,
      idempotency,
      audit: auditSink,
      auditQuery: auditSink,
      review,
      mainBranch,
      stagingBranch,
      ...(releaseStore === undefined
        ? {}
        : { releaseStore, releaseBuilder: deterministicReleaseBuilder }),
      ...(assetStore === undefined
        ? {}
        : {
            assetStore,
            assetUsage,
            ...(assetProcessor === undefined ? {} : { assetProcessor }),
          }),
      scheduler: new GitHubActionsScheduler(),
      ...(publicationNotifier === undefined ? {} : { publicationNotifier }),
      previewSessions: new SignedPreviewSessionService(config.sessionSecret),
      teamProvisioning,
      ...(translationProvider === undefined ? {} : { translationProvider }),
    });

    const contentRef = (change: Change): string =>
      change.status === "staging"
        ? stagingBranch
        : change.status === "published"
          ? mainBranch
          : change.branchName;

    const listChanges = async (actor: Actor): Promise<readonly Change[]> => {
      const canReview = actor.roles.some((role) =>
        ["reviewer", "publisher", "administrator"].includes(String(role)),
      );
      const branchRefs = await git.listBranches({
        prefix: canReview ? "cms/" : `cms/${safeLogin(actor.login)}/`,
      });
      const branchChanges = await Promise.all(
        branchRefs.map(async (branch) => {
          const file = await git.readFile({ ref: branch.name, path: ".cms/change.yaml" });
          return file === undefined ? undefined : changeFrom(yamlCodec.parse(file.content));
        }),
      );
      const lifecycleFiles = (
        await Promise.all(
          [stagingBranch, mainBranch].map((ref) =>
            git.listFiles({ ref, prefix: ".cms/changes/" }).catch(() => []),
          ),
        )
      ).flat();
      const values = [
        ...branchChanges.filter((change): change is Change => change !== undefined),
        ...lifecycleFiles.flatMap((file) => {
          const change = changeFrom(yamlCodec.parse(file.content));
          return change === undefined ? [] : [change];
        }),
      ].filter((change) => canReview || change.ownerId === actor.id);
      const byId = new Map<string, Change>();
      for (const change of values) {
        const current = byId.get(change.id);
        if (current === undefined || change.updatedAt > current.updatedAt) {
          byId.set(change.id, change);
        }
      }
      return [...byId.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    };

    const getChange = async (id: string, actor: Actor): Promise<Change> => {
      const change = (await listChanges(actor)).find((candidate) => candidate.id === id);
      if (change === undefined) {
        throw new CmsError({
          code: "CMS_CHANGE_404",
          message: "Change was not found.",
          category: "validation",
          retryable: false,
        });
      }
      return change;
    };

    async function listPointers(): Promise<readonly EnvironmentPointer[]> {
      if (releaseStore === undefined) return [];
      const pointers = await Promise.all(
        (["preview", "staging", "production"] as const).map((environment) =>
          releaseStore.readPointer(environment),
        ),
      );
      return pointers.filter((pointer): pointer is EnvironmentPointer => pointer !== undefined);
    }
    const readStagingRevision = async (): Promise<GitCommitSha> =>
      (await git.resolveRef(stagingBranch)).sha;
    async function listReleases(): Promise<readonly StoredRelease[]> {
      if (releaseStore === undefined) return [];
      const releases: StoredRelease[] = [];
      let cursor: string | undefined;
      do {
        const page = await releaseStore.listReleases({
          ...(cursor === undefined ? {} : { cursor }),
        });
        releases.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return releases.sort((left, right) => String(right.id).localeCompare(String(left.id)));
    }
    const listAssets = async (): Promise<readonly Asset[]> => {
      if (assetStore === undefined) return [];
      const assets: Asset[] = [];
      let cursor: string | undefined;
      do {
        const page = await assetStore.listAssets(cursor === undefined ? {} : { cursor });
        assets.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return assets;
    };

    const actorForRequest = async (request: Request): Promise<Actor | undefined> => {
      const token = readSessionCookie(request.headers.get("cookie"));
      if (token === undefined) return undefined;
      try {
        return (await sessions.read(token)).actor;
      } catch {
        return undefined;
      }
    };
    const server = createCmsServer({
      application,
      actorForRequest,
      verifyCsrf: async (request) => {
        const token = readSessionCookie(request.headers.get("cookie"));
        if (token === undefined) return false;
        try {
          const session = await sessions.read(token);
          return csrfMatches(session.csrfSecret, request.headers.get("x-csrf-token"));
        } catch {
          return false;
        }
      },
      allowedOrigins: [options.origin],
      rateLimit: rateLimitStore,
      onError: (
        error: unknown,
        context: { readonly requestId: string; readonly method: string; readonly path: string },
      ) =>
        logger.write({
          level: "error",
          event: "cms.http.failure",
          requestId: context.requestId,
          errorCode: error instanceof CmsError ? error.code : "CMS_INTERNAL_500",
          details: {
            method: context.method,
            path: context.path,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      verifyConfirmation: (token, action, actor) =>
        verifyConfirmationToken({
          secret: config.sessionSecret,
          token,
          actorId: actor.id,
          action,
          replayStore: confirmationStore,
        }),
      queries: {
        bootstrap: async (context) => ({
          actor: context.actor,
          project: {
            name: options.projectName,
            repository: `${options.repository.owner}/${options.repository.name}`,
            locales: ["en-US", "pl-PL"],
          },
          capabilities: {
            preview: true,
            github: true,
            releases: releaseStore !== undefined,
          },
        }),
        staging: async (context) => {
          const [revision, changes, pointers] = await Promise.all([
            readStagingRevision(),
            listChanges(context.actor),
            listPointers(),
          ]);
          return {
            revision,
            changes: changes.filter((change) => change.status === "staging"),
            pointer: pointers.find((pointer) => pointer.environment === "staging"),
          };
        },
        listChanges: async (context) => listChanges(context.actor),
        getChange: (id, context) => getChange(id, context.actor),
        listDocuments: async (changeId, context) => {
          const change = await getChange(changeId, context.actor);
          return content.listDocuments({ ref: contentRef(change) });
        },
        getDocument: async (changeId, documentId, context) => {
          const change = await getChange(changeId, context.actor);
          return content.readDocument({ ref: contentRef(change), documentId });
        },
        listReleases,
        listAssets: async () => ({ items: await listAssets() }),
        getAsset: async (id) => {
          const asset = await assetStore?.readAsset(id);
          if (asset === undefined) {
            throw new CmsError({
              code: "CMS_ASSET_404",
              message: "The selected asset does not exist.",
              category: "validation",
              retryable: false,
            });
          }
          return asset;
        },
        assetUsages: async (id) => assetUsage.usages(id),
        search: async (changeId, query, context) => {
          const change = await getChange(changeId, context.actor);
          const summaries = await content.listDocuments({ ref: contentRef(change) });
          const documents = await Promise.all(
            summaries.items.map(async (summary) => ({
              id: summary.id,
              type: summary.type,
              title: summary.title,
              path: summary.path,
              value: (
                await content.readDocument({
                  ref: contentRef(change),
                  documentId: summary.id,
                })
              ).data,
            })),
          );
          return search(buildSearchIndex(documents), query).map((hit) => ({ ...hit }));
        },
        findUsages: async (changeId, referenceId, context) => {
          const change = await getChange(changeId, context.actor);
          const summaries = await content.listDocuments({ ref: contentRef(change) });
          const documents = await Promise.all(
            summaries.items.map(async (summary) => ({
              id: summary.id,
              type: summary.type,
              title: summary.title,
              path: summary.path,
              value: (
                await content.readDocument({
                  ref: contentRef(change),
                  documentId: summary.id,
                })
              ).data,
            })),
          );
          return buildReferenceGraph(documents)
            .edges.filter((edge) => edge.targetId === referenceId)
            .map((edge) => ({ ...edge }));
        },
        exportTranslation: async (changeId, documentId, targetLocale, context) => {
          const change = await getChange(changeId, context.actor);
          const document = await content.readDocument({
            ref: contentRef(change),
            documentId,
          });
          const data =
            typeof document.data === "object" &&
            document.data !== null &&
            !Array.isArray(document.data)
              ? (document.data as Readonly<Record<string, unknown>>)
              : {};
          const localized =
            typeof data.locales === "object" && data.locales !== null
              ? (data.locales as Readonly<Record<string, unknown>>)[targetLocale]
              : undefined;
          const translatedFields =
            typeof localized === "object" && localized !== null
              ? (localized as Readonly<Record<string, unknown>>).fields
              : undefined;
          const translations =
            typeof translatedFields === "object" && translatedFields !== null
              ? (translatedFields as Readonly<Record<string, unknown>>)
              : {};
          return exportXliff({
            sourceLocale: "en-US",
            targetLocale,
            units: translatableUnits(data).map((unit) => ({
              ...unit,
              ...(typeof translations[unit.id] === "string"
                ? { target: translations[unit.id] as string }
                : {}),
            })),
          });
        },
      },
    });
    return {
      application,
      server,
      git,
      sessions,
      listChanges,
      getChange,
      contentRef,
      listReleases,
      listPointers,
      stagingRevision: readStagingRevision,
      listAssets,
      content,
      review,
      identity,
      config: runtimeConfig,
      replayStore,
      confirmationStore,
      rateLimitStore,
    };
  };

  const runtime = (): Promise<InitializedRuntime> => (initialized ??= initialize());

  return {
    async handle(request): Promise<Response> {
      const requestId = request.headers.get("x-request-id") ?? globalThis.crypto.randomUUID();
      const response = await measured(
        logger,
        "cms.http.request",
        async () => {
          const url = new URL(request.url);
          const current = await runtime();
          if (request.method === "GET" && url.pathname === `${AUTH_PATH}/start`) {
            const callbackUrl = `${options.origin}${AUTH_PATH}/callback`;
            const attempt = await createGitHubOAuthAttempt({
              clientId: current.config.oauthClientId,
              callbackUrl,
              authorizationBaseUrl: current.config.githubWebBaseUrl,
            });
            const token = await encodeAttempt(attempt, current.config.sessionSecret);
            return new Response(null, {
              status: 302,
              headers: {
                location: attempt.authorizationUrl,
                "set-cookie": oauthCookie(token),
                "cache-control": "no-store",
              },
            });
          }
          if (request.method === "GET" && url.pathname === `${AUTH_PATH}/callback`) {
            const attemptToken = cookieValue(request.headers.get("cookie"), "cms_oauth");
            if (attemptToken === undefined) {
              throw new CmsError({
                code: "CMS_AUTH_001",
                message: "The login attempt cookie is missing.",
                category: "authentication",
                retryable: false,
              });
            }
            const attempt = await decodeAttempt(attemptToken, current.config.sessionSecret);
            verifyOAuthState({
              expected: attempt.state,
              received: url.searchParams.get("state"),
              expiresAt: attempt.expiresAt,
            });
            const code = url.searchParams.get("code");
            if (code === null) {
              throw new CmsError({
                code: "CMS_AUTH_008",
                message: "GitHub did not return an authorization code.",
                category: "authentication",
                retryable: false,
              });
            }
            const token = await exchangeGitHubOAuthCode({
              clientId: current.config.oauthClientId,
              clientSecret: current.config.oauthClientSecret,
              code,
              verifier: attempt.verifier,
              redirectUri: `${options.origin}${AUTH_PATH}/callback`,
              oauthBaseUrl: current.config.githubWebBaseUrl,
              signal: request.signal,
            });
            const identity = await current.identity.resolve(token.accessToken, request.signal);
            const githubId = Number(identity.externalId);
            if (!Number.isSafeInteger(githubId)) {
              throw new CmsError({
                code: "CMS_AUTH_010",
                message: "GitHub returned an invalid numeric account ID.",
                category: "authentication",
                retryable: false,
              });
            }
            const actor: Actor = {
              id: actorId(githubId),
              githubId,
              login: identity.login,
              displayName: identity.displayName,
              roles: effectiveRoles(
                rolesFor(identity.capabilities),
                identity.teams,
                current.config.teamRoleMappings,
              ),
              source: "ui",
            };
            const issued = await current.sessions.issue(actor, new Date(), token.accessToken);
            const headers = new Headers({
              location: "/cms",
              "cache-control": "no-store",
            });
            headers.append("set-cookie", issued.cookie);
            headers.append("set-cookie", oauthCookie("", 0));
            return new Response(null, { status: 302, headers });
          }
          if (request.method === "POST" && url.pathname === `${AUTH_PATH}/logout`) {
            const token = readSessionCookie(request.headers.get("cookie"));
            const cookie = await current.sessions.logout(token);
            return new Response(null, {
              status: 303,
              headers: { location: "/cms", "set-cookie": cookie, "cache-control": "no-store" },
            });
          }
          if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
            const body = new Uint8Array(await request.arrayBuffer());
            const event = await receiveSignedWebhook({
              secret: current.config.webhookSecret,
              body,
              signature: request.headers.get("x-hub-signature-256"),
              deliveryId: request.headers.get("x-github-delivery"),
              replayStore: current.replayStore,
            });
            return Response.json(
              {
                accepted: true,
                event: request.headers.get("x-github-event"),
                action: event.action,
              },
              { status: 202 },
            );
          }
          if (request.method === "POST" && url.pathname === CONFIRMATION_PATH) {
            const token = readSessionCookie(request.headers.get("cookie"));
            if (token === undefined) {
              throw new CmsError({
                code: "CMS_AUTH_004",
                message: "Sign in to request a confirmation.",
                category: "authentication",
                retryable: false,
              });
            }
            const session = await current.sessions.read(token);
            if (!csrfMatches(session.csrfSecret, request.headers.get("x-csrf-token"))) {
              throw new CmsError({
                code: "CMS_AUTH_005",
                message: "The security token expired. Refresh and try again.",
                category: "authentication",
                retryable: true,
              });
            }
            const limited = await rateLimitResponse(current.rateLimitStore, {
              key: session.actor.id,
              scope: "cms.confirmation",
              limit: 20,
            });
            if (limited !== undefined) return limited;
            const value = (await request.json()) as Readonly<Record<string, unknown>>;
            const action = value.action;
            if (action !== "publish" && action !== "rollback") {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "action must be publish or rollback.",
                category: "validation",
                retryable: false,
              });
            }
            return Response.json({
              token: await issueConfirmation({
                secret: current.config.sessionSecret,
                actorId: session.actor.id,
                action,
              }),
              expiresIn: 300,
            });
          }
          if (request.method === "POST" && url.pathname === SCHEDULE_EXECUTION_PATH) {
            if (!secretMatches(options.environment.CMS_SCHEDULE_TOKEN, bearerToken(request))) {
              throw new CmsError({
                code: "CMS_AUTH_011",
                message: "A valid scheduler token is required.",
                category: "authentication",
                retryable: false,
              });
            }
            const limited = await rateLimitResponse(current.rateLimitStore, {
              key: "scheduler",
              scope: "cms.schedule",
              limit: 30,
            });
            if (limited !== undefined) return limited;
            const declaredLength = Number(request.headers.get("content-length") ?? "0");
            if (Number.isFinite(declaredLength) && declaredLength > 16_384) {
              throw new CmsError({
                code: "CMS_REQUEST_006",
                message: "The scheduler request body is too large.",
                category: "validation",
                retryable: false,
              });
            }
            const value = (await request.json().catch(() => ({}))) as Readonly<
              Record<string, unknown>
            >;
            const result = await current.application.executeDueSchedules.execute(
              {
                configVersion: typeof value.configVersion === "number" ? value.configVersion : 1,
                registryDigest:
                  typeof value.registryDigest === "string"
                    ? value.registryDigest
                    : current.config.registryDigest,
                schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  `schedule:${new Date().toISOString().slice(0, 16)}`,
              },
              {
                actor: serviceActor({
                  name: "scheduler",
                  roles: ["administrator"],
                  source: "action",
                }),
                requestId: request.headers.get("x-request-id") ?? globalThis.crypto.randomUUID(),
                signal: request.signal,
              },
            );
            return Response.json(result, {
              status: result.status === "nothing-due" ? 200 : 202,
              headers: { "cache-control": "no-store" },
            });
          }
          if (request.method === "POST" && url.pathname === MCP_PATH) {
            const machineAuthenticated = secretMatches(
              options.environment.CMS_MCP_TOKEN,
              bearerToken(request),
            );
            let actor: Actor;
            if (machineAuthenticated) {
              actor = serviceActor({ name: "mcp", roles: ["editor"], source: "mcp" });
            } else {
              const token = readSessionCookie(request.headers.get("cookie"));
              if (token === undefined) {
                return Response.json(
                  { jsonrpc: "2.0", error: { code: -32001, message: "Sign in to use MCP." } },
                  { status: 401 },
                );
              }
              const session = await current.sessions.read(token);
              const origin = request.headers.get("origin");
              if (origin !== null && origin !== options.origin) {
                return Response.json(
                  { jsonrpc: "2.0", error: { code: -32003, message: "Origin is not allowed." } },
                  { status: 403 },
                );
              }
              if (!csrfMatches(session.csrfSecret, request.headers.get("x-csrf-token"))) {
                return Response.json(
                  {
                    jsonrpc: "2.0",
                    error: { code: -32002, message: "A session-bound CSRF token is required." },
                  },
                  { status: 403 },
                );
              }
              actor = { ...session.actor, source: "mcp" };
            }
            const limited = await rateLimitResponse(current.rateLimitStore, {
              key: actor.id,
              scope: "cms.mcp",
              limit: 120,
            });
            if (limited !== undefined) {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  error: { code: -32029, message: "Too many MCP requests." },
                },
                {
                  status: 429,
                  headers: {
                    "cache-control": "no-store",
                    "retry-after": limited.headers.get("retry-after") ?? "60",
                  },
                },
              );
            }
            const requestContext = {
              actor,
              requestId: request.headers.get("x-request-id") ?? globalThis.crypto.randomUUID(),
              signal: request.signal,
            };
            const mcpDocuments = async (
              changeId: string,
            ): Promise<
              readonly {
                readonly id: DocumentId;
                readonly type: string;
                readonly title: string;
                readonly path: string;
                readonly value: unknown;
                readonly document: ContentDocument;
              }[]
            > => {
              const change = await current.getChange(changeId, actor);
              const summaries = await current.content.listDocuments({
                ref: current.contentRef(change),
              });
              return await Promise.all(
                summaries.items.map(async (summary) => {
                  const document = await current.content.readDocument({
                    ref: current.contentRef(change),
                    documentId: summary.id,
                  });
                  return {
                    id: summary.id,
                    type: summary.type,
                    title: summary.title,
                    path: summary.path,
                    value: document.data,
                    document,
                  };
                }),
              );
            };
            const queries: CmsMcpQueries = {
              project: async () => ({
                name: options.projectName,
                repository: `${options.repository.owner}/${options.repository.name}`,
                locales: ["en-US", "pl-PL"],
              }),
              listChanges: () => current.listChanges(actor),
              getChange: (id) => current.getChange(id, actor),
              listDocuments: async (changeId) => {
                const change = await current.getChange(changeId, actor);
                return current.content.listDocuments({ ref: current.contentRef(change) });
              },
              getDocument: async (changeId, documentId) => {
                const change = await current.getChange(changeId, actor);
                return current.content.readDocument({
                  ref: current.contentRef(change),
                  documentId,
                }) as unknown as Readonly<Record<string, unknown>>;
              },
              previewUrl: async (changeId) =>
                `${options.origin}/cms/changes/${encodeURIComponent(changeId)}`,
              listReleases: () => current.listReleases(),
              search: async (changeId, query) =>
                search(buildSearchIndex(await mcpDocuments(changeId)), query).map((hit) => ({
                  ...hit,
                })),
              findUsages: async (changeId, referenceId) =>
                buildReferenceGraph(await mcpDocuments(changeId))
                  .edges.filter((edge) => edge.targetId === referenceId)
                  .map((edge) => ({ ...edge })),
              validateChange: async (changeId) => {
                const documents = await mcpDocuments(changeId);
                const graph = buildReferenceGraph(documents);
                const change = await current.getChange(changeId, actor);
                return {
                  changeId,
                  revision: (await current.git.resolveRef(change.branchName)).sha,
                  valid: graph.broken.length === 0,
                  documents: documents.length,
                  brokenReferences: graph.broken,
                };
              },
              stagingStatus: async () => {
                const ref = await current.git.resolveRef(stagingBranch);
                const changes = (await current.listChanges(actor)).filter(
                  (change) => change.status === "staging",
                );
                return {
                  branch: stagingBranch,
                  revision: ref.sha,
                  changes,
                  ready: changes.length > 0,
                };
              },
              registrySections: async () => options.registryManifest ?? [],
              registryContentTypes: async () =>
                options.contentTypes ?? [
                  { name: "pages", version: 1, label: "Pages" },
                  { name: "posts", version: 1, label: "Posts" },
                  { name: "collections", version: 1, label: "Collections" },
                  { name: "globals", version: 1, label: "Globals" },
                  { name: "settings", version: 1, label: "Settings" },
                  { name: "reusable-blocks", version: 1, label: "Reusable Blocks" },
                ],
              contentGraph: async () => {
                const changes = await current.listChanges(actor);
                const change = changes[0];
                if (change === undefined) return { nodes: [], edges: [], broken: [] };
                const documents = await mcpDocuments(change.id);
                const graph = buildReferenceGraph(documents);
                return {
                  nodes: documents.map(({ id, type, title, path }) => ({
                    id,
                    type,
                    title,
                    path,
                  })),
                  edges: graph.edges.map((edge) => ({ ...edge })),
                  broken: graph.broken.map((reference) => ({ ...reference })),
                };
              },
              getDocumentById: async (documentId) => {
                for (const change of await current.listChanges(actor)) {
                  try {
                    return (await current.content.readDocument({
                      ref: current.contentRef(change),
                      documentId,
                    })) as unknown as Readonly<Record<string, unknown>>;
                  } catch {
                    // Continue through visible Changes until the document is found.
                  }
                }
                throw new CmsError({
                  code: "CMS_CONTENT_404",
                  message: `Document ${documentId} was not found in a visible Change.`,
                  category: "validation",
                  retryable: false,
                });
              },
            };
            const confirmation: ConfirmationService = {
              verify: (input) =>
                verifyConfirmationToken({
                  secret: current.config.sessionSecret,
                  token: input.token,
                  actorId: input.actorId,
                  action: input.action,
                  replayStore: current.confirmationStore,
                }),
            };
            return await handleMcpHttp(request, {
              application: current.application,
              queries,
              confirmation,
              request: requestContext,
              registryDigest: current.config.registryDigest,
            });
          }
          return await current.server.handle(request);
        },
        {
          requestId,
          details: { method: request.method, path: new URL(request.url).pathname },
        },
      ).catch((error: unknown) => responseError(error));
      const path = new URL(request.url).pathname;
      const token = readSessionCookie(request.headers.get("cookie"));
      if (token === undefined || path === `${AUTH_PATH}/logout`) return response;
      try {
        const rotated = await (await runtime()).sessions.rotate(token);
        const headers = new Headers(response.headers);
        headers.append("set-cookie", rotated.cookie);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return response;
      }
    },

    async editorState(request, path = ""): Promise<HostedEditorState> {
      const cookieHeader =
        typeof request === "string"
          ? request
          : request === null
            ? null
            : request.headers.get("cookie");
      try {
        const current = await runtime();
        const token = readSessionCookie(cookieHeader);
        if (token === undefined) {
          return {
            authenticated: false,
            loginUrl: `${AUTH_PATH}/start`,
            projectName: options.projectName,
          };
        }
        const session: SessionRecord = await current.sessions.read(token);
        const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
        if (segments[0] === "team") {
          const directory = await current.application.readTeamDirectory.execute({
            actor: session.actor,
            requestId: `req_${globalThis.crypto.randomUUID()}`,
          });
          return {
            authenticated: true,
            view: "team",
            actor: session.actor,
            organization: options.repository.owner,
            members: directory.members,
            teams: directory.teams,
            customRoles: current.config.customRoles,
            mainRevision: (await current.git.resolveRef(mainBranch)).sha,
            csrfToken: session.csrfSecret,
            projectName: options.projectName,
          };
        }
        const changeId =
          segments[0] === "changes" && segments[1] !== undefined ? segments[1] : undefined;
        if (changeId === undefined) {
          const [changes, releases, pointers, assets, stagingBatch] = await Promise.all([
            current.listChanges(session.actor),
            current.listReleases(),
            current.listPointers(),
            current.listAssets(),
            current.application.readStagingBatch.execute({
              actor: session.actor,
              requestId: `req_${globalThis.crypto.randomUUID()}`,
            }),
          ]);
          const requestedOverview = segments[0];
          const view =
            requestedOverview === "staging" ||
            requestedOverview === "releases" ||
            requestedOverview === "assets" ||
            requestedOverview === "settings" ||
            requestedOverview === "developer"
              ? requestedOverview
              : "dashboard";
          return {
            authenticated: true,
            view,
            actor: session.actor,
            changes,
            releases,
            pointers,
            assets,
            stagingRevision: stagingBatch.revision,
            ...(stagingBatch.lock === undefined ? {} : { stagingLock: stagingBatch.lock }),
            registryDigest: current.config.registryDigest,
            stagingUrl: options.environment.CMS_STAGING_SITE_URL ?? options.origin,
            productionUrl: options.environment.CMS_PRODUCTION_SITE_URL ?? options.origin,
            csrfToken: session.csrfSecret,
            projectName: options.projectName,
          };
        }
        const change = await current.getChange(changeId, session.actor);
        const summaries = await current.content.listDocuments({
          ref: current.contentRef(change),
        });
        const requestedDocumentId =
          segments[2] !== undefined && segments[3] !== undefined
            ? (segments[3] as DocumentId)
            : undefined;
        const documentId =
          requestedDocumentId ??
          summaries.items.find((summary) => summary.id === homeDocumentId)?.id ??
          summaries.items[0]?.id;
        if (documentId === undefined) {
          throw new CmsError({
            code: "CMS_DOCUMENT_404",
            message: "This Change does not contain any documents.",
            category: "validation",
            retryable: false,
          });
        }
        const document = (await current.content.readDocument({
          ref: current.contentRef(change),
          documentId,
        })) as ContentDocument<HostedEditablePage>;
        const contentDocuments = await Promise.all(
          summaries.items.map((summary) =>
            current.content.readDocument({
              ref: current.contentRef(change),
              documentId: summary.id,
            }),
          ),
        );
        const previewDocument =
          (contentDocuments.find((candidate) => candidate.type === "pages") as
            ContentDocument<HostedEditablePage> | undefined) ?? document;
        const workspaceContext = {
          actor: session.actor,
          requestId: `req_${globalThis.crypto.randomUUID()}`,
        };
        const [
          baseDocument,
          productionDocument,
          baseContentDocuments,
          comments,
          checks,
          assignment,
          assets,
          timeline,
          conflictState,
        ] = await Promise.all([
          current.content
            .readDocument({ ref: change.baseCommit, documentId })
            .catch(() => undefined),
          current.content.readDocument({ ref: mainBranch, documentId }).catch(() => undefined),
          Promise.all(
            summaries.items.map((summary) =>
              current.content
                .readDocument({ ref: change.baseCommit, documentId: summary.id })
                .catch(() => undefined),
            ),
          ),
          change.pullRequestNumber === undefined
            ? Promise.resolve([])
            : current.review.listComments(change.pullRequestNumber).catch(() => []),
          current.review.listChecks(document.revision).catch(() => []),
          change.pullRequestNumber === undefined
            ? Promise.resolve({ users: [], teams: [] })
            : current.review
                .listReviewers(change.pullRequestNumber)
                .catch(() => ({ users: [], teams: [] })),
          current.listAssets(),
          current.application.readAuditTimeline
            .execute({ resourceId: change.id, limit: 100 }, workspaceContext)
            .catch(() => []),
          current.application.readChangeConflicts
            .execute({ change }, workspaceContext)
            .catch(() => ({ conflicts: [], stagingRevision: change.baseCommit })),
        ]);
        const changedDocumentIds = contentDocuments
          .filter((candidate, index) => {
            const base = baseContentDocuments[index];
            return base === undefined || canonicalJson(base.data) !== canonicalJson(candidate.data);
          })
          .map((candidate) => candidate.id);
        const referenceGraph = buildReferenceGraph(
          contentDocuments.map((candidate) => ({
            id: candidate.id,
            type: candidate.type,
            title:
              typeof candidate.data === "object" &&
              candidate.data !== null &&
              !Array.isArray(candidate.data) &&
              typeof (candidate.data as Readonly<Record<string, unknown>>).title === "string"
                ? ((candidate.data as Readonly<Record<string, unknown>>).title as string)
                : candidate.id,
            path: candidate.id,
            value: candidate.data,
          })),
        );
        const changedIds = new Set(changedDocumentIds);
        return {
          authenticated: true,
          view: "workspace",
          actor: session.actor,
          change,
          document,
          ...(baseDocument === undefined
            ? {}
            : { baseDocument: baseDocument as ContentDocument<HostedEditablePage> }),
          ...(productionDocument === undefined
            ? {}
            : { productionDocument: productionDocument as ContentDocument<HostedEditablePage> }),
          conflicts: conflictState.conflicts,
          documents: summaries.items,
          contentDocuments,
          previewDocument,
          assets,
          review: {
            comments,
            checks,
            assignment,
            timeline,
            summary: {
              changedDocumentIds,
              affectedUsages: referenceGraph.edges.filter((edge) =>
                changedIds.has(edge.targetId as DocumentId),
              ).length,
              warnings: referenceGraph.broken.length,
            },
          },
          translationProviderAvailable:
            options.environment.CMS_TRANSLATION_PROVIDER_URL !== undefined,
          registryDigest: current.config.registryDigest,
          csrfToken: session.csrfSecret,
          projectName: options.projectName,
        };
      } catch {
        return {
          authenticated: false,
          loginUrl: `${AUTH_PATH}/start`,
          projectName: options.projectName,
        };
      }
    },
  };
}
