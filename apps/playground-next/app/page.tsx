import Link from "next/link";
import type { Metadata } from "next";
import { CmsPageRenderer } from "@git-native-cms/react";
import { sandboxRegistry } from "../cms.registry";
import { loadPublishedPage, loadPublishedSite } from "../public-content";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const page = await loadPublishedPage();
  const origin = process.env.CMS_ORIGIN ?? "https://git-native-cms-next.vercel.app";
  return {
    title: page.seo?.title ?? page.title,
    description: page.seo?.description ?? page.description,
    alternates: {
      canonical: origin,
      languages: {
        "en-US": `${origin}/en-US`,
        "pl-PL": `${origin}/pl-PL`,
        "x-default": origin,
      },
    },
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export default async function HomePage() {
  const { page: document, content } = await loadPublishedSite();
  const navigation = content.find((item) => item.type === "navigation");
  const navigationItems = Array.isArray(navigation?.data.items) ? navigation.data.items : [];
  return (
    <main className="site-shell">
      <nav className="site-nav">
        <Link href="/">Fieldnotes</Link>
        <div className="site-nav__links">
          {navigationItems.map((item) => {
            const value = item as Readonly<Record<string, unknown>>;
            return (
              <Link key={text(value.id, text(value.href, "/"))} href={text(value.href, "/")}>
                {text(value.label, "Link")}
              </Link>
            );
          })}
          <Link className="site-nav__cms" href="/cms">
            Open CMS
          </Link>
        </div>
      </nav>
      <CmsPageRenderer document={document} registry={sandboxRegistry} content={content} />
    </main>
  );
}
