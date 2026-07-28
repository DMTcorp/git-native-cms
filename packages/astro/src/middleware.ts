import type { MiddlewareHandler } from "astro";
import config from "virtual:git-native-cms/config";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const path = context.url.pathname;
  const editorRequest =
    path === config.editorPath || path.startsWith(`${config.editorPath}/`);
  const previewRequest =
    path === config.previewPath || path.startsWith(`${config.previewPath}/`);
  const response = editorRequest
    ? await context.rewrite(
        `${config.internalEditorPath}${path.slice(config.editorPath.length)}${context.url.search}`,
      )
    : previewRequest
      ? await context.rewrite(
          `${config.internalPreviewPath}${path.slice(config.previewPath.length)}${context.url.search}`,
        )
      : await next();
  if (
    editorRequest ||
    previewRequest ||
    path === config.apiPath ||
    path.startsWith(`${config.apiPath}/`)
  ) {
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-content-type-options", "nosniff");
  }
  return response;
};
