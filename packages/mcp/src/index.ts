import type {
  CmsApplication,
  DocumentSummary,
  Page,
  RequestContext,
  StoredRelease,
} from "@git-native-cms/application";
import type { Change, DocumentId, ReleaseId } from "@git-native-cms/core";

export interface CmsMcpQueries {
  project(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  listChanges(context: RequestContext): Promise<readonly Change[]>;
  getChange(id: string, context: RequestContext): Promise<Change>;
  listDocuments(changeId: string, context: RequestContext): Promise<Page<DocumentSummary>>;
  getDocument(
    changeId: string,
    documentId: DocumentId,
    context: RequestContext,
  ): Promise<Readonly<Record<string, unknown>>>;
  previewUrl?(changeId: string, context: RequestContext): Promise<string>;
  listReleases(context: RequestContext): Promise<readonly StoredRelease[]>;
}

export interface ConfirmationService {
  verify(input: {
    readonly token: string | undefined;
    readonly action: "publish" | "rollback";
    readonly actorId: string;
  }): Promise<boolean>;
}

export interface CmsMcpContext {
  readonly application: CmsApplication;
  readonly queries: CmsMcpQueries;
  readonly confirmation: ConfirmationService;
  readonly request: RequestContext;
  readonly registryDigest: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly destructive?: boolean;
}

const objectSchema = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const cmsTools: readonly McpToolDefinition[] = [
  {
    name: "list_changes",
    description: "List editorial Changes visible to the current actor.",
    inputSchema: objectSchema({}),
  },
  {
    name: "create_change",
    description: "Create an isolated Change from Production.",
    inputSchema: objectSchema(
      {
        name: { type: "string" },
        description: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["name", "idempotencyKey"],
    ),
  },
  {
    name: "list_documents",
    description: "List content documents in a Change.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
  },
  {
    name: "get_document",
    description: "Read a content document from a Change.",
    inputSchema: objectSchema({ changeId: { type: "string" }, documentId: { type: "string" } }, [
      "changeId",
      "documentId",
    ]),
  },
  {
    name: "update_document",
    description: "Apply typed content patches to a document.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        documentId: { type: "string" },
        expectedRevision: { type: "string" },
        patches: { type: "array" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "documentId", "expectedRevision", "patches", "idempotencyKey"],
    ),
  },
  {
    name: "create_document",
    description: "Create a typed content document inside a Change.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        type: { type: "string" },
        schemaVersion: { type: "integer", minimum: 1 },
        data: { type: "object" },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "type", "schemaVersion", "data", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "delete_document",
    description: "Delete a draft document after normal reference and permission checks.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        documentId: { type: "string" },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "documentId", "expectedRevision", "idempotencyKey"],
    ),
    destructive: true,
  },
  {
    name: "submit_for_review",
    description: "Send a Change for review.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "get_preview",
    description: "Get a preview URL for a Change without publishing it.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
  },
  {
    name: "request_changes",
    description: "Return a reviewed Change to its editor with an audit comment.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 },
        expectedRevision: { type: "string" },
        body: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "pullRequestNumber", "expectedRevision", "body", "idempotencyKey"],
    ),
  },
  {
    name: "approve_change",
    description: "Approve a reviewed Change. Normal reviewer permission is required.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 },
        expectedRevision: { type: "string" },
        body: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "pullRequestNumber", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "add_to_staging",
    description: "Squash an approved Change into Staging after checks and conflict validation.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "pullRequestNumber", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "schedule_content",
    description: "Schedule publish or unpublish through the shared scheduler command.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        action: { type: "string", enum: ["publish", "unpublish"] },
        documentIds: { type: "array", items: { type: "string" }, minItems: 1 },
        executeAt: { type: "string" },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "action", "documentIds", "executeAt", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "publish_staging",
    description: "Promote Staging to Production. Requires permission and a confirmation token.",
    inputSchema: objectSchema(
      {
        expectedRevision: { type: "string" },
        title: { type: "string" },
        idempotencyKey: { type: "string" },
        confirmationToken: { type: "string" },
      },
      ["expectedRevision", "title", "idempotencyKey", "confirmationToken"],
    ),
    destructive: true,
  },
  {
    name: "list_releases",
    description: "List immutable content releases.",
    inputSchema: objectSchema({}),
  },
  {
    name: "rollback_release",
    description: "Restore a previous Production release. Requires a confirmation token.",
    inputSchema: objectSchema(
      {
        releaseId: { type: "string" },
        expectedPointerRevision: { type: "string" },
        idempotencyKey: { type: "string" },
        confirmationToken: { type: "string" },
      },
      ["releaseId", "expectedPointerRevision", "idempotencyKey", "confirmationToken"],
    ),
    destructive: true,
  },
];

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export async function callCmsTool(
  name: string,
  inputValue: unknown,
  context: CmsMcpContext,
): Promise<unknown> {
  const input = inputRecord(inputValue);
  switch (name) {
    case "list_changes":
      return { changes: await context.queries.listChanges(context.request) };
    case "create_change":
      return {
        change: await context.application.createChange.execute(
          {
            name: string(input.name, "name"),
            ...(typeof input.description === "string" ? { description: input.description } : {}),
            idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
          },
          context.request,
        ),
      };
    case "list_documents":
      return context.queries.listDocuments(string(input.changeId, "changeId"), context.request);
    case "get_document":
      return context.queries.getDocument(
        string(input.changeId, "changeId"),
        string(input.documentId, "documentId") as DocumentId,
        context.request,
      );
    case "update_document": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return {
        document: await context.application.updateDocument.execute(
          {
            change,
            documentId: string(input.documentId, "documentId") as DocumentId,
            expectedRevision: string(
              input.expectedRevision,
              "expectedRevision",
            ) as Change["baseCommit"],
            patches: Array.isArray(input.patches) ? (input.patches as never) : [],
            idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
          },
          context.request,
        ),
      };
    }
    case "create_document": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return {
        document: await context.application.createDocument.execute(
          {
            change,
            type: string(input.type, "type"),
            schemaVersion: positiveInteger(input.schemaVersion, "schemaVersion"),
            data: input.data ?? {},
            expectedRevision: string(
              input.expectedRevision,
              "expectedRevision",
            ) as Change["baseCommit"],
            idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
          },
          context.request,
        ),
      };
    }
    case "delete_document": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return context.application.deleteDocument.execute(
        {
          change,
          documentId: string(input.documentId, "documentId") as DocumentId,
          expectedRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
    }
    case "submit_for_review": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return context.application.submitChange.execute(
        {
          change,
          expectedRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
    }
    case "get_preview": {
      if (context.queries.previewUrl === undefined) {
        throw new Error("Preview URLs are not configured.");
      }
      return {
        url: await context.queries.previewUrl(string(input.changeId, "changeId"), context.request),
      };
    }
    case "request_changes":
    case "approve_change":
    case "add_to_staging": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      const shared = {
        change,
        pullRequestNumber: positiveInteger(input.pullRequestNumber, "pullRequestNumber"),
        expectedRevision: string(
          input.expectedRevision,
          "expectedRevision",
        ) as Change["baseCommit"],
        idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
      };
      if (name === "request_changes") {
        return context.application.requestChanges.execute(
          { ...shared, body: string(input.body, "body") },
          context.request,
        );
      }
      if (name === "approve_change") {
        return context.application.approveChange.execute(
          {
            ...shared,
            ...(typeof input.body === "string" ? { body: input.body } : {}),
          },
          context.request,
        );
      }
      return context.application.addChangeToStaging.execute(shared, context.request);
    }
    case "schedule_content": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      const action = string(input.action, "action");
      if (action !== "publish" && action !== "unpublish") {
        throw new Error("action must be publish or unpublish.");
      }
      const documentIds = Array.isArray(input.documentIds)
        ? input.documentIds.map((value) => string(value, "documentId") as DocumentId)
        : [];
      return context.application.scheduleContent.execute(
        {
          change,
          action,
          documentIds,
          executeAt: string(input.executeAt, "executeAt"),
          expectedRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
    }
    case "publish_staging": {
      const confirmed = await context.confirmation.verify({
        token: typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
        action: "publish",
        actorId: context.request.actor.id,
      });
      if (!confirmed) throw new Error("A valid publication confirmation token is required.");
      return context.application.publishStaging.execute(
        {
          expectedStagingRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          title: string(input.title, "title"),
          configVersion: 1,
          registryDigest: context.registryDigest,
          schemaVersion: 1,
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
    }
    case "list_releases":
      return { releases: await context.queries.listReleases(context.request) };
    case "rollback_release": {
      const confirmed = await context.confirmation.verify({
        token: typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
        action: "rollback",
        actorId: context.request.actor.id,
      });
      if (!confirmed) throw new Error("A valid rollback confirmation token is required.");
      await context.application.rollbackRelease.execute(
        {
          releaseId: string(input.releaseId, "releaseId") as ReleaseId,
          expectedPointerRevision: string(input.expectedPointerRevision, "expectedPointerRevision"),
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
      return { releaseId: input.releaseId, rolledBack: true };
    }
    default:
      throw new Error(`Unknown CMS tool "${name}".`);
  }
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export async function handleMcpJsonRpc(
  request: JsonRpcRequest,
  context: CmsMcpContext,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    let result: unknown;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "git-native-cms", version: "0.1.0" },
        };
        break;
      case "tools/list":
        result = { tools: cmsTools };
        break;
      case "tools/call": {
        const params = inputRecord(request.params);
        const toolResult = await callCmsTool(
          string(params.name, "name"),
          params.arguments,
          context,
        );
        result = {
          content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
          structuredContent: toolResult,
        };
        break;
      }
      case "resources/list":
        result = {
          resources: [
            { uri: "cms://project", name: "CMS project", mimeType: "application/json" },
            {
              uri: "cms://permissions/current-user",
              name: "Current actor permissions",
              mimeType: "application/json",
            },
          ],
        };
        break;
      case "resources/read": {
        const params = inputRecord(request.params);
        const uri = string(params.uri, "uri");
        const value =
          uri === "cms://project"
            ? await context.queries.project(context.request)
            : uri === "cms://permissions/current-user"
              ? context.request.actor
              : undefined;
        if (value === undefined) throw new Error(`Unknown CMS resource "${uri}".`);
        result = {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
        };
        break;
      }
      case "prompts/list":
        result = {
          prompts: [
            {
              name: "prepare_editorial_change",
              description: "Plan a safe editorial Change without publishing it.",
              arguments: [
                { name: "goal", description: "Editorial outcome", required: true },
                { name: "locale", description: "Target locale", required: false },
              ],
            },
            {
              name: "review_change",
              description: "Review content differences, checks and publication risk.",
              arguments: [{ name: "changeId", description: "Change identifier", required: true }],
            },
          ],
        };
        break;
      case "prompts/get": {
        const params = inputRecord(request.params);
        const name = string(params.name, "name");
        const argumentsValue = inputRecord(params.arguments);
        if (name === "prepare_editorial_change") {
          result = {
            description: "Prepare an isolated, reviewable editorial Change.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Prepare a Change for: ${string(argumentsValue.goal, "goal")}. Use locale ${typeof argumentsValue.locale === "string" ? argumentsValue.locale : "en-US"}. Do not publish.`,
                },
              },
            ],
          };
        } else if (name === "review_change") {
          result = {
            description: "Review a Change without mutating it.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Review Change ${string(argumentsValue.changeId, "changeId")}. Summarize semantic risk and checks. Do not approve or publish.`,
                },
              },
            ],
          };
        } else {
          throw new Error(`Unknown CMS prompt "${name}".`);
        }
        break;
      }
      default:
        throw new Error(`Unsupported MCP method "${request.method}".`);
    }
    return { jsonrpc: "2.0", ...(request.id === undefined ? {} : { id: request.id }), result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      ...(request.id === undefined ? {} : { id: request.id }),
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleMcpHttp(request: Request, context: CmsMcpContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const message = (await request.json()) as JsonRpcRequest;
  return Response.json(await handleMcpJsonRpc(message, context), {
    headers: { "cache-control": "no-store" },
  });
}

export async function runMcpStdio(contextFactory: () => Promise<CmsMcpContext>): Promise<void> {
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const request = JSON.parse(line) as JsonRpcRequest;
    process.stdout.write(
      `${JSON.stringify(await handleMcpJsonRpc(request, await contextFactory()))}\n`,
    );
  }
}
