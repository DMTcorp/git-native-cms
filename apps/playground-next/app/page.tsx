import Link from "next/link";

export default function HomePage() {
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
      <section className="hero">
        <div>
          <span className="hero__eyebrow">A Git-native publication</span>
          <h1>Editorial work, without the machinery showing.</h1>
          <p>
            Build pages with real frontend components, review every Change and publish one immutable
            version at a time.
          </p>
        </div>
        <aside className="hero__proof" aria-label="Publication workflow">
          <span>Current proof</span>
          <ol>
            <li>Change prepared</li>
            <li>Review complete</li>
            <li>Ready for staging</li>
          </ol>
        </aside>
      </section>
      <section className="site-section" id="journal">
        <span className="hero__eyebrow">From the journal</span>
        <h2>The public site contains no editor runtime.</h2>
      </section>
    </main>
  );
}
