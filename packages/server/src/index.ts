import type {
  CmsApplication,
  DocumentSummary,
  Page,
  RequestContext,
  StoredRelease,
} from "@git-native-cms/application";
import {
  CmsError,
  isCmsError,
  type Actor,
  type Change,
  type DocumentId,
  type ReleaseId,
} from "@git-native-cms/core";
import { createEnvelope } from "@git-native-cms/protocol";

export interface CmsServerQueries {
  bootstrap(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  listChanges(context: RequestContext): Promise<readonly Change[]>;
  getChange(id: string, context: RequestContext): Promise<Change>;
  listDocuments(changeId: string, context: RequestContext): Promise<Page<DocumentSummary>>;
  listReleases(context: RequestContext): Promise<readonly StoredRelease[]>;
}

export interface CmsServerOptions {
  readonly application: CmsApplication;
  readonly queries: CmsServerQueries;
  readonly actorForRequest: (request: Request) => Promise<Actor | undefined>;
  readonly verifyCsrf: (request: Request, actor: Actor) => Promise<boolean>;
  readonly basePath?: string;
  readonly allowedOrigins?: readonly string[];
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
  const value = (await request.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_REQUEST_001",
      message: "The request body must be a JSON object.",
      category: "validation",
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
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

        if (request.method === "GET" && segments.join("/") === "bootstrap") {
          return json("bootstrap", await options.queries.bootstrap(context), 200, requestId);
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
          const change = await options.application.createChange.execute(
            {
              name: requiredString(input.name, "name"),
              ...(typeof input.description === "string" ? { description: input.description } : {}),
              ...(typeof input.baseBranch === "string" ? { baseBranch: input.baseBranch } : {}),
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
          if (request.method === "GET" && segments[2] === "documents" && segments.length === 3) {
            return json(
              "documents.list",
              await options.queries.listDocuments(change.id, context),
              200,
              requestId,
            );
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
          if (request.method === "POST" && segments[2] === "comments") {
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
        }
        if (request.method === "POST" && segments.join("/") === "staging/publish") {
          const input = await body(request);
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
          segments[2] === "rollback"
        ) {
          const input = await body(request);
          const pullRequest = await options.application.rollbackRelease.execute(
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
            { releaseId: segments[1], auditPullRequest: pullRequest },
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
