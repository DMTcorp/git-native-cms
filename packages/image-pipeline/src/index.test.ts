import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImage } from "./index.js";

describe("image pipeline", () => {
  it("normalizes orientation, strips metadata and creates responsive focal crops", async () => {
    const source = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 49, g: 94, b: 251 },
      },
    })
      .withMetadata({ orientation: 6, density: 300 })
      .jpeg()
      .toBuffer();

    const variants = await processImage(new Uint8Array(source), [
      { width: 60, format: "webp", fit: "inside" },
      {
        name: "square",
        width: 40,
        height: 40,
        format: "avif",
        fit: "cover",
        focalPoint: { x: 0.8, y: 0.25 },
      },
    ]);

    expect(
      variants.map(({ name, width, height, format }) => ({ name, width, height, format })),
    ).toEqual([
      { name: undefined, width: 60, height: 90, format: "webp" },
      { name: "square", width: 40, height: 40, format: "heif" },
    ]);
    for (const variant of variants) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    }
  });

  it("rejects decompression bombs through the input pixel budget", async () => {
    const bombHeader = Buffer.alloc(24);
    bombHeader.writeUInt32BE(0x89504e47, 0);
    await expect(
      processImage(new Uint8Array(bombHeader), [{ width: 20, format: "webp" }]),
    ).rejects.toThrow();
  });
});
