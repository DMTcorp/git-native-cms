import { CmsError, type ActorId, type Revision } from "@git-native-cms/core";

export type ContentPath = string & { readonly __brand: "ContentPath" };

export interface PatchMetadata {
  readonly id: string;
  readonly actorId: ActorId;
  readonly createdAt: string;
  readonly source: "editor" | "inline" | "mcp" | "migration" | "import";
  readonly description?: string;
}

export type PatchOperation =
  | { readonly op: "set"; readonly path: ContentPath; readonly value: unknown }
  | { readonly op: "unset"; readonly path: ContentPath }
  | {
      readonly op: "insert";
      readonly path: ContentPath;
      readonly index: number;
      readonly value: unknown;
    }
  | { readonly op: "remove"; readonly path: ContentPath; readonly index?: number }
  | { readonly op: "move"; readonly path: ContentPath; readonly from: number; readonly to: number }
  | {
      readonly op: "replace-reference";
      readonly path: ContentPath;
      readonly ref: { readonly collection: string; readonly id: string };
    };

export type ContentPatch = PatchOperation & { readonly metadata: PatchMetadata };

export function contentPath(value: string): ContentPath {
  if (value !== "" && !value.startsWith("/")) {
    throw new CmsError({
      code: "CMS_DOCUMENT_001",
      message: `Content path "${value}" is not an RFC 6901 pointer.`,
      category: "validation",
      retryable: false,
    });
  }
  if (/~(?![01])/u.test(value)) {
    throw new CmsError({
      code: "CMS_DOCUMENT_001",
      message: `Content path "${value}" contains an invalid RFC 6901 escape.`,
      category: "validation",
      retryable: false,
    });
  }
  const unsafe = value
    .split("/")
    .slice(1)
    .map(decodeSegment)
    .find((segment) => ["__proto__", "prototype", "constructor"].includes(segment));
  if (unsafe !== undefined) {
    throw new CmsError({
      code: "CMS_DOCUMENT_006",
      message: `Content path "${value}" targets a protected object key.`,
      category: "validation",
      retryable: false,
    });
  }
  return value as ContentPath;
}

function decodeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function encodeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function joinContentPath(...segments: readonly (string | number)[]): ContentPath {
  return contentPath(`/${segments.map((segment) => encodeSegment(String(segment))).join("/")}`);
}

export function parseContentPath(path: ContentPath): readonly string[] {
  if (path === "") return [];
  return path.slice(1).split("/").map(decodeSegment);
}

type MutableContainer = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is MutableContainer {
  return typeof value === "object" && value !== null;
}

function arrayIndex(segment: string, length: number, allowEnd = false): number {
  if (!/^(0|[1-9]\d*)$/u.test(segment)) {
    throw new CmsError({
      code: "CMS_DOCUMENT_007",
      message: `Array index "${segment}" is invalid.`,
      category: "validation",
      retryable: false,
    });
  }
  const index = Number(segment);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > length ||
    (!allowEnd && index >= length)
  ) {
    throw new CmsError({
      code: "CMS_DOCUMENT_008",
      message: `Array index ${segment} is outside the target list.`,
      category: "validation",
      retryable: false,
    });
  }
  return index;
}

function getAtPath(root: unknown, path: ContentPath): unknown {
  let current = root;
  for (const segment of parseContentPath(path)) {
    if (!isContainer(current)) return undefined;
    current = Array.isArray(current)
      ? current[arrayIndex(segment, current.length)]
      : current[segment];
  }
  return current;
}

function hasAtPath(root: unknown, path: ContentPath): boolean {
  const segments = parseContentPath(path);
  if (segments.length === 0) return true;
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (!isContainer(current)) return false;
    const key = Array.isArray(current) ? arrayIndex(segment, current.length) : segment;
    if (!(key in current)) return false;
    if (index < segments.length - 1) current = current[key as never];
  }
  return true;
}

function parentAtPath(
  root: unknown,
  path: ContentPath,
): {
  readonly parent: MutableContainer;
  readonly key: string;
} {
  const segments = parseContentPath(path);
  const key = segments.at(-1);
  if (key === undefined) {
    throw new CmsError({
      code: "CMS_DOCUMENT_002",
      message: "Root replacement is not a patch operation; replace the document revision instead.",
      category: "validation",
      retryable: false,
    });
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(current)) {
      throw new CmsError({
        code: "CMS_DOCUMENT_003",
        message: `Patch parent does not exist for ${path}.`,
        category: "validation",
        retryable: false,
      });
    }
    current = Array.isArray(current)
      ? current[arrayIndex(segment, current.length)]
      : current[segment];
  }
  if (!isContainer(current)) {
    throw new CmsError({
      code: "CMS_DOCUMENT_003",
      message: `Patch parent does not exist for ${path}.`,
      category: "validation",
      retryable: false,
    });
  }
  return { parent: current, key };
}

