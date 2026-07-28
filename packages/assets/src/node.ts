import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Asset, AssetStore, Page } from "@git-native-cms/application";
import { CmsError, type Actor, type AssetId } from "@git-native-cms/core";
import { assetBytesMatchMime, type AssetVirusScanner } from "./index.js";

interface PendingLocalUpload {
  readonly uploadId: string;
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
  readonly actor: Actor;
  readonly createdAt: string;
}

export interface FileSystemAssetStoreOptions {
  readonly root: string;
  readonly publicBaseUrl: string;
  readonly uploadBaseUrl?: string;
  readonly maximumUploadBytes?: number;
  readonly allowedMimeTypes?: readonly string[];
  readonly virusScanner?: AssetVirusScanner;
}

function safeFileName(value: string): string {
  const name = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .slice(0, 120);
  return name.length === 0 || name === "." || name === ".." ? "asset" : name;
}

function checksum(value: string): string {
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
  options: FileSystemAssetStoreOptions,
): void {
  const maximum = options.maximumUploadBytes ?? 25 * 1024 * 1024;
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
      message: `Uploads must be between 1 byte and ${String(maximum)} bytes.`,
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

export class FileSystemAssetStore implements AssetStore {
  private readonly root: string;
  private readonly pending = new Map<string, PendingLocalUpload>();

  constructor(private readonly options: FileSystemAssetStoreOptions) {
    this.root = resolve(options.root);
  }

  private pendingPath(uploadId: string): string {
    return join(this.root, "uploads", `${uploadId}.bin`);
  }

  private metadataPath(checksumValue: string): string {
    return join(this.root, "assets", checksumValue, "asset.json");
  }

  async createUpload(input: Parameters<AssetStore["createUpload"]>[0]): Promise<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }> {
    validateUpload(input, this.options);
    const uploadId = `upl_${globalThis.crypto.randomUUID()}`;
    const token = globalThis.crypto.randomUUID();
    const pending: PendingLocalUpload = {
      uploadId,
      token,
      fileName: safeFileName(input.fileName),
      mimeType: input.mimeType,
      size: input.size,
      checksum: checksum(input.checksum),
      actor: input.actor,
      createdAt: new Date().toISOString(),
    };
    this.pending.set(uploadId, pending);
    await mkdir(join(this.root, "uploads"), { recursive: true });
    await writeFile(
      join(this.root, "uploads", `${uploadId}.json`),
      `${JSON.stringify(pending, null, 2)}\n`,
      { flag: "wx" },
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
    const pending = await this.pendingUpload(input.uploadId);
    if (
      pending.token !== input.token ||
      pending.mimeType !== input.mimeType ||
      pending.size !== input.bytes.byteLength
    ) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The local upload does not match its signed upload session.",
        category: "validation",
        retryable: false,
      });
    }
    await writeFile(this.pendingPath(input.uploadId), input.bytes, { flag: "wx" });
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    input.signal?.throwIfAborted();
    const pending = await this.pendingUpload(input.uploadId);
    const expectedChecksum = checksum(input.checksum);
    const bytes = new Uint8Array(await readFile(this.pendingPath(input.uploadId)));
    if (
      pending.checksum !== expectedChecksum ||
      (await sha256(bytes)) !== expectedChecksum ||
      !assetBytesMatchMime(bytes, pending.mimeType)
    ) {
      throw new CmsError({
        code: "CMS_ASSET_003",
        message: "The local upload failed checksum or media-type verification.",
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
        await this.removePending(pending.uploadId);
        throw new CmsError({
          code: "CMS_ASSET_010",
          message: "The upload was rejected by the configured malware scanner.",
          category: "validation",
          retryable: false,
          ...(scan.threat === undefined ? {} : { context: { threat: scan.threat } }),
        });
      }
    }
    const existing = await this.assetFromChecksum(expectedChecksum);
    if (existing !== undefined) {
      await this.removePending(pending.uploadId);
      return existing;
    }
    const directory = join(this.root, "assets", expectedChecksum);
    await mkdir(directory, { recursive: true });
    const originalPath = join(directory, pending.fileName);
    await rename(this.pendingPath(pending.uploadId), originalPath);
    const asset: Asset = {
      id: `ast_${expectedChecksum.slice(0, 24)}` as AssetId,
      fileName: pending.fileName,
      mimeType: pending.mimeType,
      size: pending.size,
      checksum: expectedChecksum,
      url: `${this.options.publicBaseUrl.replace(/\/$/u, "")}/assets/${expectedChecksum}/${encodeURIComponent(pending.fileName)}`,
    };
    await writeFile(this.metadataPath(expectedChecksum), `${JSON.stringify(asset, null, 2)}\n`, {
      flag: "wx",
    });
    await unlink(join(this.root, "uploads", `${pending.uploadId}.json`)).catch(() => undefined);
    this.pending.delete(pending.uploadId);
    return asset;
  }

  async readAsset(id: AssetId): Promise<Asset | undefined> {
    const assets = await this.listAssets({});
    return assets.items.find((asset) => asset.id === id);
  }

  async updateAssetMetadata(
    input: Parameters<AssetStore["updateAssetMetadata"]>[0],
  ): Promise<Asset> {
    input.signal?.throwIfAborted();
    const existing = await this.readAsset(input.id);
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
    await writeFile(this.metadataPath(asset.checksum), `${JSON.stringify(asset, null, 2)}\n`);
    return asset;
  }

  async deleteAsset(id: AssetId): Promise<void> {
    const asset = await this.readAsset(id);
    if (asset === undefined) return;
    await rm(join(this.root, "assets", asset.checksum), { recursive: true });
  }

  async listAssets(input: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<Page<Asset>> {
    input.signal?.throwIfAborted();
    const directory = join(this.root, "assets");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const checksums = entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const offset = Number(input.cursor ?? "0");
    const page = checksums.slice(offset, offset + 100);
    const assets = await Promise.all(page.map((value) => this.assetFromChecksum(value)));
    return {
      items: assets.filter((asset): asset is Asset => asset !== undefined),
      ...(offset + page.length < checksums.length
        ? { nextCursor: String(offset + page.length) }
        : {}),
    };
  }

  async cleanupOrphanedUploads(input: {
    readonly olderThan: Date;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]> {
    input.signal?.throwIfAborted();
    const directory = join(this.root, "uploads");
    const entries = await readdir(directory).catch(() => []);
    const ids = [...new Set(entries.map((entry) => entry.replace(/\.(?:bin|json)$/u, "")))];
    const removed: string[] = [];
    for (const id of ids) {
      const paths = [this.pendingPath(id), join(directory, `${id}.json`)];
      const dates = await Promise.all(
        paths.map((path) =>
          stat(path)
            .then((value) => value.mtime)
            .catch(() => undefined),
        ),
      );
      if (dates.some((date) => date !== undefined && date < input.olderThan)) {
        await this.removePending(id);
        removed.push(id);
      }
    }
    return removed.sort();
  }

  private async pendingUpload(uploadId: string): Promise<PendingLocalUpload> {
    const memory = this.pending.get(uploadId);
    if (memory !== undefined) return memory;
    try {
      const value = JSON.parse(
        await readFile(join(this.root, "uploads", `${uploadId}.json`), "utf8"),
      ) as PendingLocalUpload;
      this.pending.set(uploadId, value);
      return value;
    } catch (cause) {
      throw new CmsError({
        code: "CMS_ASSET_005",
        message: "The local upload session does not exist or expired.",
        category: "validation",
        retryable: false,
        cause,
      });
    }
  }

  private async assetFromChecksum(checksumValue: string): Promise<Asset | undefined> {
    try {
      return JSON.parse(await readFile(this.metadataPath(checksumValue), "utf8")) as Asset;
    } catch {
      return undefined;
    }
  }

  private async removePending(uploadId: string): Promise<void> {
    await Promise.all([
      unlink(this.pendingPath(uploadId)).catch(() => undefined),
      unlink(join(this.root, "uploads", `${uploadId}.json`)).catch(() => undefined),
    ]);
    this.pending.delete(uploadId);
  }
}
