import { yamlCodec } from "@git-native-cms/content-codecs";
import { GitContentRepository } from "@git-native-cms/content-repository";
import type { AssetId, DocumentId, ReleaseId, Revision } from "@git-native-cms/core";
import { contentPath } from "@git-native-cms/document-model";
import {
  createCmsApplication,
  type Asset,
  type AssetStore,
  type EnvironmentPointer,
  type GitProvider,
  type PreviewSessionPort,
  type ReleaseBuilderPort,
  type ReleaseStore,
  type ReviewComment,
  type ReviewPort,
  type StoredRelease,
  type TeamProvisioningPort,
  type TranslationProvider,
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

const reviewer = {
  ...testActor,
  id: "actor_reviewer" as typeof testActor.id,
  login: "reviewer",
  displayName: "Review Editor",
};

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
    auditQuery: audit,
  };
  return { application: createCmsApplication(dependencies), git, content, audit };
}

class StrictDeleteMemoryGitProvider extends MemoryGitProvider {
  override async commitFiles(input: Parameters<GitProvider["commitFiles"]>[0]) {
    for (const file of input.files) {
      if (
        file.content === null &&
        (await this.readFile({ ref: input.branch, path: file.path })) === undefined
      ) {
        throw new Error(`Git Data API cannot delete missing path ${file.path}.`);
      }
    }
    return super.commitFiles(input);
  }
}

class EventuallyConsistentMemoryGitProvider extends MemoryGitProvider {
  private rejectNextRefRead = false;

  override async resolveRef(input: Parameters<MemoryGitProvider["resolveRef"]>[0]) {
    if (this.rejectNextRefRead) {
      this.rejectNextRefRead = false;
      throw new Error("A just-updated GitHub ref was read before it became consistent.");
    }
    return super.resolveRef(input);
  }

  override async commitFiles(input: Parameters<GitProvider["commitFiles"]>[0]) {
    if (input.message.includes("Resolve semantic conflicts with Staging")) {
      this.rejectNextRefRead = false;
    }
    const committed = await super.commitFiles(input);
    if (/^Resolve \d+ conflict\(s\) with Staging$/u.test(input.message)) {
      this.rejectNextRefRead = true;
    }
    return committed;
  }
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

