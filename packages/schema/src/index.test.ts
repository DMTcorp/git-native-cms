import { describe, expect, it } from "vitest";
import {
  compileEditorManifest,
  compileJsonSchema,
  compileTypes,
  defineSection,
  fields,
} from "./index.js";

const hero = defineSection({
  name: "hero",
  version: 1,
  label: "Hero",
  category: "Introductions",
  fields: {
    heading: fields.text({ required: true, localized: true, inline: true, maxLength: 90 }),
    variant: fields.select({
      options: [
        { value: "split", label: "Split" },
        { value: "centered", label: "Centered" },
      ],
    }),
  },
});

describe("schema compiler", () => {
  it("compiles stable JSON Schema and editor order", () => {
    expect(compileJsonSchema(hero)).toMatchObject({
      $id: "cms://section/hero/v1",
      required: ["heading"],
      properties: {
        heading: { type: "string", maxLength: 90 },
        variant: { enum: ["split", "centered"] },
      },
    });
    expect(compileEditorManifest(hero).fields.map((field) => field.name)).toEqual([
      "heading",
      "variant",
    ]);
  });

  it("compiles explicit TypeScript without filesystem access", () => {
    expect(compileTypes(hero)).toContain('readonly "heading": string;');
  });

  it("rejects unstable schema identifiers", () => {
    expect(() =>
      defineSection({ name: "Hero section", version: 1, label: "Hero", fields: {} }),
    ).toThrow(/stable identifier/);
  });
});
