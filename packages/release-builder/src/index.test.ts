import type { GitCommitSha } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { buildRelease } from "./index.js";

describe("release builder", () => {
  it("is reproducible for the same content and ignores generation time for identity", async () => {
    const input = {
      gitCommit: "abc123" as GitCommitSha,
      configVersion: 1,
      registryDigest: "registry",
      schemaVersion: 1,
      documents: [{ path: "pages/home.json", value: { title: "Home" } }],
    };
    const first = await buildRelease({ ...input, generatedAt: "2026-01-01T00:00:00Z" });
    const second = await buildRelease({ ...input, generatedAt: "2027-01-01T00:00:00Z" });
    expect(first.id).toBe(second.id);
    expect(first.files["pages/home.json"]).toBe(second.files["pages/home.json"]);
  });
});
