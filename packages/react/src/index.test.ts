import { describe, expect, it } from "vitest";
import { materializeSection, resolvePageSections } from "./index.js";

describe("content query materialization", () => {
  it("resolves collections, globals, and references for registered sections", () => {
    const documents = [
      { id: "plan_lite", type: "plans", data: { name: "Lite", price: 12, status: "active" } },
      { id: "plan_legacy", type: "plans", data: { name: "Legacy", status: "retired" } },
      {
        id: "global_navigation",
        type: "navigation",
        data: { items: [{ label: "Home", href: "/" }] },
      },
    ];
    const section = materializeSection(
      {
        id: "sec_pricing",
        type: "pricingGrid",
        version: 1,
        bindings: {
          plans: { collection: "plans", query: { status: "active" } },
          navigation: { global: "navigation" },
          featured: { id: "plan_lite" },
        },
      },
      documents,
    );
    expect(section.plans).toEqual([{ id: "plan_lite", name: "Lite", price: 12, status: "active" }]);
    expect(section.navigation).toEqual({ items: [{ label: "Home", href: "/" }] });
    expect(section.featured).toEqual({
      id: "plan_lite",
      name: "Lite",
      price: 12,
      status: "active",
    });
  });

  it("expands reusable blocks with instance overrides", () => {
    const sections = resolvePageSections(
      [
        {
          id: "sec_faq_reference",
          type: "reference",
          version: 1,
          ref: "reusable-blocks/pricing-faq",
          overrides: {
            sec_faq: { heading: "Pricing questions" },
          },
        },
      ],
      [
        {
          id: "block_pricing_faq",
          type: "reusable-blocks",
          data: {
            slug: "pricing-faq",
            sections: [
              {
                id: "sec_faq",
                type: "proof",
                version: 1,
                heading: "Frequently asked questions",
              },
            ],
          },
        },
      ],
    );
    expect(sections).toEqual([
      {
        id: "sec_faq_reference:sec_faq",
        type: "proof",
        version: 1,
        heading: "Pricing questions",
      },
    ]);
  });
});
