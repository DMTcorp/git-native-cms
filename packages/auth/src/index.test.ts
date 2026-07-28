import { describe, expect, it, vi } from "vitest";
import {
  createGitHubOAuthAttempt,
  csrfMatches,
  exchangeGitHubOAuthCode,
  verifyOAuthState,
} from "./index.js";

describe("GitHub OAuth exchange", () => {
  it("uses the fixed GitHub endpoint and PKCE verifier", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: "secret", token_type: "bearer", scope: "read:user" }),
      );
    const token = await exchangeGitHubOAuthCode({
      clientId: "client",
      clientSecret: "server-secret",
      code: "code",
      verifier: "verifier",
      redirectUri: "https://cms.example/callback",
      fetch: fetcher,
    });
    expect(token.scope).toBe("read:user");
    expect(fetcher).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        body: expect.stringContaining('"code_verifier":"verifier"') as string,
        redirect: "error",
      }),
    );
  });

  it("binds PKCE state to the fixed callback and rejects mismatches or expiry", async () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const attempt = await createGitHubOAuthAttempt({
      clientId: "client",
      callbackUrl: "https://cms.example/api/cms/auth/github/callback",
      now,
    });
    const authorization = new URL(attempt.authorizationUrl);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://cms.example/api/cms/auth/github/callback",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(() =>
      verifyOAuthState({
        expected: attempt.state,
        received: `${attempt.state}-attacker`,
        expiresAt: attempt.expiresAt,
        now,
      }),
    ).toThrow("could not be verified");
    expect(() =>
      verifyOAuthState({
        expected: attempt.state,
        received: attempt.state,
        expiresAt: attempt.expiresAt,
        now: new Date(attempt.expiresAt),
      }),
    ).toThrow("expired");
  });

  it("compares session-bound CSRF values without accepting prefixes or missing values", () => {
    expect(csrfMatches("csrf-session-value", "csrf-session-value")).toBe(true);
    expect(csrfMatches("csrf-session-value", "csrf-session")).toBe(false);
    expect(csrfMatches("csrf-session-value", null)).toBe(false);
  });
});
