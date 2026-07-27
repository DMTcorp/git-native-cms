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

function pointerSegments(pointer: string): readonly string[] {
  if (pointer === "" || !pointer.startsWith("/")) {
    throw new Error("Localized field keys must be RFC 6901 pointers.");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?![01])/u.test(segment)) throw new Error("Localized field pointer escape is invalid.");
      const value = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (["__proto__", "constructor", "prototype"].includes(value)) {
        throw new Error("Localized field pointer contains a protected segment.");
      }
      return value;
    });
}

function setLocalizedValue(target: unknown, pointer: string, value: unknown): void {
  const segments = pointerSegments(pointer);
  let current = target;
  for (const [index, segment] of segments.entries()) {
    if (typeof current !== "object" || current === null) return;
    const last = index === segments.length - 1;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length)
        return;
      if (last) current[arrayIndex] = structuredClone(value);
      else current = current[arrayIndex];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) return;
    if (last) record[segment] = structuredClone(value);
    else current = record[segment];
  }
}

export function materializeLocalizedValue<TValue>(
  source: TValue,
  locale: string,
  definitions: readonly LocaleDefinition[],
  documents: readonly LocalizedDocument<Record<string, unknown>>[],
): TValue {
  const localized = structuredClone(source);
  const byLocale = new Map(documents.map((document) => [document.locale, document]));
  for (const code of [...localeFallbackChain(locale, definitions)].reverse()) {
    for (const [pointer, value] of Object.entries(byLocale.get(code)?.fields ?? {})) {
      setLocalizedValue(localized, pointer, value);
    }
  }
  return localized;
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
