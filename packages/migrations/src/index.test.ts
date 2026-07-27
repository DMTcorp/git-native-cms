import { describe, expect, it } from "vitest";
import { migrateContent } from "./index.js";

describe("content migrations", () => {
  it("applies an ordered migration chain without mutating the source", () => {
    const source = { heading: "Hello" };
    const migrated = migrateContent(source, 1, 3, [
      {
        from: 1,
        to: 2,
        migrate: (value) => ({ ...value, description: "" }),
      },
      {
        from: 2,
        to: 3,
        migrate: (value) => ({ ...value, versioned: true }),
      },
    ]);
    expect(migrated).toEqual({ heading: "Hello", description: "", versioned: true });
    expect(source).toEqual({ heading: "Hello" });
  });

  it("fails closed when a migration step is missing", () => {
    expect(() => migrateContent({}, 1, 2, [])).toThrow("Missing migration");
  });
});
