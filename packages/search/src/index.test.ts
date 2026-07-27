import { describe, expect, it } from "vitest";
import { buildSearchIndex, findUsages, search } from "./index.js";

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
});
