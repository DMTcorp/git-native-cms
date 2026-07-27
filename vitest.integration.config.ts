import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesRoot = fileURLToPath(new URL("./packages/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@git-native-cms\/([^/]+)\/(.+)$/,
        replacement: `${packagesRoot}$1/src/$2.ts`,
      },
      {
        find: /^@git-native-cms\/([^/]+)$/,
        replacement: `${packagesRoot}$1/src/index.ts`,
      },
    ],
  },
  test: {
    include: ["packages/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
