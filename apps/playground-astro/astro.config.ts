import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import { gitNativeCms } from "@git-native-cms/astro";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const sharpRuntimeFiles = [
  `@img/sharp-${process.platform}-${process.arch}`,
  `@img/sharp-libvips-${process.platform}-${process.arch}`,
].map((packageName) => dirname(require.resolve(`${packageName}/package`)));

export default defineConfig({
  output: "server",
  adapter: vercel({ includeFiles: sharpRuntimeFiles }),
  integrations: [
    react(),
    gitNativeCms({
      runtimeModule: new URL("./src/cms-runtime.ts", import.meta.url).pathname,
      runtimeExport: "hostedRuntime",
      registryModule: new URL("./src/cms-registry.tsx", import.meta.url).pathname,
      registryExport: "sandboxRegistry",
    }),
  ],
  server: { port: 3001 },
});
