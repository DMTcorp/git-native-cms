import type { EnvironmentPointer, ReleaseStore, StoredRelease } from "@git-native-cms/application";
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

export function createContentClient(input: {
  readonly environment: "preview" | "staging" | "production";
  readonly source: ContentSource;
  readonly fallbackReleaseId?: ReleaseId;
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
  return {
    async readPointer(environment, signal) {
      const response = await fetcher(`${baseUrl}/environments/${environment}/current.json`, {
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`Pointer request failed with ${response.status}.`);
      return (await response.json()) as { releaseId: ReleaseId };
    },
    async readFile(releaseId, path, signal) {
      const response = await fetcher(`${baseUrl}/releases/${releaseId}/${path}`, {
        cache: "force-cache",
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`Content request failed with ${response.status}.`);
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
