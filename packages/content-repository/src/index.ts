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
  type GitCommitSha,
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

interface RepositorySnapshot {
  readonly revision: GitCommitSha;
  readonly documents: readonly {
    readonly path: string;
    readonly document: ContentDocument;
  }[];
  readonly byId: ReadonlyMap<DocumentId, ContentDocument>;
}

export class GitContentRepository implements ContentRepository {
  private static readonly REVISION_CACHE_LIMIT = 64;
  private readonly revisions = new Map<GitCommitSha, Promise<RepositorySnapshot>>();

  constructor(private readonly git: GitProvider) {}

  private remember(
    revision: GitCommitSha,
    snapshot: Promise<RepositorySnapshot>,
  ): Promise<RepositorySnapshot> {
    this.revisions.delete(revision);
    this.revisions.set(revision, snapshot);
    while (this.revisions.size > GitContentRepository.REVISION_CACHE_LIMIT) {
      const oldest = this.revisions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.revisions.delete(oldest);
    }
    void snapshot.catch(() => {
      if (this.revisions.get(revision) === snapshot) this.revisions.delete(revision);
    });
    return snapshot;
  }

  private async snapshot(input: {
    readonly ref: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositorySnapshot> {
    const resolved = await this.git.resolveRef(input.ref, input.signal);
    const cached = this.revisions.get(resolved.sha);
    if (cached !== undefined) return cached;
    return this.remember(
      resolved.sha,
      this.git
        .listFiles({
          ref: resolved.sha,
          prefix: "content/",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        .then((files) => {
          const documents = files
            .filter((file) => /\/index\.(yaml|yml|json|md)$/.test(file.path))
            .map((file) => ({
              path: file.path,
              document: decodeDocument(file.path, file.content, resolved.sha),
            }))
            .sort((left, right) => left.path.localeCompare(right.path));
          const byId = new Map<DocumentId, ContentDocument>();
          for (const entry of documents) {
            if (!byId.has(entry.document.id)) byId.set(entry.document.id, entry.document);
          }
          return { revision: resolved.sha, documents, byId };
        }),
    );
  }

  async listDocuments(input: {
    readonly ref: string;
    readonly type?: string;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<DocumentSummary>> {
    const snapshot = await this.snapshot(input);
    const decoded =
      input.type === undefined
        ? snapshot.documents
        : snapshot.documents.filter(({ document }) => document.type === input.type);
    const offset = Number(input.cursor ?? "0");
    const page = decoded.slice(offset, offset + 100);
    return {
      items: page.map(({ path, document }) => ({
        id: document.id,
        type: document.type,
        title:
          isRecord(document.data) && typeof document.data.title === "string"
            ? document.data.title
            : String(document.id),
        path,
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
    const document = (await this.snapshot(input)).byId.get(input.documentId);
    if (document !== undefined) return document;
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
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: input.expectedRevision,
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
    const committed = await this.git.commitFiles({
      branch: input.ref,
      expectedSha: input.expectedRevision,
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
