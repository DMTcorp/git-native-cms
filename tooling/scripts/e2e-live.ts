import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Actor, ActorId, ContentDocument } from "../../packages/core/src/index.js";
import { RotatingCookieSessionService } from "../../packages/sessions/src/index.js";

const registryDigest = "sha256:2dd2966dab6a531fd1e3079105da7dc00c4d9f2ad6c4fb5f03dd29436c3f00a3";
const releasesOrigin =
  process.env.CMS_PUBLIC_RELEASES_URL ?? "https://pub-028a1270268a4ecf8bdcad27a5b62ef9.r2.dev";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

const origin = (option("--origin") ?? "https://git-native-cms-next.vercel.app").replace(/\/$/u, "");
const secretPath = required(option("--session-secret-file"), "--session-secret-file");
const sessionSecret = required((await readFile(secretPath, "utf8")).trim(), "session secret");
const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;

const editor: Actor = {
  id: "act_live_editor" as ActorId,
  githubId: 10_001,
  login: "live-editor",
  displayName: "Live Editor",
  roles: ["administrator"],
  source: "ui",
};
const reviewer: Actor = {
  id: "act_live_reviewer" as ActorId,
  githubId: 10_002,
  login: "live-reviewer",
  displayName: "Live Reviewer",
  roles: ["administrator"],
  source: "ui",
};

const sessions = new RotatingCookieSessionService(sessionSecret);
const editorSession = await sessions.issue(editor);
const reviewerSession = await sessions.issue(reviewer);

class LiveApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "LiveApiError";
  }
}