function arrayAtPath(root: unknown, path: ContentPath): unknown[] {
  const value = getAtPath(root, path);
  if (!Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_DOCUMENT_004",
      message: `Patch target ${path} is not a list.`,
      category: "validation",
      retryable: false,
    });
  }
  return value;
}

export function applyPatch<TDocument>(document: TDocument, patch: ContentPatch): TDocument {
  const next = structuredClone(document);
  switch (patch.op) {
    case "set": {
      const { parent, key } = parentAtPath(next, patch.path);
      if (Array.isArray(parent)) {
        parent[arrayIndex(key, parent.length)] = structuredClone(patch.value);
      } else parent[key] = structuredClone(patch.value);
      break;
    }
    case "unset": {
      const { parent, key } = parentAtPath(next, patch.path);
      if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length), 1);
      else delete parent[key];
      break;
    }
    case "insert": {
      {
        const list = arrayAtPath(next, patch.path);
        const index = arrayIndex(String(patch.index), list.length, true);
        list.splice(index, 0, structuredClone(patch.value));
      }
      break;
    }
    case "remove": {
      if (patch.index === undefined) {
        const { parent, key } = parentAtPath(next, patch.path);
        if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length), 1);
        else delete parent[key];
      } else {
        const list = arrayAtPath(next, patch.path);
        list.splice(arrayIndex(String(patch.index), list.length), 1);
      }
      break;
    }
    case "move": {
      const list = arrayAtPath(next, patch.path);
      const from = arrayIndex(String(patch.from), list.length);
      const [item] = list.splice(from, 1);
      const to = arrayIndex(String(patch.to), list.length, true);
      list.splice(to, 0, item);
      break;
    }
    case "replace-reference": {
      const { parent, key } = parentAtPath(next, patch.path);
      const reference = structuredClone(patch.ref);
      if (Array.isArray(parent)) parent[arrayIndex(key, parent.length)] = reference;
      else parent[key] = reference;
      break;
    }
  }
  return next;
}

export function applyPatches<TDocument>(
  document: TDocument,
  patches: readonly ContentPatch[],
): TDocument {
  return patches.reduce((current, patch) => applyPatch(current, patch), document);
}

function inverseMetadata(metadata: PatchMetadata): PatchMetadata {
  return {
    ...metadata,
    id: `inverse-${metadata.id}`,
    description: `Undo: ${metadata.description ?? metadata.id}`,
  };
}

export function invertPatch(document: unknown, patch: ContentPatch): ContentPatch {
  const metadata = inverseMetadata(patch.metadata);
  switch (patch.op) {
    case "set":
    case "replace-reference":
      return hasAtPath(document, patch.path)
        ? {
            op: "set",
            path: patch.path,
            value: structuredClone(getAtPath(document, patch.path)),
            metadata,
          }
        : { op: "unset", path: patch.path, metadata };
    case "unset":
      return {
        op: "set",
        path: patch.path,
        value: structuredClone(getAtPath(document, patch.path)),
        metadata,
      };
    case "insert":
      return { op: "remove", path: patch.path, index: patch.index, metadata };
    case "remove": {
      if (patch.index === undefined) {
        return {
          op: "set",
          path: patch.path,
          value: structuredClone(getAtPath(document, patch.path)),
          metadata,
        };
      }
      return {
        op: "insert",
        path: patch.path,
        index: patch.index,
        value: structuredClone(arrayAtPath(document, patch.path)[patch.index]),
        metadata,
      };
    }
    case "move":
      return { op: "move", path: patch.path, from: patch.to, to: patch.from, metadata };
  }
}

interface HistoryEntry {
  readonly patch: ContentPatch;
  readonly inverse: ContentPatch;
}

export interface DocumentState<TDocument> {
  readonly document: TDocument;
  readonly revision: Revision;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly dirtyPaths: ReadonlySet<ContentPath>;
}

