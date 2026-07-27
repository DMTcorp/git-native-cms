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
  readonly redirectFrom: readonly string[];
  readonly seo: { readonly title: string; readonly description: string };
  readonly locales: Readonly<
    Record<string, { readonly status: string; readonly fields: Readonly<Record<string, string>> }>
  >;
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
    redirectFrom: ["/welcome"],
    seo: {
      title: "Fieldnotes · Git-native CMS",
      description: "A live Next.js demonstration of Git-native visual publishing.",
    },
    locales: {
      "pl-PL": {
        status: "translated",
        fields: {
          "/title": "Strona główna",
          "/sections/0/heading": "Praca redakcyjna bez widocznej maszynerii.",
          "/sections/0/description":
            "Buduj strony z prawdziwych komponentów i publikuj niezmienne wydania.",
          "/sections/1/heading": "Jasna droga do publikacji",
          "/sections/1/description":
            "Każda zmiana przechodzi przez przegląd i staging przed publikacją.",
        },
      },
    },
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
