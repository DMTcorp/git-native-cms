import { describe, expect, it } from "vitest";
import { canonicalJson, markdownCodec, yamlCodec } from "./index.js";

describe("content codecs", () => {
  it("serializes JSON deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
    );
  });

  it("round trips canonical YAML", () => {
    const value = { type: "page", sections: [{ id: "hero", heading: "Hello" }] };
    expect(yamlCodec.parse(yamlCodec.serialize(value))).toEqual(value);
  });

  it("preserves markdown body", () => {
    const source = "---\ntitle: Hello\n---\n# Body\n";
    expect(markdownCodec.parse(source)).toEqual({
      frontmatter: { title: "Hello" },
      body: "# Body\n",
    });
  });
});
