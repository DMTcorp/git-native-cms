import type {
  EnvironmentPointer,
  GitProvider,
  ReleaseStore,
  StoredRelease,
} from "@git-native-cms/application";
import { canonicalJson } from "@git-native-cms/content-codecs";
import { CmsError, type ReleaseId } from "@git-native-cms/core";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

export interface ContentSource {
  readPointer(
    environment: string,
    signal?: AbortSignal,
  ): Promise<{ readonly releaseId: ReleaseId }>;
  readFile(releaseId: ReleaseId, path: string, signal?: AbortSignal): Promise<string>;
}

export interface ContentClient {
  releaseId(signal?: AbortSignal): Promise<ReleaseId>;
  get<TValue>(path: string, signal?: AbortSignal): Promise<TValue>;
  invalidate(): void;
}

export interface ContentIndexEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly path: string;
}

export interface DeliveryWindow {
  readonly from?: string;
  readonly until?: string;
}

function deliveryWindow(value: unknown): DeliveryWindow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    ...(typeof record.until === "string" ? { until: record.until } : {}),
  };
}

export function isContentActive(
  data: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): boolean {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) return false;
  for (const field of ["availability", "visibilitySchedule"] as const) {
    const window = deliveryWindow(data[field]);
    if (window?.from !== undefined && new Date(window.from).getTime() > timestamp) return false;
    if (window?.until !== undefined && new Date(window.until).getTime() <= timestamp) return false;
  }
  return true;
}

export async function loadRedirects(
  client: ContentClient,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  return client.get<Readonly<Record<string, string>>>("redirects.json", signal);
}

export function resolveRedirect(
  redirects: Readonly<Record<string, string>>,
  path: string,
  maximumHops = 4,
): string | undefined {
  let current = path;
  const visited = new Set<string>();
  for (let hops = 0; hops < maximumHops; hops += 1) {
    const next = redirects[current];
    if (next === undefined) return current === path ? undefined : current;
    if (visited.has(current) || visited.has(next)) {
      throw new CmsError({
        code: "CMS_DELIVERY_009",
        message: `Redirect loop detected from ${path}.`,
        category: "validation",
        retryable: false,
      });
    }
    visited.add(current);
    current = next;
  }
  throw new CmsError({
    code: "CMS_DELIVERY_010",
    message: `Redirect from ${path} exceeds ${maximumHops} hops.`,
    category: "validation",
    retryable: false,
  });
}

export async function loadContentGraph(
  client: ContentClient,
  signal?: AbortSignal,
): Promise<
  readonly {
    readonly id: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[]
> {
  const index = await client.get<readonly ContentIndexEntry[]>("content-index.json", signal);
  const documents = await Promise.all(
    index.map((entry) => client.get<unknown>(entry.path, signal).catch(() => undefined)),
  );
  return documents.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Readonly<Record<string, unknown>>;
    if (typeof record.id !== "string" || typeof record.type !== "string") return [];
    return [
      {
        id: record.id,
        type: record.type,
        data: Object.fromEntries(
          Object.entries(record).filter(([key]) => !["id", "type", "schemaVersion"].includes(key)),
        ),
      },
    ];
  });
}

