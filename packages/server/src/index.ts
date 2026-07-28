import type {
  CmsApplication,
  Asset,
  ChangeConflictResolution,
  ContentScheduleAction,
  DocumentSummary,
  Page,
  RateLimitPort,
  RequestContext,
  StoredRelease,
} from "@git-native-cms/application";
import {
  CmsError,
  isCmsError,
  type Actor,
  type AssetId,
  type Change,
  type ContentDocument,
  type DocumentId,
  type GitCommitSha,
  type ReleaseId,
  type RoleName,
} from "@git-native-cms/core";
import { createEnvelope } from "@git-native-cms/protocol";
import { httpOperationForRequest, isHttpPayload } from "@git-native-cms/protocol/http";

export interface CmsServerQueries {
  bootstrap(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  staging(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  listChanges(context: RequestContext): Promise<readonly Change[]>;
  getChange(id: string, context: RequestContext): Promise<Change>;
  listDocuments(changeId: string, context: RequestContext): Promise<Page<DocumentSummary>>;
  getDocument(
    changeId: string,
    documentId: DocumentId,
    context: RequestContext,
  ): Promise<ContentDocument>;
  listReleases(context: RequestContext): Promise<readonly StoredRelease[]>;
  listAssets(context: RequestContext): Promise<Page<Asset>>;
  getAsset(id: AssetId, context: RequestContext): Promise<Asset>;
  assetUsages(id: AssetId, context: RequestContext): Promise<readonly string[]>;
  search(
    changeId: string,
    query: string,
    context: RequestContext,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  findUsages(
    changeId: string,
    referenceId: string,
    context: RequestContext,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  exportTranslation(
    changeId: string,
    documentId: DocumentId,
    targetLocale: string,
    context: RequestContext,
  ): Promise<string>;
}

export interface CmsServerOptions {
  readonly application: CmsApplication;
  readonly queries: CmsServerQueries;
  readonly actorForRequest: (request: Request) => Promise<Actor | undefined>;
  readonly verifyCsrf: (request: Request, actor: Actor) => Promise<boolean>;
  readonly basePath?: string;
  readonly allowedOrigins?: readonly string[];
  readonly verifyConfirmation?: (
    token: string | undefined,
    action: "publish" | "rollback",
    actor: Actor,
  ) => Promise<boolean>;
  readonly rateLimit?: RateLimitPort;
  readonly onError?: (
    error: unknown,
    context: {
      readonly requestId: string;
      readonly method: string;
      readonly path: string;
    },
  ) => void;
}

function json(
  type: string,
  payload: unknown,
  status: number,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(createEnvelope(type, payload, { requestId }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      ...extraHeaders,
    },
  });
}

function errorStatus(error: CmsError): number {
  switch (error.category) {
    case "authentication":
      return 401;
    case "authorization":
      return 403;
    case "validation":
      return error.code.endsWith("_404") ? 404 : 400;
    case "conflict":
      return 409;
    case "configuration":
      return 503;
    case "network":
    case "git":
    case "storage":
      return error.retryable ? 503 : 502;
    case "internal":
      return 500;
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const maximumBytes = 1_048_576;
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CmsError({
      code: "CMS_REQUEST_008",
      message: "Mutation requests must use application/json.",
      category: "validation",
      retryable: false,
    });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CmsError({
      code: "CMS_REQUEST_006",
      message: "The request body is too large.",
      category: "validation",
      retryable: false,
    });
  }
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > maximumBytes) {
    throw new CmsError({
      code: "CMS_REQUEST_006",
      message: "The request body is too large.",
      category: "validation",
      retryable: false,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new CmsError({
      code: "CMS_REQUEST_001",
      message: "The request body must contain valid JSON.",
      category: "validation",
      retryable: false,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_REQUEST_001",
      message: "The request body must be a JSON object.",
      category: "validation",
      retryable: false,
    });
  }
  assertSafeJson(value);
  const operation = httpOperationForRequest(request.method, new URL(request.url).pathname);
  if (operation !== undefined && !isHttpPayload(operation, value)) {
    throw new CmsError({
      code: "CMS_REQUEST_009",
      message: `The request payload does not match the ${operation} protocol schema.`,
      category: "validation",
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
}

async function assetBody(request: Request): Promise<Uint8Array> {
  const maximumBytes = 25 * 1024 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CmsError({
      code: "CMS_ASSET_001",
      message: "The asset upload exceeds the 25 MiB API limit.",
      category: "validation",
      retryable: false,
    });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new CmsError({
      code: "CMS_ASSET_001",
      message: "The asset upload is empty or exceeds the 25 MiB API limit.",
      category: "validation",
      retryable: false,
    });
  }
  return bytes;
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 64) {
    throw new CmsError({
      code: "CMS_REQUEST_007",
      message: "The request body is nested too deeply.",
      category: "validation",
      retryable: false,
    });
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new CmsError({
        code: "CMS_REQUEST_007",
        message: "The request body contains too many list items.",
        category: "validation",
        retryable: false,
      });
    }
    for (const child of value) assertSafeJson(child, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new CmsError({
        code: "CMS_REQUEST_007",
        message: "The request body contains a protected object key.",
        category: "validation",
        retryable: false,
      });
    }
    assertSafeJson(child, depth + 1);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CmsError({
      code: "CMS_REQUEST_002",
      message: `${name} is required.`,
      category: "validation",
      retryable: false,
    });
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CmsError({
      code: "CMS_REQUEST_003",
      message: `${name} must be a positive integer.`,
      category: "validation",
      retryable: false,
    });
  }
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") !== true || authorization.length <= 7) {
    throw new CmsError({
      code: "CMS_PREVIEW_006",
      message: "A preview session bearer token is required.",
      category: "authentication",
      retryable: false,
    });
  }
  return authorization.slice(7);
}

function optionalNullableString(
  input: Readonly<Record<string, unknown>>,
  name: string,
): string | null | undefined {
  if (!Object.hasOwn(input, name)) return undefined;
  const value = input[name];
  if (value === null || typeof value === "string") return value;
  throw new CmsError({
    code: "CMS_REQUEST_005",
    message: `${name} must be a string or null.`,
    category: "validation",
    retryable: false,
  });
}

function optionalFocalPoint(
  input: Readonly<Record<string, unknown>>,
): { readonly x: number; readonly y: number } | null | undefined {
  if (!Object.hasOwn(input, "focalPoint")) return undefined;
  const value = input.focalPoint;
  if (value === null) return null;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.x === "number" && typeof record.y === "number") {
      return { x: record.x, y: record.y };
    }
  }
  throw new CmsError({
    code: "CMS_REQUEST_005",
    message: "focalPoint must contain numeric x and y coordinates or be null.",
    category: "validation",
    retryable: false,
  });
}

function storedRelease(value: unknown): StoredRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_REQUEST_004",
      message: "release must be an immutable release object.",
      category: "validation",
      retryable: false,
    });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.manifest !== "object" ||
    record.manifest === null ||
    typeof record.files !== "object" ||
    record.files === null
  ) {
    throw new CmsError({
      code: "CMS_REQUEST_004",
      message: "release must contain id, manifest, and files.",
      category: "validation",
      retryable: false,
    });
  }
  return record as unknown as StoredRelease;
}

