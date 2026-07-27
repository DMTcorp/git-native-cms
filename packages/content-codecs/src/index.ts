import { parseDocument, stringify as stringifyYaml } from "yaml";

export interface ContentCodec {
  readonly extension: string;
  parse(source: string): unknown;
  serialize(value: unknown): string;
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
