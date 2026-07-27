export interface SearchDocument {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly path: string;
  readonly value: unknown;
}

export interface SearchHit {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly path: string;
  readonly score: number;
}

export interface SearchIndex {
  readonly documents: readonly SearchDocument[];
  readonly tokens: Readonly<Record<string, readonly number[]>>;
}

function tokenize(value: string): readonly string[] {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function searchableText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(searchableText).join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>)
      .map(searchableText)
      .join(" ");
  }
  return "";
}

export function buildSearchIndex(documents: readonly SearchDocument[]): SearchIndex {
  const tokens = new Map<string, Set<number>>();
  documents.forEach((document, index) => {
    const text = `${document.title} ${document.type} ${document.path} ${searchableText(document.value)}`;
    for (const token of new Set(tokenize(text))) {
      const matches = tokens.get(token) ?? new Set<number>();
      matches.add(index);
      tokens.set(token, matches);
    }
  });
  return {
    documents: structuredClone(documents),
    tokens: Object.fromEntries(
      [...tokens.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([token, matches]) => [token, [...matches]]),
    ),
  };
}

export function search(index: SearchIndex, query: string, limit = 20): readonly SearchHit[] {
  const scores = new Map<number, number>();
  for (const token of tokenize(query)) {
    for (const documentIndex of index.tokens[token] ?? []) {
      scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .flatMap(([documentIndex, score]) => {
      const document = index.documents[documentIndex];
      return document === undefined ? [] : [{ ...document, score }];
    });
}

export function findUsages(
  documents: readonly SearchDocument[],
  referenceId: string,
): readonly SearchHit[] {
  return documents
    .filter((document) => searchableText(document.value).split(/\s+/).includes(referenceId))
    .map((document) => ({ ...document, score: 1 }));
}
