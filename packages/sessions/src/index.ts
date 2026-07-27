import type { SessionRecord } from "@git-native-cms/application";
import { CmsError, type Actor } from "@git-native-cms/core";
import { EncryptJWT, jwtDecrypt } from "jose";

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

  async decode(token: string, now = new Date()): Promise<SessionRecord> {
    try {
      const result = await jwtDecrypt(token, await encryptionKey(this.secret), {
        issuer: this.issuer,
        currentDate: now,
      });
      const session = result.payload.session;
      if (typeof session !== "object" || session === null) throw new Error("Missing session.");
      return session as unknown as SessionRecord;
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
      readonly revokeGitHubToken?: (actor: Actor) => Promise<void>;
    } = {},
  ) {
    this.codec = new EncryptedCookieSessionCodec(secret);
  }

  async issue(actor: Actor, now = new Date()): Promise<SessionIssue> {
    const absoluteTtlMs = this.options.absoluteTtlMs ?? 8 * 60 * 60_000;
    const idleTtlMs = this.options.idleTtlMs ?? 60 * 60_000;
    const csrfToken = randomToken(32);
    const session: SessionRecord = {
      id: `ses_${randomToken(20)}`,
      actor,
      csrfSecret: csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + absoluteTtlMs).toISOString(),
      idleExpiresAt: new Date(now.getTime() + Math.min(idleTtlMs, absoluteTtlMs)).toISOString(),
    };
    return this.encodeIssue(session, csrfToken, now);
  }

  async rotate(token: string, now = new Date()): Promise<SessionIssue> {
    const current = await this.codec.decode(token, now);
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

  async logout(token: string | undefined, now = new Date()): Promise<string> {
    if (token !== undefined && this.options.revokeGitHubToken !== undefined) {
      try {
        const session = await this.codec.decode(token, now);
        await this.options.revokeGitHubToken(session.actor);
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
    const token = await this.codec.encode(session);
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
}
