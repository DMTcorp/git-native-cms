import type { ChangeStatus, Revision } from "@git-native-cms/core";
import type { Asset } from "@git-native-cms/application";
import type { AssetId, Change, ContentDocument } from "@git-native-cms/core";

export interface HostedWorkflowActionInput {
  readonly action: "submit" | "approve" | "stage" | "publish";
  readonly changeId: string;
  readonly changeName: string;
  readonly csrfToken: string;
  readonly expectedRevision: Revision;
  readonly pullRequestNumber?: number;
  readonly apiBaseUrl?: string;
  readonly registryDigest: string;
}

export interface HostedWorkflowActionResult {
  readonly status: ChangeStatus;
  readonly revision: Revision;
  readonly pullRequestNumber?: number;
  readonly releaseId?: string;
}

interface ErrorEnvelope {
  readonly payload?: {
    readonly error?: {
      readonly message?: string;
    };
  };
}

async function requestPayload<TPayload>(input: {
  readonly path: string;
  readonly csrfToken: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly method?: "POST" | "PATCH" | "DELETE";
}): Promise<TPayload> {
  const idempotencyKey = globalThis.crypto.randomUUID();
  const response = await fetch(input.path, {
    method: input.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-csrf-token": input.csrfToken,
    },
    body: JSON.stringify({ ...input.body, idempotencyKey }),
  });
  const envelope = (await response.json().catch(() => undefined)) as
    ({ readonly payload?: TPayload } & ErrorEnvelope) | undefined;
  if (!response.ok || envelope?.payload === undefined) {
    throw new Error(
      envelope?.payload?.error?.message ??
        `The CMS workflow request failed with status ${response.status}.`,
    );
  }
  return envelope.payload;
}

async function confirmationToken(
  csrfToken: string,
  action: "publish" | "rollback",
  apiBaseUrl = "/api/cms",
): Promise<string> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/u, "")}/confirmations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ action }),
  });
  const result = (await response.json()) as { readonly token?: string };
  if (!response.ok || result.token === undefined) {
    throw new Error(`Could not confirm ${action}.`);
  }
  return result.token;
}

export async function createHostedChange(input: {
  readonly name: string;
  readonly description?: string;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<Change> {
  const payload = await requestPayload<{ readonly change: Change }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes`,
    csrfToken: input.csrfToken,
    body: {
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
  });
  return payload.change;
}

export async function createHostedDocument(input: {
  readonly changeId: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<ContentDocument> {
  const payload = await requestPayload<{ readonly document: ContentDocument }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/documents`,
    csrfToken: input.csrfToken,
    body: {
      type: input.type,
      schemaVersion: 1,
      data: input.data,
      expectedRevision: input.expectedRevision,
    },
  });
  return payload.document;
}

export async function deleteHostedDocument(input: {
  readonly changeId: string;
  readonly documentId: string;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<Revision> {
  const payload = await requestPayload<{ readonly revision: Revision }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/documents/${encodeURIComponent(input.documentId)}`,
    method: "DELETE",
    csrfToken: input.csrfToken,
    body: { expectedRevision: input.expectedRevision },
  });
  return payload.revision;
}

export async function addHostedReviewComment(input: {
  readonly changeId: string;
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly csrfToken: string;
  readonly path?: string;
  readonly apiBaseUrl?: string;
}): Promise<void> {
  await requestPayload({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/comments`,
    csrfToken: input.csrfToken,
    body: {
      pullRequestNumber: input.pullRequestNumber,
      body: input.body,
      ...(input.path === undefined ? {} : { path: input.path }),
    },
  });
}