export async function loadActiveContentGraph(
  client: ContentClient,
  input: { readonly now?: Date; readonly signal?: AbortSignal } = {},
): Promise<
  readonly {
    readonly id: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[]
> {
  const graph = await loadContentGraph(client, input.signal);
  return graph.filter((document) => isContentActive(document.data, input.now));
}

export function createContentClient(input: {
  readonly environment: "preview" | "staging" | "production";
  readonly source: ContentSource;
  readonly fallbackReleaseId?: ReleaseId;
  readonly onStaleFallback?: (input: {
    readonly failedReleaseId: ReleaseId;
    readonly fallbackReleaseId: ReleaseId;
    readonly path: string;
    readonly cause: unknown;
  }) => void;
}): ContentClient {
  let pointer: Promise<ReleaseId> | undefined;
  const fileCache = new Map<string, Promise<unknown>>();
  async function resolvePointer(signal?: AbortSignal): Promise<ReleaseId> {
    pointer ??= input.source
      .readPointer(input.environment, signal)
      .then((value) => value.releaseId)
      .catch((cause: unknown) => {
        pointer = undefined;
        if (input.fallbackReleaseId !== undefined) return input.fallbackReleaseId;
        throw cause;
      });
    return pointer;
  }
  return {
    releaseId: resolvePointer,
    async get<TValue>(path: string, signal?: AbortSignal): Promise<TValue> {
      const releaseId = await resolvePointer(signal);
      const key = `${releaseId}:${path}`;
      let pending = fileCache.get(key);
      if (pending === undefined) {
        pending = input.source
          .readFile(releaseId, path, signal)
          .then((source) => JSON.parse(source) as unknown);
        fileCache.set(key, pending);
      }
      try {
        return (await pending) as TValue;
      } catch (cause) {
        fileCache.delete(key);
        if (input.fallbackReleaseId !== undefined && input.fallbackReleaseId !== releaseId) {
          try {
            const fallbackSource = await input.source.readFile(
              input.fallbackReleaseId,
              path,
              signal,
            );
            const fallback = JSON.parse(fallbackSource) as TValue;
            input.onStaleFallback?.({
              failedReleaseId: releaseId,
              fallbackReleaseId: input.fallbackReleaseId,
              path,
              cause,
            });
            return fallback;
          } catch {
            // Preserve the primary delivery error below.
          }
        }
        throw new CmsError({
          code: "CMS_DELIVERY_001",
          message: `Content ${path} could not be loaded.`,
          category: "network",
          retryable: true,
          cause,
        });
      }
    },
    invalidate(): void {
      pointer = undefined;
      fileCache.clear();
    },
  };
}

export function cdnSource(input: {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): ContentSource {
  const fetcher = input.fetch ?? globalThis.fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const cached = new Map<string, { readonly etag?: string; readonly body: string }>();
  async function read(url: string, cache: RequestCache, signal?: AbortSignal): Promise<string> {
    const previous = cached.get(url);
    const response = await fetcher(url, {
      cache,
      headers: previous?.etag === undefined ? {} : { "if-none-match": previous.etag },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 304 && previous !== undefined) return previous.body;
    if (!response.ok) throw new Error(`Content request failed with ${response.status}.`);
    const body = await response.text();
    const etag = response.headers.get("etag") ?? undefined;
    cached.set(url, { body, ...(etag === undefined ? {} : { etag }) });
    return body;
  }
  return {
    async readPointer(environment, signal) {
      const body = await read(
        `${baseUrl}/environments/${environment}/current.json`,
        "no-store",
        signal,
      );
      return JSON.parse(body) as { releaseId: ReleaseId };
    },
    async readFile(releaseId, path, signal) {
      return read(`${baseUrl}/releases/${releaseId}/${path}`, "force-cache", signal);
    },
  };
}

export function gitSource(input: {
  readonly git: GitProvider;
  readonly ref: string;
  readonly pointerPrefix?: string;
  readonly releasePrefix?: string;
}): ContentSource {
  const pointerPrefix = input.pointerPrefix?.replace(/^\/|\/$/gu, "") ?? ".cms/environments";
  const releasePrefix = input.releasePrefix?.replace(/^\/|\/$/gu, "") ?? "releases";
  return {
    async readPointer(environment, signal) {
      const file = await input.git.readFile({
        ref: input.ref,
        path: `${pointerPrefix}/${environment}/current.json`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (file === undefined) {
        throw new CmsError({
          code: "CMS_DELIVERY_012",
          message: `The ${environment} Git release pointer does not exist.`,
          category: "storage",
          retryable: false,
        });
      }
      const pointer = JSON.parse(file.content) as { readonly releaseId?: unknown };
      if (typeof pointer.releaseId !== "string") {
        throw new CmsError({
          code: "CMS_DELIVERY_014",
          message: `The ${environment} Git release pointer is invalid.`,
          category: "validation",
          retryable: false,
        });
      }
      return { releaseId: pointer.releaseId as ReleaseId };
    },
    async readFile(releaseId, path, signal) {
      const safePath = path.replaceAll("\\", "/");
      if (
        safePath.startsWith("/") ||
        safePath.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        throw new CmsError({
          code: "CMS_DELIVERY_015",
          message: `The Git delivery path "${path}" is unsafe.`,
          category: "validation",
          retryable: false,
        });
      }
      const file = await input.git.readFile({
        ref: input.ref,
        path: `${releasePrefix}/${releaseId}/${safePath}`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (file === undefined) {
        throw new CmsError({
          code: "CMS_DELIVERY_013",
          message: `Git release ${releaseId} does not contain ${path}.`,
          category: "storage",
          retryable: false,
        });
      }
      return file.content;
    },
  };
}

function deliveryEnvironment(value: string): EnvironmentPointer["environment"] {
  if (value === "preview" || value === "staging" || value === "production") return value;
  throw new CmsError({
    code: "CMS_DELIVERY_011",
    message: `Unknown delivery environment "${value}".`,
    category: "validation",
    retryable: false,
  });
}

export function releaseStoreSource(store: ReleaseStore): ContentSource {
  return {
    async readPointer(environment, signal) {
      const pointer = await store.readPointer(deliveryEnvironment(environment), signal);
      if (pointer === undefined) {
        throw new CmsError({
          code: "CMS_DELIVERY_012",
          message: `The ${environment} release pointer does not exist.`,
          category: "storage",
          retryable: true,
        });
      }
      return { releaseId: pointer.releaseId };
    },
    async readFile(releaseId, path, signal) {
      const release = await store.readRelease(releaseId, signal);
      const source = release?.files[path];
      if (source === undefined) {
        throw new CmsError({
          code: "CMS_DELIVERY_013",
          message: `Release ${releaseId} does not contain ${path}.`,
          category: "storage",
          retryable: false,
        });
      }
      return source;
    },
  };
}

export function previewSource(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}): ContentSource {
  const fetcher = input.fetch ?? globalThis.fetch;
  const baseUrl = input.baseUrl.replace(/\/$/u, "");
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${input.token}`,
  };
  return {
    async readPointer(environment, signal) {
      const response = await fetcher(
        `${baseUrl}/pointer?environment=${encodeURIComponent(environment)}`,
        {
          headers,
          cache: "no-store",
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!response.ok) throw new Error(`Preview pointer request failed with ${response.status}.`);
      return (await response.json()) as { readonly releaseId: ReleaseId };
    },
    async readFile(releaseId, path, signal) {
      const response = await fetcher(
        `${baseUrl}/releases/${encodeURIComponent(releaseId)}/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        {
          headers,
          cache: "no-store",
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!response.ok) throw new Error(`Preview content request failed with ${response.status}.`);
      return response.text();
    },
  };
}

async function responseBody(
  body: { transformToString(): Promise<string> } | undefined,
): Promise<string> {
  if (body === undefined) throw new Error("Storage object has no body.");
  return body.transformToString();
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  return (error as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

function isConditionalConflict(error: unknown): boolean {
  const status = statusCode(error);
  return status === 409 || status === 412;
}

function releaseContentType(path: string): string {
  if (path.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/json; charset=utf-8";
}

export class S3ReleaseStore implements ReleaseStore {
  constructor(
    private readonly options: {
      readonly client: S3Client;
      readonly bucket: string;
      readonly prefix?: string;
    },
  ) {}

  private key(path: string): string {
    const prefix = this.options.prefix?.replace(/^\/|\/$/g, "");
    return prefix === undefined || prefix.length === 0 ? path : `${prefix}/${path}`;
  }

  async writeRelease(release: StoredRelease, signal?: AbortSignal): Promise<void> {
    await Promise.all(
      Object.entries(release.files).map(async ([path, content]) => {
        const key = this.key(`releases/${release.id}/${path}`);
        try {
          await this.options.client.send(
            new PutObjectCommand({
              Bucket: this.options.bucket,
              Key: key,
              Body: content,
              ContentType: releaseContentType(path),
              CacheControl: "public, max-age=31536000, immutable",
              IfNoneMatch: "*",
            }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
        } catch (error) {
          if (!isConditionalConflict(error)) throw error;
          const existing = await this.options.client.send(
            new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
          if ((await responseBody(existing.Body)) !== content) {
            throw new CmsError({
              code: "CMS_STORAGE_010",
              message: `Immutable release file ${path} already exists with different content.`,
              category: "storage",
              retryable: false,
            });
          }
        }
      }),
    );
  }

  async readRelease(id: ReleaseId, signal?: AbortSignal): Promise<StoredRelease | undefined> {
    try {
      const files: Record<string, string> = {};
      let continuationToken: string | undefined;
      do {
        const listed = await this.options.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: this.key(`releases/${id}/`),
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
        const pageFiles = await Promise.all(
          (listed.Contents ?? []).map(async (object) => {
            if (object.Key === undefined) return undefined;
            const response = await this.options.client.send(
              new GetObjectCommand({ Bucket: this.options.bucket, Key: object.Key }),
              signal === undefined ? undefined : { abortSignal: signal },
            );
            const marker = `/releases/${id}/`;
            const markerIndex = `/${object.Key}`.indexOf(marker);
            const path =
              markerIndex >= 0 ? `/${object.Key}`.slice(markerIndex + marker.length) : object.Key;
            return { path, content: await responseBody(response.Body) };
          }),
        );
        for (const file of pageFiles
          .filter((entry): entry is { readonly path: string; readonly content: string } =>
            Boolean(entry),
          )
          .sort((left, right) => left.path.localeCompare(right.path))) {
          files[file.path] = file.content;
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);
      const manifestSource = files["manifest.json"];
      if (manifestSource === undefined) return undefined;
      return {
        id,
        manifest: JSON.parse(manifestSource) as Readonly<Record<string, unknown>>,
        files,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async listReleases(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly items: readonly StoredRelease[]; readonly nextCursor?: string }> {
    const prefix = this.key("releases/");
    const response = await this.options.client.send(
      new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        Delimiter: "/",
        ...(input.cursor === undefined ? {} : { ContinuationToken: input.cursor }),
      }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    const ids = (response.CommonPrefixes ?? [])
      .map(({ Prefix }) =>
        Prefix === undefined || !Prefix.startsWith(prefix)
          ? undefined
          : Prefix.slice(prefix.length).replace(/\/$/u, ""),
      )
      .filter((id): id is ReleaseId => id?.startsWith("rel_") === true);
    const releases = await Promise.all(ids.map((id) => this.readRelease(id, input.signal)));
    return {
      items: releases.filter((release): release is StoredRelease => release !== undefined),
      ...(response.NextContinuationToken === undefined
        ? {}
        : { nextCursor: response.NextContinuationToken }),
    };
  }

  async readPointer(
    environment: EnvironmentPointer["environment"],
    signal?: AbortSignal,
  ): Promise<EnvironmentPointer | undefined> {
    try {
      const response = await this.options.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: this.key(`environments/${environment}/current.json`),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      return JSON.parse(await responseBody(response.Body)) as EnvironmentPointer;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async compareAndSwapPointer(input: {
    readonly next: EnvironmentPointer;
    readonly expectedRevision?: string;
    readonly signal?: AbortSignal;
  }): Promise<EnvironmentPointer> {
    const key = this.key(`environments/${input.next.environment}/current.json`);
    let current: EnvironmentPointer | undefined;
    let etag: string | undefined;
    try {
      const response = await this.options.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
      current = JSON.parse(await responseBody(response.Body)) as EnvironmentPointer;
      etag = response.ETag;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      )) {
        throw error;
      }
    }
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new CmsError({
        code: "CMS_STORAGE_009",
        message: "The environment pointer changed during publication.",
        category: "conflict",
        retryable: true,
      });
    }
    try {
      await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: canonicalJson(input.next),
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store, max-age=0",
          ...(etag === undefined ? { IfNoneMatch: "*" } : { IfMatch: etag }),
        }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      throw new CmsError({
        code: "CMS_STORAGE_009",
        message: "The environment pointer changed during publication.",
        category: "conflict",
        retryable: true,
        cause: error,
      });
    }
    return input.next;
  }
}
