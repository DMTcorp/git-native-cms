import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { CmsPreviewProvider, useCmsInlineField, useCmsSection } from "./preview.js";

function Probe(): ReactElement {
  const section = useCmsSection("sec_hero");
  const field = useCmsInlineField("sec_hero", "heading");
  return (
    <output data-selected={section.selected} data-editable={field.editable} {...field.attributes} />
  );
}

describe("React preview hooks", () => {
  it("exposes selection and inline-field instrumentation through a scoped provider", () => {
    const html = renderToStaticMarkup(
      <CmsPreviewProvider
        value={{
          preview: true,
          selectedSectionId: "sec_hero",
          updateInlineField: () => undefined,
        }}
      >
        <Probe />
      </CmsPreviewProvider>,
    );
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('data-editable="true"');
    expect(html).toContain('data-cms-inline-field="heading"');
  });
});
