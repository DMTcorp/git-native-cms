import { describe, expect, it } from "vitest";
import { createEnvelope, isProtocolEnvelope } from "./index.js";
import { isEditorPreviewMessage, isPreviewEditorMessage } from "./preview.js";
import { httpOperationForRequest, isHttpPayload } from "./http.js";

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
    expect(
      isPreviewEditorMessage({
        ...selected,
        timestamp: "2026-99-99T12:00:00.000Z",
      }),
    ).toBe(false);

    const timestamp = { now: new Date("2026-07-27T12:00:00Z") };
    for (const message of [
      createEnvelope(
        "editor.set-viewport-context",
        { viewport: "tablet", width: 768, height: 1024, deviceScaleFactor: 2 },
        timestamp,
      ),
      createEnvelope(
        "editor.request-screenshot",
        { viewport: "mobile", fullPage: true },
        timestamp,
      ),
    ]) {
      expect(isEditorPreviewMessage(message), message.type).toBe(true);
    }
    for (const message of [
      createEnvelope("preview.section-hovered", { sectionId: "hero" }, timestamp),
      createEnvelope("preview.navigation", { path: "/pricing", title: "Pricing" }, timestamp),
      createEnvelope(
        "preview.validation-error",
        { path: "/sections/0/media", message: "Media is required.", severity: "error" },
        timestamp,
      ),
      createEnvelope(
        "preview.screenshot-ready",
        {
          requestId: "screenshot-1",
          viewport: "desktop",
          width: 1440,
          height: 2200,
          mimeType: "image/svg+xml",
          dataUrl: "data:image/svg+xml,%3Csvg%2F%3E",
        },
        timestamp,
      ),
      createEnvelope("preview.height-changed", { height: 840 }, timestamp),
    ]) {
      expect(isPreviewEditorMessage(message), message.type).toBe(true);
    }
  });

  it("validates versioned HTTP mutation payload contracts with Ajv", () => {
    expect(
      httpOperationForRequest("POST", "/api/cms/changes/chg_1/documents/doc_1"),
    ).toBeUndefined();
    expect(httpOperationForRequest("PATCH", "/api/cms/changes/chg_1/documents/doc_1")).toBe(
      "document.update",
    );
    expect(
      isHttpPayload("change.create", {
        name: "Homepage launch",
        collaborators: ["octocat", "team:editors"],
        targetDate: "2026-08-20",
      }),
    ).toBe(true);
    expect(isHttpPayload("change.create", { name: "" })).toBe(false);
    expect(
      isHttpPayload("schedule.create", {
        changeId: "chg_1",
        action: "availability-start",
        documentIds: ["doc_1"],
        executeAt: "2026-08-20T10:00:00.000Z",
        expectedRevision: "a".repeat(40),
      }),
    ).toBe(true);
    expect(
      isHttpPayload("asset.upload.create", {
        fileName: "../unsafe.svg",
        mimeType: "image/svg+xml",
        size: 1,
        checksum: "not-a-checksum",
      }),
    ).toBe(false);
  });
});
