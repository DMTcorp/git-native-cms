import type { AstroIntegration } from "astro";
import type { CmsServer } from "@git-native-cms/server";

export interface AstroCmsOptions {
  readonly editorPath?: string;
  readonly previewPath?: string;
  readonly apiPath?: string;
  /**
   * Module exporting `hostedRuntime` (or a default HostedCmsRuntime). When present,
   * the integration mounts the CMS API and editor routes.
   */
  readonly runtimeModule?: string;
  readonly runtimeExport?: string;
  /**
   * Module exporting `cmsRegistry`, `registry`, `sandboxRegistry`, or a default React registry.
   * Required for the injected preview route.
   */
  readonly registryModule?: string;
  readonly registryExport?: string;
}

export function gitNativeCms(options: AstroCmsOptions = {}): AstroIntegration {
  const editorPath = (options.editorPath ?? "/cms").replace(/\/$/u, "");
  const previewPath = (options.previewPath ?? "/__cms/preview").replace(/\/$/u, "");
  const apiPath = (options.apiPath ?? "/api/cms").replace(/\/$/u, "");
  const internalEditorPath = "/_git-native-cms/editor";
  const internalPreviewPath = "/_git-native-cms/preview";
  const runtimeId = "virtual:git-native-cms/runtime";
  const resolvedRuntimeId = `\0${runtimeId}`;
  const registryId = "virtual:git-native-cms/registry";
  // Astro serializes a hydrated component's resolved module ID into the browser.
  // Keep this client-facing virtual module URL-safe instead of using Vite's \0 prefix.
  const resolvedRegistryId = registryId;
  const configId = "virtual:git-native-cms/config";
  const resolvedConfigId = `\0${configId}`;
  return {
    name: "@git-native-cms/astro",
    hooks: {
      "astro:config:setup": ({ addMiddleware, injectRoute, logger, updateConfig }) => {
        logger.info(`Mount CMS routes at ${editorPath}, ${previewPath} and ${apiPath}.`);
        updateConfig({
          vite: {
            plugins: [
              {
                name: "@git-native-cms/astro-virtual-modules",
                enforce: "pre",
                resolveId(id: string) {
                  if (id === runtimeId) return resolvedRuntimeId;
                  if (id === registryId) return resolvedRegistryId;
                  if (id === configId) return resolvedConfigId;
                  return undefined;
                },
                load(id: string) {
                  if (id === resolvedConfigId) {
                    return `export default ${JSON.stringify({
                      editorPath,
                      previewPath,
                      apiPath,
                      internalEditorPath,
                      internalPreviewPath,
                    })};`;
                  }
                  if (id === resolvedRuntimeId) {
                    if (options.runtimeModule === undefined) {
                      return 'throw new Error("@git-native-cms/astro requires runtimeModule for mounted routes.");';
                    }
                    const runtimeExport = options.runtimeExport ?? "hostedRuntime";
                    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(runtimeExport)) {
                      throw new Error("The Astro CMS runtime export name must be an identifier.");
                    }
                    return [
                      `import { ${runtimeExport} as importedRuntime } from ${JSON.stringify(options.runtimeModule)};`,
                      "export const hostedRuntime = importedRuntime;",
                    ].join("\n");
                  }
                  if (id !== resolvedRegistryId) return undefined;
                  const registryExport = options.registryExport ?? "cmsRegistry";
                  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(registryExport)) {
                    throw new Error("The Astro CMS registry export name must be an identifier.");
                  }
                  const registryImport =
                    options.registryModule === undefined
                      ? "const importedRegistry = undefined;"
                      : `import { ${registryExport} as importedRegistry } from ${JSON.stringify(options.registryModule)};`;
                  return [
                    'import { createElement } from "react";',
                    'import { CmsHostedApp, createCmsPreviewComponent } from "@git-native-cms/hosted-runtime/react";',
                    registryImport,
                    "export const registry = importedRegistry;",
                    "export function CmsEditor({ state }) {",
                    "  return createElement(CmsHostedApp, importedRegistry === undefined ? { state } : { state, registry: importedRegistry });",
                    "}",
                    "export const CmsPreview = importedRegistry === undefined",
                    "  ? function MissingCmsPreview() { return null; }",
                    "  : createCmsPreviewComponent(importedRegistry);",
                  ].join("\n");
                },
              },
            ],
          },
        });
        addMiddleware({
          order: "pre",
          entrypoint: new URL("./middleware.js", import.meta.url),
        });
        if (options.runtimeModule !== undefined) {
          injectRoute({
            pattern: apiPath,
            entrypoint: new URL("./routes/api.js", import.meta.url),
            prerender: false,
          });
          injectRoute({
            pattern: `${apiPath}/[...path]`,
            entrypoint: new URL("./routes/api.js", import.meta.url),
            prerender: false,
          });
          injectRoute({
            pattern: internalEditorPath,
            entrypoint: new URL("../routes/editor.astro", import.meta.url),
            prerender: false,
          });
          injectRoute({
            pattern: `${internalEditorPath}/[...path]`,
            entrypoint: new URL("../routes/editor.astro", import.meta.url),
            prerender: false,
          });
          if (options.registryModule !== undefined) {
            injectRoute({
              pattern: internalPreviewPath,
              entrypoint: new URL("../routes/preview.astro", import.meta.url),
              prerender: false,
            });
            injectRoute({
              pattern: `${internalPreviewPath}/[...slug]`,
              entrypoint: new URL("../routes/preview.astro", import.meta.url),
              prerender: false,
            });
          } else {
            logger.warn(
              "registryModule is not configured; the CMS preview route was not injected.",
            );
          }
        }
      },
      "astro:config:done": ({ config, logger }) => {
        if (config.output === "static") {
          logger.warn(
            "Full CMS editing requires Astro server output; static delivery remains available.",
          );
        }
      },
      "astro:build:done": ({ logger }) => {
        if (options.runtimeModule !== undefined) {
          logger.info("CMS server routes and virtual runtime module were built.");
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
