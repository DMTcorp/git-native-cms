import type { GitCommitSha } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { buildRelease } from "./index.js";

describe("release builder", () => {
  it("is reproducible for the same content and ignores generation time for identity", async () => {
    const input = {
      gitCommit: "a".repeat(40) as GitCommitSha,
      configVersion: 1,
      registryDigest: `sha256:${"b".repeat(64)}`,
      schemaVersion: 1,
      documents: [{ path: "pages/home.json", value: { title: "Home" } }],
    };
    const first = await buildRelease({ ...input, generatedAt: "2026-01-01T00:00:00Z" });
    const second = await buildRelease({ ...input, generatedAt: "2027-01-01T00:00:00Z" });
    expect(first.id).toBe(second.id);
    expect(first.files["pages/home.json"]).toBe(second.files["pages/home.json"]);
  });

  it("rejects path traversal and incomplete source identities", async () => {
    await expect(
      buildRelease({
        gitCommit: "short" as GitCommitSha,
        configVersion: 1,
        registryDigest: "sha256:short",
        schemaVersion: 1,
        documents: [{ path: "../secret.json", value: {} }],
      }),
    ).rejects.toThrow(/Git commit SHA/i);
    await expect(
      buildRelease({
        gitCommit: "a".repeat(40) as GitCommitSha,
        configVersion: 1,
        registryDigest: `sha256:${"b".repeat(64)}`,
        schemaVersion: 1,
        documents: [{ path: "../secret.json", value: {} }],
      }),
    ).rejects.toThrow(/unsafe/i);
  });
});
