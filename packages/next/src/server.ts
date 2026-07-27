import type { CmsServer } from "@git-native-cms/server";

export interface NextCmsRouteHandlers {
  readonly GET: (request: Request) => Promise<Response>;
  readonly POST: (request: Request) => Promise<Response>;
  readonly PATCH: (request: Request) => Promise<Response>;
  readonly DELETE: (request: Request) => Promise<Response>;
  readonly PUT: (request: Request) => Promise<Response>;
}

export function createNextCmsRouteHandlers(server: CmsServer): NextCmsRouteHandlers {
  const handle = (request: Request): Promise<Response> => server.handle(request);
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle, PUT: handle };
}
