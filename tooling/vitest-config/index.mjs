export function cmsVitestConfig(packagesRoot, options = {}) {
  return {
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
    test:
      options.integration === true
        ? {
            include: ["packages/**/*.integration.test.ts"],
            environment: "node",
            testTimeout: 60_000,
            hookTimeout: 60_000,
            sequence: { concurrent: false },
          }
        : {
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
  };
}