function pathAfterBase(url: URL, basePath: string): readonly string[] {
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length)
    : url.pathname;
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

export interface CmsServer {
  handle(request: Request): Promise<Response>;
}

export function createCmsServer(options: CmsServerOptions): CmsServer {
  const basePath = options.basePath ?? "/api/cms";
  return {
    async handle(request): Promise<Response> {
      const requestId = request.headers.get("x-request-id") ?? globalThis.crypto.randomUUID();
      try {
        const url = new URL(request.url);
        const origin = request.headers.get("origin");
        if (
          origin !== null &&
          options.allowedOrigins !== undefined &&
          !options.allowedOrigins.includes(origin)
        ) {
          throw new CmsError({
            code: "CMS_AUTH_006",
            message: "This origin is not allowed to access the CMS.",
            category: "authorization",
            retryable: false,
          });
        }
        const actor = await options.actorForRequest(request);
        if (actor === undefined) {
          return json(
            "error",
            {
              error: {
                code: "CMS_AUTH_004",
                message: "Sign in to continue.",
                category: "authentication",
                retryable: false,
              },
            },
            401,
            requestId,
          );
        }
        const rateScope = ["GET", "HEAD", "OPTIONS"].includes(request.method)
          ? "cms.read"
          : "cms.mutation";
        const rate = await options.rateLimit?.consume({
          key: actor.id,
          scope: rateScope,
          limit: rateScope === "cms.read" ? 600 : 120,
          windowMs: 60_000,
          now: new Date().toISOString(),
        });
        if (rate?.allowed === false) {
          const retryAfter = Math.max(
            1,
            Math.ceil((new Date(rate.resetAt).getTime() - Date.now()) / 1000),
          );
          return json(
            "error",
            {
              error: {
                code: "CMS_RATE_LIMIT_001",
                message: "Too many CMS requests. Retry after the current window.",
                category: "authorization",
                retryable: true,
              },
            },
            429,
            requestId,
            { "retry-after": String(retryAfter) },
          );
        }
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          !(await options.verifyCsrf(request, actor))
        ) {
          throw new CmsError({
            code: "CMS_AUTH_005",
            message: "The security token expired. Refresh the page and try again.",
            category: "authentication",
            retryable: true,
          });
        }
        const context: RequestContext = {
          actor,
          requestId,
          signal: request.signal,
        };
        const segments = pathAfterBase(url, basePath);

        if (
          request.method === "PUT" &&
          segments[0] === "assets" &&
          segments[1] === "uploads" &&
          segments[2] !== undefined &&
          segments[3] === "content"
        ) {
          const mimeType = request.headers.get("content-type")?.split(";")[0]?.trim();
          if (mimeType === undefined || mimeType.length === 0) {
            throw new CmsError({
              code: "CMS_ASSET_002",
              message: "An asset media type is required.",
              category: "validation",
              retryable: false,
            });
          }
          await options.application.receiveAssetUpload.execute(
            {
              uploadId: segments[2],
              bytes: await assetBody(request),
              mimeType,
              ...(request.headers.get("x-cms-upload-token") === null
                ? {}
                : { token: request.headers.get("x-cms-upload-token") as string }),
            },
            context,
          );
          return new Response(null, {
            status: 204,
            headers: { "cache-control": "no-store", "x-request-id": requestId },
          });
        }

        if (request.method === "GET" && segments.join("/") === "bootstrap") {
          return json("bootstrap", await options.queries.bootstrap(context), 200, requestId);
        }
        if (request.method === "GET" && segments.join("/") === "staging") {
          const [staging, batch] = await Promise.all([
            options.queries.staging(context),
            options.application.readStagingBatch.execute(context),
          ]);
          return json("staging", { ...staging, batch }, 200, requestId);
        }
        if (request.method === "GET" && segments.join("/") === "team") {
          return json(
            "team.directory",
            await options.application.readTeamDirectory.execute(context),
            200,
            requestId,
          );
        }
        if (request.method === "POST" && segments.join("/") === "team/invitations") {
          const input = await body(request);
          const role = typeof input.role === "string" ? input.role : "direct_member";
          if (role !== "direct_member" && role !== "admin") {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "role must be direct_member or admin.",
              category: "validation",
              retryable: false,
            });
          }
          const invitation = await options.application.inviteTeamMember.execute(
            {
              ...(typeof input.email === "string" ? { email: input.email } : {}),
              ...(typeof input.inviteeId === "number" ? { inviteeId: input.inviteeId } : {}),
              role,
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("team.member-invited", { invitation }, 201, requestId);
        }
        if (
          request.method === "PUT" &&
          segments[0] === "team" &&
          segments[1] === "teams" &&
          segments[2] !== undefined &&
          segments[3] === "members" &&
          segments[4] !== undefined
        ) {
          const input = await body(request);
          const role = typeof input.role === "string" ? input.role : "member";
          if (role !== "member" && role !== "maintainer") {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "role must be member or maintainer.",
              category: "validation",
              retryable: false,
            });
          }
          await options.application.addTeamMember.execute(
            {
              teamSlug: segments[2],
              username: segments[4],
              role,
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json(
            "team.member-added",
            { team: segments[2], username: segments[4], role },
            200,
            requestId,
          );
        }
        if (request.method === "PUT" && segments.join("/") === "team/role-mappings") {
          const input = await body(request);
          if (!Array.isArray(input.mappings)) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "mappings must be an array.",
              category: "validation",
              retryable: false,
            });
          }
          const mappings = input.mappings.map((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "Each mapping must be an object.",
                category: "validation",
                retryable: false,
              });
            }
            const mapping = value as Readonly<Record<string, unknown>>;
            if (
              typeof mapping.team !== "string" ||
              !Array.isArray(mapping.roles) ||
              !mapping.roles.every((role) => typeof role === "string")
            ) {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "Each mapping requires a team and string roles.",
                category: "validation",
                retryable: false,
              });
            }
            return { team: mapping.team, roles: mapping.roles as readonly RoleName[] };
          });
          const customRoles =
            input.customRoles === undefined
              ? undefined
              : Array.isArray(input.customRoles)
                ? input.customRoles.map((value) => {
                    if (typeof value !== "object" || value === null || Array.isArray(value)) {
                      throw new CmsError({
                        code: "CMS_REQUEST_005",
                        message: "Each custom role must be an object.",
                        category: "validation",
                        retryable: false,
                      });
                    }
                    const role = value as Readonly<Record<string, unknown>>;
                    if (
                      typeof role.name !== "string" ||
                      !Array.isArray(role.actions) ||
                      !role.actions.every((action) => typeof action === "string")
                    ) {
                      throw new CmsError({
                        code: "CMS_REQUEST_005",
                        message: "Each custom role requires a name and string actions.",
                        category: "validation",
                        retryable: false,
                      });
                    }
                    return { name: role.name, actions: role.actions };
                  })
                : (() => {
                    throw new CmsError({
                      code: "CMS_REQUEST_005",
                      message: "customRoles must be an array.",
                      category: "validation",
                      retryable: false,
                    });
                  })();
          const result = await options.application.updateTeamRoleMappings.execute(
            {
              mappings,
              ...(customRoles === undefined ? {} : { customRoles }),
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("team.role-mappings-updated", result, 200, requestId);
        }
        if (request.method === "POST" && segments.join("/") === "preview/sessions") {
          const input = await body(request);
          const change = await options.queries.getChange(
            requiredString(input.changeId, "changeId"),
            context,
          );
          const session = await options.application.createPreviewSession.execute(
            {
              change,
              frontendRef: requiredString(input.frontendRef, "frontendRef"),
              locale: requiredString(input.locale, "locale"),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("preview.session-created", { session }, 201, requestId, {
            location: `${basePath}/preview/sessions/${session.id}`,
          });
        }
        if (
          request.method === "GET" &&
          segments[0] === "preview" &&
          segments[1] === "sessions" &&
          segments[2] !== undefined &&
          segments.length === 3
        ) {
          const session = await options.application.readPreviewSession.execute(
            { id: segments[2], token: bearerToken(request) },
            context,
          );
          return json("preview.session", { session }, 200, requestId);
        }
        if (
          request.method === "POST" &&
          segments[0] === "preview" &&
          segments[1] === "sessions" &&
          segments[2] !== undefined &&
          segments[3] === "refresh" &&
          segments.length === 4
        ) {
          const input = await body(request);
          const session = await options.application.refreshPreviewSession.execute(
            {
              id: segments[2],
              token: bearerToken(request),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("preview.session-refreshed", { session }, 200, requestId, {
            location: `${basePath}/preview/sessions/${session.id}`,
          });
        }
        if (request.method === "GET" && segments.join("/") === "changes") {
          return json(
            "changes.list",
            { items: await options.queries.listChanges(context) },
            200,
            requestId,
          );
        }
        if (request.method === "POST" && segments.join("/") === "changes") {
          const input = await body(request);
          const collaborators =
            input.collaborators === undefined
              ? undefined
              : Array.isArray(input.collaborators) &&
                  input.collaborators.every((value) => typeof value === "string")
                ? (input.collaborators as readonly string[])
                : null;
          if (collaborators === null) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "collaborators must be an array of GitHub usernames or team:slug values.",
              category: "validation",
              retryable: false,
            });
          }
          const change = await options.application.createChange.execute(
            {
              name: requiredString(input.name, "name"),
              ...(typeof input.description === "string" ? { description: input.description } : {}),
              ...(typeof input.baseBranch === "string" ? { baseBranch: input.baseBranch } : {}),
              ...(collaborators === undefined ? {} : { collaborators }),
              ...(typeof input.targetDate === "string" ? { targetDate: input.targetDate } : {}),
              ...(input.emergency === true ? { emergency: true } : {}),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("change.created", { change }, 201, requestId, {
            location: `${basePath}/changes/${change.id}`,
          });
        }
        if (segments[0] === "changes" && segments[1] !== undefined) {
          const change = await options.queries.getChange(segments[1], context);
          if (request.method === "GET" && segments.length === 2) {
            return json("change", { change }, 200, requestId);
          }
          if (request.method === "GET" && segments[2] === "audit" && segments.length === 3) {
            const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
            return json(
              "change.audit",
              {
                items: await options.application.readAuditTimeline.execute(
                  {
                    resourceId: change.id,
                    limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
                  },
                  context,
                ),
              },
              200,
              requestId,
            );
          }
          if (request.method === "PATCH" && segments.length === 2) {
            const input = await body(request);
            const description = optionalNullableString(input, "description");
            const result = await options.application.updateChange.execute(
              {
                change,
                ...(typeof input.name === "string" ? { name: input.name } : {}),
                ...(description === undefined ? {} : { description }),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.updated", result, 200, requestId);
          }
          if (request.method === "DELETE" && segments.length === 2) {
            const input = await body(request);
            const result = await options.application.deleteChange.execute(
              {
                change,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.deleted", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "commit" && segments.length === 3) {
            const input = await body(request);
            if (!Array.isArray(input.documents)) {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "documents must be an array of document patches.",
                category: "validation",
                retryable: false,
              });
            }
            const documents = input.documents.map((value) => {
              if (
                typeof value !== "object" ||
                value === null ||
                Array.isArray(value) ||
                typeof (value as Readonly<Record<string, unknown>>).documentId !== "string" ||
                !Array.isArray((value as Readonly<Record<string, unknown>>).patches)
              ) {
                throw new CmsError({
                  code: "CMS_REQUEST_005",
                  message: "Each committed document requires documentId and patches.",
                  category: "validation",
                  retryable: false,
                });
              }
              const record = value as Readonly<Record<string, unknown>>;
              return {
                documentId: record.documentId as DocumentId,
                patches: record.patches as never,
              };
            });
            const result = await options.application.commitChange.execute(
              {
                change,
                documents,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                ...(typeof input.message === "string" ? { message: input.message } : {}),
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.version-saved", result, 200, requestId);
          }
          if (request.method === "GET" && segments[2] === "documents" && segments.length === 3) {
            return json(
              "documents.list",
              await options.queries.listDocuments(change.id, context),
              200,
              requestId,
            );
          }
          if (
            request.method === "POST" &&
            segments[2] === "documents" &&
            segments[3] !== undefined &&
            segments[4] === "locales" &&
            segments[5] !== undefined &&
            segments[6] === "translation-jobs" &&
            segments.length === 7
          ) {
            const input = await body(request);
            const sourceLocale =
              typeof input.sourceLocale === "string" ? input.sourceLocale : "en-US";
            const result = await options.application.createTranslationJob.execute(
              {
                change,
                documentId: segments[3] as DocumentId,
                sourceLocale,
                targetLocale: segments[5],
                xliff: await options.queries.exportTranslation(
                  change.id,
                  segments[3] as DocumentId,
                  segments[5],
                  context,
                ),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("translation.job-created", result, 202, requestId, {
              location: `${basePath}/changes/${change.id}/documents/${segments[3]}/locales/${segments[5]}/translation-jobs/${result.jobId}`,
            });
          }
          if (
            request.method === "GET" &&
            segments[2] === "documents" &&
            segments[3] !== undefined &&
            segments[4] === "locales" &&
            segments[5] !== undefined &&
            segments[6] === "translation-jobs" &&
            segments[7] !== undefined &&
            segments.length === 8
          ) {
            return json(
              "translation.job",
              {
                job: await options.application.readTranslationJob.execute(
                  { change, jobId: segments[7] },
                  context,
                ),
              },
              200,
              requestId,
            );
          }
          if (
            request.method === "GET" &&
            segments[2] === "documents" &&
            segments[3] !== undefined &&
            segments[4] === "locales" &&
            segments[5] !== undefined &&
            segments[6] === "xliff"
          ) {
            return new Response(
              await options.queries.exportTranslation(
                change.id,
                segments[3] as DocumentId,
                segments[5],
                context,
              ),
              {
                status: 200,
                headers: {
                  "cache-control": "no-store",
                  "content-type": "application/xliff+xml; charset=utf-8",
                  "x-request-id": requestId,
                },
              },
            );
          }
          if (request.method === "GET" && segments[2] === "conflicts" && segments.length === 3) {
            return json(
              "change.conflicts",
              await options.application.readChangeConflicts.execute({ change }, context),
              200,
              requestId,
            );
          }
          if (
            request.method === "POST" &&
            segments[2] === "conflicts" &&
            segments[3] === "resolve" &&
            segments.length === 4
          ) {
            const input = await body(request);
            if (!Array.isArray(input.resolutions)) {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "resolutions must be an array.",
                category: "validation",
                retryable: false,
              });
            }
            const resolutions = input.resolutions.map((value, index) => {
              if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw new CmsError({
                  code: "CMS_REQUEST_005",
                  message: `resolutions[${String(index)}] must be an object.`,
                  category: "validation",
                  retryable: false,
                });
              }
              const resolution = value as Readonly<Record<string, unknown>>;
              if (typeof resolution.path !== "string") {
                throw new CmsError({
                  code: "CMS_REQUEST_005",
                  message: `resolutions[${String(index)}].path must be an RFC 6901 path.`,
                  category: "validation",
                  retryable: false,
                });
              }
              const choice = requiredString(
                resolution.choice,
                `resolutions[${String(index)}].choice`,
              );
              if (choice !== "change" && choice !== "staging") {
                throw new CmsError({
                  code: "CMS_REQUEST_005",
                  message: `resolutions[${String(index)}].choice must be change or staging.`,
                  category: "validation",
                  retryable: false,
                });
              }
              return {
                documentId: requiredString(
                  resolution.documentId,
                  `resolutions[${String(index)}].documentId`,
                ) as DocumentId,
                path: resolution.path as ChangeConflictResolution["path"],
                choice,
              } satisfies ChangeConflictResolution;
            });
            const result = await options.application.resolveChangeConflicts.execute(
              {
                change,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                resolutions,
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.conflicts-resolved", result, 200, requestId);
          }
          if (
            request.method === "POST" &&
            segments[2] === "documents" &&
            segments[3] !== undefined &&
            segments[4] === "locales" &&
            segments[5] !== undefined &&
            segments[6] === "xliff"
          ) {
            const input = await body(request);
            const document = await options.application.importTranslation.execute(
              {
                change,
                documentId: segments[3] as DocumentId,
                targetLocale: segments[5],
                xliff: requiredString(input.xliff, "xliff"),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("translation.imported", { document }, 200, requestId);
          }
          if (
            request.method === "GET" &&
            segments[2] === "documents" &&
            segments[3] !== undefined
          ) {
            return json(
              "document",
              {
                document: await options.queries.getDocument(
                  change.id,
                  segments[3] as DocumentId,
                  context,
                ),
              },
              200,
              requestId,
            );
          }
          if (request.method === "POST" && segments[2] === "documents" && segments.length === 3) {
            const input = await body(request);
            const schemaVersion = requiredNumber(input.schemaVersion, "schemaVersion");
            const document = await options.application.createDocument.execute(
              {
                change,
                type: requiredString(input.type, "type"),
                schemaVersion,
                data: input.data ?? {},
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("document.created", { document }, 201, requestId, {
              location: `${basePath}/changes/${change.id}/documents/${document.id}`,
            });
          }
          if (
            request.method === "PATCH" &&
            segments[2] === "documents" &&
            segments[3] !== undefined
          ) {
            const input = await body(request);
            const document = await options.application.updateDocument.execute(
              {
                change,
                documentId: segments[3] as DocumentId,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                patches: Array.isArray(input.patches) ? (input.patches as never) : [],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("document.updated", { document }, 200, requestId);
          }
          if (
            request.method === "DELETE" &&
            segments[2] === "documents" &&
            segments[3] !== undefined
          ) {
            const input = await body(request);
            const result = await options.application.deleteDocument.execute(
              {
                change,
                documentId: segments[3] as DocumentId,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("document.deleted", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "submit") {
            const input = await body(request);
            const result = await options.application.submitChange.execute(
              {
                change,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.submitted", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "comments" && segments.length === 3) {
            const input = await body(request);
            const comment = await options.application.reviewChange.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                body: requiredString(input.body, "body"),
                ...(typeof input.path === "string" ? { path: input.path } : {}),
                ...(typeof input.line === "number" ? { line: input.line } : {}),
              },
              context,
            );
            return json("review.comment", { comment }, 201, requestId);
          }
          if (
            request.method === "POST" &&
            segments[2] === "comments" &&
            segments[3] !== undefined &&
            segments[4] === "resolve" &&
            segments.length === 5
          ) {
            const input = await body(request);
            const comment = await options.application.resolveReviewComment.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                commentId: segments[3],
                resolved: input.resolved !== false,
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json(
              comment.resolved ? "review.thread-resolved" : "review.thread-reopened",
              { comment },
              200,
              requestId,
            );
          }
          if (request.method === "PUT" && segments[2] === "reviewers" && segments.length === 3) {
            const input = await body(request);
            if (
              !Array.isArray(input.users) ||
              !input.users.every((value) => typeof value === "string") ||
              !Array.isArray(input.teams) ||
              !input.teams.every((value) => typeof value === "string")
            ) {
              throw new CmsError({
                code: "CMS_REQUEST_005",
                message: "users and teams must be string arrays.",
                category: "validation",
                retryable: false,
              });
            }
            const assignment = await options.application.assignReviewers.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                users: input.users,
                teams: input.teams,
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("review.reviewers-assigned", { assignment }, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "approve") {
            const input = await body(request);
            const result = await options.application.approveChange.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
                ...(typeof input.body === "string" ? { body: input.body } : {}),
              },
              context,
            );
            return json("change.approved", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "request-changes") {
            const input = await body(request);
            const result = await options.application.requestChanges.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                body: requiredString(input.body, "body"),
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.changes-requested", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "archive") {
            const input = await body(request);
            const result = await options.application.archiveChange.execute(
              {
                change,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.archived", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "staging") {
            const input = await body(request);
            const result = await options.application.addChangeToStaging.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.staged", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "remove-from-staging") {
            const input = await body(request);
            const result = await options.application.removeChangeFromStaging.execute(
              {
                change,
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json("change.removed-from-staging", result, 200, requestId);
          }
          if (request.method === "POST" && segments[2] === "publish-emergency") {
            const input = await body(request);
            if (
              options.verifyConfirmation !== undefined &&
              !(await options.verifyConfirmation(
                typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
                "publish",
                actor,
              ))
            ) {
              throw new CmsError({
                code: "CMS_CONFIRMATION_001",
                message: "A valid Emergency Change publication confirmation is required.",
                category: "authorization",
                retryable: false,
              });
            }
            const result = await options.application.publishEmergencyChange.execute(
              {
                change,
                pullRequestNumber: requiredNumber(input.pullRequestNumber, "pullRequestNumber"),
                expectedRevision: requiredString(
                  input.expectedRevision,
                  "expectedRevision",
                ) as Change["baseCommit"],
                configVersion: requiredNumber(input.configVersion, "configVersion"),
                registryDigest: requiredString(input.registryDigest, "registryDigest"),
                schemaVersion: requiredNumber(input.schemaVersion, "schemaVersion"),
                ...(typeof input.expectedPointerRevision === "string"
                  ? { expectedPointerRevision: input.expectedPointerRevision }
                  : {}),
                idempotencyKey:
                  request.headers.get("idempotency-key") ??
                  requiredString(input.idempotencyKey, "idempotencyKey"),
              },
              context,
            );
            return json(
              "change.emergency-published",
              {
                change: result.change,
                revision: result.revision,
                stagingRevision: result.stagingRevision,
                releaseId: result.release.id,
                manifest: result.release.manifest,
              },
              200,
              requestId,
            );
          }
        }
        if (request.method === "POST" && segments.join("/") === "staging/publish") {
          const input = await body(request);
          if (
            options.verifyConfirmation !== undefined &&
            !(await options.verifyConfirmation(
              typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
              "publish",
              actor,
            ))
          ) {
            throw new CmsError({
              code: "CMS_CONFIRMATION_001",
              message: "A valid publication confirmation is required.",
              category: "authorization",
              retryable: false,
            });
          }
          const result = await options.application.publishStaging.execute(
            {
              expectedStagingRevision: requiredString(
                input.expectedStagingRevision,
                "expectedStagingRevision",
              ) as Change["baseCommit"],
              title: requiredString(input.title, "title"),
              configVersion: requiredNumber(input.configVersion, "configVersion"),
              registryDigest: requiredString(input.registryDigest, "registryDigest"),
              schemaVersion: requiredNumber(input.schemaVersion, "schemaVersion"),
              ...(typeof input.expectedPointerRevision === "string"
                ? { expectedPointerRevision: input.expectedPointerRevision }
                : {}),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json(
            "staging.published",
            {
              mainRevision: result.mainRevision,
              stagingRevision: result.stagingRevision,
              releaseId: result.release.id,
              manifest: result.release.manifest,
            },
            200,
            requestId,
          );
        }
        if (request.method === "POST" && segments.join("/") === "staging/lock") {
          const input = await body(request);
          if (
            !Array.isArray(input.checklist) ||
            !input.checklist.every((item) => typeof item === "string")
          ) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "checklist must be a list of completed release checks.",
              category: "validation",
              retryable: false,
            });
          }
          const result = await options.application.lockStagingBatch.execute(
            {
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as GitCommitSha,
              checklist: input.checklist,
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("staging.locked", result, 200, requestId);
        }
        if (request.method === "POST" && segments.join("/") === "staging/unlock") {
          const input = await body(request);
          const result = await options.application.unlockStagingBatch.execute(
            {
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("staging.unlocked", result, 200, requestId);
        }
        if (request.method === "POST" && segments.join("/") === "staging/promote") {
          const input = await body(request);
          const result = await options.application.promoteStaging.execute(
            {
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              title: requiredString(input.title, "title"),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("staging.promoted", result, 200, requestId);
        }
        if (request.method === "GET" && segments.join("/") === "releases") {
          return json(
            "releases.list",
            { items: await options.queries.listReleases(context) },
            200,
            requestId,
          );
        }
        if (request.method === "GET" && segments.join("/") === "assets") {
          return json("assets.list", await options.queries.listAssets(context), 200, requestId);
        }
        if (
          request.method === "GET" &&
          segments[0] === "assets" &&
          segments[1] !== undefined &&
          segments.length === 2
        ) {
          return json(
            "asset",
            { asset: await options.queries.getAsset(segments[1] as AssetId, context) },
            200,
            requestId,
          );
        }
        if (request.method === "GET" && segments.join("/") === "search") {
          const changeId = requiredString(url.searchParams.get("changeId"), "changeId");
          const query = requiredString(url.searchParams.get("q"), "q");
          return json(
            "search.results",
            { items: await options.queries.search(changeId, query, context) },
            200,
            requestId,
          );
        }
        if (request.method === "GET" && segments.join("/") === "search/usages") {
          const changeId = requiredString(url.searchParams.get("changeId"), "changeId");
          const referenceId = requiredString(url.searchParams.get("referenceId"), "referenceId");
          return json(
            "search.usages",
            { items: await options.queries.findUsages(changeId, referenceId, context) },
            200,
            requestId,
          );
        }
        if (request.method === "POST" && segments.join("/") === "schedules") {
          const input = await body(request);
          const action = requiredString(input.action, "action");
          if (
            ![
              "publish",
              "unpublish",
              "availability-start",
              "availability-end",
              "visibility-start",
              "visibility-end",
            ].includes(action)
          ) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message:
                "action must be publish, unpublish, availability-start/end or visibility-start/end.",
              category: "validation",
              retryable: false,
            });
          }
          const change = await options.queries.getChange(
            requiredString(input.changeId, "changeId"),
            context,
          );
          const result = await options.application.scheduleContent.execute(
            {
              change,
              action: action as ContentScheduleAction,
              documentIds: Array.isArray(input.documentIds)
                ? (input.documentIds.filter(
                    (value): value is string => typeof value === "string",
                  ) as DocumentId[])
                : [],
              executeAt: requiredString(input.executeAt, "executeAt"),
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("schedule.created", result, 201, requestId);
        }
        if (
          request.method === "POST" &&
          segments[0] === "schedules" &&
          segments[1] !== undefined &&
          segments[2] === "execute"
        ) {
          const input = await body(request);
          const result = await options.application.executeSchedule.execute(
            {
              scheduleId: segments[1],
              expectedAt: requiredString(input.expectedAt, "expectedAt"),
              configVersion: requiredNumber(input.configVersion, "configVersion"),
              registryDigest: requiredString(input.registryDigest, "registryDigest"),
              schemaVersion: requiredNumber(input.schemaVersion, "schemaVersion"),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("schedule.executed", result, 200, requestId);
        }
        if (request.method === "POST" && segments.join("/") === "assets/uploads") {
          const input = await body(request);
          const upload = await options.application.createAssetUpload.execute(
            {
              fileName: requiredString(input.fileName, "fileName"),
              mimeType: requiredString(input.mimeType, "mimeType"),
              size: requiredNumber(input.size, "size"),
              checksum: requiredString(input.checksum, "checksum"),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("asset.upload-created", upload, 201, requestId);
        }
        if (
          request.method === "POST" &&
          segments[0] === "assets" &&
          segments[1] === "uploads" &&
          segments[2] !== undefined &&
          segments[3] === "finalize"
        ) {
          const input = await body(request);
          const change = await options.queries.getChange(
            requiredString(input.changeId, "changeId"),
            context,
          );
          const result = await options.application.finalizeAssetUpload.execute(
            {
              change,
              uploadId: segments[2],
              checksum: requiredString(input.checksum, "checksum"),
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("asset.finalized", result, 200, requestId);
        }
        if (
          request.method === "GET" &&
          segments[0] === "assets" &&
          segments[1] !== undefined &&
          segments[2] === "usages"
        ) {
          const id = segments[1] as AssetId;
          return json(
            "asset.usages",
            { assetId: id, paths: await options.queries.assetUsages(id, context) },
            200,
            requestId,
          );
        }
        if (
          request.method === "PATCH" &&
          segments[0] === "assets" &&
          segments[1] !== undefined &&
          segments.length === 2
        ) {
          const input = await body(request);
          const change = await options.queries.getChange(
            requiredString(input.changeId, "changeId"),
            context,
          );
          const altText = optionalNullableString(input, "altText");
          const focalPoint = optionalFocalPoint(input);
          const result = await options.application.updateAsset.execute(
            {
              change,
              assetId: segments[1] as AssetId,
              ...(altText === undefined ? {} : { altText }),
              ...(focalPoint === undefined ? {} : { focalPoint }),
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("asset.updated", result, 200, requestId);
        }
        if (request.method === "DELETE" && segments[0] === "assets" && segments[1] !== undefined) {
          const input = await body(request);
          const change = await options.queries.getChange(
            requiredString(input.changeId, "changeId"),
            context,
          );
          const result = await options.application.deleteAsset.execute(
            {
              change,
              assetId: segments[1] as AssetId,
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("asset.deleted", result, 200, requestId);
        }
        if (request.method === "POST" && segments.join("/") === "releases/build-and-publish") {
          const input = await body(request);
          const environment = requiredString(input.environment, "environment");
          if (!["preview", "staging", "production"].includes(environment)) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "environment must be preview, staging, or production.",
              category: "validation",
              retryable: false,
            });
          }
          const release = await options.application.buildAndPublishRelease.execute(
            {
              ref: requiredString(input.ref, "ref"),
              expectedRevision: requiredString(
                input.expectedRevision,
                "expectedRevision",
              ) as Change["baseCommit"],
              environment: environment as "preview" | "staging" | "production",
              configVersion: requiredNumber(input.configVersion, "configVersion"),
              registryDigest: requiredString(input.registryDigest, "registryDigest"),
              schemaVersion: requiredNumber(input.schemaVersion, "schemaVersion"),
              ...(typeof input.expectedPointerRevision === "string"
                ? { expectedPointerRevision: input.expectedPointerRevision }
                : {}),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json(
            "release.built-and-published",
            { releaseId: release.id, manifest: release.manifest },
            200,
            requestId,
          );
        }
        if (request.method === "POST" && segments.join("/") === "releases/publish") {
          const input = await body(request);
          const environment = requiredString(input.environment, "environment");
          if (!["preview", "staging", "production"].includes(environment)) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "environment must be preview, staging, or production.",
              category: "validation",
              retryable: false,
            });
          }
          const release = storedRelease(input.release);
          await options.application.publishRelease.execute(
            {
              release,
              environment: environment as "preview" | "staging" | "production",
              ...(typeof input.expectedPointerRevision === "string"
                ? { expectedPointerRevision: input.expectedPointerRevision }
                : {}),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json("release.published", { releaseId: release.id, environment }, 200, requestId);
        }
        if (
          request.method === "POST" &&
          segments[0] === "releases" &&
          segments[1] !== undefined &&
          segments[2] === "revalidate"
        ) {
          const input = await body(request);
          const environment = requiredString(input.environment, "environment");
          if (!["preview", "staging", "production"].includes(environment)) {
            throw new CmsError({
              code: "CMS_REQUEST_005",
              message: "environment must be preview, staging, or production.",
              category: "validation",
              retryable: false,
            });
          }
          await options.application.revalidateRelease.execute(
            {
              releaseId: segments[1] as ReleaseId,
              environment: environment as "preview" | "staging" | "production",
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json(
            "release.revalidated",
            { releaseId: segments[1], environment },
            200,
            requestId,
          );
        }
        if (
          request.method === "POST" &&
          segments[0] === "releases" &&
          segments[1] !== undefined &&
          segments[2] === "rollback"
        ) {
          const input = await body(request);
          if (
            options.verifyConfirmation !== undefined &&
            !(await options.verifyConfirmation(
              typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
              "rollback",
              actor,
            ))
          ) {
            throw new CmsError({
              code: "CMS_CONFIRMATION_001",
              message: "A valid rollback confirmation is required.",
              category: "authorization",
              retryable: false,
            });
          }
          const result = await options.application.rollbackRelease.execute(
            {
              releaseId: segments[1] as ReleaseId,
              expectedPointerRevision: requiredString(
                input.expectedPointerRevision,
                "expectedPointerRevision",
              ),
              idempotencyKey:
                request.headers.get("idempotency-key") ??
                requiredString(input.idempotencyKey, "idempotencyKey"),
            },
            context,
          );
          return json(
            "release.rolled-back",
            {
              releaseId: segments[1],
              reconciliationPullRequest: result.pullRequest,
              stagingPullRequest: result.stagingPullRequest,
              revision: result.revision,
            },
            200,
            requestId,
          );
        }
        return json(
          "error",
          {
            error: {
              code: "CMS_ROUTE_404",
              message: "CMS route not found.",
              category: "validation",
              retryable: false,
            },
          },
          404,
          requestId,
        );
      } catch (cause) {
        try {
          options.onError?.(cause, {
            requestId,
            method: request.method,
            path: new URL(request.url).pathname,
          });
        } catch {
          // Observability must never replace the original CMS response.
        }
        const error = isCmsError(cause)
          ? cause
          : new CmsError({
              code: "CMS_INTERNAL_500",
              message: "The CMS could not complete this request.",
              category: "internal",
              retryable: false,
              cause,
            });
        return json("error", { error: error.toJSON() }, errorStatus(error), requestId);
      }
    },
  };
}
