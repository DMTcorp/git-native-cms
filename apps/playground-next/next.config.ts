import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
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
