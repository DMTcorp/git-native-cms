import { Buffer } from "node:buffer";
import type { Asset, AssetStore, GitProvider, Page } from "@git-native-cms/application";
import { CmsError, type Actor, type AssetId } from "@git-native-cms/core";
import { assetBytesMatchMime, type AssetVirusScanner } from "./index.js";

interface PendingGitUpload {
  readonly uploadId: string;
  readonly tokenDigest: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
  readonly actor: Actor;
  readonly createdAt: string;
}

export interface GitAssetStoreOptions {
  readonly git: GitProvider;
  readonly ref?: string;
  readonly publicBaseUrl: string;
  readonly uploadBaseUrl?: string;
  readonly maximumUploadBytes?: number;
  readonly allowedMimeTypes?: readonly string[];
  readonly virusScanner?: AssetVirusScanner;
  readonly systemActor: Actor;
}

function safeFileName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
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

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateUpload(
  input: { readonly mimeType: string; readonly size: number },
  options: GitAssetStoreOptions,
): void {
  const maximum = options.maximumUploadBytes ?? 10 * 1024 * 1024;
  const allowed = options.allowedMimeTypes ?? [
    "image/avif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ];
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > maximum) {
    throw new CmsError({
      code: "CMS_ASSET_001",
      message: `Git asset uploads must be between 1 byte and ${String(maximum)} bytes.`,
      category: "validation",
      retryable: false,
    });
  }
  if (!allowed.includes(input.mimeType) || input.mimeType === "image/svg+xml") {
    throw new CmsError({
      code: "CMS_ASSET_002",
      message: `The file type ${input.mimeType} is not allowed.`,
      category: "validation",
      retryable: false,
    });
  }
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class GitAssetStore implements AssetStore {
  private readonly ref: string;

  constructor(private readonly options: GitAssetStoreOptions) {
    this.ref = options.ref ?? "main";
  }

  async createUpload(input: Parameters<AssetStore["createUpload"]>[0]): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }> {
    input.signal?.throwIfAborted();
    validateUpload(input, this.options);
    const uploadId = `upl_${globalThis.crypto.randomUUID()}`;
    const token = globalThis.crypto.randomUUID();
    const pending: PendingGitUpload = {
      uploadId,
      tokenDigest: await sha256(new TextEncoder().encode(token)),
      fileName: safeFileName(input.fileName),
      mimeType: input.mimeType,
      size: input.size,
      checksum: normalizedChecksum(input.checksum),
      actor: input.actor,
      createdAt: new Date().toISOString(),
    };
    await this.commit(
      [
        {
          path: this.pendingMetadataPath(uploadId),
          content: `${JSON.stringify(pending, null, 2)}\n`,
        },
      ],
      `Prepare asset upload "${pending.fileName}"`,
      input.actor,
      input.signal,
    );
    const base = (this.options.uploadBaseUrl ?? "/api/cms/assets/uploads").replace(/\/$/u, "");
    return {
      uploadId,
      url: `${base}/${encodeURIComponent(uploadId)}/content`,
      headers: {
        "content-type": input.mimeType,
        "x-cms-upload-token": token,
      },
    };
  }

  async uploadBytes(input: {
    readonly uploadId: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly token?: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    input.signal?.throwIfAborted();
    const pending = await this.pendingUpload(input.uploadId, input.signal);
    const tokenDigest = await sha256(new TextEncoder().encode(input.token ?? ""));
    if (
      tokenDigest !== pending.tokenDigest ||
      input.mimeType !== pending.mimeType ||
      input.bytes.byteLength !== pending.size
    ) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The Git upload does not match its signed upload session.",
        category: "validation",
        retryable: false,
      });
    }
    await this.commit(
      [
        {
          path: this.pendingContentPath(input.uploadId),
          content: Buffer.from(input.bytes).toString("base64"),
        },
      ],
      `Receive asset upload "${pending.fileName}"`,
      pending.actor,
      input.signal,
    );
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    input.signal?.throwIfAborted();
    const expectedChecksum = normalizedChecksum(input.checksum);
    const existing = await this.assetFromChecksum(expectedChecksum, input.signal);
    if (existing !== undefined) return existing;
    const pending = await this.pendingUpload(input.uploadId, input.signal);
    const encoded = await this.options.git.readFile({
      ref: this.ref,
      path: this.pendingContentPath(input.uploadId),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (encoded === undefined) {
      throw new CmsError({
        code: "CMS_ASSET_005",
        message: "The Git upload has no received content.",
        category: "validation",
        retryable: false,
      });
    }
    const bytes = new Uint8Array(Buffer.from(encoded.content, "base64"));
    if (
      pending.checksum !== expectedChecksum ||
      (await sha256(bytes)) !== expectedChecksum ||
      !assetBytesMatchMime(bytes, pending.mimeType)
    ) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The Git upload failed checksum or media-type verification.",
        category: "validation",
        retryable: false,
      });
    }
    if (this.options.virusScanner !== undefined) {
      const scan = await this.options.virusScanner.scan({
        bytes,
        fileName: pending.fileName,
        mimeType: pending.mimeType,
        checksum: expectedChecksum,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!scan.clean) {
        await this.discardPending(pending, input.signal);
        throw new CmsError({
          code: "CMS_ASSET_010",
          message: "The upload was rejected by the configured malware scanner.",
          category: "validation",
          retryable: false,
          ...(scan.threat === undefined ? {} : { context: { threat: scan.threat } }),
        });
      }
    }
    const path = this.assetContentPath(expectedChecksum, pending.fileName);
    const asset: Asset = {
      id: `ast_${expectedChecksum.slice(0, 24)}` as AssetId,
      fileName: pending.fileName,
      mimeType: pending.mimeType,
      size: pending.size,
      checksum: expectedChecksum,
      url: `${this.options.publicBaseUrl.replace(/\/$/u, "")}/${encodedPath(path)}`,
    };
    await this.commit(
      [
        { path, content: encoded.content, encoding: "base64" },
        {
          path: this.assetMetadataPath(expectedChecksum),
          content: `${JSON.stringify(asset, null, 2)}\n`,
        },
        { path: this.pendingMetadataPath(input.uploadId), content: null },
        { path: this.pendingContentPath(input.uploadId), content: null },
      ],
      `Add asset "${pending.fileName}"`,
      pending.actor,
      input.signal,
    );
    return asset;
  }

  async readAsset(id: AssetId, signal?: AbortSignal): Promise<Asset | undefined> {
    const files = await this.options.git.listFiles({
      ref: this.ref,
      prefix: "assets/metadata/",
      ...(signal === undefined ? {} : { signal }),
    });
    for (const file of files) {
      const asset = this.parseAsset(file.content);
      if (asset?.id === id) return asset;
    }
    return undefined;
  }

  async updateAssetMetadata(
    input: Parameters<AssetStore["updateAssetMetadata"]>[0],
  ): Promise<Asset> {
    input.signal?.throwIfAborted();
    const existing = await this.readAsset(input.id, input.signal);
    if (existing === undefined) {
      throw new CmsError({
        code: "CMS_ASSET_404",
        message: "The selected asset does not exist.",
        category: "validation",
        retryable: false,
      });
    }
    const stable = { ...existing };
    delete stable.altText;
    delete stable.focalPoint;
    const asset: Asset = {
      ...stable,
      ...(input.altText === undefined ? {} : { altText: input.altText }),
      ...(input.focalPoint === undefined ? {} : { focalPoint: input.focalPoint }),
    };
    await this.commit(
      [
        {
          path: this.assetMetadataPath(asset.checksum),
          content: `${JSON.stringify(asset, null, 2)}\n`,
        },
      ],
      `Update asset "${asset.fileName}"`,
      this.options.systemActor,
      input.signal,
    );
    return asset;
  }

  async deleteAsset(id: AssetId, signal?: AbortSignal): Promise<void> {
    const asset = await this.readAsset(id, signal);
    if (asset === undefined) return;
    await this.commit(
      [
        { path: this.assetMetadataPath(asset.checksum), content: null },
        { path: this.assetContentPath(asset.checksum, asset.fileName), content: null },
      ],
      `Remove asset "${asset.fileName}"`,
      this.options.systemActor,
      signal,
    );
  }

  async listAssets(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<Asset>> {
    input.signal?.throwIfAborted();
    const files = await this.options.git.listFiles({
      ref: this.ref,
      prefix: "assets/metadata/",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const assets = files
      .map((file) => this.parseAsset(file.content))
      .filter((asset): asset is Asset => asset !== undefined)
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    const offset = Number(input.cursor ?? "0");
    const page = assets.slice(offset, offset + 100);
    return {
      items: page,
      ...(offset + page.length < assets.length ? { nextCursor: String(offset + page.length) } : {}),
    };
  }

  private async commit(
    files: Parameters<GitProvider["commitFiles"]>[0]["files"],
    message: string,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = await this.options.git.resolveRef(this.ref, signal);
    await this.options.git.commitFiles({
      branch: this.ref,
      expectedSha: ref.sha,
      files,
      message,
      author: actor,
      idempotencyKey: `asset:${globalThis.crypto.randomUUID()}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async pendingUpload(uploadId: string, signal?: AbortSignal): Promise<PendingGitUpload> {
    const file = await this.options.git.readFile({
      ref: this.ref,
      path: this.pendingMetadataPath(uploadId),
      ...(signal === undefined ? {} : { signal }),
    });
    if (file === undefined) {
      throw new CmsError({
        code: "CMS_ASSET_005",
        message: "The Git upload session does not exist or expired.",
        category: "validation",
        retryable: false,
      });
    }
    return JSON.parse(file.content) as PendingGitUpload;
  }

  private async assetFromChecksum(value: string, signal?: AbortSignal): Promise<Asset | undefined> {
    const file = await this.options.git.readFile({
      ref: this.ref,
      path: this.assetMetadataPath(value),
      ...(signal === undefined ? {} : { signal }),
    });
    return file === undefined ? undefined : this.parseAsset(file.content);
  }

  private parseAsset(value: string): Asset | undefined {
    try {
      const parsed = JSON.parse(value) as Asset;
      return typeof parsed.id === "string" &&
        typeof parsed.checksum === "string" &&
        typeof parsed.url === "string"
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async discardPending(pending: PendingGitUpload, signal?: AbortSignal): Promise<void> {
    await this.commit(
      [
        { path: this.pendingMetadataPath(pending.uploadId), content: null },
        { path: this.pendingContentPath(pending.uploadId), content: null },
      ],
      `Reject asset upload "${pending.fileName}"`,
      pending.actor,
      signal,
    );
  }

  private pendingMetadataPath(uploadId: string): string {
    return `.cms/uploads/${uploadId}.json`;
  }

  private pendingContentPath(uploadId: string): string {
    return `.cms/uploads/${uploadId}.base64`;
  }

  private assetMetadataPath(value: string): string {
    return `assets/metadata/${value}.json`;
  }

  private assetContentPath(value: string, fileName: string): string {
    return `assets/files/${value}/${safeFileName(fileName)}`;
  }
}