  async listReleases(): Promise<{ readonly items: readonly StoredRelease[] }> {
    return { items: [...this.releases.values()].map((release) => structuredClone(release)) };
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
    const command = {
      name: "Pricing refresh",
      baseBranch: "staging",
      collaborators: ["octo-reviewer", "team:legal"],
      targetDate: "2026-08-15",
      idempotencyKey: "create-pricing",
    } as const;
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
    ).toMatchObject({
      id: first.id,
      status: "draft",
      baseBranch: "staging",
      collaborators: ["octo-reviewer", "team:legal"],
      targetDate: "2026-08-15",
    });
    expect(audit.events.map((event) => event.type)).toEqual(["change.created"]);
    await expect(
      application.readAuditTimeline.execute({ resourceId: first.id }, context),
    ).resolves.toMatchObject([
      {
        type: "change.created",
        resourceId: first.id,
        actorId: testActor.id,
        source: testActor.source,
      },
    ]);
  });

  it("rejects unsafe Change bases, collaborators and impossible target dates", async () => {
    const { application } = fixture();
    const context = { actor: testActor, requestId: "req_change_validation" };
    await expect(
      application.createChange.execute(
        {
          name: "Unsafe base",
          baseBranch: "refs/pull/1/head",
          idempotencyKey: "change:unsafe-base",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_CHANGE_014" });
    await expect(
      application.createChange.execute(
        {
          name: "Unsafe collaborator",
          collaborators: ["../../admin"],
          idempotencyKey: "change:unsafe-collaborator",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_CHANGE_012" });
    await expect(
      application.createChange.execute(
        {
          name: "Impossible target date",
          targetDate: "2026-02-31",
          idempotencyKey: "change:unsafe-date",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_CHANGE_013" });
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

  it("resolves every semantic conflict against Staging and resets approval", async () => {
    const documentId = "doc_conflicted_home" as DocumentId;
    const path = "content/pages/conflicted-home/index.yaml";
    const git = new EventuallyConsistentMemoryGitProvider({
      [path]: yamlCodec.serialize({
        id: documentId,
        type: "pages",
        schemaVersion: 1,
        title: "Original",
        subtitle: "Original subtitle",
        announcement: "Original announcement",
      }),
    });
    const content = new GitContentRepository(git);
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      auditQuery: audit,
    });
    const context = { actor: testActor, requestId: "req_conflict_resolution" };
    const change = await application.createChange.execute(
      { name: "Conflicted homepage", idempotencyKey: "conflict:create" },
      context,
    );
    const branchDocument = await content.readDocument({
      ref: change.branchName,
      documentId,
    });
    const edited = await application.updateDocument.execute(
      {
        change,
        documentId,
        expectedRevision: branchDocument.revision,
        patches: [
          {
            op: "set",
            path: contentPath("/title"),
            value: "Title from this Change",
            metadata: {
              id: "patch_conflict_title",
              actorId: testActor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
          {
            op: "set",
            path: contentPath("/subtitle"),
            value: "Subtitle from this Change",
            metadata: {
              id: "patch_conflict_subtitle",
              actorId: testActor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
        idempotencyKey: "conflict:edit-change",
      },
      context,
    );
    const stagingDocument = await content.readDocument({ ref: "staging", documentId });
    const stagingRevision = await content.writeDocuments({
      ref: "staging",
      documents: [
        {
          ...stagingDocument,
          data: {
            ...(stagingDocument.data as Readonly<Record<string, unknown>>),
            title: "Title from Staging",
            announcement: "Announcement from Staging",
          },
        },
      ],
      expectedRevision: stagingDocument.revision,
      message: "Concurrent Staging edit",
      actor: reviewer,
      idempotencyKey: "conflict:edit-staging",
    });
    const submitted = await application.submitChange.execute(
      {
        change,
        expectedRevision: edited.revision,
        idempotencyKey: "conflict:submit",
      },
      context,
    );
    const approved = await application.approveChange.execute(
      {
        change: submitted.change,
        pullRequestNumber: submitted.pullRequest?.number ?? 0,
        expectedRevision: submitted.revision,
        idempotencyKey: "conflict:approve-first",
      },
      { ...context, actor: reviewer },
    );
    await expect(
      application.addChangeToStaging.execute(
        {
          change: approved.change,
          pullRequestNumber: approved.change.pullRequestNumber ?? 0,
          expectedRevision: approved.revision,
          idempotencyKey: "conflict:stage-blocked",
        },
        { ...context, actor: reviewer },
      ),
    ).rejects.toMatchObject({ code: "CMS_CHANGE_009" });
    const conflictState = await application.readChangeConflicts.execute(
      { change: approved.change },
      context,
    );
    expect(conflictState).toMatchObject({
      stagingRevision,
      conflicts: [
        {
          documentId,
          path: "/title",
          change: "Title from this Change",
          staging: "Title from Staging",
        },
      ],
    });
    const resolved = await application.resolveChangeConflicts.execute(
      {
        change: approved.change,
        expectedRevision: approved.revision,
        resolutions: [
          {
            documentId,
            path: contentPath("/title"),
            choice: "change",
          },
        ],
        idempotencyKey: "conflict:resolve",
      },
      context,
    );
    expect(resolved.change).toMatchObject({
      status: "in_review",
      baseBranch: "staging",
      baseCommit: stagingRevision,
    });
    await expect(
      content.readDocument({ ref: change.branchName, documentId }),
    ).resolves.toMatchObject({
      data: {
        title: "Title from this Change",
        subtitle: "Subtitle from this Change",
        announcement: "Announcement from Staging",
      },
    });
    await expect(
      application.readChangeConflicts.execute({ change: resolved.change }, context),
    ).resolves.toMatchObject({ conflicts: [] });
    const reapproved = await application.approveChange.execute(
      {
        change: resolved.change,
        pullRequestNumber: resolved.change.pullRequestNumber ?? 0,
        expectedRevision: resolved.revision,
        idempotencyKey: "conflict:approve-second",
      },
      { ...context, actor: reviewer },
    );
    await expect(
      application.addChangeToStaging.execute(
        {
          change: reapproved.change,
          pullRequestNumber: reapproved.change.pullRequestNumber ?? 0,
          expectedRevision: reapproved.revision,
          idempotencyKey: "conflict:stage-resolved",
        },
        { ...context, actor: reviewer },
      ),
    ).resolves.toMatchObject({ change: { status: "staging" } });
    expect(audit.events.map((event) => event.type)).toContain("change.conflicts-resolved");
  });

  it("updates and deletes a draft Change with optimistic concurrency", async () => {
    const { application, git, audit } = fixture();
    const context = { actor: testActor, requestId: "req_change_details" };
    const change = await application.createChange.execute(
      { name: "Initial title", description: "Initial description", idempotencyKey: "change:new" },
      context,
    );
    const branch = await git.resolveRef(change.branchName);
    const updated = await application.updateChange.execute(
      {
        change,
        name: "Editorial campaign",
        description: null,
        expectedRevision: branch.sha,
        idempotencyKey: "change:update",
      },
      context,
    );
    expect(updated.change).toMatchObject({ name: "Editorial campaign" });
    expect(updated.change.description).toBeUndefined();
    await expect(
      application.deleteChange.execute(
        {
          change: updated.change,
          expectedRevision: updated.revision,
          idempotencyKey: "change:delete",
        },
        context,
      ),
    ).resolves.toEqual({ changeId: change.id });
    await expect(git.resolveRef(change.branchName)).rejects.toThrow("Unknown branch");
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "change.updated",
      "change.deleted",
    ]);
  });

  it("saves patches for multiple documents in one logical Git version", async () => {
    const git = new MemoryGitProvider({
      "content/pages/home/index.yaml": yamlCodec.serialize({
        id: "doc_home",
        type: "pages",
        schemaVersion: 1,
        title: "Home",
      }),
      "content/globals/pricing/index.yaml": yamlCodec.serialize({
        id: "doc_pricing",
        type: "globals",
        schemaVersion: 1,
        title: "Pricing",
      }),
    });
    const content = new GitContentRepository(git);
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
    });
    const context = { actor: testActor, requestId: "req_version" };
    const change = await application.createChange.execute(
      { name: "Coherent version", idempotencyKey: "version:change" },
      context,
    );
    const branch = await git.resolveRef(change.branchName);
    const result = await application.commitChange.execute(
      {
        change,
        expectedRevision: branch.sha,
        idempotencyKey: "version:save",
        message: "Update homepage and pricing together",
        documents: [
          {
            documentId: "doc_home" as DocumentId,
            patches: [
              {
                op: "set",
                path: contentPath("/title"),
                value: "Welcome",
                metadata: {
                  id: "patch-home",
                  actorId: testActor.id,
                  createdAt: "2026-07-27T12:00:00.000Z",
                  source: "editor",
                },
              },
            ],
          },
          {
            documentId: "doc_pricing" as DocumentId,
            patches: [
              {
                op: "set",
                path: contentPath("/title"),
                value: "Plans",
                metadata: {
                  id: "patch-pricing",
                  actorId: testActor.id,
                  createdAt: "2026-07-27T12:00:00.000Z",
                  source: "editor",
                },
              },
            ],
          },
        ],
      },
      context,
    );
    expect(result.documents).toHaveLength(2);
    await expect(
      content.readDocument({ ref: change.branchName, documentId: "doc_home" as DocumentId }),
    ).resolves.toMatchObject({ data: { title: "Welcome" }, revision: result.revision });
    await expect(
      content.readDocument({ ref: change.branchName, documentId: "doc_pricing" as DocumentId }),
    ).resolves.toMatchObject({ data: { title: "Plans" }, revision: result.revision });
    expect(audit.events.at(-1)).toMatchObject({
      type: "change.version-saved",
      details: { documents: ["doc_home", "doc_pricing"] },
    });
  });

  it("creates, translates, and safely deletes generic content through application commands", async () => {
    const { application, content } = fixture();
    const context = { actor: testActor, requestId: "req_documents" };
    const change = await application.createChange.execute(
      { name: "Localized collection", idempotencyKey: "documents:create-change" },
      context,
    );
    const revision = "sha_content_1" as Revision;
    const created = await application.createDocument.execute(
      {
        change,
        type: "posts",
        schemaVersion: 1,
        data: { title: "Release notes", slug: "release-notes", sections: [] },
        expectedRevision: revision,
        idempotencyKey: "documents:create",
      },
      context,
    );
    expect(created.id).toMatch(/^doc_/u);
    const translated = await application.importTranslation.execute(
      {
        change,
        documentId: created.id,
        targetLocale: "pl-PL",
        xliff:
          '<?xml version="1.0"?><xliff version="2.1" srcLang="en-US" trgLang="pl-PL"><file id="content"><unit id="/title"><segment><source>Release notes</source><target>Informacje o wydaniu</target></segment></unit></file></xliff>',
        expectedRevision: created.revision,
        idempotencyKey: "documents:translate",
      },
      context,
    );
    expect(translated.data).toMatchObject({
      locales: {
        "pl-PL": {
          status: "translated",
          fields: { "/title": "Informacje o wydaniu" },
        },
      },
    });
    const deleted = await application.deleteDocument.execute(
      {
        change,
        documentId: created.id,
        expectedRevision: translated.revision,
        idempotencyKey: "documents:delete",
      },
      context,
    );
    expect(deleted.documentId).toBe(created.id);
    await expect(
      content.readDocument({ ref: change.branchName, documentId: created.id }),
    ).rejects.toThrow();
  });

  it("stores an idempotent future schedule and generated workflow on the Change", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
      scheduler: {
        workflow: (input) => ({
          path: `.github/workflows/${input.scheduleId}.yml`,
          content: `name: ${input.scheduleId}\n`,
        }),
      },
    });
    const context = { actor: testActor, requestId: "req_schedule" };
    const change = await application.createChange.execute(
      { name: "Timed launch", idempotencyKey: "schedule:change" },
      context,
    );
    const current = await git.resolveRef(change.branchName);
    const first = await application.scheduleContent.execute(
      {
        change,
        action: "publish",
        documentIds: ["doc_home" as DocumentId],
        executeAt: "2026-07-28T08:00:00.000Z",
        expectedRevision: current.sha,
        idempotencyKey: "schedule:create",
      },
      context,
    );
    const second = await application.scheduleContent.execute(
      {
        change,
        action: "publish",
        documentIds: ["doc_home" as DocumentId],
        executeAt: "2026-07-28T08:00:00.000Z",
        expectedRevision: current.sha,
        idempotencyKey: "schedule:create",
      },
      context,
    );
    expect(second).toEqual(first);
    expect(
      await git.readFile({
        ref: change.branchName,
        path: `.cms/schedules/${first.schedule.id}.yaml`,
      }),
    ).toBeDefined();
  });

  it("removes scheduled content before publishing an unpublish release", async () => {
    const scheduleId = "sch_unpublish_due";
    const documentId = "doc_scheduled_page" as DocumentId;
    const executeAt = "2026-07-27T11:00:00.000Z";
    const git = new MemoryGitProvider({
      "content/pages/scheduled/index.yaml": yamlCodec.serialize({
        id: documentId,
        type: "pages",
        schemaVersion: 1,
        title: "Scheduled page",
        slug: "scheduled",
        sections: [],
      }),
      [`.cms/schedules/${scheduleId}.yaml`]: yamlCodec.serialize({
        id: scheduleId,
        changeId: "chg_scheduled_unpublish",
        action: "unpublish",
        documentIds: [documentId],
        executeAt,
        status: "scheduled",
        createdBy: testActor.id,
        createdAt: "2026-07-27T10:00:00.000Z",
      }),
    });
    const content = new GitContentRepository(git);
    const releaseStore = new TestReleaseStore();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
      releaseStore,
      releaseBuilder: testReleaseBuilder,
    });

    await expect(
      application.executeSchedule.execute(
        {
          scheduleId,
          expectedAt: executeAt,
          configVersion: 1,
          registryDigest: `sha256:${"a".repeat(64)}`,
          schemaVersion: 1,
          idempotencyKey: "schedule:execute-unpublish",
        },
        { actor: testActor, requestId: "req_schedule_unpublish" },
      ),
    ).resolves.toMatchObject({ status: "executed" });
    await expect(content.readDocument({ ref: "main", documentId })).rejects.toMatchObject({
      code: "CMS_DOCUMENT_404",
    });
    expect(
      [...releaseStore.releases.values()][0]?.files["content/pages/scheduled/index.json"],
    ).toBeUndefined();
  });

  it("publishes availability and visibility windows without deleting content", async () => {
    const scheduleId = "sch_availability_due";
    const documentId = "doc_windowed_page" as DocumentId;
    const executeAt = "2026-07-27T11:00:00.000Z";
    const git = new MemoryGitProvider({
      "content/pages/windowed/index.yaml": yamlCodec.serialize({
        id: documentId,
        type: "pages",
        schemaVersion: 1,
        title: "Windowed page",
        slug: "windowed",
        sections: [],
      }),
      [`.cms/schedules/${scheduleId}.yaml`]: yamlCodec.serialize({
        id: scheduleId,
        changeId: "chg_scheduled_availability",
        action: "availability-start",
        documentIds: [documentId],
        executeAt,
        status: "scheduled",
        createdBy: testActor.id,
        createdAt: "2026-07-27T10:00:00.000Z",
      }),
    });
    const content = new GitContentRepository(git);
    const releaseStore = new TestReleaseStore();
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
      releaseStore,
      releaseBuilder: testReleaseBuilder,
    });

    await expect(
      application.executeSchedule.execute(
        {
          scheduleId,
          expectedAt: executeAt,
          configVersion: 1,
          registryDigest: `sha256:${"a".repeat(64)}`,
          schemaVersion: 1,
          idempotencyKey: "schedule:execute-availability",
        },
        { actor: testActor, requestId: "req_schedule_availability" },
      ),
    ).resolves.toMatchObject({ status: "executed" });
    await expect(content.readDocument({ ref: "main", documentId })).resolves.toMatchObject({
      data: { availability: { from: executeAt } },
    });
    expect(
      [...releaseStore.releases.values()][0]?.files["content/pages/windowed/index.json"],
    ).toContain('"availability"');
  });

  it("moves a Change through review and staging into an immutable production release", async () => {
    const git = new StrictDeleteMemoryGitProvider();
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
    await expect(
      application.approveChange.execute(
        {
          change: submitted.change,
          pullRequestNumber: submitted.pullRequest?.number ?? 0,
          expectedRevision: submitted.revision,
          idempotencyKey: "workflow:self-approve",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_REVIEW_009" });
    const approved = await application.approveChange.execute(
      {
        change: submitted.change,
        pullRequestNumber: submitted.pullRequest?.number ?? 0,
        expectedRevision: submitted.revision,
        idempotencyKey: "workflow:approve",
      },
      { ...context, actor: reviewer },
    );
    expect(approved.change.status).toBe("approved");
    const staged = await application.addChangeToStaging.execute(
      {
        change: approved.change,
        pullRequestNumber: approved.change.pullRequestNumber ?? 0,
        expectedRevision: approved.revision,
        idempotencyKey: "workflow:stage",
      },
      { ...context, actor: reviewer },
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
      { ...context, actor: reviewer },
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
    await expect(application.readStagingBatch.execute(context)).resolves.not.toHaveProperty("lock");
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "change.submitted",
      "change.approved",
      "change.added-to-staging",
      "staging.promoted",
      "release.built-and-published",
    ]);
  });

  it("locks and idempotently unlocks a Staging release candidate", async () => {
    const { application, git } = fixture();
    const context = { actor: testActor, requestId: "req_staging_lock" };
    const staging = await git.resolveRef("staging");
    const locked = await application.lockStagingBatch.execute(
      {
        expectedRevision: staging.sha,
        checklist: ["routes", "responsive", "localization"],
        idempotencyKey: "staging-lock:lock",
      },
      context,
    );
    await expect(application.readStagingBatch.execute(context)).resolves.toMatchObject({
      revision: locked.revision,
      lock: { batchRevision: staging.sha, checklist: ["localization", "responsive", "routes"] },
    });
    const unlocked = await application.unlockStagingBatch.execute(
      {
        expectedRevision: locked.revision,
        idempotencyKey: "staging-lock:unlock",
      },
      context,
    );
    await expect(
      application.unlockStagingBatch.execute(
        {
          expectedRevision: unlocked.revision,
          idempotencyKey: "staging-lock:unlock-again",
        },
        context,
      ),
    ).resolves.toEqual({ revision: unlocked.revision });
    await expect(application.readStagingBatch.execute(context)).resolves.not.toHaveProperty("lock");
  });

  it("removes a staged Change through an auditable revert pull request", async () => {
    const git = new MemoryGitProvider();
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
    });
    const context = { actor: testActor, requestId: "req_remove_staged" };
    const change = await application.createChange.execute(
      { name: "Removable campaign", idempotencyKey: "remove:create" },
      context,
    );
    const submitted = await application.submitChange.execute(
      {
        change,
        expectedRevision: (await git.resolveRef(change.branchName)).sha,
        idempotencyKey: "remove:submit",
      },
      context,
    );
    const approved = await application.approveChange.execute(
      {
        change: submitted.change,
        pullRequestNumber: submitted.pullRequest?.number ?? 0,
        expectedRevision: submitted.revision,
        idempotencyKey: "remove:approve",
      },
      { ...context, actor: reviewer },
    );
    const staged = await application.addChangeToStaging.execute(
      {
        change: approved.change,
        pullRequestNumber: approved.change.pullRequestNumber ?? 0,
        expectedRevision: approved.revision,
        idempotencyKey: "remove:stage",
      },
      { ...context, actor: reviewer },
    );
    const removed = await application.removeChangeFromStaging.execute(
      {
        change: staged.change,
        expectedRevision: staged.revision,
        idempotencyKey: "remove:revert",
      },
      { ...context, actor: reviewer },
    );
    expect(removed.change.status).toBe("archived");
    expect(removed.pullRequest).toMatchObject({ base: "staging", state: "open" });
    expect(
      yamlCodec.parse(
        (
          await git.readFile({
            ref: "staging",
            path: `.cms/changes/${change.id}.yaml`,
          })
        )?.content ?? "",
      ),
    ).toMatchObject({ status: "archived" });
    expect(audit.events.at(-1)).toMatchObject({ type: "change.removed-from-staging" });
  });

  it("publishes an approved Emergency Change directly to Production and forward-syncs Staging", async () => {
    const git = new MemoryGitProvider({
      "content/pages/home/index.yaml": yamlCodec.serialize({
        id: "doc_home",
        type: "pages",
        schemaVersion: 1,
        title: "Emergency-ready homepage",
        slug: "home",
        sections: [],
      }),
    });
    const releaseStore = new TestReleaseStore();
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content: new GitContentRepository(git),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      releaseStore,
      releaseBuilder: testReleaseBuilder,
    });
    const context = { actor: testActor, requestId: "req_emergency" };
    const change = await application.createChange.execute(
      {
        name: "Critical legal correction",
        emergency: true,
        baseBranch: "staging",
        idempotencyKey: "emergency:create",
      },
      context,
    );
    expect(change).toMatchObject({ emergency: true, baseBranch: "main" });
    expect(change.branchName).toMatch(/^hotfix\//u);
    const draft = await git.resolveRef(change.branchName);
    const submitted = await application.submitChange.execute(
      {
        change,
        expectedRevision: draft.sha,
        idempotencyKey: "emergency:submit",
      },
      context,
    );
    expect(submitted.pullRequest).toMatchObject({ base: "main" });
    const approved = await application.approveChange.execute(
      {
        change: submitted.change,
        pullRequestNumber: submitted.pullRequest?.number ?? 0,
        expectedRevision: submitted.revision,
        idempotencyKey: "emergency:approve",
      },
      { ...context, actor: reviewer },
    );
    const published = await application.publishEmergencyChange.execute(
      {
        change: approved.change,
        pullRequestNumber: approved.change.pullRequestNumber ?? 0,
        expectedRevision: approved.revision,
        configVersion: 1,
        registryDigest: `sha256:${"a".repeat(64)}`,
        schemaVersion: 1,
        idempotencyKey: "emergency:publish",
      },
      { ...context, actor: reviewer },
    );
    expect(published.change.status).toBe("published");
    expect(await releaseStore.readPointer("production")).toMatchObject({
      releaseId: "rel_test_workflow",
    });
    expect(git.pullRequest(2)).toMatchObject({
      head: "main",
      base: "staging",
      state: "merged",
    });
    await expect(git.resolveRef(change.branchName)).rejects.toThrow("Unknown branch");
    await expect(
      git.readFile({ ref: "staging", path: `.cms/changes/${change.id}.yaml` }),
    ).resolves.toBeDefined();
    expect(audit.events.map((event) => event.type)).toContain("change.emergency-published");
  });

  it("switches the rollback pointer first and opens content reconciliation PRs for main and Staging", async () => {
    const git = new MemoryGitProvider({
      "content/pages/current/index.yaml": yamlCodec.serialize({
        id: "doc_current",
        type: "pages",
        schemaVersion: 1,
        title: "Current but faulty",
        slug: "current",
      }),
    });
    const releaseStore = new TestReleaseStore();
    const releaseId = "rel_known_good" as ReleaseId;
    await releaseStore.writeRelease({
      id: releaseId,
      manifest: {
        releaseId,
        gitCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      files: {
        "content/pages/home/index.json": JSON.stringify({
          id: "doc_home",
          type: "pages",
          schemaVersion: 1,
          title: "Known good",
          slug: "home",
        }),
        "manifest.json": "{}",
      },
    });
    releaseStore.pointers.set("production", {
      environment: "production",
      releaseId: "rel_faulty" as ReleaseId,
      revision: "pointer-faulty",
      updatedAt: "2026-07-27T11:00:00.000Z",
    });
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content: new GitContentRepository(git),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      releaseStore,
    });
    const result = await application.rollbackRelease.execute(
      {
        releaseId,
        expectedPointerRevision: "pointer-faulty",
        idempotencyKey: "rollback:known-good",
      },
      { actor: reviewer, requestId: "req_rollback" },
    );
    expect(await releaseStore.readPointer("production")).toMatchObject({ releaseId });
    expect(result.pullRequest).toMatchObject({ base: "main" });
    expect(result.stagingPullRequest).toMatchObject({ base: "staging" });
    await expect(
      git.readFile({
        ref: result.pullRequest.head,
        path: "content/pages/current/index.yaml",
      }),
    ).resolves.toBeUndefined();
    await expect(
      git.readFile({
        ref: result.pullRequest.head,
        path: "content/pages/home/index.yaml",
      }),
    ).resolves.toMatchObject({ content: expect.stringContaining("Known good") });
    expect(audit.events.at(-1)).toMatchObject({
      type: "release.rolled-back",
      details: {
        pointerFirst: true,
        reconciliationPullRequest: result.pullRequest.number,
        stagingPullRequest: result.stagingPullRequest.number,
      },
    });
  });

  it("retries deployment notification after the release pointer already switched", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    const releaseStore = new TestReleaseStore();
    let notifications = 0;
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
      releaseStore,
      releaseBuilder: testReleaseBuilder,
      publicationNotifier: {
        async notify() {
          notifications += 1;
          if (notifications === 1) throw new Error("temporary deployment outage");
        },
      },
    });
    const main = await git.resolveRef("main");
    content.seed("main", {
      id: "doc_home" as DocumentId,
      type: "pages",
      schemaVersion: 1,
      revision: main.sha,
      data: { title: "Retry-safe release", sections: [] },
    });
    const command = {
      ref: "main",
      expectedRevision: main.sha,
      environment: "production" as const,
      configVersion: 1,
      registryDigest: "sha256:retry",
      schemaVersion: 1,
      idempotencyKey: "release:retry-notification",
    };
    const context = { actor: testActor, requestId: "req_release_retry" };
    await expect(application.buildAndPublishRelease.execute(command, context)).rejects.toThrow(
      "temporary deployment outage",
    );
    await expect(
      application.buildAndPublishRelease.execute(command, context),
    ).resolves.toMatchObject({ id: "rel_test_workflow" });
    expect(notifications).toBe(2);
    expect(await releaseStore.readPointer("production")).toMatchObject({
      releaseId: "rel_test_workflow",
    });
  });

  it("creates idempotent translation jobs and exposes provider status through application", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    const audit = new MemoryAuditSink();
    let createdJobs = 0;
    const translationProvider: TranslationProvider = {
      async createJob() {
        createdJobs += 1;
        return { jobId: "job-translation-1" };
      },
      async readJob() {
        return { status: "complete", xliff: '<xliff version="2.0"/>' };
      },
    };
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      translationProvider,
    });
    const context = { actor: testActor, requestId: "req_translation" };
    const change = await application.createChange.execute(
      { name: "Translate homepage", idempotencyKey: "translation-change" },
      context,
    );
    const documentId = "doc_translation" as DocumentId;
    content.seed(change.branchName, {
      id: documentId,
      type: "pages",
      schemaVersion: 1,
      revision: change.baseCommit,
      data: { title: "Homepage", sections: [] },
    });
    const command = {
      change,
      documentId,
      sourceLocale: "en-US",
      targetLocale: "pl-PL",
      xliff: '<xliff version="2.0"/>',
      expectedRevision: change.baseCommit,
      idempotencyKey: "translation-job-1",
    };
    await expect(application.createTranslationJob.execute(command, context)).resolves.toEqual({
      jobId: "job-translation-1",
    });
    await expect(application.createTranslationJob.execute(command, context)).resolves.toEqual({
      jobId: "job-translation-1",
    });
    expect(createdJobs).toBe(1);
    await expect(
      application.readTranslationJob.execute({ change, jobId: "job-translation-1" }, context),
    ).resolves.toEqual({
      status: "complete",
      xliff: '<xliff version="2.0"/>',
    });
    expect(audit.events.map((event) => event.type)).toContain("translation.job-created");
  });

  it("updates asset metadata through storage and records it on the Change branch", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    const audit = new MemoryAuditSink();
    let currentAsset: Asset = {
      id: "ast_0123456789abcdef01234567" as AssetId,
      fileName: "hero.png",
      mimeType: "image/png",
      size: 128,
      checksum: "0".repeat(64),
      url: "https://assets.test/hero.png",
    };
    const assetStore: AssetStore = {
      async createUpload() {
        throw new Error("unused");
      },
      async finalizeUpload() {
        return currentAsset;
      },
      async readAsset(id) {
        return id === currentAsset.id ? currentAsset : undefined;
      },
      async updateAssetMetadata(input) {
        const stable = { ...currentAsset };
        delete stable.altText;
        delete stable.focalPoint;
        currentAsset = {
          ...stable,
          ...(input.altText === undefined ? {} : { altText: input.altText }),
          ...(input.focalPoint === undefined ? {} : { focalPoint: input.focalPoint }),
        };
        return currentAsset;
      },
      async deleteAsset() {},
      async listAssets() {
        return { items: [currentAsset] };
      },
    };
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      assetStore,
    });
    const context = { actor: testActor, requestId: "req_asset_metadata" };
    const change = await application.createChange.execute(
      { name: "Asset metadata", idempotencyKey: "asset-change" },
      context,
    );
    const branch = await git.resolveRef(change.branchName);
    const result = await application.updateAsset.execute(
      {
        change,
        assetId: currentAsset.id,
        altText: "A field notebook on a desk",
        focalPoint: { x: 0.25, y: 0.75 },
        expectedRevision: branch.sha,
        idempotencyKey: "asset-metadata-update",
      },
      context,
    );
    expect(result.asset).toMatchObject({
      altText: "A field notebook on a desk",
      focalPoint: { x: 0.25, y: 0.75 },
    });
    await expect(
      git.readFile({
        ref: change.branchName,
        path: `.cms/assets/${currentAsset.id}.yaml`,
      }),
    ).resolves.toMatchObject({ content: expect.stringContaining("A field notebook on a desk") });
    expect(audit.events.at(-1)).toMatchObject({ type: "asset.updated" });
  });

  it("compensates storage metadata when the Change moves during an asset update", async () => {
    const git = new MemoryGitProvider();
    const content = new MemoryContentRepository();
    let currentAsset: Asset = {
      id: "ast_abcdef0123456789abcdef01" as AssetId,
      fileName: "compensated.png",
      mimeType: "image/png",
      size: 64,
      checksum: "a".repeat(64),
      url: "https://assets.test/compensated.png",
      altText: "Original",
    };
    let branchName = "";
    let injectConcurrentCommit = true;
    const assetStore: AssetStore = {
      async createUpload() {
        throw new Error("unused");
      },
      async finalizeUpload() {
        return currentAsset;
      },
      async readAsset() {
        return currentAsset;
      },
      async updateAssetMetadata(input) {
        const stable = { ...currentAsset };
        delete stable.altText;
        delete stable.focalPoint;
        currentAsset = {
          ...stable,
          ...(input.altText === undefined ? {} : { altText: input.altText }),
          ...(input.focalPoint === undefined ? {} : { focalPoint: input.focalPoint }),
        };
        if (injectConcurrentCommit) {
          injectConcurrentCommit = false;
          const ref = await git.resolveRef(branchName);
          await git.commitFiles({
            branch: branchName,
            expectedSha: ref.sha,
            files: [{ path: ".cms/concurrent.yaml", content: "moved: true\n" }],
          });
        }
        return currentAsset;
      },
      async deleteAsset() {},
      async listAssets() {
        return { items: [currentAsset] };
      },
    };
    const application = createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
      assetStore,
    });
    const context = { actor: testActor, requestId: "req_asset_compensation" };
    const change = await application.createChange.execute(
      { name: "Asset compensation", idempotencyKey: "asset-compensation-change" },
      context,
    );
    branchName = change.branchName;
    const revision = (await git.resolveRef(branchName)).sha;

    await expect(
      application.updateAsset.execute(
        {
          change,
          assetId: currentAsset.id,
          altText: "Uncommitted replacement",
          expectedRevision: revision,
          idempotencyKey: "asset-compensation-update",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_GIT_012" });
    expect(currentAsset.altText).toBe("Original");
  });

  it("creates, verifies, and refreshes actor-bound preview sessions", async () => {
    const git = new MemoryGitProvider();
    const audit = new MemoryAuditSink();
    const issued = {
      id: "prv_original",
      actorId: testActor.id,
      changeId: "chg_preview" as never,
      frontendRef: "cms/editor/preview",
      locale: "pl-PL",
      createdAt: "2026-07-27T12:00:00.000Z",
      expiresAt: "2026-07-27T12:05:00.000Z",
      token: "signed-token",
    };
    const previewSessions: PreviewSessionPort = {
      async issue(input) {
        return { ...issued, actorId: input.actorId, changeId: input.changeId };
      },
      async verify() {
        return issued;
      },
      async refresh() {
        return { ...issued, id: "prv_refreshed", token: "refreshed-token" };
      },
    };
    const application = createCmsApplication({
      git,
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      previewSessions,
    });
    const context = { actor: testActor, requestId: "req_preview" };
    const change = await application.createChange.execute(
      { name: "Preview session", idempotencyKey: "preview-change" },
      context,
    );
    const session = await application.createPreviewSession.execute(
      {
        change,
        frontendRef: change.branchName,
        locale: "pl-PL",
        idempotencyKey: "preview-create",
      },
      context,
    );
    const boundSession = { ...session, changeId: change.id };
    previewSessions.verify = async () => boundSession;
    previewSessions.refresh = async () => ({
      ...boundSession,
      id: "prv_refreshed",
      token: "refreshed-token",
    });
    await expect(
      application.readPreviewSession.execute({ id: session.id, token: session.token }, context),
    ).resolves.toMatchObject({ actorId: testActor.id, changeId: change.id });
    await expect(
      application.refreshPreviewSession.execute(
        { id: session.id, token: session.token, idempotencyKey: "preview-refresh" },
        context,
      ),
    ).resolves.toMatchObject({ id: "prv_refreshed" });
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "preview.session-created",
      "preview.session-refreshed",
    ]);
  });

  it("resolves review threads and assigns GitHub reviewers through audited commands", async () => {
    let comment: ReviewComment = {
      id: "comment-42",
      author: "reviewer",
      body: "Please verify the legal copy.",
      createdAt: "2026-07-27T12:00:00.000Z",
      resolved: false,
    };
    let assignment = { users: [] as string[], teams: [] as string[] };
    const review: ReviewPort = {
      async addComment() {
        return comment;
      },
      async listComments() {
        return [comment];
      },
      async resolveComment(input) {
        comment = { ...comment, resolved: input.resolved };
        return comment;
      },
      async assignReviewers(input) {
        assignment = { users: [...input.users], teams: [...input.teams] };
        return assignment;
      },
      async listReviewers() {
        return assignment;
      },
      async listChecks() {
        return [];
      },
    };
    const git = new MemoryGitProvider();
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git,
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      review,
    });
    const context = { actor: testActor, requestId: "req_review_collaboration" };
    const change = await application.createChange.execute(
      { name: "Review collaboration", idempotencyKey: "review:change" },
      context,
    );
    await expect(
      application.resolveReviewComment.execute(
        {
          change,
          pullRequestNumber: 7,
          commentId: comment.id,
          resolved: true,
          idempotencyKey: "review:resolve",
        },
        context,
      ),
    ).resolves.toMatchObject({ id: comment.id, resolved: true });
    await expect(
      application.assignReviewers.execute(
        {
          change,
          pullRequestNumber: 7,
          users: ["octo-reviewer"],
          teams: ["legal"],
          idempotencyKey: "review:assign",
        },
        context,
      ),
    ).resolves.toEqual({ users: ["octo-reviewer"], teams: ["legal"] });
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "review.thread-resolved",
      "review.reviewers-assigned",
    ]);
  });

  it("revalidates an immutable release without moving its environment pointer", async () => {
    const releaseStore = new TestReleaseStore();
    const releaseId = "rel_revalidate" as ReleaseId;
    const release: StoredRelease = {
      id: releaseId,
      manifest: {
        releaseId,
        gitCommit: "a".repeat(40),
        tags: ["page:home"],
      },
      files: {
        "content/pages/home/index.json": "{}",
        "routes/pl-PL.json": "{}",
        "manifest.json": "{}",
      },
    };
    await releaseStore.writeRelease(release);
    const notifications: unknown[] = [];
    const audit = new MemoryAuditSink();
    const application = createCmsApplication({
      git: new MemoryGitProvider(),
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      releaseStore,
      publicationNotifier: {
        async notify(input) {
          notifications.push(input);
        },
      },
    });
    await application.revalidateRelease.execute(
      {
        releaseId,
        environment: "production",
        idempotencyKey: "release-revalidate",
      },
      { actor: testActor, requestId: "req_revalidate" },
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      releaseId,
      environment: "production",
      tags: ["page:home"],
      paths: ["content/pages/home/index.json", "routes/pl-PL.json"],
    });
    expect(await releaseStore.readPointer("production")).toBeUndefined();
    expect(audit.events.at(-1)).toMatchObject({ type: "release.revalidated" });
  });

  it("provisions GitHub organization members and proposes audited CMS role mappings", async () => {
    const git = new MemoryGitProvider({
      ".cms/permissions.yaml": yamlCodec.serialize({
        version: 1,
        customRoles: [{ name: "legal-reviewer", actions: ["change.review", "project.read"] }],
        mappings: [],
      }),
    });
    const audit = new MemoryAuditSink();
    const operations: string[] = [];
    const teamProvisioning: TeamProvisioningPort = {
      async listMembers() {
        return [
          {
            id: "42",
            login: "octo-editor",
            displayName: "Octo Editor",
            organizationRole: "member",
          },
        ];
      },
      async listTeams() {
        return [{ id: "7", slug: "editors", name: "Editors" }];
      },
      async invite(input) {
        operations.push(`invite:${input.email ?? String(input.inviteeId)}`);
        return {
          id: "91",
          role: input.role,
          ...(input.email === undefined ? {} : { email: input.email }),
          status: "pending",
        };
      },
      async addMemberToTeam(input) {
        operations.push(`team:${input.teamSlug}:${input.username}:${input.role}`);
      },
    };
    const application = createCmsApplication({
      git,
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit,
      teamProvisioning,
    });
    const context = { actor: testActor, requestId: "req_team_management" };

    await expect(application.readTeamDirectory.execute(context)).resolves.toMatchObject({
      members: [{ login: "octo-editor" }],
      teams: [{ slug: "editors" }],
    });
    await expect(
      application.inviteTeamMember.execute(
        {
          email: `${"a".repeat(255)}@example.test`,
          role: "direct_member",
          idempotencyKey: "team:invalid-invite",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CMS_TEAM_004" });
    await application.inviteTeamMember.execute(
      {
        email: "new-editor@example.test",
        role: "direct_member",
        idempotencyKey: "team:invite",
      },
      context,
    );
    await application.addTeamMember.execute(
      {
        teamSlug: "editors",
        username: "octo-editor",
        role: "member",
        idempotencyKey: "team:add",
      },
      context,
    );
    const main = await git.resolveRef("main");
    const proposed = await application.updateTeamRoleMappings.execute(
      {
        mappings: [{ team: "DMTcorp/editors", roles: ["editor", "reviewer"] }],
        expectedRevision: main.sha,
        idempotencyKey: "team:mappings",
      },
      context,
    );
    expect(proposed.pullRequest).toMatchObject({
      base: "main",
      head: expect.stringMatching(/^cms-permissions\//u),
    });
    const permissions = await git.readFile({
      ref: proposed.pullRequest.head,
      path: ".cms/permissions.yaml",
    });
    expect(yamlCodec.parse(permissions?.content ?? "")).toEqual({
      customRoles: [{ actions: ["change.review", "project.read"], name: "legal-reviewer" }],
      mappings: [{ roles: ["editor", "reviewer"], team: "DMTcorp/editors" }],
      version: 1,
    });
    expect(operations).toEqual([
      "invite:new-editor@example.test",
      "team:editors:octo-editor:member",
    ]);
    expect(audit.events.map((event) => event.type)).toEqual([
      "team.member-invited",
      "team.member-added",
      "team.role-mappings-updated",
    ]);
  });
});
