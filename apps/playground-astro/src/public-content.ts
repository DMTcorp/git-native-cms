import {
  cdnSource,
  createContentClient,
  loadContentGraph,
  loadRedirects,
  resolveRedirect,
} from "@git-native-cms/delivery";
import { materializeLocalizedValue, type LocalizedDocument } from "@git-native-cms/localization";
import type { CmsPageDocument, RenderContentDocument } from "@git-native-cms/react";
import { document as fixture } from "./cms-fixture";

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
    id: fixture.id,
    ...fixture.data,
  };
}

export async function loadPublishedPage(locale = "en-US"): Promise<PublishedPage> {
  const baseUrl = import.meta.env.CMS_PUBLIC_RELEASES_URL as string | undefined;
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
  const baseUrl = import.meta.env.CMS_PUBLIC_RELEASES_URL as string | undefined;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return fixture.data.redirectFrom.includes(path) ? "/" : undefined;
  }
  try {
    const client = createContentClient({
      environment: "production",
      source: cdnSource({ baseUrl }),
    });
    return resolveRedirect(await loadRedirects(client), path);
  } catch {
    return fixture.data.redirectFrom.includes(path) ? "/" : undefined;
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
  const baseUrl = import.meta.env.CMS_PUBLIC_RELEASES_URL as string | undefined;
  if (baseUrl === undefined || baseUrl.length === 0) return { page, content: [] };
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
