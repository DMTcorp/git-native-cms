import { CmsError } from "@git-native-cms/core";

function base64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface OAuthAttempt {
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export async function createGitHubOAuthAttempt(input: {
  readonly clientId: string;
  readonly callbackUrl: string;
  readonly scopes?: readonly string[];
  readonly authorizationBaseUrl?: string;
  readonly now?: Date;
}): Promise<OAuthAttempt> {
  const verifier = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(
    new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const state = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL("/login/oauth/authorize", input.authorizationBaseUrl ?? "https://github.com");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scopes !== undefined) url.searchParams.set("scope", input.scopes.join(" "));
  const now = input.now ?? new Date();
  return {
    state,
    verifier,
    challenge,
    authorizationUrl: url.toString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
}

export function verifyOAuthState(input: {
  readonly expected: string;
  readonly received: string | null;
  readonly expiresAt: string;
  readonly now?: Date;
}): void {
  if (input.received === null || input.expected !== input.received) {
    throw new CmsError({
      code: "CMS_AUTH_001",
      message: "The login attempt could not be verified. Start again.",
      category: "authentication",
      retryable: false,
    });
  }
  if ((input.now ?? new Date()).getTime() >= new Date(input.expiresAt).getTime()) {
    throw new CmsError({
      code: "CMS_AUTH_002",
      message: "The login attempt expired. Start again.",
      category: "authentication",
      retryable: true,
    });
  }
}

export function csrfMatches(expected: string, received: string | null): boolean {
  if (received === null || expected.length !== received.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return difference === 0;
}

export interface GitHubOAuthToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scope: string;
}

function oauthError(message: string, context?: Readonly<Record<string, unknown>>): CmsError {
  return new CmsError({
    code: "CMS_AUTH_008",
    message,
    category: "authentication",
    retryable: false,
    ...(context === undefined ? {} : { context }),
  });
}

export async function exchangeGitHubOAuthCode(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly oauthBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<GitHubOAuthToken> {
  const response = await (input.fetch ?? globalThis.fetch)(
    new URL("/login/oauth/access_token", input.oauthBaseUrl ?? "https://github.com").toString(),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      }),
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  if (!response.ok) throw oauthError("GitHub rejected the OAuth code exchange.");
  const value = (await response.json()) as Record<string, unknown>;
  if (typeof value.error === "string") {
    throw oauthError("GitHub rejected the OAuth code exchange.", { error: value.error });
  }
  if (typeof value.access_token !== "string") {
    throw oauthError("GitHub did not return an access token.");
  }
  return {
    accessToken: value.access_token,
    tokenType: typeof value.token_type === "string" ? value.token_type : "bearer",
    scope: typeof value.scope === "string" ? value.scope : "",
  };
}

export async function revokeGitHubOAuthToken(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const authorization = btoa(`${input.clientId}:${input.clientSecret}`);
  const response = await (input.fetch ?? globalThis.fetch)(
    `${(input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "")}/applications/${encodeURIComponent(input.clientId)}/token`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${authorization}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: input.accessToken }),
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw oauthError("GitHub could not revoke the OAuth token.");
  }
}
