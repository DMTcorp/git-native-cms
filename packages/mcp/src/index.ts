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
    case "publish_staging": {
      const confirmed = await context.confirmation.verify({
        token: typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
        action: "publish",
        actorId: context.request.actor.id,
      });
      if (!confirmed) throw new Error("A valid publication confirmation token is required.");
      return context.application.promoteStaging.execute(
        {
          expectedRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          title: string(input.title, "title"),
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
          capabilities: { tools: {}, resources: {} },
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
