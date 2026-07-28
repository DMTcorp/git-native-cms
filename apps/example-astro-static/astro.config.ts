import { defineConfig } from "astro/config";
import { gitNativeCms } from "@git-native-cms/astro";

export default defineConfig({
  output: "static",
  integrations: [gitNativeCms()],
});
