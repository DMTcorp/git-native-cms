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

export const actor: Actor = {
  id: "actor_astro" as ActorId,
  githubId: 2,
  login: "astro-editor",
  displayName: "Astro Editor",
  roles: ["administrator"],
  source: "ui",
};

export const change: Change = {
  id: "chg_astro" as ChangeId,
  name: "Astro launch",
  ownerId: actor.id,
  baseBranch: "main",
  baseCommit: "sha_main_1" as GitCommitSha,
  branchName: "cms/astro-editor/astro-launch-demo",
  status: "draft",
  createdAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
  updatedAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
};

export const document: ContentDocument<{
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
  id: "doc_astro_home" as DocumentId,
  type: "pages",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Astro homepage",
    route: { path: "/" },
    sections: [
      {
        id: "sec_astro_hero",
        type: "hero",
        version: 1,
        heading: "One content model. Two real renderers.",
        description: "The same workflow drives Next.js and Astro.",
      },
      {
        id: "sec_astro_proof",
        type: "proof",
        version: 1,
        heading: "Server-rendered editing",
        description: "Astro runs the full CMS through its Node adapter.",
      },
    ],
  },
};
