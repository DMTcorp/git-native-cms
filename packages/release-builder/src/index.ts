import type { EnvironmentPointer, ReleaseStore, StoredRelease } from "@git-native-cms/application";
import { canonicalJson } from "@git-native-cms/content-codecs";
import type { GitCommitSha, ReleaseId } from "@git-native-cms/core";

export interface ReleaseDocument {
  readonly path: string;
  readonly value: unknown;
  readonly tags?: readonly string[];
}

export interface BuildReleaseInput {
  readonly gitCommit: GitCommitSha;
  readonly configVersion: number;
  readonly registryDigest: string;
  readonly schemaVersion: number;
  readonly documents: readonly ReleaseDocument[];
  readonly redirects?: Readonly<Record<string, string>>;
  readonly generatedAt?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildRelease(input: BuildReleaseInput): Promise<StoredRelease> {
  const orderedDocuments = [...input.documents].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const identity = {
    gitCommit: input.gitCommit,
    configVersion: input.configVersion,
    registryDigest: input.registryDigest,
    schemaVersion: input.schemaVersion,
    documents: orderedDocuments.map((document) => ({
      path: document.path,
      value: document.value,
    })),
    redirects: input.redirects ?? {},
  };
  const releaseDigest = await sha256(canonicalJson(identity));
  const id = `rel_${releaseDigest.slice(0, 24)}` as ReleaseId;
  const files: Record<string, string> = {};
  const checksums: Record<string, string> = {};
  for (const document of orderedDocuments) {
    const source = canonicalJson(document.value);
    files[document.path] = source;
    checksums[document.path] = await sha256(source);
  }
  files["redirects.json"] = canonicalJson(input.redirects ?? {});
  checksums["redirects.json"] = await sha256(files["redirects.json"] ?? "");
  const manifest = {
    formatVersion: 1,
    releaseId: id,
    gitCommit: input.gitCommit,
    configVersion: input.configVersion,
    schemaVersion: input.schemaVersion,
    registryDigest: input.registryDigest,
    generatedAt: input.generatedAt ?? "deterministic",
    files: Object.keys(files).sort(),
    tags: [...new Set(orderedDocuments.flatMap((document) => document.tags ?? []))].sort(),
    checksums,
  };
  files["manifest.json"] = canonicalJson(manifest);
  files["checksums.json"] = canonicalJson(checksums);
  return { id, manifest, files };
}

export async function publishRelease(input: {
  readonly store: ReleaseStore;
  readonly release: StoredRelease;
  readonly environment: EnvironmentPointer["environment"];
  readonly expectedPointerRevision?: string;
  readonly pointerRevision: string;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}): Promise<EnvironmentPointer> {
  await input.store.writeRelease(input.release, input.signal);
  const verification = await input.store.readRelease(input.release.id, input.signal);
  if (
    verification === undefined ||
    verification.files["manifest.json"] !== input.release.files["manifest.json"]
  ) {
    throw new Error("Release verification failed before the pointer update.");
  }
  return input.store.compareAndSwapPointer({
    next: {
      environment: input.environment,
      releaseId: input.release.id,
      revision: input.pointerRevision,
      updatedAt: (input.now ?? new Date()).toISOString(),
    },
    ...(input.expectedPointerRevision === undefined
      ? {}
      : { expectedRevision: input.expectedPointerRevision }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
