import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import { gitNativeCms } from "@git-native-cms/astro";

export default defineConfig({
  output: "server",
  adapter: vercel(),
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
