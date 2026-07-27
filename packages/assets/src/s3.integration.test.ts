import { AssetStoreContract, contractPassed } from "@git-native-cms/adapter-kit";
import type { Actor } from "@git-native-cms/core";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { S3AssetStore } from "./index.js";

const runContainerTests = process.env.CMS_CONTAINER_TESTS === "true";

describe.skipIf(!runContainerTests)("S3 asset contract", () => {
  let container: StartedTestContainer | undefined;
  let client: S3Client | undefined;
  const bucket = "cms-assets";
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const actor: Actor = {
    id: "act_asset_contract" as Actor["id"],
    githubId: 1,
    login: "asset-contract",
    displayName: "Asset Contract",
    roles: ["administrator"],
    source: "cli",
  };

  beforeAll(async () => {
    container = await new GenericContainer("quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z")
      .withEnvironment({
        MINIO_ROOT_USER: "cms-test",
        MINIO_ROOT_PASSWORD: "cms-test-secret",
      })
      .withCommand(["server", "/data"])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
      .start();
    client = new S3Client({
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "cms-test",
        secretAccessKey: "cms-test-secret",
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    client?.destroy();
    await container?.stop();
  });

  it("uploads, finalizes, lists, retries, and deletes an asset", async () => {
    if (client === undefined || container === undefined) {
      throw new Error("MinIO client was not initialized.");
    }
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const store = new S3AssetStore({
      client,
      bucket,
      publicBaseUrl: `http://${container.getHost()}:${container.getMappedPort(9000)}/${bucket}`,
    });
    const results = await AssetStoreContract({
      store,
      fileName: "proof.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      checksum,
      actor,
      put: async (upload) => {
        const response = await fetch(upload.url, {
          method: "PUT",
          headers: upload.headers,
          body: bytes,
        });
        expect(response.ok).toBe(true);
      },
    });
    expect(
      contractPassed(results),
      results
        .filter((result) => !result.passed)
        .map((result) => `${result.name}: ${result.details ?? "failed"}`)
        .join("\n"),
    ).toBe(true);
  });
});
