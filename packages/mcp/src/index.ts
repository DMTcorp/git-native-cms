import type {
  CmsApplication,
  ChangeConflictResolution,
  ContentScheduleAction,
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
  search?(
    changeId: string,
    query: string,
    context: RequestContext,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  findUsages?(
    changeId: string,
    referenceId: string,
    context: RequestContext,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  validateChange?(
    changeId: string,
    context: RequestContext,
  ): Promise<Readonly<Record<string, unknown>>>;
  stagingStatus?(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  registrySections?(context: RequestContext): Promise<readonly Readonly<Record<string, unknown>>[]>;
  registryContentTypes?(
    context: RequestContext,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  contentGraph?(context: RequestContext): Promise<Readonly<Record<string, unknown>>>;
  getDocumentById?(
    documentId: DocumentId,
    context: RequestContext,
  ): Promise<Readonly<Record<string, unknown>>>;
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
    name: "get_change",
    description: "Read one editorial Change and its current workflow state.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
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
    name: "create_page",
    description: "Create a routable page inside a Change.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        data: { type: "object" },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "data", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "add_section",
    description: "Insert a registered section into a page through the document patch command.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        documentId: { type: "string" },
        section: { type: "object" },
        index: { type: "integer", minimum: 0 },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "documentId", "section", "index", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "move_section",
    description: "Move a page section while preserving its stable section ID.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        documentId: { type: "string" },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "documentId", "from", "to", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "remove_section",
    description: "Remove a page section through the document patch command.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        documentId: { type: "string" },
        index: { type: "integer", minimum: 0 },
        expectedRevision: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "documentId", "index", "expectedRevision", "idempotencyKey"],
    ),
  },
  {
    name: "search_content",
    description: "Search indexed content visible in a Change.",
    inputSchema: objectSchema({ changeId: { type: "string" }, query: { type: "string" } }, [
      "changeId",
      "query",
    ]),
  },
  {
    name: "find_usages",
    description: "Find every content reference to a document, reusable block or asset.",
    inputSchema: objectSchema({ changeId: { type: "string" }, referenceId: { type: "string" } }, [
      "changeId",
      "referenceId",
    ]),
  },
  {
    name: "validate_change",
    description: "Run schema, reference and publication validation without mutating the Change.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
  },
  {
    name: "list_conflicts",
    description: "List semantic field and document conflicts between a Change and Staging.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
  },
  {
    name: "resolve_conflicts",
    description:
      "Resolve every semantic conflict explicitly; prior approval is reset for the merged result.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        expectedRevision: { type: "string" },
        resolutions: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              documentId: { type: "string" },
              path: { type: "string" },
              choice: { enum: ["change", "staging"] },
            },
            ["documentId", "path", "choice"],
          ),
        },
        idempotencyKey: { type: "string" },
      },
      ["changeId", "expectedRevision", "resolutions", "idempotencyKey"],
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
    name: "create_preview",
    description: "Create or return a preview URL without publishing content.",
    inputSchema: objectSchema({ changeId: { type: "string" } }, ["changeId"]),
  },
  {
    name: "add_review_comment",
    description: "Add a GitHub-backed review comment to a Change.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 },
        body: { type: "string" },
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
      },
      ["changeId", "pullRequestNumber", "body"],
    ),
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
    name: "get_staging_status",
    description: "Read the staging branch, pending Changes and current release readiness.",
    inputSchema: objectSchema({}),
  },
  {
    name: "schedule_content",
    description:
      "Schedule publication, unpublication, availability or visibility through the shared scheduler command.",
    inputSchema: objectSchema(
      {
        changeId: { type: "string" },
        action: {
          type: "string",
          enum: [
            "publish",
            "unpublish",
            "availability-start",
            "availability-end",
            "visibility-start",
            "visibility-end",
          ],
        },
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

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function patchMetadata(
  context: CmsMcpContext,
  description: string,
): Readonly<Record<string, unknown>> {
  return {
    id: globalThis.crypto.randomUUID(),
    actorId: context.request.actor.id,
    createdAt: new Date().toISOString(),
    source: "mcp",
    description,
  };
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
    case "get_change":
      return {
        change: await context.queries.getChange(
          string(input.changeId, "changeId"),
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
    case "create_document":
    case "create_page": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return {
        document: await context.application.createDocument.execute(
          {
            change,
            type: name === "create_page" ? "pages" : string(input.type, "type"),
            schemaVersion:
              name === "create_page" ? 1 : positiveInteger(input.schemaVersion, "schemaVersion"),
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
    case "add_section":
    case "move_section":
    case "remove_section": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      const sectionPatch =
        name === "add_section"
          ? {
              op: "insert",
              path: "/sections",
              index: nonNegativeInteger(input.index, "index"),
              value: input.section,
              metadata: patchMetadata(context, "Add section through MCP"),
            }
          : name === "move_section"
            ? {
                op: "move",
                path: "/sections",
                from: nonNegativeInteger(input.from, "from"),
                to: nonNegativeInteger(input.to, "to"),
                metadata: patchMetadata(context, "Move section through MCP"),
              }
            : {
                op: "remove",
                path: "/sections",
                index: nonNegativeInteger(input.index, "index"),
                metadata: patchMetadata(context, "Remove section through MCP"),
              };
      return {
        document: await context.application.updateDocument.execute(
          {
            change,
            documentId: string(input.documentId, "documentId") as DocumentId,
            expectedRevision: string(
              input.expectedRevision,
              "expectedRevision",
            ) as Change["baseCommit"],
            patches: [sectionPatch] as never,
            idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
          },
          context.request,
        ),
      };
    }
    case "search_content": {
      if (context.queries.search === undefined)
        throw new Error("Content search is not configured.");
      return {
        items: await context.queries.search(
          string(input.changeId, "changeId"),
          string(input.query, "query"),
          context.request,
        ),
      };
    }
    case "find_usages": {
      if (context.queries.findUsages === undefined) {
        throw new Error("Content usage search is not configured.");
      }
      return {
        items: await context.queries.findUsages(
          string(input.changeId, "changeId"),
          string(input.referenceId, "referenceId"),
          context.request,
        ),
      };
    }
    case "validate_change": {
      if (context.queries.validateChange === undefined) {
        throw new Error("Change validation is not configured.");
      }
      return context.queries.validateChange(string(input.changeId, "changeId"), context.request);
    }
    case "list_conflicts": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return context.application.readChangeConflicts.execute({ change }, context.request);
    }
    case "resolve_conflicts": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      const resolutions = Array.isArray(input.resolutions)
        ? input.resolutions.map((value) => {
            const resolution = inputRecord(value);
            const path = resolution.path;
            const choice = resolution.choice;
            if (typeof path !== "string") throw new Error("path must be an RFC 6901 string.");
            if (choice !== "change" && choice !== "staging") {
              throw new Error("choice must be change or staging.");
            }
            return {
              documentId: string(resolution.documentId, "documentId") as DocumentId,
              path: path as ChangeConflictResolution["path"],
              choice,
            } satisfies ChangeConflictResolution;
          })
        : [];
      return context.application.resolveChangeConflicts.execute(
        {
          change,
          expectedRevision: string(
            input.expectedRevision,
            "expectedRevision",
          ) as Change["baseCommit"],
          resolutions,
          idempotencyKey: string(input.idempotencyKey, "idempotencyKey"),
        },
        context.request,
      );
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
    case "get_preview":
    case "create_preview": {
      if (context.queries.previewUrl === undefined) {
        throw new Error("Preview URLs are not configured.");
      }
      return {
        url: await context.queries.previewUrl(string(input.changeId, "changeId"), context.request),
      };
    }
    case "add_review_comment": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      return {
        comment: await context.application.reviewChange.execute(
          {
            change,
            pullRequestNumber: positiveInteger(input.pullRequestNumber, "pullRequestNumber"),
            body: string(input.body, "body"),
            ...(typeof input.path === "string" ? { path: input.path } : {}),
            ...(input.line === undefined ? {} : { line: positiveInteger(input.line, "line") }),
          },
          context.request,
        ),
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
    case "get_staging_status": {
      if (context.queries.stagingStatus === undefined) {
        throw new Error("Staging status is not configured.");
      }
      return context.queries.stagingStatus(context.request);
    }
    case "schedule_content": {
      const change = await context.queries.getChange(
        string(input.changeId, "changeId"),
        context.request,
      );
      const action = string(input.action, "action");
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
        throw new Error("action must be a supported publication or content-window action.");
      }
      const documentIds = Array.isArray(input.documentIds)
        ? input.documentIds.map((value) => string(value, "documentId") as DocumentId)
        : [];
      return context.application.scheduleContent.execute(
        {
          change,
          action: action as ContentScheduleAction,
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
              uri: "cms://registry/sections",
              name: "Registered sections",
              mimeType: "application/json",
            },
            {
              uri: "cms://registry/content-types",
              name: "Registered content types",
              mimeType: "application/json",
            },
            {
              uri: "cms://changes/{id}",
              name: "Editorial Change",
              mimeType: "application/json",
            },
            {
              uri: "cms://documents/{id}",
              name: "Content document",
              mimeType: "application/json",
            },
            {
              uri: "cms://content-graph",
              name: "Content reference graph",
              mimeType: "application/json",
            },
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
        let value: unknown;
        if (uri === "cms://project") {
          value = await context.queries.project(context.request);
        } else if (uri === "cms://registry/sections") {
          value = {
            registryDigest: context.registryDigest,
            sections: await context.queries.registrySections?.(context.request),
          };
        } else if (uri === "cms://registry/content-types") {
          value = {
            registryDigest: context.registryDigest,
            contentTypes: await context.queries.registryContentTypes?.(context.request),
          };
        } else if (uri === "cms://content-graph") {
          value = await context.queries.contentGraph?.(context.request);
        } else if (uri === "cms://permissions/current-user") {
          value = context.request.actor;
        } else if (uri.startsWith("cms://changes/")) {
          value = await context.queries.getChange(
            string(uri.slice("cms://changes/".length), "changeId"),
            context.request,
          );
        } else if (uri.startsWith("cms://documents/")) {
          if (context.queries.getDocumentById === undefined) {
            throw new Error("Document resources are not configured.");
          }
          value = await context.queries.getDocumentById(
            string(uri.slice("cms://documents/".length), "documentId") as DocumentId,
            context.request,
          );
        }
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
              name: "create_landing_page",
              description: "Create a landing page from registered sections inside a new Change.",
              arguments: [
                { name: "goal", description: "Landing page objective", required: true },
                { name: "locale", description: "Target locale", required: false },
              ],
            },
            {
              name: "localize_page",
              description: "Localize a page while preserving source and fallback semantics.",
              arguments: [
                { name: "documentId", description: "Page identifier", required: true },
                { name: "locale", description: "Target locale", required: true },
              ],
            },
            {
              name: "update_global_pricing",
              description: "Update global pricing and report every dependent page.",
              arguments: [
                { name: "goal", description: "Pricing change", required: true },
                { name: "market", description: "Target market", required: false },
              ],
            },
            {
              name: "audit_seo",
              description:
                "Audit routable content, redirects, canonicals and localized alternates.",
              arguments: [{ name: "scope", description: "Content scope", required: false }],
            },
            {
              name: "prepare_campaign_change",
              description: "Prepare a coordinated campaign Change without publishing it.",
              arguments: [
                { name: "goal", description: "Campaign outcome", required: true },
                { name: "locale", description: "Primary locale", required: false },
              ],
            },
            {
              name: "summarize_change",
              description: "Summarize semantic differences, checks and publication risk.",
              arguments: [{ name: "changeId", description: "Change identifier", required: true }],
            },
          ],
        };
        break;
      case "prompts/get": {
        const params = inputRecord(request.params);
        const name = string(params.name, "name");
        const argumentsValue = inputRecord(params.arguments);
        if (name === "create_landing_page") {
          result = {
            description: "Create a registered-section landing page in an isolated Change.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Create a landing page for: ${string(argumentsValue.goal, "goal")}. Use locale ${typeof argumentsValue.locale === "string" ? argumentsValue.locale : "en-US"}, registered sections and create_preview. Do not publish.`,
                },
              },
            ],
          };
        } else if (name === "localize_page") {
          result = {
            description: "Localize a page without overwriting source-locale fields.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Localize document ${string(argumentsValue.documentId, "documentId")} to ${string(argumentsValue.locale, "locale")}. Validate fallback and preview the result. Do not publish.`,
                },
              },
            ],
          };
        } else if (name === "update_global_pricing") {
          result = {
            description: "Update shared pricing and inspect dependent content.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Prepare a Change for this pricing update: ${string(argumentsValue.goal, "goal")}. Target ${typeof argumentsValue.market === "string" ? argumentsValue.market : "all markets"} and run find_usages before review.`,
                },
              },
            ],
          };
        } else if (name === "audit_seo") {
          result = {
            description: "Audit SEO metadata and routing without mutating or publishing content.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Audit ${typeof argumentsValue.scope === "string" ? argumentsValue.scope : "all routable content"} for titles, descriptions, canonicals, redirects, sitemap entries and hreflang. Report issues only.`,
                },
              },
            ],
          };
        } else if (name === "prepare_campaign_change") {
          result = {
            description: "Prepare a coordinated campaign Change without publishing it.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Prepare a campaign Change for: ${string(argumentsValue.goal, "goal")}. Use locale ${typeof argumentsValue.locale === "string" ? argumentsValue.locale : "en-US"}, validate it and create a preview. Do not approve or publish.`,
                },
              },
            ],
          };
        } else if (name === "summarize_change") {
          result = {
            description: "Review a Change without mutating it.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Summarize Change ${string(argumentsValue.changeId, "changeId")}, its semantic differences, checks, broken references and publication risk. Do not mutate, approve or publish.`,
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
