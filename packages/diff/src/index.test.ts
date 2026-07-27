import { describe, expect, it } from "vitest";
import { visualDiff } from "./index.js";

describe("visual diff", () => {
  it("reports the changed region and ratio", () => {
    const before = new Uint8Array(2 * 2 * 4);
    const after = before.slice();
    after[4] = 255;
    expect(visualDiff(before, after, 2, 2, 10)).toEqual({
      changedPixels: 1,
      totalPixels: 4,
      ratio: 0.25,
      bounds: { left: 1, top: 0, right: 1, bottom: 0 },
    });
  });
});
