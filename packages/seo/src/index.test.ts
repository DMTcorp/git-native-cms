import { describe, expect, it } from "vitest";
import { buildHreflang, buildSitemap, proposedSlugRedirect, validateRedirects } from "./index.js";

describe("SEO graph", () => {
  it("builds localized alternates, sitemap entries, and slug redirects", () => {
    const hreflang = buildHreflang({
      baseUrl: "https://example.test",
      routes: { "en-US": "/pricing", "pl-PL": "/pl/cennik" },
      defaultLocale: "en-US",
    });
    expect(hreflang["pl-PL"]).toBe("https://example.test/pl/cennik");
    expect(buildSitemap([{ canonical: hreflang["en-US"] ?? "", hreflang }])).toContain(
      'hreflang="pl-PL"',
    );
    expect(proposedSlugRedirect("/plans", "/pricing")).toEqual({ "/plans": "/pricing" });
  });

  it("detects redirect loops", () => {
    expect(validateRedirects({ "/a": "/b", "/b": "/a" })).toContainEqual(
      expect.objectContaining({ code: "SEO_REDIRECT_LOOP" }),
    );
  });
});
