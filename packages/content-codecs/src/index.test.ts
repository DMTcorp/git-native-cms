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

  it("rejects alias bombs, protected keys, and excessive nesting", () => {
    expect(() => yamlCodec.parse("value: &a [x]\nbomb: [*a, *a, *a]\n")).not.toThrow();
    expect(() => yamlCodec.parse("__proto__: { polluted: true }\n")).toThrow(/protected key/i);
    expect(() =>
      yamlCodec.parse(
        `value: &a [x]\nbomb: [${Array.from({ length: 60 }, () => "*a").join(",")}]\n`,
      ),
    ).toThrow();

    let nested: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) nested = { child: nested };
    expect(() => canonicalJson(nested)).toThrow(/complexity/i);
  });
});
