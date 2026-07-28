import type { ReleaseId } from "@git-native-cms/core";
import type { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { resolveRedirect, S3ReleaseStore } from "./index.js";

describe("delivery redirects", () => {
  it("resolves safe redirect chains and rejects loops", () => {
    expect(resolveRedirect({ "/old": "/new" }, "/old")).toBe("/new");
    expect(resolveRedirect({ "/v1": "/v2", "/v2": "/current" }, "/v1")).toBe("/current");
    expect(resolveRedirect({ "/old": "/new" }, "/unrelated")).toBeUndefined();
    expect(() => resolveRedirect({ "/a": "/b", "/b": "/a" }, "/a")).toThrow(/loop/i);
  });
});

describe("S3 release delivery", () => {
  it("assembles concurrently fetched files in deterministic path order", async () => {
    const releaseId = "rel_0123456789abcdef01234567" as ReleaseId;
    const prefix = `releases/${releaseId}/`;
    const sources: Readonly<Record<string, string>> = {
      [`${prefix}manifest.json`]: '{"formatVersion":1}',
      [`${prefix}pages/home.json`]: '{"title":"Home"}',
    };
    const client = {
      async send(command: GetObjectCommand | ListObjectsV2Command) {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: Object.keys(sources).map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        const key = command.input.Key;
        if (key === undefined) throw new Error("Expected an object key.");
        return {
          Body: {
            async transformToString() {
              if (key.endsWith("manifest.json")) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              const source = sources[key];
              if (source === undefined) throw new Error(`Missing fixture ${key}.`);
              return source;
            },
          },
        };
      },
    } as unknown as S3Client;

    const release = await new S3ReleaseStore({ client, bucket: "cms-releases" }).readRelease(
      releaseId,
    );

    expect(Object.keys(release?.files ?? {})).toEqual(["manifest.json", "pages/home.json"]);
    expect(release).toEqual({
      id: releaseId,
      manifest: { formatVersion: 1 },
      files: {
        "manifest.json": '{"formatVersion":1}',
        "pages/home.json": '{"title":"Home"}',
      },
    });
  });
});
