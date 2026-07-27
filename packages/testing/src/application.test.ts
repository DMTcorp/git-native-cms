import { yamlCodec } from "@git-native-cms/content-codecs";
import type { DocumentId, Revision } from "@git-native-cms/core";
import { contentPath } from "@git-native-cms/document-model";
import { createCmsApplication } from "@git-native-cms/application";
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
});
