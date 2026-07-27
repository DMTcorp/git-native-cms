import type { EnvironmentPointer } from "@git-native-cms/application";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ReleaseStore } from "./index.js";

function r2Configuration():
  | {
      readonly endpoint: string;
      readonly region: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly bucket: string;
    }
  | undefined {
  if (process.env.CMS_R2_SMOKE !== "true") return undefined;
  const endpoint = process.env.CMS_S3_ENDPOINT;
  const accessKeyId = process.env.CMS_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CMS_S3_SECRET_ACCESS_KEY;
  const bucket = process.env.CMS_RELEASES_BUCKET;
  if (
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucket === undefined
  ) {
    throw new Error("The R2 smoke test requires the CMS_S3_* release-store variables.");
  }
  return {
    endpoint,
    region: process.env.CMS_S3_REGION ?? "auto",
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

const r2 = r2Configuration();

describe.skipIf(r2 === undefined)("Cloudflare R2 release-store smoke", () => {
  it("authenticates and reads the production pointer through the shared S3 adapter", async () => {
    if (r2 === undefined) throw new Error("R2 configuration disappeared.");
    const client = new S3Client({
      endpoint: r2.endpoint,
      region: r2.region,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
    try {
      const store = new S3ReleaseStore({ client, bucket: r2.bucket });
      const pointer: EnvironmentPointer | undefined = await store.readPointer("production");
      expect(pointer === undefined || pointer.environment === "production").toBe(true);
    } finally {
      client.destroy();
    }
  });
});
