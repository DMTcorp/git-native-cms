import { describe, expect, it } from "vitest";
import { createEnvelope, isProtocolEnvelope } from "./index.js";

describe("protocol", () => {
  it("creates and validates versioned envelopes", () => {
    const envelope = createEnvelope(
      "change.created",
      { id: "chg_1" },
      {
        requestId: "req_1",
        now: new Date("2026-07-27T12:00:00Z"),
      },
    );
    expect(isProtocolEnvelope(envelope)).toBe(true);
    expect(isProtocolEnvelope({ ...envelope, protocolVersion: "2.0.0" })).toBe(false);
  });
});
