import { S3Client } from "@aws-sdk/client-s3";
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
      { hero: { image: { id: assetId, alt: "Proofing desk" } } },
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
    expect(new URL(upload.url).searchParams.get("x-amz-meta-declaredsha256")).toBe("a".repeat(64));
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
});
