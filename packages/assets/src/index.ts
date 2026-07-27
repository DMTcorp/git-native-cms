import type { Asset, AssetStore, Page } from "@git-native-cms/application";
import { CmsError, type AssetId } from "@git-native-cms/core";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
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
  readonly checksum: string;
  readonly createdAt: number;
}

interface ListedObject {
  readonly Key?: string | undefined;
  readonly Size?: number | undefined;
}

function publicAssetUrl(options: S3AssetStoreOptions, key: string): string {
  return `${options.publicBaseUrl.replace(/\/$/u, "")}/${key}`;
}

async function materializeAsset(
  options: S3AssetStoreOptions,
  checksum: string,
  original: ListedObject & { readonly Key: string },
  objects: readonly ListedObject[],
  signal?: AbortSignal,
): Promise<Asset> {
  const head = await options.client.send(
    new HeadObjectCommand({ Bucket: options.bucket, Key: original.Key }),
    signal === undefined ? undefined : { abortSignal: signal },
  );
  const variants = await Promise.all(
    objects
      .filter(
        (object): object is ListedObject & { readonly Key: string } =>
          object.Key?.startsWith(`assets/${checksum}/variants/`) === true,
      )
      .map(async (object) => {
        const variantHead = await options.client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: object.Key }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
        const fileName = object.Key.split("/").at(-1) ?? "";
        const parsedWidth = Number.parseInt(fileName.split(".")[0] ?? "", 10);
        const width = Number(variantHead.Metadata?.width ?? parsedWidth);
        const height = Number(variantHead.Metadata?.height ?? width);
        const format =
          variantHead.Metadata?.format ??
          variantHead.ContentType?.replace(/^image\//u, "") ??
          fileName.split(".").at(-1) ??
          "unknown";
        return {
          width: Number.isFinite(width) ? width : 0,
          height: Number.isFinite(height) ? height : 0,
          format,
          url: publicAssetUrl(options, object.Key),
        };
      }),
  );
  const fileName = head.Metadata?.originalfilename ?? original.Key.split("/").at(-1) ?? "asset";
  return {
    id: `ast_${checksum.slice(0, 24)}` as AssetId,
    fileName,
    mimeType: head.ContentType ?? "application/octet-stream",
    size: head.ContentLength ?? original.Size ?? 0,
    checksum,
    url: publicAssetUrl(options, original.Key),
    ...(variants.length === 0
      ? {}
      : {
          variants: variants.sort(
            (left, right) => left.width - right.width || left.format.localeCompare(right.format),
          ),
        }),
  };
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

function normalizedChecksum(value: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new CmsError({
      code: "CMS_ASSET_004",
      message: "A SHA-256 checksum is required for an upload.",
      category: "validation",
      retryable: false,
    });
  }
  return value.toLowerCase();
}

