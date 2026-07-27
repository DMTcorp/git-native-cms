import type { ChangeStatus, Revision } from "@git-native-cms/core";

export interface HostedWorkflowActionInput {
  readonly action: "submit" | "approve" | "stage" | "publish";
  readonly changeId: string;
  readonly changeName: string;
  readonly csrfToken: string;
  readonly expectedRevision: Revision;
  readonly pullRequestNumber?: number;
  readonly apiBaseUrl?: string;
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
}): Promise<TPayload> {
  const idempotencyKey = globalThis.crypto.randomUUID();
  const response = await fetch(input.path, {
    method: "POST",
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

export async function advanceHostedWorkflow(
  input: HostedWorkflowActionInput,
): Promise<HostedWorkflowActionResult> {
  const baseUrl = (input.apiBaseUrl ?? "/api/cms").replace(/\/$/u, "");
  const changePath = `${baseUrl}/changes/${encodeURIComponent(input.changeId)}`;

  if (input.action === "publish") {
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
        registryDigest: "sha256:sandbox-registry-v1",
        schemaVersion: 1,
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
