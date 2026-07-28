import { compileProtocolSchema } from "./index.js";

type JsonSchema = Readonly<Record<string, unknown>>;

function object(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

const string = { type: "string", minLength: 1 } as const;
const revision = { type: "string", minLength: 7 } as const;
const idempotency = { type: "string", minLength: 8 } as const;

export const httpPayloadSchemas = {
  "change.create": object(
    {
      name: { type: "string", minLength: 2, maxLength: 120 },
      description: { type: "string", maxLength: 4_000 },
      baseBranch: { type: "string", enum: ["main", "staging"] },
      collaborators: {
        type: "array",
        maxItems: 20,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 100 },
      },
      targetDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      emergency: { type: "boolean" },
      idempotencyKey: idempotency,
    },
    ["name"],
  ),
  "change.update": object(
    {
      name: { type: "string", minLength: 2, maxLength: 120 },
      description: { anyOf: [{ type: "string", maxLength: 4_000 }, { type: "null" }] },
      expectedRevision: revision,
      idempotencyKey: idempotency,
    },
    ["expectedRevision"],
  ),
  "document.update": object(
    {
      expectedRevision: revision,
      patches: { type: "array", maxItems: 10_000, items: { type: "object" } },
      idempotencyKey: idempotency,
    },
    ["expectedRevision", "patches"],
  ),
  "review.comment": object(
    {
      pullRequestNumber: { type: "integer", minimum: 1 },
      body: { type: "string", minLength: 1, maxLength: 65_536 },
      path: { type: "string", minLength: 1 },
      line: { type: "integer", minimum: 1 },
    },
    ["pullRequestNumber", "body"],
  ),
  "schedule.create": object(
    {
      changeId: string,
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
      documentIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: string,
      },
      executeAt: { type: "string", format: "date-time" },
      expectedRevision: revision,
      idempotencyKey: idempotency,
    },
    ["changeId", "action", "documentIds", "executeAt", "expectedRevision"],
  ),
  "asset.upload.create": object(
    {
      fileName: { type: "string", minLength: 1, maxLength: 255 },
      mimeType: { type: "string", minLength: 3, maxLength: 255 },
      size: { type: "integer", minimum: 1, maximum: 26_214_400 },
      checksum: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    ["fileName", "mimeType", "size", "checksum"],
  ),
  "release.publish": object(
    {
      expectedStagingRevision: revision,
      title: { type: "string", minLength: 1, maxLength: 200 },
      configVersion: { type: "integer", minimum: 1 },
      registryDigest: string,
      schemaVersion: { type: "integer", minimum: 1 },
      confirmationToken: string,
      idempotencyKey: idempotency,
    },
    ["expectedStagingRevision", "title", "configVersion", "registryDigest", "schemaVersion"],
  ),
  "release.rollback": object(
    {
      expectedPointerRevision: string,
      confirmationToken: string,
      idempotencyKey: idempotency,
    },
    ["expectedPointerRevision"],
  ),
} as const;

export type HttpPayloadOperation = keyof typeof httpPayloadSchemas;

const validators = new Map<HttpPayloadOperation, (value: unknown) => boolean>();

export function isHttpPayload(
  operation: HttpPayloadOperation,
  value: unknown,
): boolean {
  let validate = validators.get(operation);
  if (validate === undefined) {
    validate = compileProtocolSchema(httpPayloadSchemas[operation]);
    validators.set(operation, validate);
  }
  return validate(value);
}

export function httpOperationForRequest(
  method: string,
  pathname: string,
): HttpPayloadOperation | undefined {
  if (method === "POST" && /\/changes\/?$/u.test(pathname)) return "change.create";
  if (method === "PATCH" && /\/changes\/[^/]+\/?$/u.test(pathname)) return "change.update";
  if (method === "PATCH" && /\/changes\/[^/]+\/documents\/[^/]+\/?$/u.test(pathname)) {
    return "document.update";
  }
  if (method === "POST" && /\/changes\/[^/]+\/comments\/?$/u.test(pathname)) {
    return "review.comment";
  }
  if (method === "POST" && /\/schedules\/?$/u.test(pathname)) return "schedule.create";
  if (method === "POST" && /\/assets\/uploads\/?$/u.test(pathname)) {
    return "asset.upload.create";
  }
  if (method === "POST" && /\/staging\/publish\/?$/u.test(pathname)) return "release.publish";
  if (method === "POST" && /\/releases\/[^/]+\/rollback\/?$/u.test(pathname)) {
    return "release.rollback";
  }
  return undefined;
}
