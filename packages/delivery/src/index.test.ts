import { describe, expect, it } from "vitest";
import { resolveRedirect } from "./index.js";

describe("delivery redirects", () => {
  it("resolves safe redirect chains and rejects loops", () => {
    expect(resolveRedirect({ "/old": "/new" }, "/old")).toBe("/new");
    expect(resolveRedirect({ "/v1": "/v2", "/v2": "/current" }, "/v1")).toBe("/current");
    expect(resolveRedirect({ "/old": "/new" }, "/unrelated")).toBeUndefined();
    expect(() => resolveRedirect({ "/a": "/b", "/b": "/a" }, "/a")).toThrow(/loop/i);
  });
});
