import type {
  AuditEvent,
  AuditSink,
  IdempotencyStore,
  WebhookReplayStore,
} from "@git-native-cms/application";
import { canonicalJson } from "@git-native-cms/content-codecs";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

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
    }
  }
}

export class S3AuditSink extends S3RuntimeState implements AuditSink {
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
