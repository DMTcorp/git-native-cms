import type {
  Asset,
  AssetStore,
  EnvironmentPointer,
  Page,
  ReleaseStore,
  SessionRecord,
  SessionStore,
  StoredRelease,
} from "@git-native-cms/application";
import type { Actor, AssetId, ReleaseId } from "@git-native-cms/core";
import { MemoryGitProvider } from "@git-native-cms/testing";
import { describe, expect, it } from "vitest";
import {
  AssetStoreContract,
  contractPassed,
  FrameworkAdapterContract,
  GitProviderContract,
  ReleaseStoreContract,
  RendererContract,
  SessionStoreContract,
} from "./contracts.js";

const actor: Actor = {
  id: "act_contract" as Actor["id"],
  githubId: 1,
  login: "contract",
  displayName: "Contract Adapter",
  roles: ["administrator"],
  source: "cli",
};

function expectContract(results: Awaited<ReturnType<typeof RendererContract>>): void {
  expect(
    contractPassed(results),
    results
      .filter((result) => !result.passed)
      .map((result) => `${result.name}: ${result.details ?? "failed"}`)
      .join("\n"),
  ).toBe(true);
}

class ContractAssetStore implements AssetStore {
  private readonly assets = new Map<AssetId, Asset>();

  async createUpload(input: Parameters<AssetStore["createUpload"]>[0]) {
    return {
      uploadId: "upl_contract",
      url: "https://uploads.example.test/upl_contract",
      headers: { "content-type": input.mimeType },
    };
  }

  async finalizeUpload(input: Parameters<AssetStore["finalizeUpload"]>[0]): Promise<Asset> {
    const id = `ast_${input.checksum.slice(0, 24)}` as AssetId;
    const asset =
      this.assets.get(id) ??
      ({
        id,
        fileName: "proof.png",
        mimeType: "image/png",
        size: 4,
        checksum: input.checksum,
        url: `https://assets.example.test/${input.checksum}/proof.png`,
      } satisfies Asset);
    this.assets.set(id, asset);
    return asset;
  }

  async readAsset(id: AssetId): Promise<Asset | undefined> {
    return this.assets.get(id);
  }

  async deleteAsset(id: AssetId): Promise<void> {
    this.assets.delete(id);
  }

  async listAssets(): Promise<Page<Asset>> {
    return { items: [...this.assets.values()] };
  }
}

class ContractReleaseStore implements ReleaseStore {
  private readonly releases = new Map<ReleaseId, StoredRelease>();
  private readonly pointers = new Map<EnvironmentPointer["environment"], EnvironmentPointer>();

  async writeRelease(release: StoredRelease): Promise<void> {
    const current = this.releases.get(release.id);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(release)) {
      throw new Error("immutable release changed");
    }
    this.releases.set(release.id, structuredClone(release));
  }

  async readRelease(id: ReleaseId): Promise<StoredRelease | undefined> {
    return this.releases.get(id);
  }

  async listReleases(): Promise<{ readonly items: readonly StoredRelease[] }> {
    return { items: [...this.releases.values()] };
  }

  async readPointer(
    environment: EnvironmentPointer["environment"],
  ): Promise<EnvironmentPointer | undefined> {
    return this.pointers.get(environment);
  }

  async compareAndSwapPointer(
    input: Parameters<ReleaseStore["compareAndSwapPointer"]>[0],
  ): Promise<EnvironmentPointer> {
    const current = this.pointers.get(input.next.environment);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new Error("stale pointer");
    }
    this.pointers.set(input.next.environment, input.next);
    return input.next;
  }
}

class ContractSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async read(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async write(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

describe("shared adapter contracts", () => {
  it("exercises GitProvider", async () => {
    expectContract(
      await GitProviderContract({
        provider: new MemoryGitProvider(),
        baseRef: "main",
        branch: "contract/git-provider",
        actor,
      }),
    );
  });

  it("exercises AssetStore", async () => {
    expectContract(
      await AssetStoreContract({
        store: new ContractAssetStore(),
        fileName: "proof.png",
        mimeType: "image/png",
        size: 4,
        checksum: "a".repeat(64),
        actor,
        put: async () => undefined,
      }),
    );
  });

  it("exercises ReleaseStore", async () => {
    const release: StoredRelease = {
      id: "rel_0123456789abcdef01234567" as ReleaseId,
      manifest: { formatVersion: 1 },
      files: { "manifest.json": '{"formatVersion":1}' },
    };
    expectContract(
      await ReleaseStoreContract({
        store: new ContractReleaseStore(),
        release,
        pointer: {
          environment: "production",
          releaseId: release.id,
          revision: "contract-pointer-1",
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
      }),
    );
  });

  it("exercises SessionStore", async () => {
    expectContract(
      await SessionStoreContract({
        store: new ContractSessionStore(),
        session: {
          id: "ses_contract",
          actor,
          csrfSecret: "csrf-contract",
          createdAt: "2026-07-27T12:00:00.000Z",
          expiresAt: "2026-07-27T20:00:00.000Z",
          idleExpiresAt: "2026-07-27T13:00:00.000Z",
        },
      }),
    );
  });

  it("exercises framework and renderer boundaries", async () => {
    expectContract(
      await FrameworkAdapterContract({
        handle: async () =>
          Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }),
      }),
    );
    expectContract(await RendererContract({ render: () => "<main>Published content</main>" }));
  });
});
