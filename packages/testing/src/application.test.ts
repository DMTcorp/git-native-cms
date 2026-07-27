import { yamlCodec } from "@git-native-cms/content-codecs";
import { GitContentRepository } from "@git-native-cms/content-repository";
import type { DocumentId, ReleaseId, Revision } from "@git-native-cms/core";
import { contentPath } from "@git-native-cms/document-model";
import {
  createCmsApplication,
  type EnvironmentPointer,
  type ReleaseBuilderPort,
  type ReleaseStore,
  type StoredRelease,
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
    expect(audit.events.map((event) => event.type)).toEqual([
      "change.created",
      "change.submitted",
      "change.approved",
      "change.added-to-staging",
      "staging.promoted",
      "release.built-and-published",
    ]);
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
});
