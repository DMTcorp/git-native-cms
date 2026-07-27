import type { ActorId, Revision } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import {
  applyPatches,
  commitPatch,
  compactPatches,
  contentPath,
  createDocumentState,
  mergeDocuments,
  redo,
  undo,
  type ContentPatch,
} from "./index.js";

const metadata = {
  id: "patch_1",
  actorId: "actor_1" as ActorId,
  createdAt: "2026-07-27T12:00:00.000Z",
  source: "editor" as const,
};

describe("document model", () => {
  it("applies patches immutably", () => {
    const original = { heading: "Before", sections: ["hero"] };
    const patches: ContentPatch[] = [
      { op: "set", path: contentPath("/heading"), value: "After", metadata },
      { op: "insert", path: contentPath("/sections"), index: 1, value: "pricing", metadata },
    ];
    const changed = applyPatches(original, patches);
    expect(changed).toEqual({ heading: "After", sections: ["hero", "pricing"] });
    expect(original).toEqual({ heading: "Before", sections: ["hero"] });
  });

  it("supports undo and redo", () => {
    const state = createDocumentState({ heading: "Before" }, "sha1" as Revision);
    const changed = commitPatch(state, {
      op: "set",
      path: contentPath("/heading"),
      value: "After",
      metadata,
    });
    expect(undo(changed).document).toEqual({ heading: "Before" });
    expect(redo(undo(changed)).document).toEqual({ heading: "After" });
  });

  it("compacts consecutive field updates", () => {
    const patches: ContentPatch[] = [
      { op: "set", path: contentPath("/heading"), value: "A", metadata },
      { op: "set", path: contentPath("/heading"), value: "B", metadata },
    ];
    expect(compactPatches(patches)).toHaveLength(1);
    expect(applyPatches({ heading: "" }, compactPatches(patches))).toEqual({ heading: "B" });
  });

  it("merges independent fields and reports semantic conflicts", () => {
    const base = { heading: "A", description: "One" };
    expect(
      mergeDocuments(
        base,
        { heading: "B", description: "One" },
        {
          heading: "A",
          description: "Two",
        },
      ),
    ).toEqual({
      document: { heading: "B", description: "Two" },
      conflicts: [],
    });
    expect(
      mergeDocuments(
        base,
        { heading: "B", description: "One" },
        {
          heading: "C",
          description: "One",
        },
      ).conflicts,
    ).toHaveLength(1);
  });
});
