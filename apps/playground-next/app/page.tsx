import Link from "next/link";
import { CmsPageRenderer } from "@git-native-cms/react";
import { sandboxRegistry } from "../cms.registry";
import { loadPublishedPage } from "../public-content";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const document = await loadPublishedPage();
  return (
    <main className="site-shell">
      <nav className="site-nav">
        <Link href="/">Fieldnotes</Link>
        <div className="site-nav__links">
          <Link href="#journal">Journal</Link>
          <Link className="site-nav__cms" href="/cms">
            Open CMS
          </Link>
        </div>
      </nav>
      <CmsPageRenderer document={document} registry={sandboxRegistry} />
    </main>
  );
}
