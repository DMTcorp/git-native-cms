import { describe, expect, it } from "vitest";
import { richTextToPlainText, sanitizePortableRichText } from "./index.js";

describe("portable rich text", () => {
  it("removes executable nodes and unsafe link protocols", () => {
    const sanitized = sanitizePortableRichText({
      type: "root",
      children: [
        { type: "script", children: [{ type: "text", text: "alert(1)" }] },
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "javascript:alert(1)",
              children: [{ type: "text", text: "safe label" }],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(sanitized)).not.toContain("javascript:");
    expect(JSON.stringify(sanitized)).not.toContain('"script"');
    expect(richTextToPlainText(sanitized)).toBe("safe label");
  });
});
