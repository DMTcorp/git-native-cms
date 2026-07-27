import type { Asset, AssetStore, Page } from "@git-native-cms/application";
import { CmsError, type AssetId } from "@git-native-cms/core";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3AssetStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly publicBaseUrl: string;
  readonly uploadTtlSeconds?: number;
  readonly maximumUploadBytes?: number;
  readonly allowedMimeTypes?: readonly string[];
}

interface PendingUpload {
  readonly id: string;
  readonly key: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: number;
}

function safeFileName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 120);
  return normalized.length === 0 || normalized === "." || normalized === ".."
    ? "asset"
    : normalized;
}

function validateUpload(
  input: { readonly mimeType: string; readonly size: number },
  options: S3AssetStoreOptions,
): void {
  const maximumUploadBytes = options.maximumUploadBytes ?? 25 * 1024 * 1024;
  const allowedMimeTypes = options.allowedMimeTypes ?? [
    "image/avif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ];
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maximumUploadBytes) {
    throw new CmsError({
      code: "CMS_ASSET_001",
      message: `Uploads must be between 1 byte and ${maximumUploadBytes} bytes.`,
      category: "validation",
      retryable: false,
    });
  }
  if (!allowedMimeTypes.includes(input.mimeType) || input.mimeType === "image/svg+xml") {
    throw new CmsError({
      code: "CMS_ASSET_002",
      message: `The file type ${input.mimeType} is not allowed.`,
      category: "validation",
      retryable: false,
    });
  }
}

export class S3AssetStore implements AssetStore {
  private readonly pending = new Map<string, PendingUpload>();
  constructor(private readonly options: S3AssetStoreOptions) {}

  async createUpload(input: Parameters<AssetStore["createUpload"]>[0]): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }> {
    validateUpload(input, this.options);
    const uploadId = `upl_${globalThis.crypto.randomUUID()}`;
    const fileName = safeFileName(input.fileName);
    const key = `uploads/${uploadId}/${fileName}`;
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ContentType: input.mimeType,
      ContentLength: input.size,
      Metadata: { uploadId, actorId: input.actor.id },
    });
    const url = await getSignedUrl(this.options.client, command, {
      expiresIn: this.options.uploadTtlSeconds ?? 900,
    });
    this.pending.set(uploadId, {
      id: uploadId,
      key,
      fileName,
      mimeType: input.mimeType,
      size: input.size,
      createdAt: Date.now(),
    });
    return { uploadId, url, headers: { "content-type": input.mimeType } };
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    const pending = this.pending.get(input.uploadId);
    if (pending === undefined) throw new Error("Upload session does not exist or expired.");
    const response = await this.options.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: pending.key }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    const size = response.ContentLength ?? pending.size;
    if (size !== pending.size || response.ContentType !== pending.mimeType) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The uploaded object does not match the declared size or media type.",
        category: "validation",
        retryable: false,
      });
    }
    if (!/^[a-f0-9]{64}$/i.test(input.checksum)) {
      throw new CmsError({
        code: "CMS_ASSET_004",
        message: "A SHA-256 checksum is required to finalize an upload.",
        category: "validation",
        retryable: false,
      });
    }
    const id = `ast_${input.checksum.slice(0, 24)}` as AssetId;
    const assetKey = `assets/${input.checksum.toLowerCase()}/${pending.fileName}`;
    await this.options.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: assetKey,
        CopySource: encodeURIComponent(`${this.options.bucket}/${pending.key}`).replaceAll(
          "%2F",
          "/",
        ),
        ContentType: pending.mimeType,
        MetadataDirective: "REPLACE",
        Metadata: {
          assetId: id,
          sha256: input.checksum.toLowerCase(),
          originalFileName: pending.fileName,
        },
      }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    await this.options.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: pending.key }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    this.pending.delete(input.uploadId);
    return {
      id,
      fileName: pending.fileName,
      mimeType: response.ContentType ?? pending.mimeType,
      size,
      checksum: input.checksum,
      url: `${this.options.publicBaseUrl.replace(/\/$/, "")}/${assetKey}`,
    };
  }

  async readAsset(id: AssetId): Promise<Asset | undefined> {
    const result = await this.listAssets({});
    return result.items.find((asset) => asset.id === id);
  }

  async deleteAsset(id: AssetId, signal?: AbortSignal): Promise<void> {
    const asset = await this.readAsset(id);
    if (asset === undefined) return;
    const key = new URL(asset.url).pathname.replace(/^\//, "");
    await this.options.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
  }

  async listAssets(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<Asset>> {
    const response = await this.options.client.send(
      new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: "assets/",
        ContinuationToken: input.cursor,
      }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    return {
      items: (response.Contents ?? []).flatMap((object) => {
        if (object.Key === undefined) return [];
        const fileName = object.Key.split("/").at(-1) ?? object.Key;
        const checksum = object.Key.split("/")[1] ?? object.ETag?.replaceAll('"', "") ?? "";
        return [
          {
            id: `ast_${checksum.slice(0, 24)}` as AssetId,
            fileName,
            mimeType: "application/octet-stream",
            size: object.Size ?? 0,
            checksum,
            url: `${this.options.publicBaseUrl.replace(/\/$/, "")}/${object.Key}`,
          },
        ];
      }),
      ...(response.NextContinuationToken === undefined
        ? {}
        : { nextCursor: response.NextContinuationToken }),
    };
  }

  async cleanupOrphanedUploads(input: {
    readonly olderThan: Date;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]> {
    const expired = [...this.pending.values()].filter(
      (upload) => upload.createdAt < input.olderThan.getTime(),
    );
    await Promise.all(
      expired.map((upload) =>
        this.options.client.send(
          new DeleteObjectCommand({ Bucket: this.options.bucket, Key: upload.key }),
          input.signal === undefined ? undefined : { abortSignal: input.signal },
        ),
      ),
    );
    for (const upload of expired) this.pending.delete(upload.id);
    return expired.map((upload) => upload.id);
  }
}

export interface AssetUsage {
  readonly assetId: AssetId;
  readonly paths: readonly string[];
}

export function buildAssetUsageGraph(documents: readonly unknown[]): readonly AssetUsage[] {
  const graph = new Map<AssetId, Set<string>>();
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Readonly<Record<string, unknown>>;
    if (typeof record.id === "string" && record.id.startsWith("ast_")) {
      const id = record.id as AssetId;
      const usages = graph.get(id) ?? new Set<string>();
      usages.add(path);
      graph.set(id, usages);
    }
    for (const [key, child] of Object.entries(record)) {
      visit(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  }
  documents.forEach((document, index) => visit(document, `/documents/${index}`));
  return [...graph.entries()]
    .map(([assetId, paths]) => ({ assetId, paths: [...paths].sort() }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function assertAssetCanBeDeleted(
  assetId: AssetId,
  usageGraph: readonly AssetUsage[],
  releasedAssetIds: ReadonlySet<AssetId>,
): void {
  const usages = usageGraph.find((usage) => usage.assetId === assetId)?.paths ?? [];
  if (usages.length > 0 || releasedAssetIds.has(assetId)) {
    throw new CmsError({
      code: "CMS_ASSET_009",
      message: "This asset is still used by content or an immutable release.",
      category: "conflict",
      retryable: false,
      context: { usages, released: releasedAssetIds.has(assetId) },
    });
  }
}
