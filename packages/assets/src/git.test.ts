import { MemoryGitProvider } from "@git-native-cms/testing";
import type { Actor } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { GitAssetStore } from "./git.js";

const actor: Actor = {
  id: "act_git_asset" as Actor["id"],
  githubId: 9,
  login: "git-editor",
  displayName: "Git Editor",
  roles: ["administrator"],
  source: "ui",
};

async function checksum(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Git asset storage", () => {
  it("stores verified binary blobs and content-addressed metadata in the content repository", async () => {
    const git = new MemoryGitProvider();
    const store = new GitAssetStore({
      git,
      publicBaseUrl: "https://raw.example.test/content/main",
      systemActor: actor,
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = await checksum(bytes);
    const upload = await store.createUpload({
      fileName: "Campaign hero.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      checksum: digest,
      actor,
    });
    await store.uploadBytes?.({
      uploadId: upload.uploadId,
      bytes,
      mimeType: "image/png",
      ...(upload.headers["x-cms-upload-token"] === undefined
        ? {}
        : { token: upload.headers["x-cms-upload-token"] }),
    });
    const asset = await store.finalizeUpload({ uploadId: upload.uploadId, checksum: digest });

    expect(asset).toMatchObject({
      fileName: "Campaign-hero.png",
      checksum: digest,
      url: `https://raw.example.test/content/main/assets/files/${digest}/Campaign-hero.png`,
    });
    await expect(store.listAssets({})).resolves.toMatchObject({ items: [asset] });
    await expect(
      store.updateAssetMetadata({
        id: asset.id,
        altText: "Campaign hero",
        focalPoint: { x: 0.5, y: 0.4 },
      }),
    ).resolves.toMatchObject({
      altText: "Campaign hero",
      focalPoint: { x: 0.5, y: 0.4 },
    });
    expect(
      await git.readFile({ ref: "main", path: `assets/files/${digest}/Campaign-hero.png` }),
    ).toBeDefined();

    await store.deleteAsset(asset.id);
    await expect(store.listAssets({})).resolves.toMatchObject({ items: [] });
  });

  it("rejects a forged upload token before writing content", async () => {
    const git = new MemoryGitProvider();
    const store = new GitAssetStore({
      git,
      publicBaseUrl: "https://raw.example.test/content/main",
      systemActor: actor,
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = await checksum(bytes);
    const upload = await store.createUpload({
      fileName: "hero.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      checksum: digest,
      actor,
    });
    await expect(
      store.uploadBytes?.({
        uploadId: upload.uploadId,
        bytes,
        mimeType: "image/png",
        token: "forged",
      }),
    ).rejects.toMatchObject({ code: "CMS_ASSET_003" });
  });
});
