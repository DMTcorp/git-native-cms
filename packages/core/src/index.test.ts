import { describe, expect, it } from "vitest";
import { CmsError, createPrefixedId, isoTimestamp } from "./index.js";

describe("core", () => {
  it("creates stable prefixed ULIDs with injectable entropy", () => {
    const id = createPrefixedId<"ChangeId">("chg", {
      now: 0,
      random: new Uint8Array(10),
    });
    expect(id).toBe("chg_00000000000000000000000000");
  });

  it("serializes typed errors without leaking causes", () => {
    const error = new CmsError({
      code: "CMS_SCHEMA_001",
      message: "Invalid schema",
      category: "validation",
      retryable: false,
      cause: new Error("private"),
    });
    expect(error.toJSON()).toEqual({
      code: "CMS_SCHEMA_001",
      message: "Invalid schema",
      category: "validation",
      retryable: false,
    });
  });

  it("uses ISO UTC timestamps", () => {
    expect(isoTimestamp(new Date("2026-01-01T12:00:00Z"))).toBe("2026-01-01T12:00:00.000Z");
  });
});
