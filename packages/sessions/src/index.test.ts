import type { SessionRecord, SessionStore } from "@git-native-cms/application";
import type { Actor, ActorId, Change } from "@git-native-cms/core";
import { describe, expect, it, vi } from "vitest";
import {
  RedisSessionStore,
  RotatingCookieSessionService,
  SignedPreviewSessionService,
  readSessionCookie,
} from "./index.js";

const actor: Actor = {
  id: "act_01K00000000000000000000000" as ActorId,
  githubId: 7,
  login: "editor",
  displayName: "Editor",
  roles: ["editor"],
  source: "ui",
};

describe("rotating cookie sessions", () => {
  it("rotates encrypted cookies and revokes GitHub access on logout", async () => {
    const revoke = vi.fn<(_: string, __: Actor) => Promise<void>>().mockResolvedValue();
    const service = new RotatingCookieSessionService("a-secret-longer-than-thirty-two-characters", {
      secure: true,
      revokeGitHubToken: revoke,
    });
    const issued = await service.issue(actor, new Date("2026-01-01T00:00:00.000Z"), "github-token");
    expect(issued.cookie).toContain("HttpOnly");
    expect(issued.cookie).toContain("Secure");
    expect(readSessionCookie(issued.cookie)).toBe(issued.token);
    const rotated = await service.rotate(issued.token, new Date("2026-01-01T00:10:00.000Z"));
    expect(rotated.session.id).toBe(issued.session.id);
    await service.logout(rotated.token, new Date("2026-01-01T00:11:00.000Z"));
    expect(revoke).toHaveBeenCalledWith("github-token", actor);
  });

  it("prevents fixation, tampering, and idle-session reuse", async () => {
    const service = new RotatingCookieSessionService(
      "another-secret-longer-than-thirty-two-characters",
      {
        secure: true,
        idleTtlMs: 60_000,
      },
    );
    const first = await service.issue(actor, new Date("2026-01-01T00:00:00.000Z"));
    const second = await service.issue(actor, new Date("2026-01-01T00:00:00.000Z"));
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    const tampered = first.token.split(".");
    const authenticationTag = tampered[4];
    if (authenticationTag === undefined) throw new Error("Expected a compact JWE session token.");
    tampered[4] = `${authenticationTag.startsWith("A") ? "B" : "A"}${authenticationTag.slice(1)}`;
    await expect(
      service.read(tampered.join("."), new Date("2026-01-01T00:00:30.000Z")),
    ).rejects.toMatchObject({ code: "CMS_AUTH_003" });
    await expect(
      service.read(first.token, new Date("2026-01-01T00:01:01.000Z")),
    ).rejects.toMatchObject({ code: "CMS_AUTH_007" });
  });

  it("uses a revocable server-side envelope when the cookie payload exceeds its limit", async () => {
    const values = new Map<string, SessionRecord>();
    const store: SessionStore = {
      async read(id) {
        return values.get(id);
      },
      async write(session) {
        values.set(session.id, structuredClone(session));
      },
      async delete(id) {
        values.delete(id);
      },
    };
    const service = new RotatingCookieSessionService(
      "stored-session-secret-longer-than-thirty-two-characters",
      {
        store,
        inlineLimitBytes: 1,
      },
    );
    const issued = await service.issue(
      actor,
      new Date("2026-01-01T00:00:00.000Z"),
      "large-github-access-token",
    );
    expect(values.get(issued.session.id)).toEqual(issued.session);
    await expect(
      service.read(issued.token, new Date("2026-01-01T00:10:00.000Z")),
    ).resolves.toMatchObject({ id: issued.session.id });
    await service.logout(issued.token, new Date("2026-01-01T00:11:00.000Z"));
    expect(values.has(issued.session.id)).toBe(false);
  });
});

describe("Redis session storage", () => {
  it("stores an expiring server-side envelope and supports revocation", async () => {
    const values = new Map<string, string>();
    const expirations: number[] = [];
    const store = new RedisSessionStore({
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value, options) {
        values.set(key, value);
        expirations.push(options.ex);
      },
      async del(key) {
        values.delete(key);
      },
    });
    const session: SessionRecord = {
      id: "ses_redis_contract",
      actor,
      csrfSecret: "csrf",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await store.write(session);
    await expect(store.read(session.id)).resolves.toEqual(session);
    expect(expirations[0]).toBeGreaterThan(0);
    await store.delete(session.id);
    await expect(store.read(session.id)).resolves.toBeUndefined();
  });
});

describe("signed preview sessions", () => {
  it("binds a short-lived token to actor, Change, frontend ref, and locale", async () => {
    const service = new SignedPreviewSessionService(
      "preview-secret-longer-than-thirty-two-characters",
      60_000,
    );
    const now = new Date("2026-01-01T00:00:00.000Z");
    const issued = await service.issue({
      actorId: actor.id,
      changeId: "chg_01K00000000000000000000000" as Change["id"],
      frontendRef: "cms/alice/campaign",
      locale: "pl-PL",
      now,
    });
    expect(issued.token).not.toContain("github");
    await expect(
      service.verify({ id: issued.id, token: issued.token, now }),
    ).resolves.toMatchObject({
      actorId: actor.id,
      changeId: "chg_01K00000000000000000000000",
      frontendRef: "cms/alice/campaign",
      locale: "pl-PL",
    });

    const refreshed = await service.refresh({
      id: issued.id,
      token: issued.token,
      now: new Date("2026-01-01T00:00:30.000Z"),
    });
    expect(refreshed.id).not.toBe(issued.id);
    expect(refreshed.expiresAt).toBe("2026-01-01T00:01:30.000Z");
  });

  it("rejects mismatched IDs, tampering, and expired preview tokens", async () => {
    const service = new SignedPreviewSessionService(
      "another-preview-secret-longer-than-thirty-two-characters",
      1_000,
    );
    const now = new Date("2026-01-01T00:00:00.000Z");
    const issued = await service.issue({
      actorId: actor.id,
      changeId: "chg_01K00000000000000000000000" as Change["id"],
      frontendRef: "main",
      locale: "en-US",
      now,
    });
    await expect(
      service.verify({ id: "prv_wrong", token: issued.token, now }),
    ).rejects.toMatchObject({ code: "CMS_PREVIEW_001" });
    await expect(
      service.verify({
        id: issued.id,
        token: issued.token.replace(
          /\.([^.]+)$/u,
          (_match, signature: string) =>
            `.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`,
        ),
        now,
      }),
    ).rejects.toMatchObject({ code: "CMS_PREVIEW_001" });
    await expect(
      service.verify({
        id: issued.id,
        token: issued.token,
        now: new Date("2026-01-01T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({ code: "CMS_PREVIEW_001" });
  });
});
