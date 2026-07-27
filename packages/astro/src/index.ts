import type { AstroIntegration } from "astro";
import type { CmsServer } from "@git-native-cms/server";

export interface AstroCmsOptions {
  readonly editorPath?: string;
  readonly previewPath?: string;
  readonly apiPath?: string;
}

export function gitNativeCms(options: AstroCmsOptions = {}): AstroIntegration {
  return {
    name: "@git-native-cms/astro",
    hooks: {
      "astro:config:setup": ({ logger }) => {
        logger.info(
          `Mount CMS routes at ${options.editorPath ?? "/cms"}, ${options.previewPath ?? "/__cms/preview"} and ${options.apiPath ?? "/api/cms"}.`,
        );
      },
      "astro:config:done": ({ config, logger }) => {
        if (config.output === "static") {
          logger.warn(
            "Full CMS editing requires Astro server output; static delivery remains available.",
          );
        }
      },
    },
  };
}

export function createAstroCmsEndpoint(
  server: CmsServer,
): (context: { readonly request: Request }) => Promise<Response> {
  return ({ request }) => server.handle(request);
}

export { CmsHostedApp, createCmsPreviewComponent } from "@git-native-cms/hosted-runtime/react";
export {
  createHostedCmsRuntime,
  type HostedCmsRuntime,
  type HostedRuntimeEnvironment,
} from "@git-native-cms/hosted-runtime";
