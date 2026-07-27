import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Git-native CMS",
      description: "Visual editing, Git history and immutable delivery for Next.js and Astro.",
      customCss: ["./src/styles/custom.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/DMTcorp/git-native-cms" },
      ],
      sidebar: [
        { label: "Start", items: ["index", "getting-started"] },
        {
          label: "Core concepts",
          items: ["architecture", "changes-and-publishing", "content-modeling"],
        },
        {
          label: "Integrations",
          items: ["nextjs", "astro", "astro-static", "mcp", "adapters"],
        },
        { label: "Operations", items: ["security", "doctor-and-upgrades", "sandbox"] },
      ],
    }),
  ],
});
