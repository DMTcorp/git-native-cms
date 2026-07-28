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
import type { Asset } from "@git-native-cms/application";
import type { AssetId } from "@git-native-cms/core";

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
  baseCommit: "0000000000000000000000000000000000000001" as GitCommitSha,
  branchName: "cms/sandbox-editor/autumn-campaign-demo",
  status: "draft",
  createdAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
  updatedAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
};

export const sandboxAssets: readonly Asset[] = [
  {
    id: "ast_0123456789abcdef01234567" as AssetId,
    fileName: "editorial-grid.png",
    mimeType: "image/png",
    size: 68,
    checksum: "9d7f1cda29a611c744467d427f3f8726172b68f24e505b2afdc67cf1b5744c54",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    altText: "Blue editorial grid placeholder",
  },
];

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
    readonly heading?: string;
    readonly description?: string;
    readonly bindings?: Readonly<Record<string, unknown>>;
    readonly ref?: string;
    readonly overrides?: Readonly<Record<string, unknown>>;
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
      {
        id: "sec_pricing",
        type: "pricingGrid",
        version: 1,
        heading: "Plans that grow with the publication",
        bindings: { plans: { collection: "plans" } },
      },
      {
        id: "sec_reusable",
        type: "reference",
        version: 1,
        ref: "reusable-blocks/editorial-note",
        overrides: {},
      },
    ],
  },
};

export const sandboxNavigation: ContentDocument<{
  readonly title: string;
  readonly slug: string;
  readonly items: readonly {
    readonly label: string;
    readonly href: string;
  }[];
}> = {
  id: "doc_navigation_primary" as DocumentId,
  type: "navigation",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Primary navigation",
    slug: "primary",
    items: [
      { label: "Journal", href: "/#journal" },
      { label: "Plans", href: "/#plans" },
    ],
  },
};

export const sandboxPricingPlans: readonly ContentDocument<{
  readonly title: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly price: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly locale: string;
}>[] = [
  {
    id: "doc_plan_lite" as DocumentId,
    type: "plans",
    schemaVersion: 1,
    revision: "sha_content_1" as Revision,
    data: {
      title: "Fieldnotes Lite",
      slug: "lite",
      name: "Lite",
      description: "A focused workflow for one publication.",
      price: { amount: 1900, currency: "USD" },
      locale: "en-US",
    },
  },
  {
    id: "doc_plan_studio" as DocumentId,
    type: "plans",
    schemaVersion: 1,
    revision: "sha_content_1" as Revision,
    data: {
      title: "Fieldnotes Studio",
      slug: "studio",
      name: "Studio",
      description: "Review, staging and releases for editorial teams.",
      price: { amount: 4900, currency: "USD" },
      locale: "en-US",
    },
  },
];

export const sandboxSettings: ContentDocument<{
  readonly title: string;
  readonly slug: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly defaultLocale: string;
}> = {
  id: "doc_settings_site" as DocumentId,
  type: "settings",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Site settings",
    slug: "site",
    siteName: "Fieldnotes",
    siteUrl: "https://git-native-cms-next.vercel.app",
    defaultLocale: "en-US",
  },
};

export const sandboxReusableBlock: ContentDocument<{
  readonly title: string;
  readonly slug: string;
  readonly sections: readonly {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    readonly heading: string;
    readonly description: string;
  }[];
}> = {
  id: "doc_reusable_editorial_note" as DocumentId,
  type: "reusable-blocks",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Editorial note",
    slug: "editorial-note",
    sections: [
      {
        id: "sec_editorial_note",
        type: "proof",
        version: 1,
        heading: "One source, every page",
        description: "Reusable blocks stay synchronized until an editor explicitly detaches them.",
      },
    ],
  },
};

export const sandboxContentDocuments: readonly ContentDocument[] = [
  sandboxDocument,
  sandboxNavigation,
  ...sandboxPricingPlans,
  sandboxSettings,
  sandboxReusableBlock,
];
