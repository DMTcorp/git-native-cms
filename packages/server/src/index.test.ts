import type { Asset, CmsApplication } from "@git-native-cms/application";
import type { Actor, Change, GitCommitSha, ReleaseId } from "@git-native-cms/core";
import { describe, expect, it, vi } from "vitest";
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
      staging: unavailable,
      listChanges: unavailable,
      getChange: unavailable,
      listDocuments: unavailable,
      getDocument: unavailable,
      listReleases: unavailable,
      listAssets: unavailable,
      getAsset: unavailable,
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
  it("exposes the application audit timeline for an authenticated Change", async () => {
    const change = {
      id: "chg_audit",
      name: "Audit fixture",
      branchName: "cms/audit",
      baseBranch: "main",
      baseCommit: "a".repeat(40) as GitCommitSha,
      ownerId: actor.id,
      status: "draft",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
    } as Change;
    const readAuditTimeline = vi.fn().mockResolvedValue([
      {
        type: "change.created",
        actorId: actor.id,
        requestId: "req_audit",
        source: "ui",
        timestamp: "2026-07-27T12:00:00.000Z",
        resourceId: change.id,
      },
    ]);
    const auditServer = createCmsServer({
      application: {
        readAuditTimeline: { execute: readAuditTimeline },
      } as unknown as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => true,
      queries: {
        bootstrap: async () => ({}),
        staging: async () => ({}),
        listChanges: async () => [change],
        getChange: async () => change,
        listDocuments: async () => ({ items: [] }),
        getDocument: async () => {
          throw new Error("unused");
        },
        listReleases: async () => [],
        listAssets: async () => ({ items: [] }),
        getAsset: async () => {
          throw new Error("unused");
        },
        assetUsages: async () => [],
        search: async () => [],
        findUsages: async () => [],
        exportTranslation: async () => "",
      },
    });
    const response = await auditServer.handle(
      new Request(`https://cms.test/api/cms/changes/${change.id}/audit?limit=25`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "change.audit",
      payload: { items: [{ type: "change.created", resourceId: change.id }] },
    });
    expect(readAuditTimeline).toHaveBeenCalledWith(
      { resourceId: change.id, limit: 25 },
      expect.objectContaining({ actor }),
    );
  });

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
        staging: async () => ({}),
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
        getAsset: async () => {
          throw new Error("unused");
        },
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
        staging: async () => ({}),
        listChanges: async () => [],
        getChange: unused,
        listDocuments: unused,
        getDocument: unused,
        listReleases: unused,
        listAssets: unused,
        getAsset: unused,
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
        staging: async () => ({}),
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
        getAsset: async () => {
          throw new Error("unused");
        },
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

  it("streams same-origin local asset uploads without forcing JSON encoding", async () => {
    let received:
      | {
          readonly uploadId: string;
          readonly mimeType: string;
          readonly token?: string;
          readonly bytes: Uint8Array;
        }
      | undefined;
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    const uploadServer = createCmsServer({
      application: {
        receiveAssetUpload: {
          execute: async (
            input: Parameters<CmsApplication["receiveAssetUpload"]["execute"]>[0],
          ) => {
            received = input;
          },
        },
      } as unknown as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async (request) => request.headers.get("x-csrf-token") === "csrf",
      allowedOrigins: ["https://cms.test"],
      queries: {
        bootstrap: unused,
        staging: unused,
        listChanges: unused,
        getChange: unused,
        listDocuments: unused,
        getDocument: unused,
        listReleases: unused,
        listAssets: unused,
        getAsset: unused,
        assetUsages: unused,
        search: unused,
        findUsages: unused,
        exportTranslation: unused,
      },
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const response = await uploadServer.handle(
      new Request("https://cms.test/api/cms/assets/uploads/upl_local/content", {
        method: "PUT",
        headers: {
          origin: "https://cms.test",
          "content-type": "image/png",
          "x-cms-upload-token": "upload-token",
          "x-csrf-token": "csrf",
        },
        body: bytes,
      }),
    );
    expect(response.status).toBe(204);
    expect(received).toMatchObject({
      uploadId: "upl_local",
      mimeType: "image/png",
      token: "upload-token",
      bytes,
    });
  });
});

