import type { CmsPageDocument, RenderContentDocument } from "@git-native-cms/react";
import {
  cdnSource,
  createContentClient,
  loadContentGraph,
  loadRedirects,
  resolveRedirect,
} from "@git-native-cms/delivery";
import { materializeLocalizedValue, type LocalizedDocument } from "@git-native-cms/localization";
import { sandboxContentDocuments, sandboxDocument } from "./cms.fixture";

interface PublishedPage extends CmsPageDocument {
  readonly title?: string;
  readonly description?: string;
  readonly locales?: Readonly<Record<string, unknown>>;
  readonly seo?: {
    readonly title?: string;
    readonly description?: string;
  };
}

const localeDefinitions = [
  { code: "en-US", language: "en" },
  { code: "pl-PL", language: "pl", fallback: "en-US" },
] as const;

function localizedPage(page: PublishedPage, locale: string): PublishedPage {
  const translations = Object.entries(page.locales ?? {}).flatMap(([code, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Readonly<Record<string, unknown>>;
    if (typeof record.fields !== "object" || record.fields === null) return [];
    return [
      {
        locale: code,
        status: "translated" as const,
        fields: record.fields as Record<string, unknown>,
      } satisfies LocalizedDocument<Record<string, unknown>>,
    ];
  });
  return materializeLocalizedValue(page, locale, localeDefinitions, translations);
}

function fallbackPage(): PublishedPage {
  return {
    id: sandboxDocument.id,
    ...sandboxDocument.data,
  };
}

function fallbackContent(): readonly RenderContentDocument[] {
  return sandboxContentDocuments
    .filter((document) => document.type !== "pages")
    .map((document) => ({
      id: document.id,
      type: document.type,
      data:
        typeof document.data === "object" && document.data !== null && !Array.isArray(document.data)
          ? (document.data as Readonly<Record<string, unknown>>)
          : { value: document.data },
    }));
}

export async function loadPublishedPage(locale = "en-US"): Promise<PublishedPage> {
  const baseUrl = process.env.CMS_PUBLIC_RELEASES_URL;
  if (baseUrl === undefined || baseUrl.length === 0) return localizedPage(fallbackPage(), locale);
  try {
    const client = createContentClient({
      environment: "production",
      source: cdnSource({ baseUrl }),
    });
    return localizedPage(await client.get<PublishedPage>("content/pages/home/index.json"), locale);
  } catch {
    return localizedPage(fallbackPage(), locale);
  }
}

export async function loadPublishedRedirect(path: string): Promise<string | undefined> {
  const baseUrl = process.env.CMS_PUBLIC_RELEASES_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return sandboxDocument.data.redirectFrom.includes(path) ? "/" : undefined;
  }
  try {
    const client = createContentClient({
      environment: "production",
      source: cdnSource({ baseUrl }),
    });
    return resolveRedirect(await loadRedirects(client), path);
  } catch {
    return sandboxDocument.data.redirectFrom.includes(path) ? "/" : undefined;
  }
}

function renderDocument(value: unknown): RenderContentDocument | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.id !== "string" || typeof record.type !== "string") return undefined;
  const data = Object.fromEntries(
    Object.entries(record).filter(([key]) => !["id", "type", "schemaVersion"].includes(key)),
  );
  return { id: record.id, type: record.type, data };
}

export async function loadPublishedSite(locale = "en-US"): Promise<{
  readonly page: PublishedPage;
  readonly content: readonly RenderContentDocument[];
}> {
  const page = await loadPublishedPage(locale);
  const baseUrl = process.env.CMS_PUBLIC_RELEASES_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return { page, content: fallbackContent() };
  }
  const client = createContentClient({
    environment: "production",
    source: cdnSource({ baseUrl }),
  });
  const content = await loadContentGraph(client).catch(async () => {
    const values = await Promise.all(
      [
        "content/collections/plans/lite/index.json",
        "content/globals/navigation/primary/index.json",
      ].map((path) => client.get<unknown>(path).catch(() => undefined)),
    );
    return values.flatMap((value) => {
      const document = renderDocument(value);
      return document === undefined ? [] : [document];
    });
  });
  return { page, content };
}
