import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cmsVitestConfig } from "./tooling/vitest-config/index.mjs";

const packagesRoot = fileURLToPath(new URL("./packages/", import.meta.url));

export default defineConfig(cmsVitestConfig(packagesRoot, { integration: true }));
