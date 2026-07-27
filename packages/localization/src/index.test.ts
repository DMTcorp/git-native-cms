import { describe, expect, it } from "vitest";
import { exportXliff, importXliff, resolveLocalizedFields, translationStatus } from "./index.js";

describe("localization", () => {
  it("resolves pl-PL fields with en-US fallback and round-trips XLIFF", () => {
    expect(
      resolveLocalizedFields(
        "pl-PL",
        [
          { code: "en-US", language: "en" },
          { code: "pl-PL", language: "pl", fallback: "en-US" },
        ],
        [{ locale: "pl-PL", status: "translated", fields: { title: "Cennik" } }],
        { title: "Pricing", description: "Plans for every team" },
      ),
    ).toEqual({ title: "Cennik", description: "Plans for every team" });
    const xliff = exportXliff({
      sourceLocale: "en-US",
      targetLocale: "pl-PL",
      units: [{ id: "hero.title", source: "Build & publish", target: "Twórz i publikuj" }],
    });
    expect(importXliff(xliff)).toEqual([
      { id: "hero.title", source: "Build & publish", target: "Twórz i publikuj" },
    ]);
    expect(translationStatus({ sourceRevision: "2", translatedFromRevision: "1" })).toBe(
      "outdated",
    );
  });

  it("rejects XLIFF entity declarations", () => {
    expect(() =>
      importXliff("<!DOCTYPE xliff [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>"),
    ).toThrow(/not allowed/i);
  });
});
