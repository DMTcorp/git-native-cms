import { describe, expect, it } from "vitest";
import {
  MemoryWebhookReplayStore,
  createScheduledPublicationWorkflow,
  receiveSignedWebhook,
} from "./index.js";

async function signature(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)),
  );
  return `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("signed integrations", () => {
  it("accepts a signed delivery once and rejects replay", async () => {
    const secret = "test-secret";
    const body = new TextEncoder().encode('{"action":"published"}');
    const replayStore = new MemoryWebhookReplayStore();
    const input = {
      secret,
      body,
      signature: await signature(secret, body),
      deliveryId: "delivery-1",
      replayStore,
    };
    await expect(receiveSignedWebhook(input)).resolves.toEqual({ action: "published" });
    await expect(receiveSignedWebhook(input)).rejects.toMatchObject({ code: "CMS_WEBHOOK_004" });
  });

  it("generates a locked, idempotent publication workflow", () => {
    const workflow = createScheduledPublicationWorkflow({
      name: "Publish scheduled content",
      cron: "15 8 * * 1-5",
      environment: "production",
    });
    expect(workflow).toContain("group: cms-publish-production");
    expect(workflow).toContain("schedule-${{ github.run_id }}-${{ github.run_attempt }}");
  });
});
