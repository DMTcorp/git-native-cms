import type {
  AuditEvent,
  AuditQueryPort,
  AuditSink,
  IdempotencyStore,
  RateLimitPort,
  WebhookReplayStore,
} from "@git-native-cms/application";
import { canonicalJson } from "@git-native-cms/content-codecs";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  return (error as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

function isConditionalConflict(error: unknown): boolean {
  const status = statusCode(error);
  return status === 409 || status === 412;
}

async function bodyText(
  body: { transformToString(): Promise<string> } | undefined,
): Promise<string> {
  if (body === undefined) throw new Error("Runtime state object has no body.");
  return body.transformToString();
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedCount(value: string): number {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("count" in parsed) ||
    typeof parsed.count !== "number" ||
    !Number.isSafeInteger(parsed.count) ||
    parsed.count < 0
  ) {
    return 0;
  }
  return parsed.count;
}

function safeTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}

interface S3RuntimeStateOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix?: string;
}

abstract class S3RuntimeState {
  constructor(protected readonly options: S3RuntimeStateOptions) {}

  protected key(path: string): string {
    const prefix = this.options.prefix?.replace(/^\/|\/$/g, "") ?? "runtime";
    return `${prefix}/${path}`;
  }
}

export class S3IdempotencyStore extends S3RuntimeState implements IdempotencyStore {
  async read<TResult>(key: string): Promise<TResult | undefined> {
    const objectKey = this.key(`idempotency/${await digest(key)}.json`);
    try {
      const response = await this.options.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );
      const body = response.Body as { transformToString(): Promise<string> } | undefined;
      return JSON.parse(await bodyText(body)) as TResult;
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async write<TResult>(key: string, result: TResult): Promise<void> {
    const objectKey = this.key(`idempotency/${await digest(key)}.json`);
    try {
      await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          Body: canonicalJson(result),
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      const existing = await this.read<TResult>(key);
      if (existing === undefined || canonicalJson(existing) !== canonicalJson(result)) {
        throw new Error("Idempotency key was reused for a different operation result.", {
          cause: error,
        });
      }
    }
  }
}

export class S3AuditSink extends S3RuntimeState implements AuditSink, AuditQueryPort {
  async write(event: AuditEvent): Promise<void> {
    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(
          `audit/${safeTimestamp(event.timestamp)}-${globalThis.crypto.randomUUID()}.json`,
        ),
        Body: canonicalJson(event),
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
        IfNoneMatch: "*",
      }),
    );
  }

  async list(input: {
    readonly resourceId?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly AuditEvent[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.key("audit/"),
          ...(continuationToken === undefined
            ? {}
            : { ContinuationToken: continuationToken }),
        }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
      for (const object of response.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    const events = await Promise.all(
      keys
        .sort((left, right) => right.localeCompare(left))
        .map(async (key): Promise<AuditEvent | undefined> => {
          try {
            const response = await this.options.client.send(
              new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
              input.signal === undefined ? undefined : { abortSignal: input.signal },
            );
            const body = response.Body as { transformToString(): Promise<string> } | undefined;
            const parsed: unknown = JSON.parse(await bodyText(body));
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("type" in parsed) ||
              typeof parsed.type !== "string" ||
              !("actorId" in parsed) ||
              typeof parsed.actorId !== "string" ||
              !("requestId" in parsed) ||
              typeof parsed.requestId !== "string" ||
              !("timestamp" in parsed) ||
              typeof parsed.timestamp !== "string"
            ) {
              return undefined;
            }
            return parsed as AuditEvent;
          } catch (error) {
            if (input.signal?.aborted === true) throw error;
            return undefined;
          }
        }),
    );

    return events
      .filter((event): event is AuditEvent => event !== undefined)
      .filter((event) => input.resourceId === undefined || event.resourceId === input.resourceId)
      .slice(0, input.limit ?? 100);
  }
}

export class S3WebhookReplayStore extends S3RuntimeState implements WebhookReplayStore {
  async claim(deliveryId: string, expiresAt: string): Promise<boolean> {
    try {
      await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: this.key(`webhook-deliveries/${await digest(deliveryId)}.json`),
          Body: canonicalJson({ deliveryId, expiresAt }),
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store",
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalConflict(error)) return false;
      throw error;
    }
  }
}

export class S3ConfirmationReplayStore extends S3RuntimeState {
  async claim(tokenId: string, expiresAt: string): Promise<boolean> {
    try {
      await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: this.key(`confirmation-tokens/${await digest(tokenId)}.json`),
          Body: canonicalJson({ tokenId, expiresAt }),
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store",
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalConflict(error)) return false;
      throw error;
    }
  }
}

export class MemoryRateLimitStore implements RateLimitPort {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  async consume(
    input: Parameters<RateLimitPort["consume"]>[0],
  ): ReturnType<RateLimitPort["consume"]> {
    const now = new Date(input.now).getTime();
    const windowStart = Math.floor(now / input.windowMs) * input.windowMs;
    const resetAt = windowStart + input.windowMs;
    const key = `${input.scope}:${input.key}:${windowStart}`;
    const current = this.windows.get(key) ?? { count: 0, resetAt };
    const allowed = current.count < input.limit;
    if (allowed) {
      current.count += 1;
      this.windows.set(key, current);
    }
    for (const [candidate, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(candidate);
    }
    return {
      allowed,
      remaining: Math.max(0, input.limit - current.count),
      resetAt: new Date(resetAt).toISOString(),
    };
  }
}

export class S3RateLimitStore extends S3RuntimeState implements RateLimitPort {
  async consume(
    input: Parameters<RateLimitPort["consume"]>[0],
  ): ReturnType<RateLimitPort["consume"]> {
    const now = new Date(input.now).getTime();
    const windowStart = Math.floor(now / input.windowMs) * input.windowMs;
    const resetAt = new Date(windowStart + input.windowMs).toISOString();
    const objectKey = this.key(
      `rate-limits/${await digest(`${input.scope}:${input.key}:${windowStart}`)}.json`,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let count = 0;
      let etag: string | undefined;
      try {
        const response = await this.options.client.send(
          new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
        );
        const body = response.Body as { transformToString(): Promise<string> } | undefined;
        count = storedCount(await bodyText(body));
        etag = response.ETag;
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
      if (count >= input.limit) {
        return { allowed: false, remaining: 0, resetAt };
      }
      try {
        await this.options.client.send(
          new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: objectKey,
            Body: canonicalJson({ count: count + 1, resetAt }),
            ContentType: "application/json; charset=utf-8",
            CacheControl: "no-store",
            ...(etag === undefined ? { IfNoneMatch: "*" } : { IfMatch: etag }),
          }),
        );
        return {
          allowed: true,
          remaining: Math.max(0, input.limit - count - 1),
          resetAt,
        };
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
      }
    }
    return { allowed: false, remaining: 0, resetAt };
  }
}
