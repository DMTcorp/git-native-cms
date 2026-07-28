import { CmsPageRenderer } from "@git-native-cms/react";
import { enterpriseHomeDocument } from "../cms.content";
import { enterpriseRegistry } from "../cms.registry";

export default function Home() {
  return (
    <main>
      <CmsPageRenderer document={enterpriseHomeDocument} registry={enterpriseRegistry} />
      <a href="/cms">Open CMS</a>
    </main>
  );
}
