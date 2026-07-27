import type {
  EnvironmentPointer,
  ReleaseBuilderPort,
  ReleaseStore,
  StoredRelease,
} from "@git-native-cms/application";
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
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly generatedAt?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertReleaseInput(input: BuildReleaseInput): void {
  if (!/^[a-f0-9]{40}$/iu.test(input.gitCommit)) {
    throw new Error("Release gitCommit must be an exact 40-character Git commit SHA.");
  }
  if (!/^sha256:[a-f0-9]{64}$/iu.test(input.registryDigest)) {
    throw new Error("Release registryDigest must contain a full SHA-256 digest.");
  }
  if (
    !Number.isSafeInteger(input.configVersion) ||
    input.configVersion < 1 ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1
  ) {
    throw new Error("Release config and schema versions must be positive integers.");
  }
  const paths = [
    ...input.documents.map((document) => document.path),
    ...Object.keys(input.artifacts ?? {}),
  ];
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      path === "manifest.json" ||
      path === "checksums.json"
    ) {
      throw new Error(`Release path "${path}" is unsafe or reserved.`);
    }
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("Release document and artifact paths must be unique.");
  }
}

export async function buildRelease(input: BuildReleaseInput): Promise<StoredRelease> {
  assertReleaseInput(input);
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
    artifacts: Object.fromEntries(
      Object.entries(input.artifacts ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
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
  for (const [path, source] of Object.entries(input.artifacts ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    files[path] = source;
    checksums[path] = await sha256(source);
  }
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

export const deterministicReleaseBuilder: ReleaseBuilderPort = {
  build: buildRelease,
};

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
    Object.keys(verification.files).length !== Object.keys(input.release.files).length ||
    !Object.entries(input.release.files).every(
      ([path, content]) => verification.files[path] === content,
    )
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
