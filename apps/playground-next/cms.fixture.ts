import type {
  Actor,
  ActorId,
  Change,
  ChangeId,
  ContentDocument,
  DocumentId,
  GitCommitSha,
  IsoTimestamp,
  Revision,
} from "@git-native-cms/core";

export const sandboxActor: Actor = {
  id: "actor_sandbox" as ActorId,
  githubId: 1,
  login: "sandbox-editor",
  displayName: "Sandbox Editor",
  roles: ["administrator"],
  source: "ui",
};

export const sandboxChange: Change = {
  id: "chg_sandbox" as ChangeId,
  name: "Autumn campaign",
  description: "Refresh the homepage introduction and proof points.",
  ownerId: sandboxActor.id,
  baseBranch: "main",
  baseCommit: "sha_main_1" as GitCommitSha,
  branchName: "cms/sandbox-editor/autumn-campaign-demo",
  status: "draft",
  createdAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
  updatedAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
};

export const sandboxDocument: ContentDocument<{
  readonly title: string;
  readonly route: { readonly path: string };
  readonly sections: readonly {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    readonly heading: string;
    readonly description: string;
  }[];
}> = {
  id: "doc_home" as DocumentId,
  type: "pages",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Homepage",
    route: { path: "/" },
    sections: [
      {
        id: "sec_hero",
        type: "hero",
        version: 1,
        heading: "Editorial work, without the machinery showing.",
        description: "Build pages with real components and publish immutable releases.",
      },
      {
        id: "sec_proof",
        type: "proof",
        version: 1,
        heading: "A clear path to publication",
        description: "Every Change moves through review and staging before it goes live.",
      },
    ],
  },
};
