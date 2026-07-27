import { describe, expect, it } from "vitest";
import { contentPath } from "./index.js";

describe("patch path hardening", () => {
  it("rejects prototype pollution and malformed pointer escapes", () => {
    expect(() => contentPath("/__proto__/polluted")).toThrow(/protected/i);
    expect(() => contentPath("/constructor/prototype/value")).toThrow(/protected/i);
    expect(() => contentPath("/invalid~2escape")).toThrow(/RFC 6901/i);
  });
});
