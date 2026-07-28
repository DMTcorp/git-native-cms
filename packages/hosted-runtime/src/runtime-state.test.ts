import type { S3Client } from "@aws-sdk/client-s3";
import type { AuditEvent } from "@git-native-cms/application";
import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore, S3AuditSink } from "./runtime-state.js";

class FakeS3 {
  readonly objects = new Map<string, string>();

  async send(command: object): Promise<unknown> {
    const named = command as {
      readonly constructor: { readonly name: string };
      readonly input: Readonly<Record<string, unknown>>;
    };
    if (named.constructor.name === "PutObjectCommand") {
      this.objects.set(String(named.input.Key), String(named.input.Body));
      return {};
    }
    if (named.constructor.name === "ListObjectsV2Command") {
      const prefix = typeof named.input.Prefix === "string" ? named.input.Prefix : "";
      return {
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    if (named.constructor.name === "GetObjectCommand") {
      const value = this.objects.get(String(named.input.Key));
      if (value === undefined) throw new Error("Object not found.");
      return { Body: { transformToString: async () => value } };
    }
    throw new Error(`Unsupported fake S3 command: ${named.constructor.name}`);
  }
}

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

describe("S3AuditSink", () => {
  it("persists, filters and orders an audit timeline from object storage", async () => {
    const storage = new FakeS3();
    const audit = new S3AuditSink({
      client: storage as unknown as S3Client,
      bucket: "state",
    });
    const events: readonly AuditEvent[] = [
      {
        type: "change.created",
        actorId: "act_editor",
        requestId: "req_1",
        source: "ui",
        timestamp: "2026-07-27T12:00:00.000Z",
        resourceId: "chg_target",
      },
      {
        type: "change.created",
        actorId: "act_editor",
        requestId: "req_2",
        source: "ui",
        timestamp: "2026-07-27T12:01:00.000Z",
        resourceId: "chg_other",
      },
      {
        type: "change.submitted",
        actorId: "act_reviewer",
        requestId: "req_3",
        source: "ui",
        timestamp: "2026-07-27T12:02:00.000Z",
        resourceId: "chg_target",
        details: { pullRequestNumber: 42 },
      },
    ];
    for (const event of events) await audit.write(event);

    await expect(audit.list({ resourceId: "chg_target", limit: 10 })).resolves.toEqual([
      events[2],
      events[0],
    ]);
    await expect(audit.list({ resourceId: "chg_target", limit: 1 })).resolves.toEqual([events[2]]);
  });
});
