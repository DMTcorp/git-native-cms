import { describe, expect, it } from "vitest";
import type { Actor, ActorId, ContentDocument, DocumentId, Revision } from "@git-native-cms/core";
import { createMemoryHostedRuntime } from "./index.js";

const actor: Actor = {
  id: "actor_fixture" as ActorId,
  githubId: 1,
  login: "fixture-editor",
  displayName: "Fixture Editor",
  roles: ["administrator"],
  source: "ui",
};

const document: ContentDocument = {
  id: "doc_home" as DocumentId,
  type: "pages",
  schemaVersion: 1,
  revision: "0000000000000000000000000000000000000001" as Revision,
  data: {
    title: "Homepage",
    route: { path: "/" },
    sections: [
      {
        id: "sec_hero",
        type: "hero",
        version: 1,
        heading: "Initial heading",
        description: "Initial description",
      },
    ],
  },
};

const navigation: ContentDocument = {
  id: "doc_navigation_primary" as DocumentId,
  type: "navigation",
  schemaVersion: 1,
  revision: "0000000000000000000000000000000000000001" as Revision,
  data: {
    title: "Primary navigation",
    slug: "primary",
    items: [{ label: "Journal", href: "/journal" }],
  },
};

const plan: ContentDocument = {
  id: "doc_plan_lite" as DocumentId,
  type: "plans",
  schemaVersion: 1,
  revision: "0000000000000000000000000000000000000001" as Revision,
  data: {
    title: "Lite",
    slug: "lite",
    name: "Lite",
    price: { amount: 1900, currency: "USD" },
  },
};

const settings: ContentDocument = {
  id: "doc_settings_site" as DocumentId,
  type: "settings",
  schemaVersion: 1,
  revision: "0000000000000000000000000000000000000001" as Revision,
  data: {
    title: "Site settings",
    slug: "site",
    siteName: "Fieldnotes",
    defaultLocale: "en-US",
  },
};

