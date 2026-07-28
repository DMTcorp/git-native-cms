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
import { describe, expect, it, vi } from "vitest";
import { callCmsTool, cmsTools, handleMcpJsonRpc, type CmsMcpContext } from "./index.js";

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
  it("exposes the complete CMS resource, tool and prompt surface", async () => {
    expect(cmsTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_change",
        "create_page",
        "add_section",
        "move_section",
        "remove_section",
        "search_content",
        "find_usages",
        "validate_change",
        "list_conflicts",
        "resolve_conflicts",
        "create_preview",
        "add_review_comment",
        "get_staging_status",
      ]),
    );
    const application = createCmsApplication({
      git: new MemoryGitProvider(),
      content: new MemoryContentRepository(),
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
    });
    const placeholder = {
      id: "chg_placeholder",
      name: "Placeholder",
    } as Change;
    const mcp = context(application, () => placeholder);
    const resources = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      mcp,
    );
    expect(JSON.stringify(resources)).toContain("cms://content-graph");
    expect(JSON.stringify(resources)).toContain("cms://documents/{id}");
    const prompts = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 2, method: "prompts/list" }, mcp);
    for (const name of [
      "create_landing_page",
      "localize_page",
      "update_global_pricing",
      "audit_seo",
      "prepare_campaign_change",
      "summarize_change",
    ]) {
      expect(JSON.stringify(prompts)).toContain(name);
    }
  });

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
      callCmsTool("get_change", { changeId: state.change.id }, mcp),
    ).resolves.toMatchObject({ change: { id: state.change.id } });
    await expect(
      callCmsTool("create_preview", { changeId: state.change.id }, mcp),
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

  it("delegates semantic conflict reads and resolutions to application handlers", async () => {
    const change = {
      id: "chg_mcp_conflicts",
      name: "MCP conflict",
      ownerId: actor.id,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      branchName: "cms/mcp-editor/conflicts",
      status: "in_review",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
    } as Change;
    const readChangeConflicts = vi.fn(async () => ({
      conflicts: [{ documentId: "doc_home", path: "/title" }],
      stagingRevision: "b".repeat(40),
    }));
    const resolveChangeConflicts = vi.fn(async () => ({
      change,
      revision: "c".repeat(40),
    }));
    const application = {
      readChangeConflicts: { execute: readChangeConflicts },
      resolveChangeConflicts: { execute: resolveChangeConflicts },
    } as unknown as CmsApplication;
    const mcp = context(application, () => change);

    await expect(
      callCmsTool("list_conflicts", { changeId: change.id }, mcp),
    ).resolves.toMatchObject({ conflicts: [{ path: "/title" }] });
    await callCmsTool(
      "resolve_conflicts",
      {
        changeId: change.id,
        expectedRevision: "c".repeat(40),
        resolutions: [{ documentId: "doc_home", path: "/title", choice: "change" }],
        idempotencyKey: "mcp:resolve-conflicts",
      },
      mcp,
    );
    expect(resolveChangeConflicts).toHaveBeenCalledWith(
      {
        change,
        expectedRevision: "c".repeat(40),
        resolutions: [{ documentId: "doc_home", path: "/title", choice: "change" }],
        idempotencyKey: "mcp:resolve-conflicts",
      },
      mcp.request,
    );
  });
});
