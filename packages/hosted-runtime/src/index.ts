import { S3Client } from "@aws-sdk/client-s3";
import {
  createCmsApplication,
  type AuditEvent,
  type AuditSink,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type SessionRecord,
} from "@git-native-cms/application";
import {
  createGitHubOAuthAttempt,
  csrfMatches,
  exchangeGitHubOAuthCode,
  revokeGitHubOAuthToken,
  verifyOAuthState,
  type OAuthAttempt,
} from "@git-native-cms/auth";
import { yamlCodec } from "@git-native-cms/content-codecs";
import { GitContentRepository } from "@git-native-cms/content-repository";
import {
  CmsError,
  createPrefixedId,
  isoTimestamp,
  type Actor,
  type ActorId,
  type Change,
  type ChangeId,
  type ContentDocument,
  type DocumentId,
  type RoleName,
} from "@git-native-cms/core";
import { S3ReleaseStore } from "@git-native-cms/delivery";
import {
  createGitHubAppRequester,
  GitHubGitProvider,
  GitHubReviewPort,
} from "@git-native-cms/github";
import { MemoryWebhookReplayStore, receiveSignedWebhook } from "@git-native-cms/integrations";
import { AuthorizationService } from "@git-native-cms/permissions";
import { createCmsServer, type CmsServer } from "@git-native-cms/server";
import { readSessionCookie, RotatingCookieSessionService } from "@git-native-cms/sessions";
import { EncryptJWT, jwtDecrypt } from "jose";

const AUTH_PATH = "/api/cms/auth/github";
const WEBHOOK_PATH = "/api/cms/webhooks/github";
const HOME_DOCUMENT_ID = "doc_home" as DocumentId;

export interface HostedRuntimeEnvironment {
  readonly [key: string]: string | undefined;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET?: string;
  readonly GITHUB_WEBHOOK_SECRET?: string;
  readonly CMS_SESSION_SECRET?: string;
  readonly CMS_S3_ENDPOINT?: string;
  readonly CMS_S3_REGION?: string;
  readonly CMS_S3_ACCESS_KEY_ID?: string;
  readonly CMS_S3_SECRET_ACCESS_KEY?: string;
  readonly CMS_RELEASES_BUCKET?: string;
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
      readonly actor: Actor;
      readonly change: Change;
      readonly document: ContentDocument<HostedEditablePage>;
      readonly csrfToken: string;
      readonly projectName: string;
    };

export interface HostedCmsRuntime {
  handle(request: Request): Promise<Response>;
  editorState(request: Request | string | null): Promise<HostedEditorState>;
}

interface RuntimeConfiguration {
  readonly appId: number;
  readonly privateKey: string;
  readonly installationId: number;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly webhookSecret: string;
  readonly sessionSecret: string;
}

interface GitHubIdentity {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
  readonly permissions: Readonly<Record<string, boolean>>;
}

interface InitializedRuntime {
  readonly server: CmsServer;
  readonly sessions: RotatingCookieSessionService;
  readonly ensureChange: (actor: Actor) => Promise<Change>;
  readonly content: GitContentRepository;
  readonly config: RuntimeConfiguration;
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
  return {
    appId,
    privateKey: required(environment, "GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n"),
    installationId,
    oauthClientId: required(environment, "GITHUB_OAUTH_CLIENT_ID"),
    oauthClientSecret: required(environment, "GITHUB_OAUTH_CLIENT_SECRET"),
    webhookSecret: required(environment, "GITHUB_WEBHOOK_SECRET"),
    sessionSecret: required(environment, "CMS_SESSION_SECRET"),
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

class RuntimeAuditSink implements AuditSink {
  readonly recent: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.recent.push(event);
    if (this.recent.length > 500) this.recent.shift();
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

async function githubIdentity(accessToken: string): Promise<GitHubIdentity> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": "2022-11-28",
  };
  const [userResponse, repositoryResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers, redirect: "error" }),
    fetch("https://api.github.com/repos/DMTcorp/git-native-cms-sandbox-content", {
      headers,
      redirect: "error",
    }),
  ]);
  if (!userResponse.ok || !repositoryResponse.ok) {
    throw new CmsError({
      code: "CMS_AUTH_009",
      message: "Your GitHub account cannot access the sandbox content repository.",
      category: "authorization",
      retryable: false,
    });
  }
  const user = (await userResponse.json()) as Record<string, unknown>;
  const repository = (await repositoryResponse.json()) as Record<string, unknown>;
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new Error("GitHub returned an invalid user profile.");
  }
  const permissionValue = repository.permissions;
  const permissions =
    typeof permissionValue === "object" && permissionValue !== null
      ? (permissionValue as Readonly<Record<string, boolean>>)
      : {};
  return {
    id: user.id,
    login: user.login,
    ...(typeof user.name === "string" ? { name: user.name } : {}),
    permissions,
  };
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