export async function requestHostedChanges(input: {
  readonly changeId: string;
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<HostedWorkflowActionResult> {
  const payload = await requestPayload<{
    readonly change: { readonly status: ChangeStatus };
    readonly revision: Revision;
  }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/request-changes`,
    csrfToken: input.csrfToken,
    body: {
      pullRequestNumber: input.pullRequestNumber,
      expectedRevision: input.expectedRevision,
      body: input.body,
    },
  });
  return {
    status: payload.change.status,
    revision: payload.revision,
    pullRequestNumber: input.pullRequestNumber,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadHostedAsset(input: {
  readonly changeId: string;
  readonly file: File;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<{ readonly asset: Asset; readonly revision: Revision }> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await input.file.arrayBuffer());
  const checksum = bytesToHex(new Uint8Array(digest));
  const upload = await requestPayload<{
    readonly uploadId: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }>({
    path: `${baseUrl}/assets/uploads`,
    csrfToken: input.csrfToken,
    body: {
      fileName: input.file.name,
      mimeType: input.file.type,
      size: input.file.size,
      checksum,
    },
  });
  const putResponse = await fetch(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: input.file,
  });
  if (!putResponse.ok) {
    throw new Error(`Asset upload failed with status ${putResponse.status}.`);
  }
  return requestPayload({
    path: `${baseUrl}/assets/uploads/${encodeURIComponent(upload.uploadId)}/finalize`,
    csrfToken: input.csrfToken,
    body: {
      changeId: input.changeId,
      expectedRevision: input.expectedRevision,
      checksum,
    },
  });
}

export async function deleteHostedAsset(input: {
  readonly changeId: string;
  readonly assetId: AssetId;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<Revision> {
  const payload = await requestPayload<{ readonly revision: Revision }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/assets/${encodeURIComponent(input.assetId)}`,
    method: "DELETE",
    csrfToken: input.csrfToken,
    body: {
      changeId: input.changeId,
      expectedRevision: input.expectedRevision,
    },
  });
  return payload.revision;
}

export async function importHostedTranslation(input: {
  readonly changeId: string;
  readonly documentId: string;
  readonly targetLocale: string;
  readonly xliff: string;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<Revision> {
  const payload = await requestPayload<{
    readonly document: { readonly revision: Revision };
  }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/documents/${encodeURIComponent(input.documentId)}/locales/${encodeURIComponent(input.targetLocale)}/xliff`,
    csrfToken: input.csrfToken,
    body: {
      xliff: input.xliff,
      expectedRevision: input.expectedRevision,
    },
  });
  return payload.document.revision;
}

export type HostedTranslationJob =
  | { readonly status: "queued" | "working" }
  | { readonly status: "complete"; readonly xliff: string }
  | { readonly status: "failed"; readonly message: string };

export async function createHostedTranslationJob(input: {
  readonly changeId: string;
  readonly documentId: string;
  readonly targetLocale: string;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<{ readonly jobId: string }> {
  return requestPayload({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/changes/${encodeURIComponent(input.changeId)}/documents/${encodeURIComponent(input.documentId)}/locales/${encodeURIComponent(input.targetLocale)}/translation-jobs`,
    csrfToken: input.csrfToken,
    body: {
      sourceLocale: "en-US",
      expectedRevision: input.expectedRevision,
    },
  });
}

export async function readHostedTranslationJob(input: {
  readonly changeId: string;
  readonly documentId: string;
  readonly targetLocale: string;
  readonly jobId: string;
  readonly apiBaseUrl?: string;
}): Promise<HostedTranslationJob> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const response = await fetch(
    `${baseUrl}/changes/${encodeURIComponent(input.changeId)}/documents/${encodeURIComponent(input.documentId)}/locales/${encodeURIComponent(input.targetLocale)}/translation-jobs/${encodeURIComponent(input.jobId)}`,
    { headers: { accept: "application/json" } },
  );
  const envelope = (await response.json().catch(() => undefined)) as
    { readonly payload?: { readonly job?: HostedTranslationJob } } | undefined;
  if (!response.ok || envelope?.payload?.job === undefined) {
    throw new Error(`Translation status request failed with status ${response.status}.`);
  }
  return envelope.payload.job;
}

