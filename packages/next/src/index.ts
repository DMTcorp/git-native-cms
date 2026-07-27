export interface CmsProjectConfig {
  readonly configVersion: number;
  readonly editor: { readonly path: string };
  readonly preview: { readonly path: string; readonly allowedOrigins?: readonly string[] };
  readonly api: { readonly path: string };
  readonly content?: unknown;
  readonly registry?: unknown;
  readonly assets?: unknown;
  readonly delivery?: unknown;
}

export function defineCms<TConfig extends CmsProjectConfig>(config: TConfig): TConfig {
  if (config.configVersion !== 1) throw new Error("Unsupported CMS config version.");
  for (const [name, path] of [
    ["editor", config.editor.path],
    ["preview", config.preview.path],
    ["api", config.api.path],
  ] as const) {
    if (!path.startsWith("/")) throw new Error(`${name} path must start with "/".`);
  }
  return Object.freeze(config);
}
