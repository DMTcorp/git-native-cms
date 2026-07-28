import type { CmsServer } from "@git-native-cms/server";
import { createNextCmsRouteHandlers } from "./server.js";

export function createNextCmsTestRequest(input: {
  readonly server: CmsServer;
  readonly path?: string;
  readonly init?: RequestInit;
}): Promise<Response> {
  const request = new Request(`https://cms.test${input.path ?? "/api/cms/bootstrap"}`, input.init);
  return createNextCmsRouteHandlers(input.server).GET(request);
}

export function publicMarkupContainsEditorRuntime(markup: string): boolean {
  return /@git-native-cms\/(?:editor|editor-bridge)|cms-editor(?:\.js|\/)/u.test(markup);
}
