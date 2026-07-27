import type { Actor, Change, GitCommitSha } from "@git-native-cms/core";

export function slugifyBranchPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildChangeBranchName(input: {
  readonly actor: Actor;
  readonly name: string;
  readonly suffix: string;
  readonly emergency?: boolean;
}): string {
  const namespace = input.emergency === true ? "hotfix" : "cms";
  return `${namespace}/${slugifyBranchPart(input.actor.login)}/${slugifyBranchPart(input.name)}-${slugifyBranchPart(input.suffix)}`;
}

export function changeCommitMessage(change: Change, summary: string): string {
  return `${summary}\n\nChange-ID: ${change.id}\nCMS-Actor: ${change.ownerId}`;
}

export interface SemanticFileDiff {
  readonly path: string;
  readonly status: "created" | "updated" | "deleted";
  readonly beforeSha?: GitCommitSha;
  readonly afterSha?: GitCommitSha;
}

export function normalizeGitRef(ref: string): string {
  const normalized = ref.replace(/^refs\/heads\//, "");
  if (
    normalized.length === 0 ||
    normalized.includes("..") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    /[\s~^:?*[\\]/.test(normalized)
  ) {
    throw new Error(`Invalid Git ref "${ref}".`);
  }
  return normalized;
}
