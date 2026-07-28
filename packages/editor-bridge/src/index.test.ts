import { PREVIEW_CHANNEL } from "@git-native-cms/protocol/preview";
import { describe, expect, it } from "vitest";
import { isTrustedPreviewHandshake } from "./index.js";

const port = {} as MessagePort;
const expected = {
  parentOrigin: "https://cms.example",
  sessionId: "preview-session",
};

describe("preview handshake trust boundary", () => {
  it("accepts only the exact parent origin, channel, session and transferred port", () => {
    expect(
      isTrustedPreviewHandshake(
        {
          origin: expected.parentOrigin,
          data: { channel: PREVIEW_CHANNEL, sessionId: expected.sessionId },
          ports: [port],
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isTrustedPreviewHandshake(
        {
          origin: "https://attacker.example",
          data: { channel: PREVIEW_CHANNEL, sessionId: expected.sessionId },
          ports: [port],
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isTrustedPreviewHandshake(
        {
          origin: expected.parentOrigin,
          data: { channel: PREVIEW_CHANNEL, sessionId: "stolen-session" },
          ports: [port],
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isTrustedPreviewHandshake(
        {
          origin: expected.parentOrigin,
          data: { channel: PREVIEW_CHANNEL, sessionId: expected.sessionId },
          ports: [],
        },
        expected,
      ),
    ).toBe(false);
  });
});
