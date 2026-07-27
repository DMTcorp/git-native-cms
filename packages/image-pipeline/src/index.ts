export interface ImageVariantRequest {
  readonly width: number;
  readonly height?: number;
  readonly format: "avif" | "webp" | "jpeg" | "png";
  readonly quality?: number;
  readonly fit?: "cover" | "contain" | "inside";
}

export interface ImageVariant {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export async function processImage(
  source: Uint8Array,
  variants: readonly ImageVariantRequest[],
): Promise<readonly ImageVariant[]> {
  const sharp = (await import("sharp")).default;
  return Promise.all(
    variants.map(async (variant) => {
      let pipeline = sharp(source, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
        sequentialRead: true,
      })
        .rotate()
        .resize(variant.width, variant.height, {
          fit: variant.fit ?? "cover",
          withoutEnlargement: true,
        });
      switch (variant.format) {
        case "avif":
          pipeline = pipeline.avif({ quality: variant.quality ?? 65 });
          break;
        case "webp":
          pipeline = pipeline.webp({ quality: variant.quality ?? 78 });
          break;
        case "jpeg":
          pipeline = pipeline.jpeg({ quality: variant.quality ?? 82 });
          break;
        case "png":
          pipeline = pipeline.png({ compressionLevel: 9 });
          break;
      }
      const result = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        bytes: new Uint8Array(result.data),
        width: result.info.width,
        height: result.info.height,
        format: result.info.format,
      };
    }),
  );
}

export class S3ImageAssetProcessor implements AssetProcessorPort {
  constructor(
    private readonly options: {
      readonly client: S3Client;
      readonly bucket: string;
      readonly publicBaseUrl: string;
      readonly widths?: readonly number[];
    },
  ) {}

  async process(asset: Asset, signal?: AbortSignal): Promise<Asset> {
    if (!asset.mimeType.startsWith("image/")) return asset;
    const publicBase = this.options.publicBaseUrl.replace(/\/$/u, "");
    if (!asset.url.startsWith(`${publicBase}/`)) {
      throw new Error("Asset URL does not belong to the configured asset store.");
    }
    const sourceKey = decodeURIComponent(asset.url.slice(publicBase.length + 1));
    const object = await this.options.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: sourceKey }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    if (object.Body === undefined) throw new Error("Uploaded image body is missing.");
    const source = new Uint8Array(await object.Body.transformToByteArray());
    const requests = (this.options.widths ?? [320, 768, 1440]).flatMap((width) => [
      { width, format: "avif" as const, quality: 65, fit: "inside" as const },
      { width, format: "webp" as const, quality: 78, fit: "inside" as const },
    ]);
    const generated = await processImage(source, requests);
    const variants = await Promise.all(
      generated.map(async (variant) => {
        const key = `assets/${asset.checksum.toLowerCase()}/variants/${variant.width}.${variant.format}`;
        await this.options.client.send(
          new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
            Body: variant.bytes,
            ContentType: `image/${variant.format}`,
            CacheControl: "public, max-age=31536000, immutable",
            Metadata: {
              assetId: asset.id,
              sha256: asset.checksum.toLowerCase(),
              exifRemoved: "true",
              width: String(variant.width),
              height: String(variant.height),
              format: variant.format,
            },
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
        return {
          width: variant.width,
          height: variant.height,
          format: variant.format,
          url: `${publicBase}/${key}`,
        };
      }),
    );
    return { ...asset, variants };
  }
}
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Asset, AssetProcessorPort } from "@git-native-cms/application";
