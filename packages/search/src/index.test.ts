import { describe, expect, it } from "vitest";
import { buildReferenceGraph, buildSearchIndex, findUsages, search } from "./index.js";

const documents = [
  {
    id: "page-home",
    type: "page",
    title: "Home",
    path: "/",
    value: { navigation: { id: "global-navigation" }, text: "Editorial publishing" },
  },
  {
    id: "global-navigation",
    type: "global",
    title: "Navigation",
    path: "/globals/navigation",
    value: { links: ["Home", "Pricing"] },
  },
];

describe("search graph", () => {
  it("searches content and reports reference usages", () => {
    const index = buildSearchIndex(documents);
    expect(search(index, "publishing")).toContainEqual(
      expect.objectContaining({ id: "page-home" }),
    );
    expect(findUsages(documents, "global-navigation")).toContainEqual(
      expect.objectContaining({ id: "page-home" }),
    );
  });

  it("builds a deterministic reference graph and reports broken references", () => {
    const graph = buildReferenceGraph([
      ...documents,
      {
        id: "page-pricing",
        type: "pages",
        title: "Pricing",
        path: "/pricing",
        value: {
          navigation: { global: "global-navigation" },
          sections: [{ type: "reference", ref: "reusable-blocks/missing" }],
        },
      },
    ]);
    expect(graph.edges).toContainEqual({
      sourceId: "page-home",
      sourcePath: "/navigation/id",
      targetId: "global-navigation",
    });
    expect(graph.broken).toContainEqual({
      sourceId: "page-pricing",
      sourcePath: "/sections/0/ref",
      reference: "reusable-blocks/missing",
    });
  });
});