describe("CMS server public API contract", () => {
  it("exposes preview sessions, asset metadata, and release revalidation", async () => {
    const revision = "a".repeat(40) as GitCommitSha;
    const change = {
      id: "chg_01K00000000000000000000000",
      name: "API contract",
      ownerId: actor.id,
      baseBranch: "main",
      baseCommit: revision,
      branchName: "cms/security/api-contract",
      status: "draft",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Change;
    const asset = {
      id: "ast_0123456789abcdef01234567",
      fileName: "hero.png",
      mimeType: "image/png",
      size: 128,
      checksum: "0".repeat(64),
      url: "https://assets.test/hero.png",
    } as Asset;
    const preview = {
      id: "prv_contract",
      actorId: actor.id,
      changeId: change.id,
      frontendRef: change.branchName,
      locale: "pl-PL",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      token: "signed-preview-token",
    };
    const createPreview = vi.fn(async () => preview);
    const readPreview = vi.fn(async () => preview);
    const refreshPreview = vi.fn(async () => ({ ...preview, id: "prv_refreshed" }));
    const updateAsset = vi.fn(async () => ({
      asset: { ...asset, altText: "Campaign hero", focalPoint: { x: 0.25, y: 0.75 } },
      revision,
    }));
    const revalidateRelease = vi.fn(async () => undefined);
    const api = createCmsServer({
      application: {
        createPreviewSession: { execute: createPreview },
        readPreviewSession: { execute: readPreview },
        refreshPreviewSession: { execute: refreshPreview },
        updateAsset: { execute: updateAsset },
        revalidateRelease: { execute: revalidateRelease },
      } as unknown as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => true,
      queries: {
        bootstrap: async () => ({}),
        staging: async () => ({}),
        listChanges: async () => [change],
        getChange: async () => change,
        listDocuments: async () => ({ items: [] }),
        getDocument: async () => {
          throw new Error("unused");
        },
        listReleases: async () => [],
        listAssets: async () => ({ items: [asset] }),
        getAsset: async () => asset,
        assetUsages: async () => [],
        search: async () => [],
        findUsages: async () => [],
        exportTranslation: async () => "",
      },
    });

    const created = await api.handle(
      new Request("https://cms.test/api/cms/preview/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "preview-create" },
        body: JSON.stringify({
          changeId: change.id,
          frontendRef: change.branchName,
          locale: "pl-PL",
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/api/cms/preview/sessions/prv_contract");

    const read = await api.handle(
      new Request("https://cms.test/api/cms/preview/sessions/prv_contract", {
        headers: { authorization: "Bearer signed-preview-token" },
      }),
    );
    expect(read.status).toBe(200);
    expect(readPreview).toHaveBeenCalledWith(
      { id: "prv_contract", token: "signed-preview-token" },
      expect.objectContaining({ actor }),
    );

    const refreshed = await api.handle(
      new Request("https://cms.test/api/cms/preview/sessions/prv_contract/refresh", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-preview-token",
          "content-type": "application/json",
          "idempotency-key": "preview-refresh",
        },
        body: "{}",
      }),
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("location")).toBe("/api/cms/preview/sessions/prv_refreshed");

    const readAsset = await api.handle(new Request(`https://cms.test/api/cms/assets/${asset.id}`));
    expect(readAsset.status).toBe(200);
    const updatedAsset = await api.handle(
      new Request(`https://cms.test/api/cms/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "asset-update" },
        body: JSON.stringify({
          changeId: change.id,
          expectedRevision: revision,
          altText: "Campaign hero",
          focalPoint: { x: 0.25, y: 0.75 },
        }),
      }),
    );
    expect(updatedAsset.status).toBe(200);
    expect(updateAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: asset.id,
        altText: "Campaign hero",
        focalPoint: { x: 0.25, y: 0.75 },
      }),
      expect.objectContaining({ actor }),
    );

    const releaseId = `rel_${"1".repeat(64)}` as ReleaseId;
    const revalidated = await api.handle(
      new Request(`https://cms.test/api/cms/releases/${releaseId}/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "revalidate" },
        body: JSON.stringify({ environment: "production" }),
      }),
    );
    expect(revalidated.status).toBe(200);
    expect(revalidateRelease).toHaveBeenCalledWith(
      { releaseId, environment: "production", idempotencyKey: "revalidate" },
      expect.objectContaining({ actor }),
    );
  });
});

describe("CMS semantic conflict API", () => {
  it("reads conflicts and validates explicit field resolutions", async () => {
    const revision = "b".repeat(40) as GitCommitSha;
    const change = {
      id: "chg_conflict_api",
      name: "Resolve API conflict",
      ownerId: actor.id,
      baseBranch: "main",
      baseCommit: "a".repeat(40) as GitCommitSha,
      branchName: "cms/security/conflict-api",
      status: "approved",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Change;
    const readChangeConflicts = vi.fn(async () => ({
      conflicts: [
        {
          documentId: "doc_home",
          path: "/title",
          base: "Original",
          change: "Campaign",
          staging: "Legal",
          scope: "field",
        },
      ],
      stagingRevision: "c".repeat(40),
    }));
    const resolveChangeConflicts = vi.fn(async () => ({
      change: { ...change, status: "in_review" },
      revision,
    }));
    const api = createCmsServer({
      application: {
        readChangeConflicts: { execute: readChangeConflicts },
        resolveChangeConflicts: { execute: resolveChangeConflicts },
      } as unknown as CmsApplication,
      actorForRequest: async () => actor,
      verifyCsrf: async () => true,
      queries: {
        bootstrap: async () => ({}),
        staging: async () => ({}),
        listChanges: async () => [change],
        getChange: async () => change,
        listDocuments: async () => ({ items: [] }),
        getDocument: async () => {
          throw new Error("unused");
        },
        listReleases: async () => [],
        listAssets: async () => ({ items: [] }),
        getAsset: async () => {
          throw new Error("unused");
        },
        assetUsages: async () => [],
        search: async () => [],
        findUsages: async () => [],
        exportTranslation: async () => "",
      },
    });
    const read = await api.handle(
      new Request(`https://cms.test/api/cms/changes/${change.id}/conflicts`),
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      type: "change.conflicts",
      payload: { conflicts: [{ documentId: "doc_home", path: "/title" }] },
    });

    const resolved = await api.handle(
      new Request(`https://cms.test/api/cms/changes/${change.id}/conflicts/resolve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "resolve-api-conflict",
        },
        body: JSON.stringify({
          expectedRevision: revision,
          resolutions: [{ documentId: "doc_home", path: "/title", choice: "change" }],
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    expect(resolveChangeConflicts).toHaveBeenCalledWith(
      {
        change,
        expectedRevision: revision,
        resolutions: [{ documentId: "doc_home", path: "/title", choice: "change" }],
        idempotencyKey: "resolve-api-conflict",
      },
      expect.objectContaining({ actor }),
    );
  });
});
