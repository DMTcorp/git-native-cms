import { parseDocument, stringify as stringifyYaml } from "yaml";

export interface ContentCodec {
  readonly extension: string;
  parse(source: string): unknown;
  serialize(value: unknown): string;
}

export interface ContentSourceLocation {
  readonly line: number;
  readonly column: number;
  readonly offset?: number;
}

export interface ContentDiagnostic {
  readonly message: string;
  readonly location?: ContentSourceLocation;
}

const PROTECTED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

export function assertSafeContent(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (depth > 64 || nodes > 100_000) {
      throw new Error("Content exceeds the configured structural complexity limit.");
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Content numbers must be finite.");
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof current !== "object") {
      throw new Error("Content must contain only JSON-compatible values.");
    }
    const prototype = Object.getPrototypeOf(current) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Content contains an unsupported object type.");
    }
    for (const [key, child] of Object.entries(current as Readonly<Record<string, unknown>>)) {
      if (PROTECTED_KEYS.has(key)) {
        throw new Error(`Content contains the protected key "${key}".`);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function assertSourceSize(source: string): void {
  if (new TextEncoder().encode(source).byteLength > MAX_CONTENT_BYTES) {
    throw new Error("Content source exceeds the 4 MiB limit.");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  assertSafeContent(value);
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export const jsonCodec: ContentCodec = {
  extension: ".json",
  parse(source) {
    assertSourceSize(source);
    const value = JSON.parse(source) as unknown;
    assertSafeContent(value);
    return value;
  },
  serialize: canonicalJson,
};

export const yamlCodec: ContentCodec = {
  extension: ".yaml",
  parse(source) {
    assertSourceSize(source);
    const document = parseDocument(source, {
      prettyErrors: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw document.errors[0];
    const value = document.toJS({ maxAliasCount: 50 }) as unknown;
    assertSafeContent(value);
    return value;
  },
  serialize(value) {
    assertSafeContent(value);
    return stringifyYaml(value, {
      indent: 2,
      lineWidth: 100,
      sortMapEntries: (left, right) => String(left.key).localeCompare(String(right.key)),
    });
  },
};

export interface MarkdownDocument {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export const markdownCodec: ContentCodec = {
  extension: ".md",
  parse(source): MarkdownDocument {
    assertSourceSize(source);
    if (!source.startsWith("---\n")) return { frontmatter: {}, body: source };
    const end = source.indexOf("\n---\n", 4);
    if (end < 0) throw new Error("Markdown frontmatter is not closed.");
    const frontmatter = yamlCodec.parse(source.slice(4, end));
    if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
      throw new Error("Markdown frontmatter must be an object.");
    }
    return {
      frontmatter: frontmatter as Readonly<Record<string, unknown>>,
      body: source.slice(end + 5),
    };
  },
  serialize(value): string {
    const document = value as MarkdownDocument;
    return `---\n${yamlCodec.serialize(document.frontmatter)}---\n${document.body}`;
  },
};

export function codecForPath(path: string): ContentCodec {
  if (path.endsWith(".json")) return jsonCodec;
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return yamlCodec;
  if (path.endsWith(".md") || path.endsWith(".mdx")) return markdownCodec;
  throw new Error(`No content codec is registered for ${path}.`);
}

function offsetLocation(source: string, offset: number): ContentSourceLocation {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    offset,
  };
}

function errorLocation(error: unknown, source: string): ContentSourceLocation | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("linePos" in error && Array.isArray(error.linePos)) {
    const position = error.linePos[0] as
      { readonly line?: unknown; readonly col?: unknown } | undefined;
    if (typeof position?.line === "number" && typeof position.col === "number") {
      return { line: position.line, column: position.col };
    }
  }
  if (error instanceof SyntaxError) {
    const match = /position\s+(\d+)/iu.exec(error.message);
    if (match?.[1] !== undefined) return offsetLocation(source, Number(match[1]));
  }
  return undefined;
}

export function parseContentWithDiagnostics(
  path: string,
  source: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly diagnostics: readonly ContentDiagnostic[] } {
  try {
    return { ok: true, value: codecForPath(path).parse(source) };
  } catch (error) {
    const location = errorLocation(error, source);
    return {
      ok: false,
      diagnostics: [
        {
          message: error instanceof Error ? error.message : "Content parsing failed.",
          ...(location === undefined ? {} : { location }),
        },
      ],
    };
  }
}

export function serializeContent(
  path: string,
  value: unknown,
  options: {
    readonly mode?: "canonical" | "preserve";
    readonly originalSource?: string;
  } = {},
): string {
  if (options.mode === "preserve" && options.originalSource !== undefined) {
    const original = parseContentWithDiagnostics(path, options.originalSource);
    if (
      original.ok &&
      JSON.stringify(canonicalize(original.value)) === JSON.stringify(canonicalize(value))
    ) {
      return options.originalSource;
    }
  }
  return codecForPath(path).serialize(value);
}
