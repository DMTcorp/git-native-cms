import { createHostedCmsRuntime } from "@git-native-cms/hosted-runtime";
import { enterpriseRegistry } from "./cms.registry";

export const hostedRuntime = createHostedCmsRuntime({
  origin: process.env.CMS_ORIGIN ?? "http://localhost:3100",
  projectName: "Enterprise CMS example",
  environment: process.env,
  registryManifest: enterpriseRegistry.manifest,
  repository: {
    owner: process.env.CMS_GITHUB_OWNER ?? "DMTcorp",
    name: process.env.CMS_GITHUB_REPOSITORY ?? "git-native-cms-sandbox-content",
    mainBranch: "main",
    stagingBranch: "staging",
    homeDocumentId: "doc_home",
  },
});
