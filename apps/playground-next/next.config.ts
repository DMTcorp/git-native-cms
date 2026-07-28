import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const sharpPlatform = `${process.platform}-${process.arch}`;

const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  outputFileTracingIncludes: {
    "/api/cms/*": [
      `../../node_modules/.pnpm/@img+sharp-${sharpPlatform}@*/node_modules/@img/sharp-${sharpPlatform}/**/*`,
      `../../node_modules/.pnpm/@img+sharp-libvips-${sharpPlatform}@*/node_modules/@img/sharp-libvips-${sharpPlatform}/**/*`,
    ],
  },
  transpilePackages: [
    "@git-native-cms/editor",
    "@git-native-cms/editor-ui",
    "@git-native-cms/next",
    "@git-native-cms/react",
  ],
  experimental: {
    optimizePackageImports: ["@git-native-cms/editor-ui"],
    useTypeScriptCli: true,
  },
};

export default config;
