import { createCmsApplication } from "@git-native-cms/application";
import { createCmsServer } from "@git-native-cms/server";
import { AuthorizationService } from "@git-native-cms/permissions";
import {
  DeterministicIds,
  FixedClock,
  MemoryAuditSink,
  MemoryContentRepository,
  MemoryGitProvider,
  MemoryIdempotencyStore,
} from "@git-native-cms/testing";
import { sandboxActor, sandboxChange, sandboxDocument } from "./cms.fixture";

const git = new MemoryGitProvider();
const content = new MemoryContentRepository();
content.seed(sandboxChange.branchName, sandboxDocument);

const application = createCmsApplication({
  git,
  content,
  authorization: new AuthorizationService(),
  clock: new FixedClock(),
  ids: new DeterministicIds(),
  idempotency: new MemoryIdempotencyStore(),
  audit: new MemoryAuditSink(),
});

export const cmsServer = createCmsServer({
  application,
  actorForRequest: async () => sandboxActor,
  verifyCsrf: async (request) => request.headers.get("x-csrf-token") === "sandbox",
  queries: {
    bootstrap: async () => ({
      actor: sandboxActor,
      project: { name: "Fieldnotes", locales: ["en-US", "pl-PL"] },
      capabilities: { preview: true, publishing: true, mcp: true },
    }),
    listChanges: async () => [sandboxChange],
    getChange: async () => sandboxChange,
    listDocuments: async () => content.listDocuments({ ref: sandboxChange.branchName }),
    listReleases: async () => [],
  },
});
