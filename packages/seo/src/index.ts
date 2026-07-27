export interface SeoMetadata {
  readonly title?: string;
  readonly titleTemplate?: string;
  readonly description?: string;
  readonly canonical?: string;
  readonly robots?: { readonly index?: boolean; readonly follow?: boolean };
  readonly socialImage?: string;
  readonly structuredData?: unknown;
  readonly hreflang?: Readonly<Record<string, string>>;
  readonly sitemap?: boolean;
}

export interface SeoDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path: string;
}

export function resolveSeo(...layers: readonly (SeoMetadata | undefined)[]): SeoMetadata {
  let resolved: SeoMetadata = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    const robots =
      resolved.robots === undefined && layer.robots === undefined
        ? undefined
        : { ...resolved.robots, ...layer.robots };
    const hreflang =
      resolved.hreflang === undefined && layer.hreflang === undefined
        ? undefined
        : { ...resolved.hreflang, ...layer.hreflang };
    resolved = {
      ...resolved,
      ...layer,
      ...(robots === undefined ? {} : { robots }),
      ...(hreflang === undefined ? {} : { hreflang }),
    };
  }
  return resolved;
}

export function renderTitle(metadata: SeoMetadata, siteName?: string): string | undefined {
  if (metadata.title === undefined) return undefined;
  return (
    metadata.titleTemplate?.replace("%s", metadata.title).replace("%site%", siteName ?? "") ??
    metadata.title
  );
}

export function auditSeo(
  entries: readonly { readonly path: string; readonly metadata: SeoMetadata }[],
): readonly SeoDiagnostic[] {
  const diagnostics: SeoDiagnostic[] = [];
  const titlePaths = new Map<string, string[]>();
  for (const entry of entries) {
    const title = entry.metadata.title?.trim();
    if (title === undefined || title.length === 0) {
      diagnostics.push({
        code: "SEO_MISSING_TITLE",
        severity: "error",
        message: "Add a page title.",
        path: entry.path,
      });
    } else {
      const paths = titlePaths.get(title.toLowerCase()) ?? [];
      paths.push(entry.path);
      titlePaths.set(title.toLowerCase(), paths);
      if (title.length > 65) {
        diagnostics.push({
          code: "SEO_LONG_TITLE",
          severity: "warning",
          message: "Keep the page title at 65 characters or fewer.",
          path: entry.path,
        });
      }
    }
    if (entry.metadata.description !== undefined && entry.metadata.description.length > 170) {
      diagnostics.push({
        code: "SEO_LONG_DESCRIPTION",
        severity: "warning",
        message: "Keep the description at 170 characters or fewer.",
        path: entry.path,
      });
    }
    if (entry.metadata.robots?.index === false && entry.metadata.sitemap === true) {
      diagnostics.push({
        code: "SEO_NOINDEX_SITEMAP",
        severity: "error",
        message: "A noindex page cannot be included in the sitemap.",
        path: entry.path,
      });
    }
  }
  for (const paths of titlePaths.values()) {
    if (paths.length > 1) {
      for (const path of paths) {
        diagnostics.push({
          code: "SEO_DUPLICATE_TITLE",
          severity: "warning",
          message: `This title is also used on ${paths.filter((item) => item !== path).join(", ")}.`,
          path,
        });
      }
    }
  }
  return diagnostics;
}

export function proposedSlugRedirect(
  previousPath: string,
  nextPath: string,
): Record<string, string> {
  return previousPath === nextPath ? {} : { [previousPath]: nextPath };
}

export function validateRedirects(
  redirects: Readonly<Record<string, string>>,
): readonly SeoDiagnostic[] {
  const diagnostics: SeoDiagnostic[] = [];
  for (const source of Object.keys(redirects)) {
    const visited = new Set<string>();
    let current: string | undefined = source;
    while (current !== undefined) {
      if (visited.has(current)) {
        diagnostics.push({
          code: "SEO_REDIRECT_LOOP",
          severity: "error",
          message: `Redirect loop detected from ${source}.`,
          path: source,
        });
        break;
      }
      visited.add(current);
      current = redirects[current];
    }
    if (visited.size > 3) {
      diagnostics.push({
        code: "SEO_REDIRECT_CHAIN",
        severity: "warning",
        message: `Redirect ${source} has ${visited.size - 1} hops.`,
        path: source,
      });
    }
  }
  return diagnostics;
}

export function buildHreflang(input: {
  readonly baseUrl: string;
  readonly routes: Readonly<Record<string, string>>;
  readonly defaultLocale?: string;
}): Readonly<Record<string, string>> {
  const baseUrl = input.baseUrl.replace(/\/$/u, "");
  const entries = Object.entries(input.routes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([locale, path]) => [locale, `${baseUrl}/${path.replace(/^\//u, "")}`] as const);
  const result: Record<string, string> = Object.fromEntries(entries);
  const defaultPath =
    input.defaultLocale === undefined ? undefined : input.routes[input.defaultLocale];
  if (defaultPath !== undefined) {
    result["x-default"] = `${baseUrl}/${defaultPath.replace(/^\//u, "")}`;
  }
  return result;
}

function sitemapEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildSitemap(
  pages: readonly {
    readonly canonical: string;
    readonly lastModified?: string;
    readonly hreflang?: Readonly<Record<string, string>>;
    readonly include?: boolean;
  }[],
): string {
  const urls = [...pages]
    .filter((page) => page.include !== false)
    .sort((left, right) => left.canonical.localeCompare(right.canonical))
    .map((page) => {
      const alternates = Object.entries(page.hreflang ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([locale, href]) =>
            `    <xhtml:link rel="alternate" hreflang="${sitemapEscape(locale)}" href="${sitemapEscape(href)}"/>`,
        );
      return [
        "  <url>",
        `    <loc>${sitemapEscape(page.canonical)}</loc>`,
        ...(page.lastModified === undefined
          ? []
          : [`    <lastmod>${sitemapEscape(page.lastModified)}</lastmod>`]),
        ...alternates,
        "  </url>",
      ].join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}
