import type { CmsApplication } from "@git-native-cms/application";
import type { Actor } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { createCmsServer } from "./index.js";

const actor: Actor = {
  id: "act_00000000000000000000000000" as Actor["id"],
  githubId: 1,
  login: "security",
  displayName: "Security Test",
  roles: ["administrator"],
  source: "ui",
};

function server() {
  const unavailable = async (): Promise<never> => {
    throw new Error("Query is not used by this test.");
  };
  return createCmsServer({
    application: {} as CmsApplication,
    actorForRequest: async () => actor,
    verifyCsrf: async () => true,
    queries: {
      bootstrap: unavailable,
      listChanges: unavailable,
      getChange: unavailable,
      listDocuments: unavailable,
      getDocument: unavailable,
      listReleases: unavailable,
      listAssets: unavailable,
      assetUsages: unavailable,
      search: unavailable,
      findUsages: unavailable,
      exportTranslation: unavailable,
    },
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const value = (await response.json()) as {
    readonly payload?: { readonly error?: { readonly code?: string } };
  };
  return value.payload?.error?.code;
}

describe("CMS server request hardening", () => {
  it("rejects oversized mutation bodies before dispatch", async () => {
    const response = await server().handle(
      new Request("https://cms.test/api/cms/changes", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1048577" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("CMS_REQUEST_006");
  });

  it("rejects protected object keys and excessive nesting", async () => {
    const protectedResponse = await server().handle(
      new Request("https://cms.test/api/cms/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"safe","__proto__":{"polluted":true}}',
      }),
    );
    expect(protectedResponse.status).toBe(400);
    expect(await errorCode(protectedResponse)).toBe("CMS_REQUEST_007");

    let value: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) value = { child: value };
    const nestedResponse = await server().handle(
      new Request("https://cms.test/api/cms/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
    expect(nestedResponse.status).toBe(400);
    expect(await errorCode(nestedResponse)).toBe("CMS_REQUEST_007");
  });

  it("rejects cross-origin requests before resolving a command", async () => {
    const secured = createCmsServer({
      application: {} as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => true,
      allowedOrigins: ["https://cms.test"],
      queries: {
        bootstrap: async () => ({}),
        listChanges: async () => [],
        getChange: async () => {
          throw new Error("unused");
        },
        listDocuments: async () => ({ items: [] }),
        getDocument: async () => {
          throw new Error("unused");
        },
        listReleases: async () => [],
        listAssets: async () => ({ items: [] }),
        assetUsages: async () => [],
        search: async () => [],
        findUsages: async () => [],
        exportTranslation: async () => "",
      },
    });
    const response = await secured.handle(
      new Request("https://cms.test/api/cms/bootstrap", {
        headers: { origin: "https://attacker.test" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("CMS_AUTH_006");
  });

  it("requires a session-bound CSRF token and JSON media type for mutations", async () => {
    const unused = async (): Promise<never> => {
      throw new Error("Query is not used by this test.");
    };
    const csrfServer = createCmsServer({
      application: {} as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => false,
      queries: {
        bootstrap: async () => ({}),
        listChanges: async () => [],
        getChange: unused,
        listDocuments: unused,
        getDocument: unused,
        listReleases: unused,
        listAssets: unused,
        assetUsages: unused,
        search: unused,
        findUsages: unused,
        exportTranslation: unused,
      },
    });
    const csrfResponse = await csrfServer.handle(
      new Request("https://cms.test/api/cms/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"blocked"}',
      }),
    );
    expect(csrfResponse.status).toBe(401);
    expect(await errorCode(csrfResponse)).toBe("CMS_AUTH_005");

    const mediaTypeResponse = await server().handle(
      new Request("https://cms.test/api/cms/changes", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"name":"blocked"}',
      }),
    );
    expect(mediaTypeResponse.status).toBe(400);
    expect(await errorCode(mediaTypeResponse)).toBe("CMS_REQUEST_008");
  });

  it("returns a retryable 429 response when the actor exhausts a request window", async () => {
    const limited = createCmsServer({
      application: {} as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => true,
      rateLimit: {
        consume: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      },
      queries: {
        bootstrap: async () => ({}),
        listChanges: async () => [],
        getChange: async () => {
          throw new Error("unused");
        },
        listDocuments: async () => ({ items: [] }),
        getDocument: async () => {
          throw new Error("unused");
        },
        listReleases: async () => [],
        listAssets: async () => ({ items: [] }),
        assetUsages: async () => [],
        search: async () => [],
        findUsages: async () => [],
        exportTranslation: async () => "",
      },
    });

    const response = await limited.handle(new Request("https://cms.test/api/cms/bootstrap"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(await errorCode(response)).toBe("CMS_RATE_LIMIT_001");
  });
});
