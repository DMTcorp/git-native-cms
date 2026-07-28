import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ContentSource } from "./index.js";
import type { ReleaseId } from "@git-native-cms/core";

function within(root: string, path: string): string {
  const target = resolve(root, path);
  const difference = relative(root, target);
  if (
    difference === ".." ||
    difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(difference) === difference
  ) {
    throw new Error(`Delivery path "${path}" escapes the configured release directory.`);
  }
  return target;
}

export function filesystemSource(input: { readonly root: string }): ContentSource {
  const root = resolve(input.root);
  return {
    async readPointer(environment) {
      const source = await readFile(
        within(root, `environments/${environment}/current.json`),
        "utf8",
      );
      const value = JSON.parse(source) as { readonly releaseId?: unknown };
      if (typeof value.releaseId !== "string" || !value.releaseId.startsWith("rel_")) {
        throw new Error(`The ${environment} filesystem pointer is invalid.`);
      }
      return { releaseId: value.releaseId as ReleaseId };
    },
    readFile(releaseId, path) {
      return readFile(within(root, `releases/${releaseId}/${path}`), "utf8");
    },
  };
}
