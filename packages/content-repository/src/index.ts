import type {
  ContentRepository,
  DocumentSummary,
  GitProvider,
  Page,
  ProjectConfig,
  RegistryLock,
} from "@git-native-cms/application";
import { codecForPath, yamlCodec } from "@git-native-cms/content-codecs";
import {
  CmsError,
  type ContentDocument,
  type DocumentId,
  type Revision,
} from "@git-native-cms/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePathSegment(value: string, label: string): string {
  const normalized = value.normalize("NFKC");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    !/^[\p{L}\p{N}._-]+$/u.test(normalized)
  ) {
    throw new CmsError({
      code: "CMS_DOCUMENT_010",
      message: `${label} contains characters that are unsafe in a content path.`,
      category: "validation",
      retryable: false,
    });
  }
  return normalized;
}

export function contentFilePath(document: ContentDocument): string {
  const data = isRecord(document.data) ? document.data : {};
  const slug =
    typeof data.slug === "string"
      ? data.slug
      : String(document.id).replace(/^doc_/, "").replaceAll("_", "-");
  const slugSegments = slug.split("/");
  if (slugSegments.length > 16) {
    throw new CmsError({
      code: "CMS_DOCUMENT_011",
      message: "A content slug cannot contain more than 16 path segments.",
      category: "validation",
      retryable: false,
    });
  }
  return `content/${safePathSegment(document.type, "Document type")}/${slugSegments
    .map((segment) => safePathSegment(segment, "Document slug"))
    .join("/")}/index.yaml`;
}

function decodeDocument(path: string, content: string, revision: Revision): ContentDocument {
  const parsed = codecForPath(path).parse(content);
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.schemaVersion !== "number"
  ) {
    throw new CmsError({
      code: "CMS_SCHEMA_017",
      message: `${path} is missing id, type or schemaVersion.`,
      category: "validation",
      retryable: false,
      context: { path },
    });
  }
  const { id, type, schemaVersion, ...data } = parsed;
  return {
    id: id as DocumentId,
    type,
    schemaVersion,
    revision,
    data,
  };
}

function encodeDocument(document: ContentDocument): string {
  const data = isRecord(document.data) ? document.data : { value: document.data };
  return yamlCodec.serialize({
    id: document.id,
    type: document.type,
    schemaVersion: document.schemaVersion,
    ...data,
  });
}

export class GitContentRepository implements ContentRepository {
  constructor(private readonly git: GitProvider) {}

  async listDocuments(input: {
    readonly ref: string;
    readonly type?: string;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<DocumentSummary>> {
    const prefix = input.type === undefined ? "content/" : `content/${input.type}/`;
    const [files, ref] = await Promise.all([
      this.git.listFiles({
        ref: input.ref,
        prefix,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
      this.git.resolveRef(input.ref, input.signal),
    ]);
    const decoded = files
      .filter((file) => /\/index\.(yaml|yml|json|md)$/.test(file.path))
      .map((file) => ({ file, document: decodeDocument(file.path, file.content, ref.sha) }))
      .sort((left, right) => left.file.path.localeCompare(right.file.path));
    const offset = Number(input.cursor ?? "0");
    const page = decoded.slice(offset, offset + 100);
    return {
      items: page.map(({ file, document }) => ({
        id: document.id,
        type: document.type,
        title:
          isRecord(document.data) && typeof document.data.title === "string"
            ? document.data.title
            : String(document.id),
        path: file.path,
        revision: document.revision,
      })),
      ...(offset + page.length < decoded.length
        ? { nextCursor: String(offset + page.length) }
        : {}),
    };
  }

  async readDocument(input: {
    readonly ref: string;
    readonly documentId: DocumentId;
    readonly signal?: AbortSignal;
  }): Promise<ContentDocument> {
    const [files, ref] = await Promise.all([
      this.git.listFiles({
        ref: input.ref,
        prefix: "content/",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
      this.git.resolveRef(input.ref, input.signal),
    ]);
    for (const file of files.filter((candidate) => candidate.path.includes("/index."))) {
      const document = decodeDocument(file.path, file.content, ref.sha);
      if (document.id === input.documentId) return document;
    }
    throw new CmsError({
      code: "CMS_DOCUMENT_404",
      message: `Document ${input.documentId} was not found.`,
      category: "validation",
      retryable: false,
    });
  }

  async writeDocuments(
    input: Parameters<ContentRepository["writeDocuments"]>[0],
  ): Promise<Revision> {
    const ref = await this.git.resolveRef(input.ref, input.signal);
    if (ref.sha !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_CHANGE_003",
        message: "The Change moved while content was being saved.",
        category: "conflict",
        retryable: true,
      });
    }
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: ref.sha,
      files: input.documents.map((document) => ({
        path: contentFilePath(document),
        content: encodeDocument(document),
      })),
      message: input.message,
      author: input.actor,
      idempotencyKey: input.idempotencyKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return committed.sha;
  }

  async deleteDocuments(
    input: Parameters<ContentRepository["deleteDocuments"]>[0],
  ): Promise<Revision> {
    const summaries = await this.listDocuments({
      ref: input.ref,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const paths = summaries.items
      .filter((summary) => input.documentIds.includes(summary.id))
      .map((summary) => summary.path);
    const ref = await this.git.resolveRef(input.ref, input.signal);
    if (ref.sha !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_CHANGE_003",
        message: "The Change moved while content was being deleted.",
        category: "conflict",
        retryable: true,
      });
    }
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: ref.sha,
      files: paths.map((path) => ({ path, content: null })),
      message: `Delete ${paths.length} document(s)`,
      author: input.actor,
      idempotencyKey: input.idempotencyKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return committed.sha;
  }

  async readProjectConfig(ref: string, signal?: AbortSignal): Promise<ProjectConfig> {
    const file = await this.git.readFile({
      ref,
      path: ".cms/project.yaml",
      ...(signal === undefined ? {} : { signal }),
    });
    const value = file === undefined ? undefined : yamlCodec.parse(file.content);
    if (!isRecord(value) || typeof value.configVersion !== "number") {
      throw new CmsError({
        code: "CMS_CONFIGURATION_004",
        message: ".cms/project.yaml is missing or invalid.",
        category: "configuration",
        retryable: false,
      });
    }
    return value as ProjectConfig;
  }

  async readRegistryLock(ref: string, signal?: AbortSignal): Promise<RegistryLock> {
    const file = await this.git.readFile({
      ref,
      path: ".cms/registry-lock.json",
      ...(signal === undefined ? {} : { signal }),
    });
    let value: unknown;
    try {
      value = file === undefined ? undefined : JSON.parse(file.content);
    } catch (cause) {
      throw new CmsError({
        code: "CMS_CONFIGURATION_005",
        message: ".cms/registry-lock.json contains invalid JSON.",
        category: "configuration",
        retryable: false,
        cause,
      });
    }
    if (!isRecord(value) || typeof value.registryDigest !== "string") {
      throw new CmsError({
        code: "CMS_CONFIGURATION_005",
        message: ".cms/registry-lock.json is missing or invalid.",
        category: "configuration",
        retryable: false,
      });
    }
    return value as RegistryLock;
  }
}
