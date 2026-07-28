import type {
  PreviewSession,
  PreviewSessionPort,
  SessionRecord,
  SessionStore,
} from "@git-native-cms/application";
import { CmsError, type Actor, type Change } from "@git-native-cms/core";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";

async function encryptionKey(secret: string): Promise<Uint8Array> {
  if (secret.length < 32) {
    throw new CmsError({
      code: "CMS_CONFIGURATION_002",
      message: "CMS_SESSION_SECRET must contain at least 32 characters.",
      category: "configuration",
      retryable: false,
    });
  }
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
}

export class EncryptedCookieSessionCodec {
  constructor(
    private readonly secret: string,
    private readonly issuer = "git-native-cms",
  ) {}

  async encode(session: SessionRecord): Promise<string> {
    return new EncryptJWT({ session })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .setIssuer(this.issuer)
      .setSubject(session.id)
      .setIssuedAt(Math.floor(new Date(session.createdAt).getTime() / 1000))
      .setExpirationTime(Math.floor(new Date(session.expiresAt).getTime() / 1000))
      .encrypt(await encryptionKey(this.secret));
  }

  async encodeReference(reference: {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<string> {
    return new EncryptJWT({ sessionId: reference.sessionId })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .setIssuer(this.issuer)
      .setSubject(reference.sessionId)
      .setIssuedAt(Math.floor(new Date(reference.createdAt).getTime() / 1000))
      .setExpirationTime(Math.floor(new Date(reference.expiresAt).getTime() / 1000))
      .encrypt(await encryptionKey(this.secret));
  }

  async decodeEnvelope(
    token: string,
    now = new Date(),
  ): Promise<
    | { readonly kind: "inline"; readonly session: SessionRecord }
    | { readonly kind: "stored"; readonly sessionId: string }
  > {
    try {
      const result = await jwtDecrypt(token, await encryptionKey(this.secret), {
        issuer: this.issuer,
        currentDate: now,
      });
      const session = result.payload.session;
      if (typeof session === "object" && session !== null) {
        return { kind: "inline", session: session as unknown as SessionRecord };
      }
      if (typeof result.payload.sessionId === "string") {
        return { kind: "stored", sessionId: result.payload.sessionId };
      }
      throw new Error("Missing session envelope.");
    } catch (cause) {
      throw new CmsError({
        code: "CMS_AUTH_003",
        message: "The session is invalid or expired.",
        category: "authentication",
        retryable: false,
        cause,
      });
    }
  }

  async decode(token: string, now = new Date()): Promise<SessionRecord> {
    const envelope = await this.decodeEnvelope(token, now);
    if (envelope.kind === "stored") {
      throw new CmsError({
        code: "CMS_AUTH_003",
        message: "The session requires its configured server-side store.",
        category: "authentication",
        retryable: false,
      });
    }
    return envelope.session;
  }
}

export function sessionCookie(
  token: string,
  options: { readonly maxAge: number; readonly secure?: boolean },
): string {
  return [
    `cms_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    options.secure === false ? "" : "Secure",
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const [name, ...value] = entry.trim().split("=");
    if (name === "cms_session") return value.join("=") || undefined;
  }
  return undefined;
}

export function expiredSessionCookie(secure = true): string {
  return sessionCookie("", { maxAge: 0, secure });
}

function randomToken(bytes: number): string {
  const value = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export class SignedPreviewSessionService implements PreviewSessionPort {
  private readonly issuer = "git-native-cms";
  private readonly audience = "git-native-cms-preview";

  constructor(
    private readonly secret: string,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async issue(input: Parameters<PreviewSessionPort["issue"]>[0]): Promise<PreviewSession> {
    input.signal?.throwIfAborted();
    if (this.ttlMs < 1_000 || this.ttlMs > 15 * 60_000) {
      throw new CmsError({
        code: "CMS_CONFIGURATION_005",
        message: "Preview sessions must expire between 1 second and 15 minutes.",
        category: "configuration",
        retryable: false,
      });
    }
    const id = `prv_${randomToken(20)}`;
    const createdAt = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + this.ttlMs).toISOString();
    const token = await new SignJWT({
      actorId: input.actorId,
      changeId: input.changeId,
      frontendRef: input.frontendRef,
      locale: input.locale,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(id)
      .setSubject(input.actorId)
      .setIssuedAt(Math.floor(input.now.getTime() / 1000))
      .setExpirationTime(Math.floor(new Date(expiresAt).getTime() / 1000))
      .sign(await encryptionKey(this.secret));
    return {
      id,
      actorId: input.actorId,
      changeId: input.changeId,
      frontendRef: input.frontendRef,
      locale: input.locale,
      createdAt,
      expiresAt,
      token,
    };
  }

  async verify(input: Parameters<PreviewSessionPort["verify"]>[0]): Promise<PreviewSession> {
    input.signal?.throwIfAborted();
    try {
      const result = await jwtVerify(input.token, await encryptionKey(this.secret), {
        algorithms: ["HS256"],
        issuer: this.issuer,
        audience: this.audience,
        currentDate: input.now,
      });
      const { payload } = result;
      if (
        payload.jti !== input.id ||
        typeof payload.sub !== "string" ||
        typeof payload.actorId !== "string" ||
        payload.sub !== payload.actorId ||
        typeof payload.changeId !== "string" ||
        typeof payload.frontendRef !== "string" ||
        typeof payload.locale !== "string" ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number"
      ) {
        throw new Error("Preview claims are incomplete.");
      }
      return {
        id: input.id,
        actorId: payload.actorId as Actor["id"],
        changeId: payload.changeId as Change["id"],
        frontendRef: payload.frontendRef,
        locale: payload.locale,
        createdAt: new Date(payload.iat * 1000).toISOString(),
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        token: input.token,
      };
    } catch (cause) {
      throw new CmsError({
        code: "CMS_PREVIEW_001",
        message: "The preview session is invalid or expired.",
        category: "authentication",
        retryable: false,
        cause,
      });
    }
  }

  async refresh(input: Parameters<PreviewSessionPort["refresh"]>[0]): Promise<PreviewSession> {
    const current = await this.verify(input);
    return this.issue({
      actorId: current.actorId,
      changeId: current.changeId,
      frontendRef: current.frontendRef,
      locale: current.locale,
      now: input.now,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

export interface SessionIssue {
  readonly session: SessionRecord;
  readonly token: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

export class RotatingCookieSessionService {
  private readonly codec: EncryptedCookieSessionCodec;

  constructor(
    secret: string,
    private readonly options: {
      readonly absoluteTtlMs?: number;
      readonly idleTtlMs?: number;
      readonly secure?: boolean;
      readonly revokeGitHubToken?: (accessToken: string, actor: Actor) => Promise<void>;
      readonly store?: SessionStore;
      readonly inlineLimitBytes?: number;
    } = {},
  ) {
    this.codec = new EncryptedCookieSessionCodec(secret);
  }

  async issue(actor: Actor, now = new Date(), githubAccessToken?: string): Promise<SessionIssue> {
    const absoluteTtlMs = this.options.absoluteTtlMs ?? 8 * 60 * 60_000;
    const idleTtlMs = this.options.idleTtlMs ?? 60 * 60_000;
    const csrfToken = randomToken(32);
    const session: SessionRecord = {
      id: `ses_${randomToken(20)}`,
      actor,
      ...(githubAccessToken === undefined ? {} : { githubAccessToken }),
      csrfSecret: csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + absoluteTtlMs).toISOString(),
      idleExpiresAt: new Date(now.getTime() + Math.min(idleTtlMs, absoluteTtlMs)).toISOString(),
    };
    return this.encodeIssue(session, csrfToken, now);
  }

  async rotate(token: string, now = new Date()): Promise<SessionIssue> {
    const current = await this.decodeSession(token, now);
    if (
      new Date(current.expiresAt).getTime() <= now.getTime() ||
      new Date(current.idleExpiresAt).getTime() <= now.getTime()
    ) {
      throw new CmsError({
        code: "CMS_AUTH_007",
        message: "The session expired due to inactivity.",
        category: "authentication",
        retryable: true,
      });
    }
    const idleTtlMs = this.options.idleTtlMs ?? 60 * 60_000;
    const idleExpiresAt = Math.min(
      new Date(current.expiresAt).getTime(),
      now.getTime() + idleTtlMs,
    );
    const rotated: SessionRecord = {
      ...current,
      idleExpiresAt: new Date(idleExpiresAt).toISOString(),
    };
    return this.encodeIssue(rotated, current.csrfSecret, now);
  }

  async read(token: string, now = new Date()): Promise<SessionRecord> {
    const session = await this.decodeSession(token, now);
    if (
      new Date(session.expiresAt).getTime() <= now.getTime() ||
      new Date(session.idleExpiresAt).getTime() <= now.getTime()
    ) {
      throw new CmsError({
        code: "CMS_AUTH_007",
        message: "The session expired due to inactivity.",
        category: "authentication",
        retryable: true,
      });
    }
    return session;
  }

  async logout(token: string | undefined, now = new Date()): Promise<string> {
    if (token !== undefined) {
      try {
        const session = await this.decodeSession(token, now);
        try {
          if (
            session.githubAccessToken !== undefined &&
            this.options.revokeGitHubToken !== undefined
          ) {
            await this.options.revokeGitHubToken(session.githubAccessToken, session.actor);
          }
        } finally {
          await this.options.store?.delete(session.id);
        }
      } catch {
        // Logout remains successful for stale or malformed cookies.
      }
    }
    return expiredSessionCookie(this.options.secure !== false);
  }

  private async encodeIssue(
    session: SessionRecord,
    csrfToken: string,
    now: Date,
  ): Promise<SessionIssue> {
    const stored =
      this.options.store !== undefined &&
      new TextEncoder().encode(JSON.stringify(session)).byteLength >
        (this.options.inlineLimitBytes ?? 2_400);
    if (stored) await this.options.store?.write(session);
    const token = stored
      ? await this.codec.encodeReference({
          sessionId: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        })
      : await this.codec.encode(session);
    const maxAge = Math.max(
      0,
      Math.floor((new Date(session.expiresAt).getTime() - now.getTime()) / 1000),
    );
    return {
      session,
      token,
      csrfToken,
      cookie: sessionCookie(token, {
        maxAge,
        ...(this.options.secure === undefined ? {} : { secure: this.options.secure }),
      }),
    };
  }

  private async decodeSession(token: string, now: Date): Promise<SessionRecord> {
    const envelope = await this.codec.decodeEnvelope(token, now);
    if (envelope.kind === "inline") return envelope.session;
    const session = await this.options.store?.read(envelope.sessionId);
    if (session === undefined || session.id !== envelope.sessionId) {
      throw new CmsError({
        code: "CMS_AUTH_003",
        message: "The server-side session is missing or expired.",
        category: "authentication",
        retryable: false,
      });
    }
    return session;
  }
}

export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { readonly ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly client: RedisSessionClient,
    private readonly prefix = "git-native-cms:session:",
  ) {}

  async read(id: string): Promise<SessionRecord | undefined> {
    const source = await this.client.get(this.key(id));
    if (source === null) return undefined;
    try {
      const value = JSON.parse(source) as SessionRecord;
      if (
        value.id !== id ||
        typeof value.expiresAt !== "string" ||
        typeof value.csrfSecret !== "string"
      ) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  async write(session: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
    await this.client.set(this.key(session.id), JSON.stringify(session), { ex: ttl });
  }

  async delete(id: string): Promise<void> {
    await this.client.del(this.key(id));
  }

  private key(id: string): string {
    if (!/^ses_[a-zA-Z0-9_-]+$/u.test(id)) {
      throw new CmsError({
        code: "CMS_AUTH_011",
        message: "The server-side session ID is invalid.",
        category: "validation",
        retryable: false,
      });
    }
    return `${this.prefix}${id}`;
  }
}
