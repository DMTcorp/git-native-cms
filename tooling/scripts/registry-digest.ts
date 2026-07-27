import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/content-codecs/src/index.js";

interface RegistryLike {
  readonly sections: ReadonlyMap<
    string,
    { readonly definition: Readonly<Record<string, unknown>> }
  >;
}

function isRegistry(value: unknown): value is RegistryLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "sections" in value &&
    value.sections instanceof Map
  );
}

const modulePath = process.argv[2];
if (modulePath === undefined) {
  throw new Error("Usage: pnpm registry:digest <registry-module.tsx>");
}
const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as Readonly<
  Record<string, unknown>
>;
const registry = Object.values(loaded).find(isRegistry);
if (registry === undefined) {
  throw new Error("The module does not export a React CMS registry.");
}
const definitions = [...registry.sections.values()]
  .map(({ definition }) => definition)
  .sort((left, right) => String(left.name).localeCompare(String(right.name)));
const bytes = new TextEncoder().encode(canonicalJson(definitions));
const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
process.stdout.write(
  `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}\n`,
);
