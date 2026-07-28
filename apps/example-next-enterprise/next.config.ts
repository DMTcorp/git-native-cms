import type { NextConfig } from "next";

export default {
  reactStrictMode: true,
  transpilePackages: [
    "@git-native-cms/hosted-runtime",
    "@git-native-cms/next",
    "@git-native-cms/react",
    "@git-native-cms/schema",
  ],
} satisfies NextConfig;
