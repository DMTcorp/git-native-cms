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
  baseCommit: "0000000000000000000000000000000000000001" as GitCommitSha,
  branchName: "cms/astro-editor/astro-launch-demo",
  status: "draft",
  createdAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
  updatedAt: "2026-07-27T12:00:00.000Z" as IsoTimestamp,
};

export const assets: readonly Asset[] = [
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

export const document: ContentDocument<{
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
  id: "doc_astro_home" as DocumentId,
  type: "pages",
  schemaVersion: 1,
  revision: "sha_content_1" as Revision,
  data: {
    title: "Astro homepage",
    route: { path: "/" },
    redirectFrom: ["/welcome"],
    seo: {
      title: "Fieldnotes · Astro Git-native CMS",
      description: "A live Astro demonstration of Git-native visual publishing.",
    },
    locales: {
      "pl-PL": {
        status: "translated",
        fields: {
          "/title": "Strona główna Astro",
          "/sections/0/heading": "Jeden model treści. Dwa prawdziwe renderery.",
          "/sections/0/description": "Ten sam proces obsługuje Next.js i Astro.",
          "/sections/1/heading": "Edycja renderowana na serwerze",
          "/sections/1/description": "Astro uruchamia pełny CMS przez adapter serwerowy.",
        },
      },
    },
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
      {
        id: "sec_astro_pricing",
        type: "pricingGrid",
        version: 1,
        heading: "Plans materialized from a collection",
        bindings: { plans: { collection: "plans" } },
      },
      {
        id: "sec_astro_reusable",
        type: "reference",
        version: 1,
        ref: "reusable-blocks/editorial-note",
        overrides: {},
      },
    ],
  },
};

export const navigation: ContentDocument<{
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
      { label: "Renderer", href: "/#renderer" },
      { label: "Plans", href: "/#plans" },
    ],
  },
};

export const pricingPlans: readonly ContentDocument<{
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

export const settings: ContentDocument<{
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
    siteName: "Fieldnotes / Astro",
    siteUrl: "https://git-native-cms-astro.vercel.app",
    defaultLocale: "en-US",
  },
};

export const reusableBlock: ContentDocument<{
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
        id: "sec_astro_editorial_note",
        type: "proof",
        version: 1,
        heading: "One source, two frameworks",
        description: "Reusable content is resolved identically by the Next.js and Astro renderers.",
      },
    ],
  },
};

export const contentDocuments: readonly ContentDocument[] = [
  document,
  navigation,
  ...pricingPlans,
  settings,
  reusableBlock,
];
