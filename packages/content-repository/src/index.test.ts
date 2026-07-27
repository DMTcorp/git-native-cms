import type { ContentDocument, DocumentId, Revision } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { contentFilePath } from "./index.js";

function document(slug: string): ContentDocument {
  return {
    id: "doc_test" as DocumentId,
    type: "pages",
    schemaVersion: 1,
    revision: "0123456789012345678901234567890123456789" as Revision,
    data: { slug },
  };
}

describe("content paths", () => {
  it("supports nested slugs without allowing traversal", () => {
    expect(contentFilePath(document("guides/getting-started"))).toBe(
      "content/pages/guides/getting-started/index.yaml",
    );
    expect(() => contentFilePath(document("../../secrets"))).toThrow(/unsafe/i);
    expect(() => contentFilePath(document("guides\\secrets"))).toThrow(/unsafe/i);
  });
});
