import type { CmsPageDocument } from "@git-native-cms/react";
import { cdnSource, createContentClient } from "@git-native-cms/delivery";
import { sandboxDocument } from "./cms.fixture";

interface PublishedPage extends CmsPageDocument {
  readonly title?: string;
}

function fallbackPage(): PublishedPage {
  return {
    id: sandboxDocument.id,
    route: sandboxDocument.data.route,
    sections: sandboxDocument.data.sections,
    title: sandboxDocument.data.title,
  };
}

export async function loadPublishedPage(): Promise<PublishedPage> {
  const baseUrl = process.env.CMS_PUBLIC_RELEASES_URL;
  if (baseUrl === undefined || baseUrl.length === 0) return fallbackPage();
  try {
    const client = createContentClient({
      environment: "production",
      source: cdnSource({ baseUrl }),
    });
    return await client.get<PublishedPage>("content/pages/home/index.json");
  } catch {
    return fallbackPage();
  }
}
