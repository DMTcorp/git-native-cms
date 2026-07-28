import { createMemoryHostedRuntime } from "@git-native-cms/e2e-fixtures";
import { createHostedCmsRuntime } from "@git-native-cms/hosted-runtime";
import { sandboxActor, sandboxAssets, sandboxChange, sandboxContentDocuments } from "./cms.fixture";
import { sandboxRegistry } from "./cms.registry";

const productionRuntime = createHostedCmsRuntime({
  origin: "https://git-native-cms-next.vercel.app",
  projectName: "Fieldnotes / Next.js",
  environment: process.env,
  registryManifest: sandboxRegistry.manifest,
  repository: {
    owner: "DMTcorp",
    name: "git-native-cms-sandbox-content",
    mainBranch: "main",
    stagingBranch: "staging",
    homeDocumentId: "doc_home",
  },
});

function memoryRuntime() {
  return createMemoryHostedRuntime({
    actor: sandboxActor,
    initialChange: sandboxChange,
    documents: sandboxContentDocuments,
    assets: sandboxAssets,
    projectName: "Fieldnotes / Next.js",
  });
}

export const hostedRuntime =
  process.env.CMS_HOSTED_RUNTIME === "true" ? productionRuntime : memoryRuntime();
