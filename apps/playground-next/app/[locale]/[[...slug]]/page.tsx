import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { CmsPageRenderer } from "@git-native-cms/react";
import { sandboxRegistry } from "../../../cms.registry";
import {
  loadPublishedPage,
  loadPublishedRedirect,
  loadPublishedSite,
} from "../../../public-content";

export const dynamic = "force-dynamic";

const locales = new Set(["en-US", "pl-PL"]);

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export async function generateMetadata(props: {
  readonly params: Promise<{ readonly locale: string; readonly slug?: readonly string[] }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  if (!locales.has(locale)) return {};
  const page = await loadPublishedPage(locale);
  const origin = process.env.CMS_ORIGIN ?? "https://git-native-cms-next.vercel.app";
  return {
    title: page.seo?.title ?? page.title,
    description: page.seo?.description ?? page.description,
    alternates: {
      canonical: `${origin}/${locale}`,
      languages: {
        "en-US": `${origin}/en-US`,
        "pl-PL": `${origin}/pl-PL`,
        "x-default": origin,
      },
    },
  };
}

export default async function LocalizedPage(props: {
  readonly params: Promise<{ readonly locale: string; readonly slug?: readonly string[] }>;
}) {
  const { locale, slug } = await props.params;
  if (!locales.has(locale)) notFound();
  if ((slug?.length ?? 0) > 0) {
    const target = await loadPublishedRedirect(`/${slug?.join("/")}`);
    if (target !== undefined) redirect(`/${locale}${target === "/" ? "" : target}`);
    notFound();
  }
  const { page: document, content } = await loadPublishedSite(locale);
  const navigation = content.find((item) => item.type === "navigation");
  const navigationItems = Array.isArray(navigation?.data.items) ? navigation.data.items : [];
  return (
    <main className="site-shell" lang={locale}>
      <nav className="site-nav">
        <Link href={`/${locale}`}>Fieldnotes</Link>
        <div className="site-nav__links">
          {navigationItems.map((item) => {
            const value = item as Readonly<Record<string, unknown>>;
            return (
              <Link key={text(value.id, text(value.href, "/"))} href={text(value.href, "/")}>
                {text(value.label, "Link")}
              </Link>
            );
          })}
          <Link href={locale === "pl-PL" ? "/en-US" : "/pl-PL"}>
            {locale === "pl-PL" ? "English" : "Polski"}
          </Link>
          <Link className="site-nav__cms" href="/cms">
            Open CMS
          </Link>
        </div>
      </nav>
      <CmsPageRenderer document={document} registry={sandboxRegistry} content={content} />
    </main>
  );
}
