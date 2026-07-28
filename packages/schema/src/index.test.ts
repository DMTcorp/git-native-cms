import { describe, expect, it } from "vitest";
import {
  compileEditorManifest,
  compileJsonSchema,
  compileMcpDescription,
  compileMigrationMetadata,
  compileStableAst,
  compileTypes,
  compileValidator,
  defineSection,
  defineTemplate,
  defineWorkflow,
  fields,
  fromZod,
} from "./index.js";

const hero = defineSection({
  name: "hero",
  version: 1,
  label: "Hero",
  category: "Introductions",
  fields: {
    heading: fields.text({ required: true, localized: true, inline: true, maxLength: 90 }),
    media: fields.asset({ accept: ["image/*"], aspectRatio: [16, 9] }),
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
        media: {
          type: "object",
          required: ["id", "fileName", "mimeType", "url"],
          properties: {
            id: { pattern: "^ast_[0-9A-Za-z]+$" },
            altText: { type: "string" },
          },
        },
        variant: { enum: ["split", "centered"] },
      },
    });
    expect(compileEditorManifest(hero).fields.map((field) => field.name)).toEqual([
      "heading",
      "media",
      "variant",
    ]);
  });

  it("compiles explicit TypeScript without filesystem access", () => {
    expect(compileTypes(hero)).toContain('readonly "heading": string;');
    expect(compileTypes(hero)).toContain(
      'readonly "media"?: { readonly id: string; readonly fileName: string;',
    );
  });

  it("rejects unstable schema identifiers", () => {
    expect(() =>
      defineSection({ name: "Hero section", version: 1, label: "Hero", fields: {} }),
    ).toThrow(/stable identifier/);
  });

  it("compiles runtime validation, MCP descriptions and migration metadata", () => {
    const versionedHero = defineSection({
      name: "versionedHero",
      version: 2,
      label: "Versioned hero",
      description: "A migrated section.",
      fields: {
        heading: fields.text({ required: true, maxLength: 10 }),
      },
      migrations: [{ from: 1, to: 2, description: "Add the heading field." }],
    });
    const validator = compileValidator<{ readonly heading: string }>(versionedHero);
    expect(validator.validate({ heading: "Short" })).toEqual({
      valid: true,
      value: { heading: "Short" },
    });
    expect(validator.validate({ heading: "This heading is too long" })).toMatchObject({
      valid: false,
      issues: [{ path: "/heading", keyword: "maxLength" }],
    });
    expect(compileMcpDescription(versionedHero)).toMatchObject({
      name: "section_versionedHero",
      title: "Versioned hero",
      description: "A migrated section.",
    });
    expect(compileMigrationMetadata(versionedHero)).toEqual({
      schema: "section/versionedHero",
      currentVersion: 2,
      chain: [{ from: 1, to: 2, description: "Add the heading field." }],
    });
  });

  it("defines deterministic templates and permissioned workflows", () => {
    const template = defineTemplate({
      name: "campaign",
      version: 1,
      label: "Campaign",
      pageType: "landingPage",
      sections: [
        { id: "hero", type: "hero", values: { heading: "Launch" } },
        { id: "proof", type: "proof" },
      ],
    });
    const workflow = defineWorkflow({
      name: "editorial",
      version: 1,
      label: "Editorial",
      initialState: "draft",
      states: [
        { id: "draft", label: "Draft" },
        { id: "live", label: "Live", terminal: true },
      ],
      transitions: [
        {
          from: "draft",
          to: "live",
          permission: "staging.publish",
          confirmation: true,
        },
      ],
    });
    expect(compileStableAst(template)).toEqual(compileStableAst(structuredClone(template)));
    expect(compileStableAst(workflow)).toMatchObject({
      kind: "workflow",
      initialState: "draft",
    });
    expect(() =>
      defineTemplate({
        name: "duplicate",
        version: 1,
        label: "Duplicate",
        pageType: "page",
        sections: [
          { id: "hero", type: "hero" },
          { id: "hero", type: "proof" },
        ],
      }),
    ).toThrow(/duplicate section ID/);
  });

  it("keeps Zod optional through a narrow safeParse adapter", () => {
    const validator = fromZod<string>({
      safeParse: (value) =>
        typeof value === "string"
          ? { success: true, data: value }
          : { success: false, error: new Error("Expected a string.") },
    });
    expect(validator.validate("content")).toEqual({ valid: true, value: "content" });
    expect(validator.validate(42)).toMatchObject({
      valid: false,
      issues: [{ keyword: "zod", message: "Expected a string." }],
    });
  });
});