export async function scheduleHostedContent(input: {
  readonly changeId: string;
  readonly documentIds: readonly string[];
  readonly action: "publish" | "unpublish";
  readonly executeAt: string;
  readonly expectedRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<{ readonly scheduleId: string; readonly revision: Revision }> {
  const payload = await requestPayload<{
    readonly schedule: { readonly id: string };
    readonly revision: Revision;
  }>({
    path: `${(input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "")}/schedules`,
    csrfToken: input.csrfToken,
    body: {
      changeId: input.changeId,
      documentIds: input.documentIds,
      action: input.action,
      executeAt: input.executeAt,
      expectedRevision: input.expectedRevision,
    },
  });
  return { scheduleId: payload.schedule.id, revision: payload.revision };
}

export async function findHostedUsages(input: {
  readonly changeId: string;
  readonly referenceId: string;
  readonly apiBaseUrl?: string;
}): Promise<
  readonly {
    readonly sourceId: string;
    readonly sourcePath: string;
  }[]
> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const query = new URLSearchParams({
    changeId: input.changeId,
    referenceId: input.referenceId,
  });
  const response = await fetch(`${baseUrl}/search/usages?${query.toString()}`, {
    headers: { accept: "application/json" },
  });
  const envelope = (await response.json().catch(() => undefined)) as
    | {
        readonly payload?: {
          readonly items?: readonly {
            readonly sourceId: string;
            readonly sourcePath: string;
          }[];
        };
      }
    | undefined;
  if (!response.ok) throw new Error(`Usage lookup failed with status ${response.status}.`);
  return envelope?.payload?.items ?? [];
}

export async function publishHostedStaging(input: {
  readonly expectedStagingRevision: Revision;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
  readonly registryDigest: string;
}): Promise<void> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const confirmation = await confirmationToken(input.csrfToken, "publish", baseUrl);
  await requestPayload({
    path: `${baseUrl}/staging/publish`,
    csrfToken: input.csrfToken,
    body: {
      expectedStagingRevision: input.expectedStagingRevision,
      title: "Publish staged Changes",
      configVersion: 1,
      registryDigest: input.registryDigest,
      schemaVersion: 1,
      confirmationToken: confirmation,
    },
  });
}

export async function advanceHostedWorkflow(
  input: HostedWorkflowActionInput,
): Promise<HostedWorkflowActionResult> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const changePath = `${baseUrl}/changes/${encodeURIComponent(input.changeId)}`;

  if (input.action === "publish") {
    const confirmation = await confirmationToken(input.csrfToken, "publish", baseUrl);
    const payload = await requestPayload<{
      readonly mainRevision: Revision;
      readonly releaseId: string;
    }>({
      path: `${baseUrl}/staging/publish`,
      csrfToken: input.csrfToken,
      body: {
        expectedStagingRevision: input.expectedRevision,
        title: `Release ${input.changeName}`,
        configVersion: 1,
        registryDigest: input.registryDigest,
        schemaVersion: 1,
        confirmationToken: confirmation,
      },
    });
    return {
      status: "published",
      revision: payload.mainRevision,
      releaseId: payload.releaseId,
    };
  }

  if (input.action !== "submit" && input.pullRequestNumber === undefined) {
    throw new Error("This Change has no pull request. Refresh the editor and try again.");
  }

  const payload = await requestPayload<{
    readonly change: {
      readonly status: ChangeStatus;
      readonly pullRequestNumber?: number;
    };
    readonly revision: Revision;
    readonly pullRequest?: { readonly number: number };
  }>({
    path: `${changePath}/${input.action === "stage" ? "staging" : input.action}`,
    csrfToken: input.csrfToken,
    body: {
      expectedRevision: input.expectedRevision,
      ...(input.pullRequestNumber === undefined
        ? {}
        : { pullRequestNumber: input.pullRequestNumber }),
    },
  });
  const pullRequestNumber =
    payload.pullRequest?.number ?? payload.change.pullRequestNumber ?? input.pullRequestNumber;
  return {
    status: payload.change.status,
    revision: payload.revision,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
  };
}

export async function rollbackHostedRelease(input: {
  readonly releaseId: string;
  readonly expectedPointerRevision: string;
  readonly csrfToken: string;
  readonly apiBaseUrl?: string;
}): Promise<void> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const confirmation = await confirmationToken(input.csrfToken, "rollback", baseUrl);
  await requestPayload({
    path: `${baseUrl}/releases/${encodeURIComponent(input.releaseId)}/rollback`,
    csrfToken: input.csrfToken,
    body: {
      expectedPointerRevision: input.expectedPointerRevision,
      confirmationToken: confirmation,
    },
  });
}
