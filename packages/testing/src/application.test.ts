import { yamlCodec } from "@git-native-cms/content-codecs";
import type { DocumentId, ReleaseId, Revision } from "@git-native-cms/core";
import { contentPath } from "@git-native-cms/document-model";
import {
  createCmsApplication,
  type EnvironmentPointer,
  type ReleaseBuilderPort,
  type ReleaseStore,
  type StoredRelease,
} from "@git-native-cms/application";
import { AuthorizationService } from "@git-native-cms/permissions";
import { describe, expect, it } from "vitest";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryGitProvider,
  MemoryIdempotencyStore,
  testActor,
} from "./index.js";

function fixture() {
  const git = new MemoryGitProvider();
  const content = new MemoryContentRepository();
  const audit = new MemoryAuditSink();
  const dependencies = {
    git,
    content,
    authorization: new AuthorizationService(),
    clock: new FixedClock(),
    ids: new DeterministicIds(),
    idempotency: new MemoryIdempotencyStore(),
    audit,
  };
  return { application: createCmsApplication(dependencies), git, content, audit };
}

class TestReleaseStore implements ReleaseStore {
  readonly releases = new Map<ReleaseId, StoredRelease>();
  readonly pointers = new Map<EnvironmentPointer["environment"], EnvironmentPointer>();

  async writeRelease(release: StoredRelease): Promise<void> {
    this.releases.set(release.id, structuredClone(release));
  }

  async readRelease(id: ReleaseId): Promise<StoredRelease | undefined> {
    const release = this.releases.get(id);
    return release === undefined ? undefined : structuredClone(release);
  }

  async readPointer(
    environment: EnvironmentPointer["environment"],
  ): Promise<EnvironmentPointer | undefined> {
    const pointer = this.pointers.get(environment);
    return pointer === undefined ? undefined : structuredClone(pointer);
  }

  async compareAndSwapPointer(input: {
    readonly next: EnvironmentPointer;
    readonly expectedRevision?: string;
  }): Promise<EnvironmentPointer> {
    const current = this.pointers.get(input.next.environment);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new Error("Pointer changed.");
    }
    this.pointers.set(input.next.environment, structuredClone(input.next));
    return input.next;
  }
}

const testReleaseBuilder: ReleaseBuilderPort = {
  async build(input): Promise<StoredRelease> {
    const id = "rel_test_workflow" as ReleaseId;
    const files = Object.fromEntries(
      input.documents.map((document) => [document.path, JSON.stringify(document.value)]),
    );
    const manifest = { releaseId: id, gitCommit: input.gitCommit };
    return {
      id,
      manifest,
      files: { ...files, "manifest.json": JSON.stringify(manifest) },
    };
  },
};

describe("application commands", () => {
  it("creates an idempotent Change branch with canonical metadata", async () => {
    const { application, git, audit } = fixture();
    const context = { actor: testActor, requestId: "req_1" };
    const command = { name: "Pricing refresh", idempotencyKey: "create-pricing" };
    const first = await application.createChange.execute(command, context);
    const second = await application.createChange.execute(command, context);
    expect(second).toEqual(first);
    expect(
      yamlCodec.parse(
        (
          await git.readFile({
            ref: first.branchName,
            path: ".cms/change.yaml",
          })
        )?.content ?? "",
      ),
    ).toMatchObject({ id: first.id, status: "draft" });
    expect(audit.events.map((event) => event.type)).toEqual(["change.created"]);
  });

  it("updates content through patches and optimistic concurrency", async () => {
    const { application, content } = fixture();
    const context = { actor: testActor, requestId: "req_1" };
    const change = await application.createChange.execute(
      { name: "Homepage", idempotencyKey: "create-homepage" },
      context,
    );
    const revision = "sha_content_1" as Revision;
    const documentId = "doc_home" as DocumentId;
    content.seed(change.branchName, {
      id: documentId,
      type: "pages",
      schemaVersion: 1,
      revision,
      data: { title: "Home" },
    });
    const result = await application.updateDocument.execute(
      {
        change,
        documentId,
        expectedRevision: revision,
        patches: [
          {
            op: "set",
            path: contentPath("/title"),
            value: "Welcome",
            metadata: {
              id: "patch_1",
              actorId: testActor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
        idempotencyKey: "update-home",
      },
      context,
    );
    expect(result.data).toEqual({ title: "Welcome" });
  });

  it("moves a Change through review and staging into an immutable production release", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    const audit = new MemoryAuditSink();
    const releaseStore = new TestReleaseStore();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      releaseStore,
      releaseBuilder: testReleaseBuilder,
    });
    const context = { actor: testActor, requestId: "req_workflow" };
    const change = await application.createChange.execute(
      { name: "Release homepage", idempotencyKey: "workflow:create" },
      context,
    );
    const draft = await git.resolveRef(change.branchName);
    const submitted = await application.submitChange.execute(
      {
        change,
        expectedRevision: draft.sha,
        idempotencyKey: "workflow:submit",
      },
      context,
    );
    expect(submitted.change).toMatchObject({
      status: "in_review",
      pullRequestNumber: 1,
    });
    const approved = await application.approveChange.execute(
      {
        change: submitted.change,
        pullRequestNumber: submitted.pullRequest?.number ?? 0,
        expectedRevision: submitted.revision,
        idempotencyKey: "workflow:approve",
      },
      context,
    );
    expect(approved.change.status).toBe("approved");
    const staged = await application.addChangeToStaging.execute(
      {
        change: approved.change,
        pullRequestNumber: approved.change.pullRequestNumber ?? 0,
        expectedRevision: approved.revision,
        idempotencyKey: "workflow:stage",
      },
      context,
    );
    expect(staged.change.status).toBe("staging");

    content.seed("main", {
      id: "doc_home" as DocumentId,
      type: "pages",
      schemaVersion: 1,
      revision: "sha_main_content" as Revision,
      data: {
        title: "Published homepage",
        sections: [{ id: "sec_hero", type: "hero", version: 1, heading: "Live" }],
      },
    });
    const published = await application.publishStaging.execute(
      {
        expectedStagingRevision: staged.revision,
        title: "Release homepage",
        configVersion: 1,
        registryDigest: "sha256:test",
        schemaVersion: 1,
        idempotencyKey: "workflow:publish",
      },
      context,
    );
    expect(published.release.id).toBe("rel_test_workflow");
    expect(await releaseStore.readPointer("production")).toMatchObject({
      releaseId: "rel_test_workflow",
      revision: "rel_test_workflow",
    });
    expect(published.release.files["content/pages/doc_home/index.json"]).toContain(
      "Published homepage",
    );
    expect(
      yamlCodec.parse(
        (
          await git.readFile({
            ref: "main",
            path: `.cms/changes/${change.id}.yaml`,
          })
        )?.content ?? "",
      ),
    ).toMatchObject({ status: "published" });
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "change.submitted",
      "change.approved",
      "change.added-to-staging",
      "staging.promoted",
      "release.built-and-published",
    ]);
  });
});
