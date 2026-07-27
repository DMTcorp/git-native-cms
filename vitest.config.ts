import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/**/*.integration.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