export function createHostedCmsRuntime(options: {
  readonly origin: string;
  readonly projectName: string;
  readonly environment: HostedRuntimeEnvironment;
}): HostedCmsRuntime {
  let initialized: Promise<InitializedRuntime> | undefined;
  const replayStore = new MemoryWebhookReplayStore();

  const initialize = async (): Promise<InitializedRuntime> => {
    const config = configuration(options.environment);
    const requester = await createGitHubAppRequester({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    });
    const git = new GitHubGitProvider({
      requester,
      owner: "DMTcorp",
      repository: "git-native-cms-sandbox-content",
    });
    const content = new GitContentRepository(git);
    const clock = new SystemClock();
    const ids = new RuntimeIds();
    const sessions = new RotatingCookieSessionService(config.sessionSecret, {
      secure: true,
      revokeGitHubToken: (accessToken) =>
        revokeGitHubOAuthToken({
          clientId: config.oauthClientId,
          clientSecret: config.oauthClientSecret,
          accessToken,
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
      s3 === undefined
        ? undefined
        : new S3ReleaseStore({
            client: s3,
            bucket: options.environment.CMS_RELEASES_BUCKET as string,
          });
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock,
      ids,
      idempotency: new RuntimeIdempotencyStore(),
      audit: new RuntimeAuditSink(),
      review: new GitHubReviewPort({
        requester,
        owner: "DMTcorp",
        repository: "git-native-cms-sandbox-content",
      }),
      ...(releaseStore === undefined ? {} : { releaseStore }),
    });

    const ensureChange = async (actor: Actor): Promise<Change> => {
      const branchName = `cms/${safeLogin(actor.login)}/sandbox`;
      const existing = await git.readFile({ ref: branchName, path: ".cms/change.yaml" });
      const decoded =
        existing === undefined ? undefined : changeFrom(yamlCodec.parse(existing.content));
      if (decoded !== undefined) return decoded;
      const main = await git.resolveRef("main");
      const branch = await git.createBranch({
        branch: branchName,
        from: main.sha,
      });
      const now = isoTimestamp(clock.now());
      const change: Change = {
        id: ids.changeId(),
        name: "Sandbox editorial change",
        description: "A real Git-backed Change created by the public hosted playground.",
        ownerId: actor.id,
        baseBranch: "main",
        baseCommit: main.sha,
        branchName,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await git.commitFiles({
          branch: branchName,
          expectedSha: branch.sha,
          files: [{ path: ".cms/change.yaml", content: yamlCodec.serialize(change) }],
          message: `Create hosted sandbox Change\n\nChange-ID: ${change.id}`,
          author: actor,
          idempotencyKey: `sandbox:${actor.id}:metadata`,
        });
        return change;
      } catch (error) {
        const raced = await git.readFile({ ref: branchName, path: ".cms/change.yaml" });
        const racedChange =
          raced === undefined ? undefined : changeFrom(yamlCodec.parse(raced.content));
        if (racedChange !== undefined) return racedChange;
        throw error;
      }
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
      queries: {
        bootstrap: async (context) => ({
          actor: context.actor,
          project: {
            name: options.projectName,
            repository: "DMTcorp/git-native-cms-sandbox-content",
            locales: ["en-US", "pl-PL"],
          },
          capabilities: {
            preview: true,
            github: true,
            releases: releaseStore !== undefined,
          },
        }),
        listChanges: async (context) => [await ensureChange(context.actor)],
        getChange: async (id, context) => {
          const change = await ensureChange(context.actor);
          if (change.id !== id) {
            throw new CmsError({
              code: "CMS_CHANGE_404",
              message: "Change was not found.",
              category: "validation",
              retryable: false,
            });
          }
          return change;
        },
        listDocuments: async (changeId, context) => {
          const change = await ensureChange(context.actor);
          if (change.id !== changeId) {
            throw new CmsError({
              code: "CMS_CHANGE_404",
              message: "Change was not found.",
              category: "validation",
              retryable: false,
            });
          }
          return content.listDocuments({ ref: change.branchName });
        },
        listReleases: async () => [],
      },
    });
    return { server, sessions, ensureChange, content, config };
  };

  const runtime = (): Promise<InitializedRuntime> => (initialized ??= initialize());

  return {
    async handle(request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const current = await runtime();
        if (request.method === "GET" && url.pathname === `${AUTH_PATH}/start`) {
          const callbackUrl = `${options.origin}${AUTH_PATH}/callback`;
          const attempt = await createGitHubOAuthAttempt({
            clientId: current.config.oauthClientId,
            callbackUrl,
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
            signal: request.signal,
          });
          const identity = await githubIdentity(token.accessToken);
          const actor: Actor = {
            id: actorId(identity.id),
            githubId: identity.id,
            login: identity.login,
            displayName: identity.name ?? identity.login,
            roles: rolesFor(identity.permissions),
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
            replayStore,
          });
          return Response.json(
            { accepted: true, event: request.headers.get("x-github-event"), action: event.action },
            { status: 202 },
          );
        }
        return await current.server.handle(request);
      } catch (error) {
        return responseError(error);
      }
    },

    async editorState(request): Promise<HostedEditorState> {
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
        const change = await current.ensureChange(session.actor);
        const document = (await current.content.readDocument({
          ref: change.branchName,
          documentId: HOME_DOCUMENT_ID,
        })) as ContentDocument<HostedEditablePage>;
        return {
          authenticated: true,
          actor: session.actor,
          change,
          document,
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
