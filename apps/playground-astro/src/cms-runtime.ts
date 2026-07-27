import { createCmsApplication } from "@git-native-cms/application";
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
import { actor, change, document } from "./cms-fixture";

const content = new MemoryContentRepository();
content.seed(change.branchName, document);

export const cmsServer = createCmsServer({
  application: createCmsApplication({
    git: new MemoryGitProvider(),
    content,
    authorization: new AuthorizationService(),
    clock: new FixedClock(),
    ids: new DeterministicIds(),
    idempotency: new MemoryIdempotencyStore(),
    audit: new MemoryAuditSink(),
  }),
  actorForRequest: async () => actor,
  verifyCsrf: async (request) => request.headers.get("x-csrf-token") === "sandbox",
  queries: {
    bootstrap: async () => ({ actor, project: { name: "Fieldnotes / Astro" } }),
    listChanges: async () => [change],
    getChange: async () => change,
    listDocuments: async () => content.listDocuments({ ref: change.branchName }),
    listReleases: async () => [],
  },
});
