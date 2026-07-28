import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpTranslationProvider,
  MemoryWebhookReplayStore,
  createScheduledPublicationWorkflow,
  receiveSignedWebhook,
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signature(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)));
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

  it("runs translation jobs through the provider contract without leaking credentials", async () => {
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        requests.push({ url: url.toString(), ...(init === undefined ? {} : { init }) });
        return Response.json(
          init?.method === "GET"
            ? { status: "complete", xliff: '<xliff version="2.0"/>' }
            : { jobId: "job-42" },
        );
      }),
    );
    const provider = new HttpTranslationProvider({
      url: "https://translations.example.test/api",
      token: "provider-secret",
    });
    await expect(
      provider.createJob({
        sourceLocale: "en-US",
        targetLocale: "pl-PL",
        xliff: "<xliff/>",
        idempotencyKey: "translation-contract-1",
      }),
    ).resolves.toEqual({ jobId: "job-42" });
    await expect(provider.readJob("job-42")).resolves.toEqual({
      status: "complete",
      xliff: '<xliff version="2.0"/>',
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://translations.example.test/api/jobs",
      "https://translations.example.test/api/jobs/job-42",
    ]);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer provider-secret",
      "idempotency-key": "translation-contract-1",
    });
  });

  it("rejects non-TLS integration endpoints", async () => {
    const provider = new HttpTranslationProvider({ url: "http://attacker.example/api" });
    await expect(provider.readJob("job-1")).rejects.toMatchObject({
      code: "CMS_INTEGRATION_001",
    });
  });

  it.each([
    "https://127.0.0.1/api",
    "https://10.20.30.40/api",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/api",
    "https://[::1]/api",
    "https://metadata.google.internal/computeMetadata/v1",
  ])("rejects SSRF targets at %s", async (url) => {
    const provider = new HttpTranslationProvider({ url });
    await expect(provider.readJob("job-1")).rejects.toMatchObject({
      code: "CMS_INTEGRATION_003",
    });
  });

  it("does not permit a local HTTP exception", async () => {
    const provider = new HttpTranslationProvider({ url: "http://localhost:9000/api" });
    await expect(provider.readJob("job-1")).rejects.toMatchObject({
      code: "CMS_INTEGRATION_001",
    });
  });
});
