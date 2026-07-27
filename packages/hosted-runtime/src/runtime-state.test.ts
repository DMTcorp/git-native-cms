import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore } from "./runtime-state.js";

describe("MemoryRateLimitStore", () => {
  it("enforces independent fixed windows and reports their reset", async () => {
    const store = new MemoryRateLimitStore();
    const input = {
      key: "act_editor",
      scope: "cms.mutation",
      limit: 2,
      windowMs: 60_000,
      now: "2026-07-27T12:00:01.000Z",
    } as const;

    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: "2026-07-27T12:01:00.000Z",
    });
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
    await expect(
      store.consume({ ...input, now: "2026-07-27T12:01:00.000Z" }),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(store.consume({ ...input, scope: "cms.read" })).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });
});
