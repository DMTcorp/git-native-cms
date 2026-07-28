export interface ImageVariantRequest {
  readonly width: number;
  readonly height?: number;
  readonly format: "avif" | "webp" | "jpeg" | "png";
  readonly quality?: number;
  readonly fit?: "cover" | "contain" | "inside";
  readonly name?: string;
  readonly focalPoint?: {
    readonly x: number;
    readonly y: number;
  };
}

export interface ImageVariant {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly name?: string;
}

function normalizedFocalPoint(
  value: ImageVariantRequest["focalPoint"],
): { readonly x: number; readonly y: number } | undefined {
  if (
    value === undefined ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    value.x < 0 ||
    value.x > 1 ||
    value.y < 0 ||
    value.y > 1
  ) {
    return undefined;
  }
  return value;
}

export async function processImage(
  source: Uint8Array,
  variants: readonly ImageVariantRequest[],
): Promise<readonly ImageVariant[]> {
  const sharp = (await import("sharp")).default;
  const normalized = await sharp(source, {
    failOn: "warning",
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  return Promise.all(
    variants.map(async (variant) => {
      let pipeline = sharp(normalized.data, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
        sequentialRead: true,
      });
      const focalPoint = normalizedFocalPoint(variant.focalPoint);
      if (
        focalPoint !== undefined &&
        variant.height !== undefined &&
        (variant.fit ?? "cover") === "cover"
      ) {
        const sourceWidth = normalized.info.width;
        const sourceHeight = normalized.info.height;
        const targetRatio = variant.width / variant.height;
        const sourceRatio = sourceWidth / sourceHeight;
        const cropWidth = Math.max(
          1,
          Math.round(sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth),
        );
        const cropHeight = Math.max(
          1,
          Math.round(sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio),
        );
        const left = Math.max(
          0,
          Math.min(sourceWidth - cropWidth, Math.round(focalPoint.x * sourceWidth - cropWidth / 2)),
        );
        const top = Math.max(
          0,
          Math.min(
            sourceHeight - cropHeight,
            Math.round(focalPoint.y * sourceHeight - cropHeight / 2),
          ),
        );
        pipeline = pipeline
          .extract({ left, top, width: cropWidth, height: cropHeight })
          .resize(variant.width, variant.height, {
            fit: "fill",
            withoutEnlargement: true,
          });
      } else {
        pipeline = pipeline.resize(variant.width, variant.height, {
          fit: variant.fit ?? "cover",
          withoutEnlargement: true,
        });
      }
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
        ...(variant.name === undefined ? {} : { name: variant.name }),
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
      readonly cropPresets?: readonly {
        readonly name: string;
        readonly width: number;
        readonly height: number;
      }[];
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
    const requests: ImageVariantRequest[] = [
      ...(this.options.widths ?? [320, 768, 1440]).flatMap((width) => [
        { width, format: "avif" as const, quality: 65, fit: "inside" as const },
        { width, format: "webp" as const, quality: 78, fit: "inside" as const },
      ]),
      ...(this.options.cropPresets ?? []).flatMap((preset) => [
        {
          ...preset,
          format: "avif" as const,
          quality: 65,
          fit: "cover" as const,
          ...(asset.focalPoint === undefined ? {} : { focalPoint: asset.focalPoint }),
        },
        {
          ...preset,
          format: "webp" as const,
          quality: 78,
          fit: "cover" as const,
          ...(asset.focalPoint === undefined ? {} : { focalPoint: asset.focalPoint }),
        },
      ]),
    ];
    const generated = await processImage(source, requests);
    const sharp = (await import("sharp")).default;
    const original = await sharp(source, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    })
      .rotate()
      .toBuffer({ resolveWithObject: true });
    await this.options.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: sourceKey,
        CopySource: encodeURIComponent(`${this.options.bucket}/${sourceKey}`).replaceAll(
          "%2F",
          "/",
        ),
        ContentType: asset.mimeType,
        CacheControl: "public, max-age=31536000, immutable",
        MetadataDirective: "REPLACE",
        Metadata: {
          assetId: asset.id,
          sha256: asset.checksum.toLowerCase(),
          originalFileName: asset.fileName,
          exifRemoved: "true",
          width: String(original.info.width),
          height: String(original.info.height),
          ...(asset.altText === undefined ? {} : { altText: asset.altText }),
          ...(asset.focalPoint === undefined
            ? {}
            : {
                focalX: String(asset.focalPoint.x),
                focalY: String(asset.focalPoint.y),
              }),
        },
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    const variants = await Promise.all(
      generated.map(async (variant) => {
        const key = `assets/${asset.checksum.toLowerCase()}/variants/${
          variant.name === undefined ? "" : `${variant.name}-`
        }${variant.width}x${variant.height}.${variant.format}`;
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
              ...(variant.name === undefined ? {} : { name: variant.name }),
            },
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
        return {
          ...(variant.name === undefined ? {} : { name: variant.name }),
          width: variant.width,
          height: variant.height,
          format: variant.format,
          url: `${publicBase}/${key}`,
        };
      }),
    );
    return {
      ...asset,
      width: original.info.width,
      height: original.info.height,
      variants,
    };
  }
}
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Asset, AssetProcessorPort } from "@git-native-cms/application";
