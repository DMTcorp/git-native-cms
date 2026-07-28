import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Actor, AssetId } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import {
  assertAssetCanBeDeleted,
  assetBytesMatchMime,
  buildAssetUsageGraph,
  S3AssetStore,
} from "./index.js";

const actor: Actor = {
  id: "act_asset_security" as Actor["id"],
  githubId: 1,
  login: "asset-security",
  displayName: "Asset Security",
  roles: ["administrator"],
  source: "cli",
};

describe("asset usage safety", () => {
  it("finds content references and prevents unsafe deletion", () => {
    const assetId = "ast_0123456789abcdef01234567" as AssetId;
    const graph = buildAssetUsageGraph([
      {
        hero: {
          image: {
            id: assetId,
            fileName: "proofing-desk.png",
            mimeType: "image/png",
            url: "https://assets.example.test/assets/proofing-desk.png",
            altText: "Proofing desk",
          },
        },
      },
    ]);
    expect(graph).toEqual([
      {
        assetId,
        paths: ["/documents/0/hero/image"],
      },
    ]);
    expect(() => assertAssetCanBeDeleted(assetId, graph, new Set())).toThrow(/still used/i);
  });

  it("rejects SVG/upload bombs and signs the exact content checksum", async () => {
    const client = new S3Client({
      endpoint: "https://s3.example.test",
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test-secret" },
    });
    const store = new S3AssetStore({
      client,
      bucket: "assets",
      publicBaseUrl: "https://assets.example.test",
      maximumUploadBytes: 8,
    });
    await expect(
      store.createUpload({
        fileName: "payload.svg",
        mimeType: "image/svg+xml",
        size: 4,
        checksum: "a".repeat(64),
        actor,
      }),
    ).rejects.toMatchObject({ code: "CMS_ASSET_002" });
    await expect(
      store.createUpload({
        fileName: "bomb.png",
        mimeType: "image/png",
        size: 9,
        checksum: "a".repeat(64),
        actor,
      }),
    ).rejects.toMatchObject({ code: "CMS_ASSET_001" });
    const upload = await store.createUpload({
      fileName: "../../proof.png",
      mimeType: "image/png",
      size: 4,
      checksum: "a".repeat(64),
      actor,
    });
    const signedUrl = new URL(upload.url);
    expect(signedUrl.searchParams.get("x-amz-meta-declaredsha256")).toBeNull();
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "x-amz-meta-declaredsha256",
    );
    expect(upload.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-meta-declaredmime": "image/png",
      "x-amz-meta-declaredsha256": "a".repeat(64),
      "x-amz-meta-declaredsize": "4",
      "x-amz-meta-originalfilename": "..-..-proof.png",
    });
    expect(decodeURIComponent(upload.url)).not.toContain("/../");
    client.destroy();
  });

  it("rejects media-type spoofing before an object becomes public", () => {
    expect(assetBytesMatchMime(new TextEncoder().encode("<script>"), "image/png")).toBe(false);
    expect(
      assetBytesMatchMime(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png",
      ),
    ).toBe(true);
    expect(assetBytesMatchMime(new TextEncoder().encode("%PDF-1.7"), "application/pdf")).toBe(true);
  });

  it("replaces S3 object metadata while preserving immutable delivery headers", async () => {
    const checksum = "b".repeat(64);
    const copied: CopyObjectCommand[] = [];
    const client = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [{ Key: `assets/${checksum}/proof.png`, Size: 128 }],
          };
        }
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 128,
            ContentType: "image/png",
            CacheControl: "public, max-age=31536000, immutable",
            Metadata: {
              assetid: `ast_${checksum.slice(0, 24)}`,
              sha256: checksum,
              originalfilename: "proof.png",
              width: "1200",
              height: "800",
              alttext: "Old alternative text",
              focalx: "0.1",
              focaly: "0.2",
            },
          };
        }
        if (command instanceof CopyObjectCommand) {
          copied.push(command);
          return {};
        }
        throw new Error(`Unexpected S3 command: ${String(command)}`);
      },
    } as unknown as S3Client;
    const store = new S3AssetStore({
      client,
      bucket: "assets",
      publicBaseUrl: "https://assets.example.test",
    });

    const updated = await store.updateAssetMetadata({
      id: `ast_${checksum.slice(0, 24)}` as AssetId,
      altText: "A reviewed proof image",
      focalPoint: { x: 0.45, y: 0.6 },
    });

    expect(updated).toMatchObject({
      altText: "A reviewed proof image",
      focalPoint: { x: 0.45, y: 0.6 },
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]?.input).toMatchObject({
      Bucket: "assets",
      Key: `assets/${checksum}/proof.png`,
      MetadataDirective: "REPLACE",
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        originalfilename: "proof.png",
        width: "1200",
        height: "800",
        altText: "A reviewed proof image",
        focalX: "0.45",
        focalY: "0.6",
      },
    });
  });
});