async function uploadedObject(
  body: { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly checksum: string }> {
  if (body === undefined) {
    throw new CmsError({
      code: "CMS_ASSET_003",
      message: "The uploaded object body is missing.",
      category: "storage",
      retryable: true,
    });
  }
  const bytes = await body.transformToByteArray();
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", digestInput));
  return {
    bytes,
    checksum: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function assetBytesMatchMime(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes[0] === 0x89 &&
        ascii(bytes, 1, 4) === "PNG" &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "image/avif":
      return ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12));
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    default:
      return false;
  }
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
    const checksum = normalizedChecksum(input.checksum);
    const uploadId = `upl_${globalThis.crypto.randomUUID()}`;
    const fileName = safeFileName(input.fileName);
    const key = `uploads/${uploadId}/${fileName}`;
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ContentType: input.mimeType,
      ContentLength: input.size,
      Metadata: {
        uploadId,
        actorId: input.actor.id,
        declaredSize: String(input.size),
        declaredMime: input.mimeType,
        declaredSha256: checksum,
        originalFileName: fileName,
      },
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
      checksum,
      createdAt: Date.now(),
    });
    return {
      uploadId,
      url,
      headers: {
        "content-type": input.mimeType,
      },
    };
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    const checksum = normalizedChecksum(input.checksum);
    let pending = this.pending.get(input.uploadId);
    if (pending === undefined) {
      const listed = await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: `uploads/${input.uploadId}/`,
          MaxKeys: 2,
        }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
      const key = listed.Contents?.[0]?.Key;
      if (key === undefined || (listed.Contents?.length ?? 0) !== 1) {
        const assetPrefix = `assets/${input.checksum.toLowerCase()}/`;
        const finalized = await this.options.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: assetPrefix,
          }),
          input.signal === undefined ? undefined : { abortSignal: input.signal },
        );
        const originalKey = finalized.Contents?.find(
          (object) => object.Key?.split("/").length === 3,
        )?.Key;
        if (originalKey !== undefined) {
          return materializeAsset(
            this.options,
            input.checksum.toLowerCase(),
            { Key: originalKey },
            finalized.Contents ?? [],
            input.signal,
          );
        }
        throw new CmsError({
          code: "CMS_ASSET_005",
          message: "Upload session does not exist, is ambiguous, or expired.",
          category: "validation",
          retryable: false,
        });
      }
      const head = await this.options.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
      const fileName = head.Metadata?.originalfilename ?? key.split("/").at(-1) ?? "asset";
      pending = {
        id: input.uploadId,
        key,
        fileName,
        mimeType: head.Metadata?.declaredmime ?? head.ContentType ?? "application/octet-stream",
        size: Number(head.Metadata?.declaredsize ?? head.ContentLength ?? 0),
        checksum: normalizedChecksum(head.Metadata?.declaredsha256 ?? ""),
        createdAt: head.LastModified?.getTime() ?? Date.now(),
      };
    }
    const response = await this.options.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: pending.key }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    const size = response.ContentLength ?? pending.size;
    const uploaded = await this.options.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: pending.key }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    const actual = await uploadedObject(uploaded.Body);
    if (
      size !== pending.size ||
      response.ContentType !== pending.mimeType ||
      pending.checksum !== checksum ||
      response.Metadata?.declaredsha256 !== checksum ||
      actual.checksum !== checksum ||
      !assetBytesMatchMime(actual.bytes, pending.mimeType)
    ) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The uploaded object does not match the declared size or media type.",
        category: "validation",
        retryable: false,
      });
    }
    const id = `ast_${checksum.slice(0, 24)}` as AssetId;
    const assetKey = `assets/${checksum}/${pending.fileName}`;
    await this.options.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: assetKey,
        CopySource: encodeURIComponent(`${this.options.bucket}/${pending.key}`).replaceAll(
          "%2F",
          "/",
        ),
        ContentType: pending.mimeType,
        CacheControl: "public, max-age=31536000, immutable",
        MetadataDirective: "REPLACE",
        Metadata: {
          assetId: id,
          sha256: checksum,
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
      checksum,
      url: publicAssetUrl(this.options, assetKey),
    };
  }

  async readAsset(id: AssetId): Promise<Asset | undefined> {
    const result = await this.listAssets({});
    return result.items.find((asset) => asset.id === id);
  }

  async deleteAsset(id: AssetId, signal?: AbortSignal): Promise<void> {
    const asset = await this.readAsset(id);
    if (asset === undefined) return;
    const prefix = `assets/${asset.checksum.toLowerCase()}/`;
    const listed = await this.options.client.send(
      new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    await this.options.client.send(
      new DeleteObjectsCommand({
        Bucket: this.options.bucket,
        Delete: {
          Objects: (listed.Contents ?? []).flatMap((object) =>
            object.Key === undefined ? [] : [{ Key: object.Key }],
          ),
          Quiet: true,
        },
      }),
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
    const objects = response.Contents ?? [];
    const originals = objects.filter(
      (object): object is typeof object & { readonly Key: string } =>
        object.Key?.split("/").length === 3,
    );
    return {
      items: await Promise.all(
        originals.map((original) => {
          const checksum = original.Key.split("/")[1] ?? "";
          return materializeAsset(this.options, checksum, original, objects, input.signal);
        }),
      ),
      ...(response.NextContinuationToken === undefined
        ? {}
        : { nextCursor: response.NextContinuationToken }),
    };
  }

  async cleanupOrphanedUploads(input: {
    readonly olderThan: Date;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]> {
    const remembered = [...this.pending.values()].filter(
      (upload) => upload.createdAt < input.olderThan.getTime(),
    );
    const listed = await this.options.client.send(
      new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: "uploads/" }),
      input.signal === undefined ? undefined : { abortSignal: input.signal },
    );
    const discovered: PendingUpload[] = (listed.Contents ?? []).flatMap((object) => {
      if (
        object.Key === undefined ||
        object.LastModified === undefined ||
        object.LastModified >= input.olderThan
      ) {
        return [];
      }
      const [, id, fileName = "asset"] = object.Key.split("/");
      if (id === undefined) return [];
      return [
        {
          id,
          key: object.Key,
          fileName,
          mimeType: "application/octet-stream",
          size: object.Size ?? 0,
          checksum: "",
          createdAt: object.LastModified.getTime(),
        },
      ];
    });
    const expired = [
      ...new Map([...remembered, ...discovered].map((upload) => [upload.key, upload])).values(),
    ];
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