async function mutate(
  runtime: ReturnType<typeof createMemoryHostedRuntime>,
  path: string,
  body: Readonly<Record<string, unknown>>,
  method: "POST" | "PATCH" = "POST",
): Promise<{ readonly status: number; readonly payload: Readonly<Record<string, unknown>> }> {
  const response = await runtime.handle(
    new Request(`https://fixture.test/api/cms${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": `fixture-${crypto.randomUUID()}`,
        "x-csrf-token": "sandbox",
      },
      body: JSON.stringify(body),
    }),
  );
  const envelope = (await response.json()) as {
    readonly payload: Readonly<Record<string, unknown>>;
  };
  return { status: response.status, payload: envelope.payload };
}

describe("stateful browser fixture", () => {
  it("moves edited content through review, staging, immutable delivery and rollback", async () => {
    const runtime = createMemoryHostedRuntime({
      actor,
      documents: [document, navigation, plan, settings],
      projectName: "E2E fixture",
    });
    const dashboard = await runtime.editorState(null);
    expect(dashboard).toMatchObject({ authenticated: true, view: "dashboard" });
    if (!dashboard.authenticated || dashboard.view !== "dashboard") return;
    expect(dashboard.releases).toHaveLength(1);
    const initialRelease = dashboard.releases[0];
    if (initialRelease === undefined) throw new Error("Expected the initial release.");

    const created = await mutate(runtime, "/changes", {
      name: "Complete publication",
      description: "Exercise the entire product workflow.",
      collaborators: ["reviewer", "team:publishers"],
    });
    expect(created.status).toBe(201);
    const change = created.payload.change as {
      readonly id: string;
      readonly status: string;
    };
    expect(change.status).toBe("draft");

    const workspace = await runtime.editorState(null, `changes/${change.id}`);
    if (!workspace.authenticated || workspace.view !== "workspace") {
      throw new Error("Expected the workspace fixture.");
    }
    const saved = await mutate(
      runtime,
      `/changes/${change.id}/documents/${workspace.document.id}`,
      {
        expectedRevision: workspace.document.revision,
        patches: [
          {
            op: "set",
            path: "/sections/0/heading",
            value: "Published through the complete workflow",
            metadata: {
              id: "patch_fixture",
              actorId: actor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
      },
      "PATCH",
    );
    expect(saved.status).toBe(200);
    const savedRevision = (saved.payload.document as { readonly revision: Revision }).revision;

    const navigationSaved = await mutate(
      runtime,
      `/changes/${change.id}/documents/${navigation.id}`,
      {
        expectedRevision: savedRevision,
        patches: [
          {
            op: "set",
            path: "/items/0/label",
            value: "Dispatches",
            metadata: {
              id: "patch_navigation",
              actorId: actor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
      },
      "PATCH",
    );
    expect(navigationSaved.status).toBe(200);
    const navigationRevision = (navigationSaved.payload.document as { readonly revision: Revision })
      .revision;

    const planSaved = await mutate(
      runtime,
      `/changes/${change.id}/documents/${plan.id}`,
      {
        expectedRevision: navigationRevision,
        patches: [
          {
            op: "set",
            path: "/price/amount",
            value: 2500,
            metadata: {
              id: "patch_plan",
              actorId: actor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
      },
      "PATCH",
    );
    expect(planSaved.status).toBe(200);
    const planRevision = (planSaved.payload.document as { readonly revision: Revision }).revision;

    const settingsSaved = await mutate(
      runtime,
      `/changes/${change.id}/documents/${settings.id}`,
      {
        expectedRevision: planRevision,
        patches: [
          {
            op: "set",
            path: "/siteName",
            value: "Fieldnotes Studio",
            metadata: {
              id: "patch_settings",
              actorId: actor.id,
              createdAt: "2026-07-27T12:00:00.000Z",
              source: "editor",
            },
          },
        ],
      },
      "PATCH",
    );
    expect(settingsSaved.status).toBe(200);
    const settingsRevision = (settingsSaved.payload.document as { readonly revision: Revision })
      .revision;

    const coordinatedWorkspace = await runtime.editorState(
      null,
      `changes/${change.id}/documents/${settings.id}`,
    );
    if (!coordinatedWorkspace.authenticated || coordinatedWorkspace.view !== "workspace") {
      throw new Error("Expected the coordinated workspace fixture.");
    }
    expect(coordinatedWorkspace.review.summary.changedDocumentIds).toHaveLength(4);

    const submitted = await mutate(runtime, `/changes/${change.id}/submit`, {
      expectedRevision: settingsRevision,
    });
    expect(submitted.status).toBe(200);
    const submittedChange = submitted.payload.change as {
      readonly pullRequestNumber: number;
      readonly status: string;
    };
    expect(submittedChange.status).toBe("in_review");

    const commented = await mutate(runtime, `/changes/${change.id}/comments`, {
      pullRequestNumber: submittedChange.pullRequestNumber,
      body: "The preview and localized route look correct.",
      path: "/sections/0",
    });
    expect(commented.status).toBe(201);

    const approved = await mutate(runtime, `/changes/${change.id}/approve`, {
      pullRequestNumber: submittedChange.pullRequestNumber,
      expectedRevision: submitted.payload.revision,
    });
    expect(approved.status).toBe(200);
    expect((approved.payload.change as { readonly status: string }).status).toBe("approved");

    const staged = await mutate(runtime, `/changes/${change.id}/staging`, {
      pullRequestNumber: submittedChange.pullRequestNumber,
      expectedRevision: approved.payload.revision,
    });
    expect(staged.status).toBe(200);
    expect((staged.payload.change as { readonly status: string }).status).toBe("staging");

    const published = await mutate(runtime, "/staging/publish", {
      expectedStagingRevision: staged.payload.revision,
      title: "Release complete publication",
      configVersion: 1,
      registryDigest: `sha256:${"0".repeat(64)}`,
      schemaVersion: 1,
      confirmationToken: "sandbox-confirmation",
    });
    expect(published.status).toBe(200);

    const releases = await runtime.editorState(null, "releases");
    if (!releases.authenticated || releases.view !== "releases") {
      throw new Error("Expected the releases fixture.");
    }
    expect(releases.releases).toHaveLength(2);
    const production = releases.pointers.find((pointer) => pointer.environment === "production");
    expect(production?.releaseId).toBe(published.payload.releaseId);
    const currentRelease = releases.releases.find(
      (release) => release.id === production?.releaseId,
    );
    expect(currentRelease?.files["content/pages/doc_home/index.json"]).toContain(
      "Published through the complete workflow",
    );
    expect(currentRelease?.files["content/navigation/doc_navigation_primary/index.json"]).toContain(
      "Dispatches",
    );
    expect(currentRelease?.files["content/plans/doc_plan_lite/index.json"]).toContain("2500");
    expect(currentRelease?.files["content/settings/doc_settings_site/index.json"]).toContain(
      "Fieldnotes Studio",
    );

    const rolledBack = await mutate(runtime, `/releases/${initialRelease.id}/rollback`, {
      expectedPointerRevision: production?.revision,
      confirmationToken: "sandbox-confirmation",
    });
    expect(rolledBack.status).toBe(200);

    const restored = await runtime.editorState(null, "releases");
    if (!restored.authenticated || restored.view !== "releases") {
      throw new Error("Expected the restored releases fixture.");
    }
    expect(
      restored.pointers.find((pointer) => pointer.environment === "production")?.releaseId,
    ).toBe(initialRelease.id);
  });
});
