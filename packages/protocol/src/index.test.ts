import { describe, expect, it } from "vitest";
import { createEnvelope, isProtocolEnvelope } from "./index.js";
import { isEditorPreviewMessage, isPreviewEditorMessage } from "./preview.js";

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
    expect(isProtocolEnvelope({ ...envelope, timestamp: "not-a-date" })).toBe(false);
  });

  it("validates both directions of the preview protocol at runtime", () => {
    const initialize = createEnvelope(
      "editor.initialize",
      {
        sessionId: "session-1",
        document: { id: "page-home" },
        capabilities: ["patches"],
      },
      { now: new Date("2026-07-27T12:00:00Z") },
    );
    expect(isEditorPreviewMessage(initialize)).toBe(true);
    expect(
      isEditorPreviewMessage({
        ...initialize,
        payload: { ...initialize.payload, capabilities: ["arbitrary-code"] },
      }),
    ).toBe(false);

    const selected = createEnvelope(
      "preview.section-selected",
      { sectionId: "hero" },
      { now: new Date("2026-07-27T12:00:00Z") },
    );
    expect(isPreviewEditorMessage(selected)).toBe(true);
    expect(
      isPreviewEditorMessage({
        ...selected,
        payload: { sectionId: "" },
      }),
    ).toBe(false);
  });
});
