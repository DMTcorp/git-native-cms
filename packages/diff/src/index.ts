import { joinContentPath, type ContentPath } from "@git-native-cms/document-model";

export interface SemanticChange {
  readonly path: ContentPath;
  readonly kind: "added" | "removed" | "changed";
  readonly before?: unknown;
  readonly after?: unknown;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function semanticDiff(
  before: unknown,
  after: unknown,
  segments: readonly string[] = [],
): readonly SemanticChange[] {
  if (equal(before, after)) return [];
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [
      {
        path: joinContentPath(...segments),
        kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      },
    ];
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
    semanticDiff(left[key], right[key], [...segments, key]),
  );
}

export function summarizeDiff(changes: readonly SemanticChange[]): string {
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return `${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`;
}

export interface VisualDiffResult {
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly ratio: number;
  readonly bounds?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export function visualDiff(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
  threshold = 16,
): VisualDiffResult {
  const expectedLength = width * height * 4;
  if (
    before.length !== expectedLength ||
    after.length !== expectedLength ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("Visual diff inputs must be equally sized RGBA buffers.");
  }
  let changedPixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      delta = Math.max(
        delta,
        Math.abs((before[offset + channel] ?? 0) - (after[offset + channel] ?? 0)),
      );
    }
    if (delta <= threshold) continue;
    changedPixels += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  const totalPixels = width * height;
  return {
    changedPixels,
    totalPixels,
    ratio: changedPixels / totalPixels,
    ...(changedPixels === 0 ? {} : { bounds: { left, top, right, bottom } }),
  };
}