async function api<TValue>(
  session: typeof editorSession,
  method: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
  idempotencyKey?: string,
): Promise<TValue> {
  const response = await fetch(`${origin}/api/cms/${path.replace(/^\//u, "")}`, {
    method,
    headers: {
      cookie: `cms_session=${session.token}`,
      origin,
      "x-csrf-token": session.csrfToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as {
    readonly payload?: TValue & {
      readonly error?: {
        readonly code?: string;
        readonly message?: string;
        readonly context?: Readonly<Record<string, unknown>>;
      };
    };
    readonly error?: {
      readonly code?: string;
      readonly message?: string;
      readonly context?: Readonly<Record<string, unknown>>;
    };
  };
  if (!response.ok) {
    const error = result.error ?? result.payload?.error;
    throw new LiveApiError(
      response.status,
      error?.code ?? "CMS_UNKNOWN",
      `${method} ${path} failed (${response.status}) ${error?.code ?? "CMS_UNKNOWN"}: ${
        error?.message ?? "Unknown CMS error."
      }`,
      error?.context,
    );
  }
  return (result.payload ?? result) as TValue;
}

async function releasePointer(): Promise<{
  readonly environment: string;
  readonly releaseId: string;
  readonly revision: string;
}> {
  const response = await fetch(`${releasesOrigin}/environments/production/current.json`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Production pointer returned ${response.status}.`);
  return response.json() as Promise<{
    readonly environment: string;
    readonly releaseId: string;
    readonly revision: string;
  }>;
}

const baseline = await releasePointer();
const createKey = `live:${runId}:change`;
const created = await api<{
  readonly change: {
    readonly id: string;
    readonly baseCommit: string;
  };
}>(editorSession, "POST", "changes", {
  name: `Live acceptance ${runId}`,
  description: "Automated end-to-end proof across GitHub, Vercel and R2.",
  idempotencyKey: createKey,
});
const change = created.change;
const initialHome = await api<{ readonly document: ContentDocument }>(
  editorSession,
  "GET",
  `changes/${change.id}/documents/doc_home`,
);

const assetBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const assetChecksum = createHash("sha256").update(assetBytes).digest("hex");
const uploadKey = `live:${runId}:asset-upload`;
const upload = await api<{
  readonly uploadId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}>(
  editorSession,
  "POST",
  "assets/uploads",
  {
    fileName: `live-acceptance-${runId}.png`,
    mimeType: "image/png",
    size: assetBytes.byteLength,
    checksum: assetChecksum,
    idempotencyKey: uploadKey,
  },
  uploadKey,
);
const requestedUploadHeaders = Object.keys(upload.headers)
  .map((header) => header.toLowerCase())
  .sort()
  .join(",");
const preflight = await fetch(upload.url, {
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": "PUT",
    "access-control-request-headers": requestedUploadHeaders,
  },
  signal: AbortSignal.timeout(15_000),
});
const allowedOrigin = preflight.headers.get("access-control-allow-origin");
const allowedMethods =
  preflight.headers
    .get("access-control-allow-methods")
    ?.split(",")
    .map((method) => method.trim().toUpperCase()) ?? [];
const allowedHeaders =
  preflight.headers
    .get("access-control-allow-headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase()) ?? [];
const missingAllowedHeaders = requestedUploadHeaders
  .split(",")
  .filter((header) => !allowedHeaders.includes(header) && !allowedHeaders.includes("*"));
if (
  !preflight.ok ||
  (allowedOrigin !== origin && allowedOrigin !== "*") ||
  !allowedMethods.includes("PUT") ||
  missingAllowedHeaders.length > 0
) {
  throw new Error(
    `R2 browser upload preflight failed (${preflight.status}): origin=${allowedOrigin ?? "missing"}, methods=${allowedMethods.join("|") || "missing"}, missingHeaders=${missingAllowedHeaders.join("|") || "none"}.`,
  );
}
const uploaded = await fetch(upload.url, {
  method: "PUT",
  headers: upload.headers,
  body: Buffer.from(assetBytes),
  signal: AbortSignal.timeout(30_000),
});
if (!uploaded.ok) throw new Error(`Direct R2 asset upload returned ${uploaded.status}.`);

const finalizeKey = `live:${runId}:asset-finalize`;
const finalized = await api<{
  readonly asset: {
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
    readonly fileName: string;
    readonly altText?: string;
  };
  readonly revision: string;
}>(
  editorSession,
  "POST",
  `assets/uploads/${encodeURIComponent(upload.uploadId)}/finalize`,
  {
    changeId: change.id,
    checksum: assetChecksum,
    expectedRevision: initialHome.document.revision,
    idempotencyKey: finalizeKey,
  },
  finalizeKey,
);
const assetMetadataKey = `live:${runId}:asset-metadata`;
const storedAsset = await api<{
  readonly asset: {
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
    readonly fileName: string;
    readonly altText?: string;
  };
  readonly revision: string;
}>(
  editorSession,
  "PATCH",
  `assets/${encodeURIComponent(finalized.asset.id)}`,
  {
    changeId: change.id,
    altText: "A live R2 asset selected through the CMS media field",
    focalPoint: { x: 0.5, y: 0.5 },
    expectedRevision: finalized.revision,
    idempotencyKey: assetMetadataKey,
  },
  assetMetadataKey,
);

async function createDocument(
  type: string,
  data: Readonly<Record<string, unknown>>,
  expectedRevision: string,
  suffix: string,
): Promise<ContentDocument> {
  const key = `live:${runId}:document:${suffix}`;
  const result = await api<{ readonly document: ContentDocument }>(
    editorSession,
    "POST",
    `changes/${change.id}/documents`,
    {
      type,
      schemaVersion: 1,
      data,
      expectedRevision,
      idempotencyKey: key,
    },
    key,
  );
  return result.document;
}

const page = await createDocument(
  "pages",
  {
    title: `Acceptance page ${runId}`,
    route: { path: `/acceptance-${runId}` },
    sections: [
      {
        id: `hero-${runId}`,
        type: "hero",
        heading: "Git-native content, proven live",
        description: "Created through the same application command used by the editor.",
        media: storedAsset.asset,
      },
    ],
    locales: {
      "pl-PL": {
        title: `Strona akceptacyjna ${runId}`,
        route: { path: `/pl-PL/akceptacja-${runId}` },
      },
    },
  },
  storedAsset.revision,
  "page",
);
const pricing = await createDocument(
  "globals",
  {
    title: `Pricing ${runId}`,
    key: "pricing",
    plans: [{ name: "Editorial", price: 49, currency: "EUR" }],
  },
  page.revision,
  "pricing",
);
const navigation = await createDocument(
  "globals",
  {
    title: `Navigation ${runId}`,
    key: "navigation",
    items: [{ label: "Acceptance", href: `/acceptance-${runId}` }],
  },
  pricing.revision,
  "navigation",
);

const home = initialHome;
const updateKey = `live:${runId}:home`;
const updated = await api<{ readonly document: ContentDocument }>(
  editorSession,
  "PATCH",
  `changes/${change.id}/documents/doc_home`,
  {
    expectedRevision: navigation.revision,
    patches: [
      {
        op: "set",
        path: "/title",
        value: `Live acceptance ${runId}`,
        metadata: {
          id: `patch-${runId}`,
          actorId: editor.id,
          createdAt: new Date().toISOString(),
          source: "editor",
        },
      },
      {
        op: "set",
        path: "/sections/0/media",
        value: storedAsset.asset,
        metadata: {
          id: `patch-media-${runId}`,
          actorId: editor.id,
          createdAt: new Date().toISOString(),
          source: "editor",
        },
      },
    ],
    idempotencyKey: updateKey,
  },
  updateKey,
);
if (home.document.id !== updated.document.id) throw new Error("The home preview document changed.");

const preview = await fetch(`${origin}/cms/changes/${encodeURIComponent(change.id)}`, {
  headers: { cookie: `cms_session=${editorSession.token}` },
  signal: AbortSignal.timeout(30_000),
});
const previewSource = await preview.text();
if (
  !preview.ok ||
  !previewSource.includes(`Live acceptance ${runId}`) ||
  !previewSource.includes("A live R2 asset selected through the CMS media field")
) {
  throw new Error(
    "The server-rendered Change preview did not contain the edited title and selected R2 asset.",
  );
}

const submitKey = `live:${runId}:submit`;
const submitted = await api<{
  readonly revision: string;
  readonly pullRequest: { readonly number: number; readonly url: string };
}>(
  editorSession,
  "POST",
  `changes/${change.id}/submit`,
  { expectedRevision: updated.document.revision, idempotencyKey: submitKey },
  submitKey,
);
await api(
  reviewerSession,
  "POST",
  `changes/${change.id}/comments`,
  {
    pullRequestNumber: submitted.pullRequest.number,
    body: "Live acceptance review: semantic and visual preview verified.",
  },
  `live:${runId}:comment`,
);
const approvalKey = `live:${runId}:approve`;
const approved = await api<{ readonly revision: string }>(
  reviewerSession,
  "POST",
  `changes/${change.id}/approve`,
  {
    pullRequestNumber: submitted.pullRequest.number,
    expectedRevision: submitted.revision,
    body: "Approved by an actor other than the Change owner.",
    idempotencyKey: approvalKey,
  },
  approvalKey,
);
const inspectedConflicts = await api<{
  readonly conflicts: readonly {
    readonly documentId: string;
    readonly path: string;
  }[];
}>(editorSession, "GET", `changes/${change.id}/conflicts`);
const stagingRevision =
  inspectedConflicts.conflicts.length === 0
    ? approved.revision
    : await (async () => {
        try {
          return (
            await api<{ readonly revision: string }>(
              editorSession,
              "POST",
              `changes/${change.id}/conflicts/resolve`,
              {
                expectedRevision: approved.revision,
                resolutions: inspectedConflicts.conflicts.map((conflict) => ({
                  documentId: conflict.documentId,
                  path: conflict.path,
                  choice: "change",
                })),
                idempotencyKey: `live:${runId}:resolve-conflicts`,
              },
              `live:${runId}:resolve-conflicts`,
            )
          ).revision;
        } catch (error) {
          if (error instanceof LiveApiError && error.code === "CMS_CHANGE_017") {
            return approved.revision;
          }
          throw error;
        }
      })();
const stagingApproval =
  stagingRevision === approved.revision
    ? approved
    : await api<{ readonly revision: string }>(
        reviewerSession,
        "POST",
        `changes/${change.id}/approve`,
        {
          pullRequestNumber: submitted.pullRequest.number,
          expectedRevision: stagingRevision,
          body: "Re-approved after resolving semantic conflicts against current Staging.",
          idempotencyKey: `live:${runId}:reapprove`,
        },
        `live:${runId}:reapprove`,
      );
const stagingKey = `live:${runId}:staging`;
const staged = await api<{ readonly revision: string }>(
  reviewerSession,
  "POST",
  `changes/${change.id}/staging`,
  {
    pullRequestNumber: submitted.pullRequest.number,
    expectedRevision: stagingApproval.revision,
    idempotencyKey: stagingKey,
  },
  stagingKey,
);

const publishConfirmation = await api<{ readonly token: string }>(
  reviewerSession,
  "POST",
  "confirmations",
  { action: "publish" },
);
const publishKey = `live:${runId}:publish`;
const published = await api<{
  readonly releaseId: string;
  readonly mainRevision: string;
  readonly stagingRevision: string;
}>(
  reviewerSession,
  "POST",
  "staging/publish",
  {
    expectedStagingRevision: staged.revision,
    expectedPointerRevision: baseline.revision,
    title: `Live acceptance ${runId}`,
    configVersion: 1,
    registryDigest,
    schemaVersion: 1,
    confirmationToken: publishConfirmation.token,
    idempotencyKey: publishKey,
  },
  publishKey,
);

const livePointer = await releasePointer();
if (livePointer.releaseId !== published.releaseId) {
  throw new Error("Production did not atomically point to the published release.");
}
const manifestResponse = await fetch(
  `${releasesOrigin}/releases/${published.releaseId}/manifest.json`,
  { signal: AbortSignal.timeout(15_000) },
);
const manifest = (await manifestResponse.json()) as {
  readonly releaseId?: string;
  readonly registryDigest?: string;
};
if (
  !manifestResponse.ok ||
  manifest.releaseId !== published.releaseId ||
  manifest.registryDigest !== registryDigest
) {
  throw new Error("The immutable CDN manifest does not match the published release.");
}
const indexResponse = await fetch(
  `${releasesOrigin}/releases/${published.releaseId}/content-index.json`,
  { signal: AbortSignal.timeout(15_000) },
);
const contentIndex = (await indexResponse.json()) as readonly {
  readonly title?: string;
  readonly path?: string;
}[];
const releasedPage = contentIndex.find((entry) => entry.title === `Acceptance page ${runId}`);
if (!indexResponse.ok || releasedPage?.path === undefined) {
  throw new Error("The immutable CDN index does not contain the live acceptance page.");
}
const releasedPageResponse = await fetch(
  `${releasesOrigin}/releases/${published.releaseId}/${releasedPage.path}`,
  { signal: AbortSignal.timeout(15_000) },
);
const releasedPageSource = await releasedPageResponse.text();
if (!releasedPageResponse.ok || !releasedPageSource.includes(storedAsset.asset.id)) {
  throw new Error("The immutable CDN page does not contain the stable R2 asset reference.");
}

async function confirmation(action: "rollback"): Promise<string> {
  return (
    await api<{ readonly token: string }>(reviewerSession, "POST", "confirmations", { action })
  ).token;
}

const rollbackKey = `live:${runId}:rollback`;
await api(
  reviewerSession,
  "POST",
  `releases/${baseline.releaseId}/rollback`,
  {
    expectedPointerRevision: livePointer.revision,
    confirmationToken: await confirmation("rollback"),
    idempotencyKey: rollbackKey,
  },
  rollbackKey,
);
const rolledBack = await releasePointer();
if (rolledBack.releaseId !== baseline.releaseId) {
  throw new Error("Atomic rollback did not restore the baseline release.");
}

const restoreKey = `live:${runId}:restore`;
await api(
  reviewerSession,
  "POST",
  `releases/${published.releaseId}/rollback`,
  {
    expectedPointerRevision: rolledBack.revision,
    confirmationToken: await confirmation("rollback"),
    idempotencyKey: restoreKey,
  },
  restoreKey,
);
const restored = await releasePointer();
if (restored.releaseId !== published.releaseId) {
  throw new Error("The final production pointer was not restored to the verified release.");
}

process.stdout.write(
  [
    `READY Change ${change.id}`,
    `READY review PR ${submitted.pullRequest.url}`,
    `READY asset ${storedAsset.asset.id}`,
    `READY release ${published.releaseId}`,
    `READY rollback ${baseline.releaseId} and restore ${restored.releaseId}`,
  ].join("\n") + "\n",
);