export function createDocumentState<TDocument>(
  document: TDocument,
  revision: Revision,
): DocumentState<TDocument> {
  return {
    document: structuredClone(document),
    revision,
    past: [],
    future: [],
    dirtyPaths: new Set(),
  };
}

export function commitPatch<TDocument>(
  state: DocumentState<TDocument>,
  patch: ContentPatch,
): DocumentState<TDocument> {
  const inverse = invertPatch(state.document, patch);
  return {
    ...state,
    document: applyPatch(state.document, patch),
    past: [...state.past, { patch, inverse }],
    future: [],
    dirtyPaths: new Set([...state.dirtyPaths, patch.path]),
  };
}

export function undo<TDocument>(state: DocumentState<TDocument>): DocumentState<TDocument> {
  const entry = state.past.at(-1);
  if (entry === undefined) return state;
  return {
    ...state,
    document: applyPatch(state.document, entry.inverse),
    past: state.past.slice(0, -1),
    future: [entry, ...state.future],
  };
}

export function redo<TDocument>(state: DocumentState<TDocument>): DocumentState<TDocument> {
  const [entry, ...future] = state.future;
  if (entry === undefined) return state;
  return {
    ...state,
    document: applyPatch(state.document, entry.patch),
    past: [...state.past, entry],
    future,
  };
}

export function compactPatches(patches: readonly ContentPatch[]): readonly ContentPatch[] {
  const compacted: ContentPatch[] = [];
  for (const patch of patches) {
    const previous = compacted.at(-1);
    if (
      previous !== undefined &&
      previous.path === patch.path &&
      previous.op === "set" &&
      patch.op === "set"
    ) {
      compacted[compacted.length - 1] = patch;
    } else {
      compacted.push(patch);
    }
  }
  return compacted;
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => equal(leftRecord[key], rightRecord[key]));
}

interface ChangeAtPath {
  readonly path: ContentPath;
  readonly exists: boolean;
  readonly value: unknown;
}

function collectChanges(
  base: unknown,
  changed: unknown,
  segments: readonly string[] = [],
): ChangeAtPath[] {
  if (equal(base, changed)) return [];
  if (
    typeof base !== "object" ||
    base === null ||
    typeof changed !== "object" ||
    changed === null ||
    Array.isArray(base) ||
    Array.isArray(changed)
  ) {
    return [{ path: joinContentPath(...segments), exists: changed !== undefined, value: changed }];
  }
  const baseRecord = base as Record<string, unknown>;
  const changedRecord = changed as Record<string, unknown>;
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(changedRecord)]);
  return [...keys].flatMap((key) => {
    if (!(key in changedRecord)) {
      return [{ path: joinContentPath(...segments, key), exists: false, value: undefined }];
    }
    return collectChanges(baseRecord[key], changedRecord[key], [...segments, key]);
  });
}

export interface MergeConflict {
  readonly path: ContentPath;
  readonly base: unknown;
  readonly ours: unknown;
  readonly theirs: unknown;
}

export interface MergeResult<TDocument> {
  readonly document: TDocument;
  readonly conflicts: readonly MergeConflict[];
}

export function mergeDocuments<TDocument>(
  base: TDocument,
  ours: TDocument,
  theirs: TDocument,
): MergeResult<TDocument> {
  const oursChanges = collectChanges(base, ours);
  const theirsChanges = collectChanges(base, theirs);
  const oursByPath = new Map(oursChanges.map((change) => [change.path, change]));
  const conflicts: MergeConflict[] = [];
  let document = structuredClone(ours);

  for (const theirsChange of theirsChanges) {
    const oursChange = oursByPath.get(theirsChange.path);
    if (
      oursChange !== undefined &&
      (oursChange.exists !== theirsChange.exists || !equal(oursChange.value, theirsChange.value))
    ) {
      conflicts.push({
        path: theirsChange.path,
        base: getAtPath(base, theirsChange.path),
        ours: oursChange.value,
        theirs: theirsChange.value,
      });
      continue;
    }
    if (oursChange === undefined) {
      const metadata = {
        id: `merge-${theirsChange.path}`,
        actorId: "actor_merge" as ActorId,
        createdAt: new Date(0).toISOString(),
        source: "migration" as const,
      };
      document = applyPatch(
        document,
        theirsChange.exists
          ? {
              op: "set",
              path: theirsChange.path,
              value: theirsChange.value,
              metadata,
            }
          : { op: "unset", path: theirsChange.path, metadata },
      );
    }
  }
  return { document, conflicts };
}
