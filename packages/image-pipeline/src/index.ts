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
      let pipeline = sharp(source, { failOn: "warning" })
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
