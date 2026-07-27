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
      Object.entries(release.files).map(([path, content]) =>
        this.options.client.send(
          new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: this.key(`releases/${release.id}/${path}`),
            Body: content,
            ContentType: "application/json; charset=utf-8",
            CacheControl: "public, max-age=31536000, immutable",
            IfNoneMatch: "*",
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        ),
      ),
    );
  }

  async readRelease(id: ReleaseId, signal?: AbortSignal): Promise<StoredRelease | undefined> {
    try {
      const listed = await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.key(`releases/${id}/`),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      const files: Record<string, string> = {};
      await Promise.all(
        (listed.Contents ?? []).map(async (object) => {
          if (object.Key === undefined) return;
          const response = await this.options.client.send(
            new GetObjectCommand({ Bucket: this.options.bucket, Key: object.Key }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
          const marker = `/releases/${id}/`;
          const markerIndex = `/${object.Key}`.indexOf(marker);
          const path =
            markerIndex >= 0 ? `/${object.Key}`.slice(markerIndex + marker.length) : object.Key;
          files[path] = await responseBody(response.Body);
        }),
      );
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
    return input.next;
  }
}
