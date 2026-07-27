import type { Actor, ActorId } from "@git-native-cms/core";
import { describe, expect, it, vi } from "vitest";
import { RotatingCookieSessionService, readSessionCookie } from "./index.js";

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
});
