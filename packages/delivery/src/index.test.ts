import type { EnvironmentPointer, ReleaseStore, StoredRelease } from "@git-native-cms/application";
import type { ReleaseId } from "@git-native-cms/core";
import { MemoryGitProvider } from "@git-native-cms/testing";
import type { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  cdnSource,
  createContentClient,
  gitSource,
  isContentActive,
  loadActiveContentGraph,
  previewSource,
  releaseStoreSource,
  resolveRedirect,
  S3ReleaseStore,
} from "./index.js";

describe("delivery redirects", () => {
  it("resolves safe redirect chains and rejects loops", () => {
    expect(resolveRedirect({ "/old": "/new" }, "/old")).toBe("/new");
    expect(resolveRedirect({ "/v1": "/v2", "/v2": "/current" }, "/v1")).toBe("/current");
    expect(resolveRedirect({ "/old": "/new" }, "/unrelated")).toBeUndefined();
    expect(() => resolveRedirect({ "/a": "/b", "/b": "/a" }, "/a")).toThrow(/loop/i);
  });
});

describe("delivery availability and visibility", () => {
  it("filters content against independent availability and visibility windows", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      isContentActive(
        {
          availability: {
            from: "2026-08-01T10:00:00.000Z",
            until: "2026-08-01T14:00:00.000Z",
          },
          visibilitySchedule: { from: "2026-08-01T11:00:00.000Z" },
        },
        now,
      ),
    ).toBe(true);
    expect(
      isContentActive(
        { visibilitySchedule: { until: "2026-08-01T12:00:00.000Z" } },
        now,
      ),
    ).toBe(false);

    const releaseId = "rel_windows" as ReleaseId;
    const files: Readonly<Record<string, string>> = {
      "content-index.json": JSON.stringify([
        { id: "visible", type: "pages", title: "Visible", path: "pages/visible.json" },
        { id: "future", type: "pages", title: "Future", path: "pages/future.json" },
      ]),
      "pages/visible.json": JSON.stringify({ id: "visible", type: "pages", title: "Visible" }),
      "pages/future.json": JSON.stringify({
        id: "future",
        type: "pages",
        title: "Future",
        availability: { from: "2026-08-02T00:00:00.000Z" },
      }),
    };
    const client = createContentClient({
      environment: "production",
      source: {
        readPointer: async () => ({ releaseId }),
        readFile: async (_id, path) => files[path] ?? Promise.reject(new Error("missing")),
      },
    });
    await expect(loadActiveContentGraph(client, { now })).resolves.toMatchObject([
      { id: "visible" },
    ]);
  });
});

describe("typed delivery sources", () => {
  it("reads a ReleaseStore and falls back to a known-good immutable release", async () => {
    const current = "rel_current" as ReleaseId;
    const fallback = "rel_fallback" as ReleaseId;
    const releases = new Map<ReleaseId, StoredRelease>([
      [
        current,
        {
          id: current,
          manifest: {},
          files: {},
        },
      ],
      [
        fallback,
        {
          id: fallback,
          manifest: {},
          files: { "pages/home.json": '{"title":"Known good"}' },
        },
      ],
    ]);
    const pointer: EnvironmentPointer = {
      environment: "production",
      releaseId: current,
      revision: "pointer-current",
      updatedAt: "2026-07-27T12:00:00.000Z",
    };
    const store: ReleaseStore = {
      async writeRelease() {},
      async readRelease(id) {
        return releases.get(id);
      },
      async listReleases() {
        return { items: [...releases.values()] };
      },
      async readPointer() {
        return pointer;
      },
      async compareAndSwapPointer({ next }) {
        return next;
      },
    };
    const stale: string[] = [];
    const client = createContentClient({
      environment: "production",
      source: releaseStoreSource(store),
      fallbackReleaseId: fallback,
      onStaleFallback: ({ path }) => stale.push(path),
    });
    await expect(client.get("pages/home.json")).resolves.toEqual({ title: "Known good" });
    expect(stale).toEqual(["pages/home.json"]);
  });

  it("authenticates every preview request with the scoped bearer token", async () => {
    const requests: { readonly url: string; readonly authorization: string | null }[] = [];
    const source = previewSource({
      baseUrl: "https://preview.example.test/api",
      token: "preview-token",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({
          url,
          authorization: headers.get("authorization"),
        });
        return Response.json(
          url.includes("/pointer?") ? { releaseId: "rel_preview" } : { title: "Preview" },
        );
      },
    });
    const pointer = await source.readPointer("preview");
    await source.readFile(pointer.releaseId, "pages/home.json");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.authorization === "Bearer preview-token")).toBe(
      true,
    );
  });

  it("revalidates CDN responses with ETags after a client invalidation", async () => {
    const seen: (string | null)[] = [];
    const source = cdnSource({
      baseUrl: "https://cdn.example.test",
      fetch: async (_input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        seen.push(etag);
        if (etag === '"pointer-v1"') return new Response(null, { status: 304 });
        return new Response('{"releaseId":"rel_etag"}', {
          headers: { etag: '"pointer-v1"', "content-type": "application/json" },
        });
      },
    });
    await expect(source.readPointer("production")).resolves.toEqual({ releaseId: "rel_etag" });
    await expect(source.readPointer("production")).resolves.toEqual({ releaseId: "rel_etag" });
    expect(seen).toEqual([null, '"pointer-v1"']);
  });

  it("reads immutable release files from Git during static builds", async () => {
    const releaseId = "rel_git_build" as ReleaseId;
    const git = new MemoryGitProvider({
      ".cms/environments/production/current.json": JSON.stringify({ releaseId }),
      [`releases/${releaseId}/pages/home.json`]: '{"title":"Built from Git"}',
    });
    const client = createContentClient({
      environment: "production",
      source: gitSource({ git, ref: "main" }),
    });
    await expect(client.get("pages/home.json")).resolves.toEqual({ title: "Built from Git" });
    await expect(
      gitSource({ git, ref: "main" }).readFile(releaseId, "../secret.json"),
    ).rejects.toMatchObject({
      code: "CMS_DELIVERY_015",
    });
  });
});

describe("S3 release delivery", () => {
  it("assembles concurrently fetched files in deterministic path order", async () => {
    const releaseId = "rel_0123456789abcdef01234567" as ReleaseId;
    const prefix = `releases/${releaseId}/`;
    const sources: Readonly<Record<string, string>> = {
      [`${prefix}manifest.json`]: '{"formatVersion":1}',
      [`${prefix}pages/home.json`]: '{"title":"Home"}',
    };
    const client = {
      async send(command: GetObjectCommand | ListObjectsV2Command) {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: Object.keys(sources).map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        const key = command.input.Key;
        if (key === undefined) throw new Error("Expected an object key.");
        return {
          Body: {
            async transformToString() {
              if (key.endsWith("manifest.json")) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              const source = sources[key];
              if (source === undefined) throw new Error(`Missing fixture ${key}.`);
              return source;
            },
          },
        };
      },
    } as unknown as S3Client;

    const release = await new S3ReleaseStore({ client, bucket: "cms-releases" }).readRelease(
      releaseId,
    );

    expect(Object.keys(release?.files ?? {})).toEqual(["manifest.json", "pages/home.json"]);
    expect(release).toEqual({
      id: releaseId,
      manifest: { formatVersion: 1 },
      files: {
        "manifest.json": '{"formatVersion":1}',
        "pages/home.json": '{"title":"Home"}',
      },
    });
  });
});
