import type { EnvironmentPointer, StoredRelease } from "@git-native-cms/application";
import type { ReleaseId } from "@git-native-cms/core";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { S3ReleaseStore } from "./index.js";

const runContainerTests = process.env.CMS_CONTAINER_TESTS === "true";

describe.skipIf(!runContainerTests)("S3 release contract", () => {
  let container: StartedTestContainer | undefined;
  let client: S3Client | undefined;
  const bucket = "cms-releases";

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
    await client?.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    client?.destroy();
    await container?.stop();
  });

  it("writes immutable files and switches the pointer with CAS", async () => {
    if (client === undefined) throw new Error("MinIO client was not initialized.");
    const store = new S3ReleaseStore({ client, bucket });
    const release: StoredRelease = {
      id: "rel_0123456789abcdef01234567" as ReleaseId,
      manifest: { formatVersion: 1 },
      files: {
        "manifest.json": '{"formatVersion":1}',
        "pages/home.json": '{"title":"Home"}',
      },
    };
    await store.writeRelease(release);
    await expect(store.writeRelease(release)).resolves.toBeUndefined();
    await expect(store.readRelease(release.id)).resolves.toEqual(release);
    const first: EnvironmentPointer = {
      environment: "production",
      releaseId: release.id,
      revision: "pointer-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(store.compareAndSwapPointer({ next: first })).resolves.toEqual(first);
    await expect(
      store.compareAndSwapPointer({
        next: { ...first, revision: "pointer-2" },
        expectedRevision: "stale",
      }),
    ).rejects.toMatchObject({ code: "CMS_STORAGE_009" });
  });
});
