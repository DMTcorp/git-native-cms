import { cdnSource, createContentClient } from "@git-native-cms/delivery";
import type { CmsPageDocument } from "@git-native-cms/react";
import { document as fixture } from "./cms-fixture";

interface PublishedPage extends CmsPageDocument {
  readonly title?: string;
}

function fallbackPage(): PublishedPage {
  return {
    id: fixture.id,
    route: fixture.data.route,
    sections: fixture.data.sections,
    title: fixture.data.title,
  };
}

export async function loadPublishedPage(): Promise<PublishedPage> {
  const baseUrl = import.meta.env.CMS_PUBLIC_RELEASES_URL as string | undefined;
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
