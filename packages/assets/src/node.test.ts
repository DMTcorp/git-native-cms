import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@git-native-cms/core";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemAssetStore } from "./node.js";

const directories: string[] = [];
const actor: Actor = {
  id: "act_local_asset" as Actor["id"],
  githubId: 4,
  login: "local-editor",
  displayName: "Local Editor",
  roles: ["administrator"],
  source: "ui",
};

async function checksum(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("filesystem asset storage", () => {
  it("uploads, verifies, lists and deletes content-addressed local assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cms-assets-"));
    directories.push(root);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = await checksum(bytes);
    const store = new FileSystemAssetStore({
      root,
      publicBaseUrl: "http://127.0.0.1:3000/cms-assets",
    });
    const upload = await store.createUpload({
      fileName: "../../hero.png",
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
      fileName: "..-..-hero.png",
      checksum: digest,
      mimeType: "image/png",
    });
    await expect(store.listAssets({})).resolves.toMatchObject({ items: [asset] });
    await expect(
      store.updateAssetMetadata({
        id: asset.id,
        altText: "A campaign hero",
        focalPoint: { x: 0.25, y: 0.75 },
      }),
    ).resolves.toMatchObject({
      altText: "A campaign hero",
      focalPoint: { x: 0.25, y: 0.75 },
    });
    await expect(store.readAsset(asset.id)).resolves.toMatchObject({
      altText: "A campaign hero",
      focalPoint: { x: 0.25, y: 0.75 },
    });
    await store.deleteAsset(asset.id);
    await expect(store.listAssets({})).resolves.toMatchObject({ items: [] });
  });

  it("rejects an upload when the local malware hook reports a threat", async () => {
    const root = await mkdtemp(join(tmpdir(), "cms-assets-"));
    directories.push(root);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = await checksum(bytes);
    const store = new FileSystemAssetStore({
      root,
      publicBaseUrl: "http://127.0.0.1:3000/cms-assets",
      virusScanner: {
        async scan() {
          return { clean: false, threat: "test-signature" };
        },
      },
    });
    const upload = await store.createUpload({
      fileName: "threat.png",
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
    await expect(
      store.finalizeUpload({ uploadId: upload.uploadId, checksum: digest }),
    ).rejects.toMatchObject({ code: "CMS_ASSET_010" });
  });
});
