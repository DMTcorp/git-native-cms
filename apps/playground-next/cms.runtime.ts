import { createCmsApplication } from "@git-native-cms/application";
import { createHostedCmsRuntime, type HostedCmsRuntime } from "@git-native-cms/hosted-runtime";
import { AuthorizationService } from "@git-native-cms/permissions";
import { createCmsServer } from "@git-native-cms/server";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryGitProvider,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";
import { sandboxActor, sandboxChange, sandboxDocument } from "./cms.fixture";

const productionRuntime = createHostedCmsRuntime({
  origin: "https://git-native-cms-next.vercel.app",
  projectName: "Fieldnotes / Next.js",
  environment: process.env,
});

function memoryRuntime(): HostedCmsRuntime {
  const git = new MemoryGitProvider();
  const content = new MemoryContentRepository();
  content.seed(sandboxChange.branchName, sandboxDocument);
  const server = createCmsServer({
    application: createCmsApplication({
      git,
      content,
      authorization: new AuthorizationService(),
      clock: new FixedClock(),
      ids: new DeterministicIds(),
      idempotency: new MemoryIdempotencyStore(),
      audit: new MemoryAuditSink(),
    }),
    actorForRequest: async () => sandboxActor,
    verifyCsrf: async (request) => request.headers.get("x-csrf-token") === "sandbox",
    queries: {
      bootstrap: async () => ({ actor: sandboxActor, project: { name: "Fieldnotes" } }),
      listChanges: async () => [sandboxChange],
      getChange: async () => sandboxChange,
      listDocuments: async () => content.listDocuments({ ref: sandboxChange.branchName }),
      listReleases: async () => [],
    },
  });
  return {
    handle: (request) => server.handle(request),
    editorState: async () => ({
      authenticated: true,
      actor: sandboxActor,
      change: sandboxChange,
      document: sandboxDocument,
      csrfToken: "sandbox",
      projectName: "Fieldnotes / Next.js",
    }),
  };
}

export const hostedRuntime =
  process.env.CMS_HOSTED_RUNTIME === "true" ? productionRuntime : memoryRuntime();
