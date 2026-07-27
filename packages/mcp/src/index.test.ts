import { createCmsApplication, type CmsApplication } from "@git-native-cms/application";
import type { Actor, Change } from "@git-native-cms/core";
import { AuthorizationService } from "@git-native-cms/permissions";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryGitProvider,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";
import { describe, expect, it } from "vitest";
import { callCmsTool, type CmsMcpContext } from "./index.js";

const actor: Actor = {
  id: "act_mcp_editor" as Actor["id"],
  githubId: 99,
  login: "mcp-editor",
  displayName: "MCP Editor",
  roles: ["editor"],
  source: "mcp",
};

function context(application: CmsApplication, getChange: () => Change): CmsMcpContext {
  return {
    application,
    registryDigest: `sha256:${"a".repeat(64)}`,
    request: { actor, requestId: "req_mcp_contract" },
    confirmation: { verify: async () => false },
    queries: {
      project: async () => ({ name: "MCP fixture" }),
      listChanges: async () => [getChange()],
      getChange: async () => getChange(),
      listDocuments: async () => ({ items: [] }),
      getDocument: async () => ({}),
      previewUrl: async (changeId) => `https://preview.example.test/cms/${changeId}`,
      listReleases: async () => [],
    },
  };
}

describe("MCP permission parity", () => {
  it("lets an editor create and preview a Change but not approve or publish it", async () => {
    const application = createCmsApplication({
      git: new MemoryGitProvider(),
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
    });
    const state: { change?: Change } = {};
    const mcp = context(application, () => {
      if (state.change === undefined) throw new Error("Change not created.");
      return state.change;
    });
    const created = (await callCmsTool(
      "create_change",
      { name: "Agent draft", idempotencyKey: "mcp-create-1" },
      mcp,
    )) as { readonly change: Change };
    state.change = created.change;
    await expect(
      callCmsTool("get_preview", { changeId: state.change.id }, mcp),
    ).resolves.toMatchObject({
      url: expect.stringContaining(String(state.change.id)) as string,
    });
    await expect(
      callCmsTool(
        "approve_change",
        {
          changeId: state.change.id,
          pullRequestNumber: 1,
          expectedRevision: state.change.baseCommit,
          idempotencyKey: "mcp-approve-1",
        },
        mcp,
      ),
    ).rejects.toMatchObject({ code: "CMS_PERMISSION_004" });
    await expect(
      callCmsTool(
        "publish_staging",
        {
          expectedRevision: state.change.baseCommit,
          title: "Unauthorized release",
          idempotencyKey: "mcp-publish-1",
          confirmationToken: "invalid",
        },
        mcp,
      ),
    ).rejects.toThrow(/confirmation token/i);
  });
});
