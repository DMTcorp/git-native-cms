import { describe, expect, it, vi } from "vitest";
import { exchangeGitHubOAuthCode } from "./index.js";

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
});
