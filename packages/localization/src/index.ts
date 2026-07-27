export type TranslationStatus =
  "missing" | "machine_translated" | "translated" | "reviewed" | "approved" | "outdated";

export interface LocaleDefinition {
  readonly code: string;
  readonly language: string;
  readonly market?: string;
  readonly fallback?: string;
}

export interface LocalizedDocument<TFields extends Record<string, unknown>> {
  readonly locale: string;
  readonly fields: Partial<TFields>;
  readonly status: TranslationStatus;
  readonly sourceRevision?: string;
}

export function localeFallbackChain(
  locale: string,
  definitions: readonly LocaleDefinition[],
): readonly string[] {
  const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
  const chain: string[] = [];
  let current: string | undefined = locale;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = byCode.get(current)?.fallback;
  }
  return chain;
}

export function resolveLocalizedFields<TFields extends Record<string, unknown>>(
  locale: string,
  definitions: readonly LocaleDefinition[],
  documents: readonly LocalizedDocument<TFields>[],
  source: TFields,
): TFields {
  const byLocale = new Map(documents.map((document) => [document.locale, document]));
  return [...localeFallbackChain(locale, definitions)]
    .reverse()
    .reduce<TFields>(
      (fields, code) => ({ ...fields, ...byLocale.get(code)?.fields }),
      structuredClone(source),
    );
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function exportXliff(input: {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly units: readonly {
    readonly id: string;
    readonly source: string;
    readonly target?: string;
  }[];
}): string {
  const units = input.units
    .map(
      (unit) =>
        `    <unit id="${xmlEscape(unit.id)}"><segment><source>${xmlEscape(unit.source)}</source>${
          unit.target === undefined ? "" : `<target>${xmlEscape(unit.target)}</target>`
        }</segment></unit>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="2.1" srcLang="${xmlEscape(
    input.sourceLocale,
  )}" trgLang="${xmlEscape(input.targetLocale)}">\n  <file id="content">\n${units}\n  </file>\n</xliff>\n`;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function importXliff(
  source: string,
  maximumBytes = 5 * 1024 * 1024,
): readonly { readonly id: string; readonly source: string; readonly target?: string }[] {
  if (new TextEncoder().encode(source).byteLength > maximumBytes) {
    throw new Error("XLIFF exceeds the configured size limit.");
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    throw new Error("XLIFF document types and entities are not allowed.");
  }
  const units: { id: string; source: string; target?: string }[] = [];
  const pattern =
    /<unit\s+id="([^"]+)"[^>]*>\s*<segment[^>]*>\s*<source>([\s\S]*?)<\/source>(?:\s*<target>([\s\S]*?)<\/target>)?\s*<\/segment>\s*<\/unit>/giu;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const sourceText = match[2];
    if (id === undefined || sourceText === undefined) continue;
    units.push({
      id: xmlUnescape(id),
      source: xmlUnescape(sourceText),
      ...(match[3] === undefined ? {} : { target: xmlUnescape(match[3]) }),
    });
  }
  return units;
}

export function translationStatus(input: {
  readonly sourceRevision: string;
  readonly translatedFromRevision?: string;
  readonly reviewed?: boolean;
  readonly approved?: boolean;
}): TranslationStatus {
  if (input.translatedFromRevision === undefined) return "missing";
  if (input.translatedFromRevision !== input.sourceRevision) return "outdated";
  if (input.approved === true) return "approved";
  if (input.reviewed === true) return "reviewed";
  return "translated";
}
