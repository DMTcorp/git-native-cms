import { parseDocument, stringify as stringifyYaml } from "yaml";

export interface ContentCodec {
  readonly extension: string;
  parse(source: string): unknown;
  serialize(value: unknown): string;
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
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export const jsonCodec: ContentCodec = {
  extension: ".json",
  parse: (source) => JSON.parse(source) as unknown,
  serialize: canonicalJson,
};

export const yamlCodec: ContentCodec = {
  extension: ".yaml",
  parse(source) {
    const document = parseDocument(source, {
      prettyErrors: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS({ maxAliasCount: 50 }) as unknown;
  },
  serialize(value) {
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
