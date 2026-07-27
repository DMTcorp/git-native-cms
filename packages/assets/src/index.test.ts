import type { AssetId } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { assertAssetCanBeDeleted, buildAssetUsageGraph } from "./index.js";

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
});
