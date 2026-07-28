import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CmsMcpContext } from "@git-native-cms/mcp";
import { runMcpStdio } from "@git-native-cms/mcp";
import type { StoredRelease } from "@git-native-cms/application";
import { buildRelease } from "@git-native-cms/release-builder";
import { canonicalJson, yamlCodec } from "@git-native-cms/content-codecs";
import {
  createScheduleExecutorWorkflow,
  createScheduledPublicationWorkflow,
} from "@git-native-cms/integrations";
import { migrateContent } from "@git-native-cms/migrations";
import ts from "typescript";

const execFileAsync = promisify(execFile);

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface GitHubSetupTransport {
  readonly origin: string;
  readonly redirectUrl: string;
  readonly setupUrl: string;
  readonly code: Promise<string>;
  readonly installationId: Promise<number>;
  close(): Promise<void>;
}

export interface CliRuntime {
  readonly dev?: () => Promise<void>;
  readonly githubSetup?: (input: {
    readonly origin: string;
    readonly owner: string;
    readonly dryRun: boolean;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly githubSetupTransport?: () => Promise<GitHubSetupTransport>;
  readonly registryManifest?: () => Promise<unknown>;
  readonly buildRelease?: (input: {
    readonly ref: string;
    readonly environment: "preview" | "staging" | "production";
    readonly dryRun: boolean;
  }) => Promise<StoredRelease>;
  readonly migrateContent?: (input: {
    readonly path: string;
    readonly targetVersion: number;
    readonly dryRun: boolean;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly generate?: (input: {
    readonly target: string;
    readonly dryRun: boolean;
  }) => Promise<readonly string[]>;
  readonly codemod?: (input: {
    readonly target: string;
    readonly dryRun: boolean;
  }) => Promise<readonly string[]>;
  readonly inspectAdapters?: () => Promise<Readonly<Record<string, unknown>>>;
  readonly mcpContext?: () => Promise<CmsMcpContext>;
  readonly publish?: (input: {
    readonly environment: "staging" | "production";
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly unpublish?: (input: {
    readonly environment: "staging" | "production";
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly executeSchedule?: (input: {
    readonly scheduleId: string;
    readonly expectedAt: string;
  }) => Promise<"executed" | "already-executed" | "not-due">;
  readonly doctor?: () => Promise<
    readonly { readonly name: string; readonly ok: boolean; readonly repair?: string }[]
  >;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function init(cwd: string, io: CliIo, dryRun = false): Promise<number> {
  if (dryRun) {
    io.stdout(
      [
        "Dry run — no files were written.",
        "Would generate CMS config, runtime, registry, editor/API/preview routes, content configuration and GitHub Actions workflows.",
      ].join("\n"),
    );
    return 0;
  }
  const packagePath = resolve(cwd, "package.json");
  const packageSource = (await exists(packagePath)) ? await readFile(packagePath, "utf8") : "";
  const isAstro = packageSource.includes('"astro"') && !packageSource.includes('"next"');
  const configPath = resolve(cwd, "cms.config.ts");
  if (!(await exists(configPath))) {
    await writeFile(
      configPath,
      isAstro
        ? `export default {\n  configVersion: 1,\n  editor: { path: "/cms" },\n  preview: { path: "/__cms/preview" },\n  api: { path: "/api/cms" },\n} as const;\n`
        : `import { defineCms } from "@git-native-cms/next";\n\nexport default defineCms({\n  configVersion: 1,\n  editor: { path: "/cms" },\n  preview: { path: "/__cms/preview" },\n  api: { path: "/api/cms" },\n});\n`,
      { flag: "wx" },
    );
  }
  const runtimeDirectory = resolve(cwd, "src/cms");
  await mkdir(runtimeDirectory, { recursive: true });
  const runtimePath = resolve(runtimeDirectory, "runtime.ts");
  if (!(await exists(runtimePath))) {
    const frameworkServer = isAstro
      ? "@git-native-cms/astro/server"
      : "@git-native-cms/next/server";
    await writeFile(
      runtimePath,
      [
        `import { createHostedCmsRuntime } from ${JSON.stringify(frameworkServer)};`,
        'import { cmsRegistry } from "./registry";',
        "",
        "export const cmsRuntime = createHostedCmsRuntime({",
        '  origin: process.env.CMS_ORIGIN ?? "http://localhost:3000",',
        '  projectName: process.env.CMS_PROJECT_NAME ?? "Content",',
        "  environment: process.env,",
        "  registryManifest: cmsRegistry.manifest,",
        "  repository: {",
        '    owner: process.env.CMS_GITHUB_OWNER ?? "",',
        '    name: process.env.CMS_GITHUB_REPOSITORY ?? "",',
        '    mainBranch: "main",',
        '    stagingBranch: "staging",',
        "  },",
        "});",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  }
  const registryPath = resolve(runtimeDirectory, "registry.tsx");
  if (!(await exists(registryPath))) {
    const frameworkRegistry = isAstro
      ? "@git-native-cms/astro/registry"
      : "@git-native-cms/next/registry";
    await writeFile(
      registryPath,
      [
        `import { createReactRegistry, defineSection, fields, registerReactSection } from ${JSON.stringify(frameworkRegistry)};`,
        "",
        "const editorialSection = (name: string, label: string) =>",
        "  defineSection({",
        "    name,",
        "    version: 1,",
        "    label,",
        "    fields: {",
        "      heading: fields.text({ required: true, inline: true }),",
        "      description: fields.text({ inline: true }),",
        "    },",
        "  });",
        "",
        "export const cmsRegistry = createReactRegistry({",
        "  sections: [",
        '    registerReactSection(editorialSection("hero", "Hero"), ({ section }) => (',
        '      <section data-cms-section-kind="hero">',
        '        <h1 data-cms-inline-field="heading">{String(section.heading ?? "")}</h1>',
        '        <p data-cms-inline-field="description">{String(section.description ?? "")}</p>',
        "      </section>",
        "    )),",
        '    registerReactSection(editorialSection("proof", "Proof"), ({ section }) => (',
        '      <section data-cms-section-kind="proof">',
        '        <h2 data-cms-inline-field="heading">{String(section.heading ?? "")}</h2>',
        '        <p data-cms-inline-field="description">{String(section.description ?? "")}</p>',
        "      </section>",
        "    )),",
        "  ],",
        "});",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  }
  const previewComponentPath = resolve(runtimeDirectory, "preview.tsx");
  if (!(await exists(previewComponentPath))) {
    const frameworkEditor = isAstro
      ? "@git-native-cms/astro/preview"
      : "@git-native-cms/next/editor";
    await writeFile(
      previewComponentPath,
      [
        '"use client";',
        "",
        `import { createCmsPreviewComponent } from ${JSON.stringify(frameworkEditor)};`,
        'import { cmsRegistry } from "./registry";',
        "",
        "export const CmsPreview = createCmsPreviewComponent(cmsRegistry);",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  }
  if (isAstro) {
    const routeDirectory = resolve(cwd, "src/pages/api/cms");
    await mkdir(routeDirectory, { recursive: true });
    const routePath = resolve(routeDirectory, "[...path].ts");
    if (!(await exists(routePath))) {
      await writeFile(
        routePath,
        [
          'import type { APIRoute } from "astro";',
          'import { cmsRuntime } from "../../../cms/runtime";',
          "",
          "export const ALL: APIRoute = ({ request }) => cmsRuntime.handle(request);",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
    const editorDirectory = resolve(cwd, "src/pages/cms");
    await mkdir(editorDirectory, { recursive: true });
    const editorPath = resolve(editorDirectory, "[...path].astro");
    if (!(await exists(editorPath))) {
      await writeFile(
        editorPath,
        [
          "---",
          'import "@git-native-cms/astro/styles.css";',
          'import { CmsHostedApp } from "@git-native-cms/astro/editor";',
          'import { cmsRuntime } from "../../cms/runtime";',
          'import { cmsRegistry } from "../../cms/registry";',
          "",
          'const state = await cmsRuntime.editorState(Astro.request, Astro.params.path ?? "");',
          "---",
          "",
          '<html lang="en">',
          "  <head>",
          '    <meta charset="utf-8" />',
          '    <meta name="viewport" content="width=device-width" />',
          "    <title>Content editor</title>",
          "  </head>",
          "  <body><CmsHostedApp state={state} registry={cmsRegistry} client:load /></body>",
          "</html>",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
    const previewDirectory = resolve(cwd, "src/pages/[cmsRoot]/preview");
    await mkdir(previewDirectory, { recursive: true });
    const previewPath = resolve(previewDirectory, "[...slug].astro");
    if (!(await exists(previewPath))) {
      await writeFile(
        previewPath,
        [
          "---",
          'import { CmsPreview } from "../../../cms/preview";',
          "",
          'const preview = Astro.params.cmsRoot === "__cms";',
          "if (!preview) Astro.response.status = 404;",
          "---",
          "",
          '<html lang="en">',
          "  <head>",
          '    <meta charset="utf-8" />',
          '    <meta name="viewport" content="width=device-width" />',
          '    <title>{preview ? "Content preview" : "Not found"}</title>',
          "  </head>",
          "  <body>{preview ? <CmsPreview client:load /> : <main><h1>Not found</h1></main>}</body>",
          "</html>",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
  } else {
    const usesSourceApp = await exists(resolve(cwd, "src/app"));
    const registryImport = usesSourceApp ? "@/cms/registry" : "@/src/cms/registry";
    const routeDirectory = resolve(
      cwd,
      usesSourceApp ? "src/app/api/cms/[[...path]]" : "app/api/cms/[[...path]]",
    );
    await mkdir(routeDirectory, { recursive: true });
    const routePath = resolve(routeDirectory, "route.ts");
    if (!(await exists(routePath))) {
      const runtimeImport = usesSourceApp ? "@/cms/runtime" : "@/src/cms/runtime";
      await writeFile(
        routePath,
        [
          `import { cmsRuntime } from ${JSON.stringify(runtimeImport)};`,
          "",
          'export const dynamic = "force-dynamic";',
          "export const GET = (request: Request) => cmsRuntime.handle(request);",
          "export const POST = (request: Request) => cmsRuntime.handle(request);",
          "export const PATCH = (request: Request) => cmsRuntime.handle(request);",
          "export const DELETE = (request: Request) => cmsRuntime.handle(request);",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
    const editorDirectory = resolve(
      cwd,
      usesSourceApp ? "src/app/cms/[[...path]]" : "app/cms/[[...path]]",
    );
    await mkdir(editorDirectory, { recursive: true });
    const editorLayoutPath = resolve(editorDirectory, "layout.tsx");
    if (!(await exists(editorLayoutPath))) {
      await writeFile(
        editorLayoutPath,
        [
          'import type { ReactNode } from "react";',
          'import "@git-native-cms/next/styles.css";',
          "",
          "export default function CmsLayout(props: { readonly children: ReactNode }) {",
          "  return props.children;",
          "}",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
    const editorPagePath = resolve(editorDirectory, "page.tsx");
    if (!(await exists(editorPagePath))) {
      const runtimeImport = usesSourceApp ? "@/cms/runtime" : "@/src/cms/runtime";
      await writeFile(
        editorPagePath,
        [
          'import { headers } from "next/headers";',
          'import { CmsHostedApp } from "@git-native-cms/next/editor";',
          `import { cmsRuntime } from ${JSON.stringify(runtimeImport)};`,
          `import { cmsRegistry } from ${JSON.stringify(registryImport)};`,
          "",
          'export const dynamic = "force-dynamic";',
          "",
          "export default async function CmsPage(props: {",
          "  readonly params: Promise<{ readonly path?: readonly string[] }>;",
          "}) {",
          "  const requestHeaders = await headers();",
          "  const params = await props.params;",
          "  const state = await cmsRuntime.editorState(",
          '    requestHeaders.get("cookie"),',
          '    params.path?.join("/") ?? "",',
          "  );",
          "  return <CmsHostedApp state={state} registry={cmsRegistry} />;",
          "}",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
    const previewDirectory = resolve(
      cwd,
      usesSourceApp ? "src/app/%5F%5Fcms/preview/[[...slug]]" : "app/%5F%5Fcms/preview/[[...slug]]",
    );
    await mkdir(previewDirectory, { recursive: true });
    const previewPagePath = resolve(previewDirectory, "page.tsx");
    if (!(await exists(previewPagePath))) {
      const previewImport = usesSourceApp ? "@/cms/preview" : "@/src/cms/preview";
      await writeFile(
        previewPagePath,
        [
          `import { CmsPreview } from ${JSON.stringify(previewImport)};`,
          "",
          "export default function CmsPreviewPage() {",
          "  return <CmsPreview />;",
          "}",
          "",
        ].join("\n"),
        { flag: "wx" },
      );
    }
  }
  const cmsDirectory = resolve(cwd, ".cms");
  await mkdir(cmsDirectory, { recursive: true });
  const projectPath = resolve(cmsDirectory, "project.yaml");
  if (!(await exists(projectPath))) {
    await writeFile(
      projectPath,
      yamlCodec.serialize({
        configVersion: 1,
        defaultLocale: "en-US",
        locales: [
          { code: "en-US", language: "en" },
          { code: "pl-PL", language: "pl", fallback: "en-US" },
        ],
        branches: { production: "main", staging: "staging" },
      }),
      { flag: "wx" },
    );
  }
  const permissionsPath = resolve(cmsDirectory, "permissions.yaml");
  if (!(await exists(permissionsPath))) {
    await writeFile(
      permissionsPath,
      yamlCodec.serialize({
        version: 1,
        defaults: { repositoryAdmin: "administrator", repositoryWrite: "editor" },
      }),
      { flag: "wx" },
    );
  }
  const workflows = resolve(cwd, ".github/workflows");
  await mkdir(workflows, { recursive: true });
  const workflowPath = resolve(workflows, "cms.yml");
  if (!(await exists(workflowPath))) {
    await writeFile(
      workflowPath,
      [
        "name: CMS validation",
        "on:",
        "  pull_request:",
        "    branches: [main, staging]",
        "permissions:",
        "  contents: read",
        "  pull-requests: write",
        "jobs:",
        "  validate:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v6",
        "      - uses: pnpm/action-setup@v6",
        "        with:",
        "          version: 11",
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          node-version: 22",
        "          cache: pnpm",
        "      - run: pnpm install --frozen-lockfile",
        "      - run: pnpm cms doctor",
        "      - run: pnpm test",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  }
  const schedulesWorkflowPath = resolve(workflows, "cms-schedules.yml");
  if (!(await exists(schedulesWorkflowPath))) {
    await writeFile(schedulesWorkflowPath, createScheduleExecutorWorkflow(), { flag: "wx" });
  }
  io.stdout("CMS routes and configuration are ready.");
  return 0;
}

async function doctor(cwd: string, io: CliIo, runtime?: CliRuntime): Promise<number> {
  const packagePath = resolve(cwd, "package.json");
  const packageValue = (await exists(packagePath))
    ? (JSON.parse(await readFile(packagePath, "utf8")) as Readonly<Record<string, unknown>>)
    : {};
  const dependencies = {
    ...(typeof packageValue.dependencies === "object" && packageValue.dependencies !== null
      ? (packageValue.dependencies as Readonly<Record<string, unknown>>)
      : {}),
    ...(typeof packageValue.devDependencies === "object" && packageValue.devDependencies !== null
      ? (packageValue.devDependencies as Readonly<Record<string, unknown>>)
      : {}),
  };
  const nodeParts = process.versions.node.split(".").map(Number);
  const nodeOk =
    (nodeParts[0] ?? 0) > 22 || ((nodeParts[0] ?? 0) === 22 && (nodeParts[1] ?? 0) >= 12);
  const nextRoute =
    (await exists(resolve(cwd, "app/api/cms/[[...path]]/route.ts"))) ||
    (await exists(resolve(cwd, "src/app/api/cms/[[...path]]/route.ts")));
  const astroRoute =
    (await exists(resolve(cwd, "src/pages/api/cms/[...path].ts"))) ||
    (await exists(resolve(cwd, "src/pages/api/cms/[...path].js")));
  const nextEditor =
    (await exists(resolve(cwd, "app/cms/[[...path]]/page.tsx"))) ||
    (await exists(resolve(cwd, "src/app/cms/[[...path]]/page.tsx")));
  const astroEditor = await exists(resolve(cwd, "src/pages/cms/[...path].astro"));
  const nextPreview =
    (await exists(resolve(cwd, "app/%5F%5Fcms/preview/[[...slug]]/page.tsx"))) ||
    (await exists(resolve(cwd, "src/app/%5F%5Fcms/preview/[[...slug]]/page.tsx")));
  const astroPreview =
    (await exists(resolve(cwd, "src/pages/[cmsRoot]/preview/[...slug].astro"))) ||
    (await exists(resolve(cwd, "src/pages/__cms/preview/[...slug].astro")));
  const astroConfigPath = (await exists(resolve(cwd, "astro.config.ts")))
    ? resolve(cwd, "astro.config.ts")
    : resolve(cwd, "astro.config.mjs");
  const astroIntegration =
    (await exists(astroConfigPath)) &&
    (await readFile(astroConfigPath, "utf8")).includes("gitNativeCms");
  const requiredEnvironment = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "CMS_SESSION_SECRET",
    "CMS_SCHEDULE_TOKEN",
    "CMS_MCP_TOKEN",
    "CMS_REGISTRY_DIGEST",
  ];
  const missingEnvironment = requiredEnvironment.filter(
    (name) => process.env[name] === undefined || process.env[name]?.length === 0,
  );
  const checks = [
    {
      name: "Node.js",
      ok: nodeOk,
      repair: "Install Node.js 22.12 or newer.",
    },
    {
      name: "cms.config.ts",
      ok: await exists(resolve(cwd, "cms.config.ts")),
      repair: "Run `cms init`.",
    },
    {
      name: "content configuration",
      ok:
        (await exists(resolve(cwd, ".cms"))) ||
        (await exists(resolve(cwd, "fixtures/content/.cms"))),
      repair: "Add .cms/project.yaml to the content repository.",
    },
    {
      name: "framework package",
      ok: "@git-native-cms/next" in dependencies || "@git-native-cms/astro" in dependencies,
      repair: "Install @git-native-cms/next or @git-native-cms/astro.",
    },
    {
      name: "server API route",
      ok: nextRoute || astroRoute || astroIntegration,
      repair: "Mount the catch-all CMS API route documented for your framework.",
    },
    {
      name: "editor route",
      ok: nextEditor || astroEditor || astroIntegration,
      repair: "Run `cms init` to generate the framework editor route.",
    },
    {
      name: "preview route and registry",
      ok:
        ((nextPreview || astroPreview) &&
          (await exists(resolve(cwd, "src/cms/registry.tsx"))) &&
          (await exists(resolve(cwd, "src/cms/preview.tsx")))) ||
        astroIntegration,
      repair: "Generate the preview route and register site sections.",
    },
    {
      name: "server-only environment",
      ok: missingEnvironment.length === 0,
      repair: `Configure: ${missingEnvironment.join(", ")}.`,
    },
    {
      name: "session encryption strength",
      ok: (process.env.CMS_SESSION_SECRET?.length ?? 0) >= 32,
      repair: "Generate a CMS_SESSION_SECRET with at least 32 random characters.",
    },
    {
      name: "machine token strength",
      ok:
        (process.env.CMS_SCHEDULE_TOKEN?.length ?? 0) >= 32 &&
        (process.env.CMS_MCP_TOKEN?.length ?? 0) >= 32,
      repair: "Generate separate CMS_SCHEDULE_TOKEN and CMS_MCP_TOKEN values of 32+ characters.",
    },
    {
      name: "storage configuration",
      ok:
        process.env.CMS_S3_ENDPOINT !== undefined &&
        process.env.CMS_S3_ACCESS_KEY_ID !== undefined &&
        process.env.CMS_S3_SECRET_ACCESS_KEY !== undefined &&
        process.env.CMS_ASSETS_BUCKET !== undefined &&
        process.env.CMS_RELEASES_BUCKET !== undefined &&
        process.env.CMS_STATE_BUCKET !== undefined &&
        process.env.CMS_PUBLIC_ASSETS_URL !== undefined &&
        process.env.CMS_PUBLIC_RELEASES_URL !== undefined,
      repair: "Configure the S3/R2 endpoint and separate asset, release and private state buckets.",
    },
    {
      name: "registry digest",
      ok: /^sha256:[a-f0-9]{64}$/iu.test(process.env.CMS_REGISTRY_DIGEST ?? ""),
      repair: "Set CMS_REGISTRY_DIGEST to the deployed component registry SHA-256 digest.",
    },
    {
      name: "publication integrations",
      ok:
        (process.env.CMS_DEPLOYMENT_HOOK_URL === undefined &&
          process.env.CMS_REVALIDATION_URL === undefined) ||
        (process.env.CMS_DEPLOYMENT_HOOK_URL !== undefined &&
          process.env.CMS_REVALIDATION_URL !== undefined),
      repair: "Configure both CMS_DEPLOYMENT_HOOK_URL and CMS_REVALIDATION_URL, or neither.",
    },
    {
      name: "translation integration",
      ok:
        process.env.CMS_TRANSLATION_PROVIDER_TOKEN === undefined ||
        process.env.CMS_TRANSLATION_PROVIDER_URL !== undefined,
      repair: "Set CMS_TRANSLATION_PROVIDER_URL when a translation provider token is configured.",
    },
    {
      name: "GitHub webhook workflow",
      ok:
        (await exists(resolve(cwd, ".github/workflows/cms.yml"))) ||
        (await exists(resolve(cwd, ".github/workflows/cms-publish.yml"))),
      repair: "Generate the CMS validation and publication workflow.",
    },
    {
      name: "schedule executor",
      ok: await exists(resolve(cwd, ".github/workflows/cms-schedules.yml")),
      repair: "Generate cms-schedules.yml and configure its endpoint/token secrets.",
    },
  ];
  const runtimeChecks = (await runtime?.doctor?.()) ?? [];
  const allChecks = [...checks, ...runtimeChecks];
  for (const check of allChecks)
    io.stdout(
      `${check.ok ? "✓" : "✗"} ${check.name}${
        check.ok || check.repair === undefined ? "" : ` — ${check.repair}`
      }`,
    );
  return allChecks.every((check) => check.ok) ? 0 : 1;
}

async function validateContent(path: string, io: CliIo): Promise<number> {
  const value = yamlCodec.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null) {
    io.stderr(`${path} does not contain a content object.`);
    return 1;
  }
  io.stdout(`${path} is valid.`);
  return 0;
}

async function releaseBuild(path: string, io: CliIo): Promise<number> {
  const input = JSON.parse(await readFile(path, "utf8")) as Parameters<typeof buildRelease>[0];
  const release = await buildRelease(input);
  io.stdout(JSON.stringify(release, null, 2));
  return 0;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function dev(cwd: string, io: CliIo, runtime: CliRuntime | undefined): Promise<number> {
  if (runtime?.dev !== undefined) {
    await runtime.dev();
    return 0;
  }
  const packageManager = (await exists(resolve(cwd, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(resolve(cwd, "yarn.lock")))
      ? "yarn"
      : "npm";
  const arguments_ = packageManager === "npm" ? ["run", "dev"] : ["dev"];
  io.stdout(`Starting the project with ${packageManager} ${arguments_.join(" ")}.`);
  const result = await execFileAsync(packageManager, arguments_, { cwd });
  if (result.stdout.length > 0) io.stdout(result.stdout.trimEnd());
  if (result.stderr.length > 0) io.stderr(result.stderr.trimEnd());
  return 0;
}

function githubAppManifest(input: {
  readonly origin: string;
  readonly name: string;
  readonly redirectUrl: string;
  readonly setupUrl?: string;
}): Readonly<Record<string, unknown>> {
  const origin = input.origin.replace(/\/$/u, "");
  return {
    name: input.name,
    url: input.origin,
    redirect_url: input.redirectUrl,
    callback_urls: [`${origin}/api/cms/auth/github/callback`],
    ...(input.setupUrl === undefined ? {} : { setup_url: input.setupUrl, setup_on_update: true }),
    public: false,
    hook_attributes: {
      active: true,
      url: `${origin}/api/cms/webhooks/github`,
    },
    default_permissions: {
      checks: "write",
      contents: "write",
      deployments: "write",
      members: "write",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: [
      "check_run",
      "check_suite",
      "deployment",
      "deployment_status",
      "installation_repositories",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "push",
    ],
  };
}

function githubManifestForm(owner: string, manifestSource: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create GitHub App</title></head>
<body>
  <form id="github-app-manifest" method="post" action="https://github.com/organizations/${htmlAttribute(owner)}/settings/apps/new">
    <input type="hidden" name="manifest" value="${htmlAttribute(manifestSource)}">
    <button type="submit">Create GitHub App</button>
  </form>
</body></html>
`;
}

async function openExternalUrl(url: string): Promise<void> {
  if (url.length > 2_048) {
    throw new Error("Refusing to open an unexpectedly long external URL.");
  }
  const parsed = new URL(url);
  const isLocalSetupFile =
    parsed.protocol === "file:" &&
    (parsed.hostname.length === 0 || parsed.hostname === "localhost") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0;
  const isGitHubInstallation =
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.username.length === 0 &&
    parsed.password.length === 0;
  if (!isLocalSetupFile && !isGitHubInstallation) {
    throw new Error("Refusing to open an URL outside the local setup file or github.com.");
  }
  const safeUrl = parsed.href;
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/open", [safeUrl]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", safeUrl]);
    return;
  }
  await execFileAsync("xdg-open", [safeUrl]);
}

interface GitHubManifestConversion {
  readonly id: number;
  readonly slug: string;
  readonly html_url: string;
  readonly pem: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly webhook_secret: string;
}

function githubManifestConversion(value: unknown): GitHubManifestConversion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid App manifest conversion.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !Number.isSafeInteger(record.id) ||
    typeof record.slug !== "string" ||
    typeof record.html_url !== "string" ||
    typeof record.pem !== "string" ||
    typeof record.client_id !== "string" ||
    typeof record.client_secret !== "string" ||
    typeof record.webhook_secret !== "string"
  ) {
    throw new Error("GitHub App manifest conversion is missing required credentials.");
  }
  return record as unknown as GitHubManifestConversion;
}

async function githubSetupServer(): Promise<GitHubSetupTransport> {
  const state = globalThis.crypto.randomUUID();
  let resolveCode: (value: string) => void = () => undefined;
  let rejectCode: (reason: Error) => void = () => undefined;
  let resolveInstallation: (value: number) => void = () => undefined;
  let rejectInstallation: (reason: Error) => void = () => undefined;
  const code = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  const installationId = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveInstallation = resolvePromise;
    rejectInstallation = rejectPromise;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && url.pathname === `/callback/${state}`) {
      const manifestCode = url.searchParams.get("code");
      if (manifestCode === null || manifestCode.length === 0) {
        response.statusCode = 400;
        response.end("<h1>GitHub App creation failed</h1><p>Return to the terminal.</p>");
        rejectCode(new Error("GitHub did not return a manifest conversion code."));
        return;
      }
      response.end("<h1>GitHub App created</h1><p>Return to the terminal to install it.</p>");
      resolveCode(manifestCode);
      return;
    }
    if (request.method === "GET" && url.pathname === `/installed/${state}`) {
      const value = Number(url.searchParams.get("installation_id"));
      if (!Number.isSafeInteger(value) || value <= 0) {
        response.statusCode = 400;
        response.end("<h1>GitHub App installation failed</h1><p>Return to the terminal.</p>");
        rejectInstallation(new Error("GitHub did not return a valid installation ID."));
        return;
      }
      response.end("<h1>GitHub App installed</h1><p>You can close this tab.</p>");
      resolveInstallation(value);
      return;
    }
    response.statusCode = 404;
    response.end("<h1>Not found</h1>");
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not bind the local GitHub App callback.");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const timeout = setTimeout(() => {
    const error = new Error("GitHub App setup timed out after 10 minutes.");
    rejectCode(error);
    rejectInstallation(error);
  }, 10 * 60_000);
  timeout.unref();
  return {
    origin,
    redirectUrl: `${origin}/callback/${state}`,
    setupUrl: `${origin}/installed/${state}`,
    code,
    installationId,
    async close() {
      clearTimeout(timeout);
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

async function writeGitHubEnvironment(input: {
  readonly cwd: string;
  readonly origin: string;
  readonly owner: string;
  readonly conversion: GitHubManifestConversion;
  readonly installationId: number;
}): Promise<string> {
  const path = resolve(input.cwd, ".env.cms.local");
  const source = [
    `CMS_ORIGIN=${JSON.stringify(input.origin.replace(/\/$/u, ""))}`,
    `CMS_GITHUB_OWNER=${JSON.stringify(input.owner)}`,
    `GITHUB_APP_ID=${String(input.conversion.id)}`,
    `GITHUB_APP_INSTALLATION_ID=${String(input.installationId)}`,
    `GITHUB_APP_PRIVATE_KEY=${JSON.stringify(input.conversion.pem)}`,
    `GITHUB_OAUTH_CLIENT_ID=${JSON.stringify(input.conversion.client_id)}`,
    `GITHUB_OAUTH_CLIENT_SECRET=${JSON.stringify(input.conversion.client_secret)}`,
    `GITHUB_WEBHOOK_SECRET=${JSON.stringify(input.conversion.webhook_secret)}`,
    "",
  ].join("\n");
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
  const ignorePath = resolve(input.cwd, ".gitignore");
  const ignore = (await exists(ignorePath)) ? await readFile(ignorePath, "utf8") : "";
  if (!ignore.split(/\r?\n/u).includes(".env.cms.local")) {
    await writeFile(
      ignorePath,
      `${ignore}${ignore.length === 0 || ignore.endsWith("\n") ? "" : "\n"}.env.cms.local\n`,
    );
  }
  return path;
}

async function githubSetup(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  runtime: CliRuntime | undefined,
  dryRun: boolean,
): Promise<number> {
  const origin = option(argv, "--origin") ?? process.env.CMS_ORIGIN;
  const owner = option(argv, "--owner") ?? process.env.CMS_GITHUB_OWNER;
  if (origin === undefined || owner === undefined) {
    io.stderr("Usage: cms github setup --origin <https://site.example> --owner <github-owner>");
    return 1;
  }
  if (runtime?.githubSetup !== undefined) {
    const result = await runtime.githubSetup({ origin, owner, dryRun });
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  const directory = resolve(cwd, ".cms");
  const manifestPath = resolve(directory, "github-app-manifest.json");
  const formPath = resolve(directory, "github-app-setup.html");
  const name = option(argv, "--name") ?? "Git Native CMS";
  if (dryRun || flag(argv, "--manifest-only")) {
    const manifestSource = canonicalJson(
      githubAppManifest({
        origin,
        name,
        redirectUrl: `${origin.replace(/\/$/u, "")}/api/cms/github-app/callback`,
      }),
    );
    const form = githubManifestForm(owner, manifestSource);
    if (!dryRun) {
      await mkdir(directory, { recursive: true });
      await writeFile(manifestPath, `${manifestSource}\n`);
      await writeFile(formPath, form);
    }
    io.stdout(
      dryRun
        ? `Dry run — would write ${manifestPath} and ${formPath}.`
        : `GitHub App manifest ready: ${formPath}`,
    );
    io.stdout(
      "The manifest intentionally omits the unsupported installation default event; GitHub sends installation lifecycle events automatically.",
    );
    return 0;
  }

  const callback = await (runtime?.githubSetupTransport ?? githubSetupServer)();
  try {
    const manifestSource = canonicalJson(
      githubAppManifest({
        origin,
        name,
        redirectUrl: callback.redirectUrl,
        setupUrl: callback.setupUrl,
      }),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(manifestPath, `${manifestSource}\n`);
    await writeFile(formPath, githubManifestForm(owner, manifestSource));
    io.stdout("Opening GitHub to create the App. Keep this terminal running.");
    const openUrl = runtime?.openUrl ?? openExternalUrl;
    if (flag(argv, "--no-open")) {
      io.stdout(`Open this file in a browser: ${formPath}`);
    } else {
      await openUrl(pathToFileURL(formPath).href);
    }
    const code = await callback.code;
    const apiBase = (option(argv, "--github-api-url") ?? "https://api.github.com").replace(
      /\/$/u,
      "",
    );
    const response = await (runtime?.fetch ?? globalThis.fetch)(
      `${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "git-native-cms-cli",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub App manifest conversion failed with status ${response.status}.`);
    }
    const conversion = githubManifestConversion(await response.json());
    const installationUrl = `${conversion.html_url.replace(/\/$/u, "")}/installations/new`;
    io.stdout(`GitHub App ${conversion.slug} created. Opening repository installation.`);
    if (flag(argv, "--no-open")) {
      io.stdout(`Open this URL in a browser: ${installationUrl}`);
    } else {
      await openUrl(installationUrl);
    }
    const installationId = await callback.installationId;
    const environmentPath = await writeGitHubEnvironment({
      cwd,
      origin,
      owner,
      conversion,
      installationId,
    });
    await writeFile(
      resolve(directory, "github-app.json"),
      `${canonicalJson({
        appId: conversion.id,
        slug: conversion.slug,
        installationId,
        owner,
        configuredAt: new Date().toISOString(),
      })}\n`,
    );
    io.stdout(
      `GitHub App connected. Server-only credentials were written with mode 0600 to ${environmentPath}.`,
    );
    io.stdout("Copy these values to your deployment provider; never commit this file.");
    return 0;
  } finally {
    await callback.close();
  }
}

async function registryBuild(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  runtime: CliRuntime | undefined,
  dryRun: boolean,
): Promise<number> {
  const inputPath = resolve(cwd, option(argv, "--input") ?? ".cms/registry.source.json");
  const manifest: unknown =
    runtime?.registryManifest === undefined
      ? (JSON.parse(await readFile(inputPath, "utf8")) as unknown)
      : await runtime.registryManifest();
  const source = canonicalJson(manifest);
  const digest = `sha256:${await sha256(source)}`;
  const directory = resolve(cwd, ".cms");
  const manifestPath = resolve(directory, "registry.json");
  const digestPath = resolve(directory, "registry.sha256");
  if (!dryRun) {
    await mkdir(directory, { recursive: true });
    await writeFile(manifestPath, `${source}\n`);
    await writeFile(digestPath, `${digest}\n`);
  }
  io.stdout(`${dryRun ? "Would build" : "Built"} registry ${digest}.`);
  return 0;
}

async function registryValidate(cwd: string, argv: readonly string[], io: CliIo): Promise<number> {
  const path = resolve(cwd, option(argv, "--input") ?? ".cms/registry.json");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if ((typeof value !== "object" || value === null) && !Array.isArray(value)) {
    io.stderr(`${path} is not a registry object or array.`);
    return 1;
  }
  const source = canonicalJson(value);
  const digest = `sha256:${await sha256(source)}`;
  const digestPath = resolve(cwd, ".cms/registry.sha256");
  if (await exists(digestPath)) {
    const expected = (await readFile(digestPath, "utf8")).trim();
    if (expected !== digest) {
      io.stderr(`Registry digest mismatch: expected ${expected}, received ${digest}.`);
      return 1;
    }
  }
  io.stdout(`Registry is valid (${digest}).`);
  return 0;
}

async function contentMigrate(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  runtime: CliRuntime | undefined,
  dryRun: boolean,
): Promise<number> {
  const argument = argv[2] ?? option(argv, "--file");
  const targetVersion = Number(option(argv, "--target"));
  if (argument === undefined || !Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    io.stderr("Usage: cms content migrate <file> --target <schema-version> [--dry-run]");
    return 1;
  }
  const path = resolve(cwd, argument);
  if (runtime?.migrateContent !== undefined) {
    const result = await runtime.migrateContent({ path, targetVersion, dryRun });
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  const value = yamlCodec.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    io.stderr(`${path} does not contain a content object.`);
    return 1;
  }
  const record = value as Record<string, unknown>;
  const fromVersion =
    typeof record.schemaVersion === "number" ? record.schemaVersion : targetVersion;
  const migrated = migrateContent(record, fromVersion, targetVersion, []);
  if (!dryRun) await writeFile(path, yamlCodec.serialize(migrated));
  io.stdout(
    `${dryRun ? "Would migrate" : "Migrated"} ${path} from schema v${String(fromVersion)} to v${String(targetVersion)}.`,
  );
  return 0;
}

async function generate(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  runtime: CliRuntime | undefined,
  dryRun: boolean,
): Promise<number> {
  const target = option(argv, "--target") ?? "all";
  if (runtime?.generate !== undefined) {
    const files = await runtime.generate({ target, dryRun });
    files.forEach((path) => io.stdout(`${dryRun ? "Would generate" : "Generated"} ${path}`));
    return 0;
  }
  const registryPath = resolve(cwd, ".cms/registry.json");
  if (!(await exists(registryPath))) {
    io.stderr("Build the registry before generating artifacts: cms registry build.");
    return 1;
  }
  const source = await readFile(registryPath, "utf8");
  const outputPath = resolve(cwd, ".cms/generated/registry.d.ts");
  if (!dryRun) {
    await mkdir(resolve(cwd, ".cms/generated"), { recursive: true });
    await writeFile(
      outputPath,
      `export declare const registryManifest: ${JSON.stringify(JSON.parse(source) as unknown, null, 2)};\n`,
    );
  }
  io.stdout(`${dryRun ? "Would generate" : "Generated"} ${outputPath}.`);
  return 0;
}

async function codemod(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  runtime: CliRuntime | undefined,
  dryRun: boolean,
): Promise<number> {
  const target = option(argv, "--target") ?? "latest";
  if (runtime?.codemod === undefined) {
    const files = await sourceFiles(cwd);
    const updated: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      const next = modernizeSource(path, source);
      if (next === source) continue;
      updated.push(path);
      if (!dryRun) await writeFile(path, next);
    }
    if (updated.length === 0) {
      io.stdout(`AST codemod target ${target} found no legacy CMS APIs.`);
      return 0;
    }
    updated.forEach((path) => io.stdout(`${dryRun ? "Would update" : "Updated"} ${path}`));
    return 0;
  }
  const files = await runtime.codemod({ target, dryRun });
  files.forEach((path) => io.stdout(`${dryRun ? "Would update" : "Updated"} ${path}`));
  return 0;
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const ignored = new Set([
    ".git",
    ".astro",
    ".next",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
  ]);
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
        result.push(path);
      }
    }
  }
  await visit(root);
  return result.sort();
}

function modernizeSource(path: string, source: string): string {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  let changed = false;
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && node.text === "defineCMS") {
        changed = true;
        return context.factory.createIdentifier("defineCms");
      }
      const visited = ts.visitEachChild(node, visit, context);
      if (
        (ts.isImportDeclaration(visited) || ts.isExportDeclaration(visited)) &&
        visited.moduleSpecifier !== undefined &&
        ts.isStringLiteral(visited.moduleSpecifier) &&
        visited.moduleSpecifier.text.startsWith("@cms/")
      ) {
        changed = true;
        const moduleSpecifier = context.factory.createStringLiteral(
          visited.moduleSpecifier.text.replace(/^@cms\//u, "@git-native-cms/"),
        );
        if (ts.isImportDeclaration(visited)) {
          return context.factory.updateImportDeclaration(
            visited,
            visited.modifiers,
            visited.importClause,
            moduleSpecifier,
            visited.attributes,
          );
        }
        return context.factory.updateExportDeclaration(
          visited,
          visited.modifiers,
          visited.isTypeOnly,
          visited.exportClause,
          moduleSpecifier,
          visited.attributes,
        );
      }
      return visited;
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    if (!changed) return source;
    const result = transformed.transformed[0];
    return result === undefined
      ? source
      : ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result);
  } finally {
    transformed.dispose();
  }
}

async function adapterInspect(io: CliIo, runtime: CliRuntime | undefined): Promise<number> {
  const report =
    (await runtime?.inspectAdapters?.()) ??
    ({
      github: {
        configured:
          process.env.GITHUB_APP_ID !== undefined &&
          process.env.GITHUB_APP_INSTALLATION_ID !== undefined,
      },
      assets: {
        adapter: process.env.CMS_ASSETS_BUCKET === undefined ? "none" : "s3-compatible",
        bucket: process.env.CMS_ASSETS_BUCKET ?? null,
      },
      releases: {
        adapter: process.env.CMS_RELEASES_BUCKET === undefined ? "none" : "s3-compatible",
        bucket: process.env.CMS_RELEASES_BUCKET ?? null,
      },
      sessions: { adapter: "rotating-jwe-cookie" },
    } satisfies Readonly<Record<string, unknown>>);
  io.stdout(JSON.stringify(report, null, 2));
  return 0;
}

function publicationInput(argv: readonly string[]): {
  readonly environment: "staging" | "production";
  readonly idempotencyKey: string;
} {
  const environment = option(argv, "--environment");
  const idempotencyKey = option(argv, "--idempotency-key");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be staging or production.");
  }
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    throw new Error("--idempotency-key is required.");
  }
  return { environment, idempotencyKey };
}

async function scheduleCreate(
  cwd: string,
  argv: readonly string[],
  io: CliIo,
  dryRun = false,
): Promise<number> {
  const cron = option(argv, "--cron");
  const environment = option(argv, "--environment");
  if (cron === undefined || (environment !== "staging" && environment !== "production")) {
    io.stderr("Usage: cms schedule create --cron '<UTC cron>' --environment <staging|production>");
    return 1;
  }
  const workflow = createScheduledPublicationWorkflow({
    name: `CMS scheduled ${environment} publication`,
    cron,
    environment,
  });
  const workflows = resolve(cwd, ".github/workflows");
  const path = resolve(workflows, `cms-scheduled-${environment}.yml`);
  if (!dryRun) {
    await mkdir(workflows, { recursive: true });
    await writeFile(path, workflow);
  }
  io.stdout(`${dryRun ? "Would create" : "Created"} ${path}`);
  return 0;
}

async function upgrade(cwd: string, io: CliIo, dryRun = false): Promise<number> {
  const candidates = [
    resolve(cwd, ".cms/project.yaml"),
    resolve(cwd, "fixtures/content/.cms/project.yaml"),
  ];
  const projectPath = (
    await Promise.all(
      candidates.map(async (path) => ({
        path,
        exists: await exists(path),
      })),
    )
  ).find((candidate) => candidate.exists)?.path;
  if (projectPath === undefined) {
    io.stderr("No .cms/project.yaml file was found.");
    return 1;
  }
  const value = yamlCodec.parse(await readFile(projectPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    io.stderr(`${projectPath} is not a valid project configuration.`);
    return 1;
  }
  const record = value as Record<string, unknown>;
  const version = typeof record.configVersion === "number" ? record.configVersion : 1;
  if (version > 1) {
    io.stderr(`Project config version ${version} is newer than this CLI supports.`);
    return 1;
  }
  const migrated = migrateContent(record, version, 1, []);
  if (dryRun) {
    io.stdout(
      `Dry run — would upgrade ${projectPath} from config v${String(version)} to v1 and create a backup branch and file.`,
    );
    return 0;
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let backupBranch: string | undefined;
  if (await exists(resolve(cwd, ".git"))) {
    backupBranch = `cms/backup/upgrade-${timestamp}`;
    try {
      await execFileAsync("git", ["branch", backupBranch, "HEAD"], { cwd });
    } catch (cause) {
      io.stderr(
        `Could not create backup branch ${backupBranch}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return 1;
    }
  }
  const backupDirectory = resolve(cwd, ".cms/backups");
  await mkdir(backupDirectory, { recursive: true });
  const backupPath = resolve(backupDirectory, `${timestamp}-project.yaml`);
  await writeFile(backupPath, await readFile(projectPath, "utf8"), { flag: "wx" });
  await writeFile(projectPath, yamlCodec.serialize({ ...migrated, configVersion: 1 }));
  const codemodFiles: string[] = [];
  for (const path of await sourceFiles(cwd)) {
    const source = await readFile(path, "utf8");
    const next = modernizeSource(path, source);
    if (next === source) continue;
    await writeFile(path, next);
    codemodFiles.push(path);
  }
  const registryPath = resolve(cwd, ".cms/registry.json");
  let registryDigest: string | undefined;
  if (await exists(registryPath)) {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
    registryDigest = `sha256:${await sha256(canonicalJson(registry))}`;
    await writeFile(resolve(cwd, ".cms/registry.sha256"), `${registryDigest}\n`);
  }
  const reportDirectory = resolve(cwd, ".cms/upgrades");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, `${timestamp}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        target: "latest",
        config: { path: projectPath, fromVersion: version, toVersion: 1 },
        backup: { file: backupPath, branch: backupBranch ?? null },
        codemodFiles,
        registryDigest: registryDigest ?? null,
        manualActions: [],
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  io.stdout(`Backup created: ${backupPath}`);
  if (backupBranch !== undefined) io.stdout(`Backup branch created: ${backupBranch}`);
  io.stdout(`AST codemods updated ${String(codemodFiles.length)} source file(s).`);
  if (registryDigest !== undefined) io.stdout(`Registry regenerated: ${registryDigest}`);
  io.stdout(`Upgrade report: ${reportPath}`);
  io.stdout(`Project configuration is current (v1): ${projectPath}`);
  return 0;
}

export async function runCmsCli(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly io?: CliIo;
    readonly runtime?: CliRuntime;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const io = options.io ?? {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  };
  const [command, subcommand, argument] = argv;
  const dryRun = flag(argv, "--dry-run");
  if (command === "init") return init(cwd, io, dryRun);
  if (command === "dev") {
    if (dryRun) {
      io.stdout("Dry run — would start the framework development server.");
      return 0;
    }
    return dev(cwd, io, options.runtime);
  }
  if (command === "doctor") return doctor(cwd, io, options.runtime);
  if (command === "upgrade") return upgrade(cwd, io, dryRun);
  if (command === "github" && subcommand === "setup") {
    return githubSetup(cwd, argv, io, options.runtime, dryRun);
  }
  if (command === "registry" && subcommand === "build") {
    return registryBuild(cwd, argv, io, options.runtime, dryRun);
  }
  if (command === "registry" && subcommand === "validate") {
    return registryValidate(cwd, argv, io);
  }
  if (command === "content" && subcommand === "validate" && argument !== undefined) {
    return validateContent(resolve(cwd, argument), io);
  }
  if (command === "content" && subcommand === "migrate") {
    return contentMigrate(cwd, argv, io, options.runtime, dryRun);
  }
  if (
    command === "release" &&
    subcommand === "build" &&
    argument !== undefined &&
    !argument.startsWith("--")
  ) {
    return releaseBuild(resolve(cwd, argument), io);
  }
  if (command === "release" && subcommand === "build") {
    const ref = option(argv, "--ref");
    const environment = option(argv, "--environment") ?? "production";
    if (
      ref === undefined ||
      !["preview", "staging", "production"].includes(environment) ||
      options.runtime?.buildRelease === undefined
    ) {
      io.stderr(
        "Usage: cms release build <input.json> or cms release build --ref <git-ref> --environment <preview|staging|production>",
      );
      return 1;
    }
    const release = await options.runtime.buildRelease({
      ref,
      environment: environment as "preview" | "staging" | "production",
      dryRun,
    });
    io.stdout(JSON.stringify(release, null, 2));
    return 0;
  }
  if (command === "release" && subcommand === "publish") {
    if (options.runtime?.publish === undefined) {
      io.stderr("The project runtime does not configure release publication.");
      return 1;
    }
    if (dryRun) {
      io.stdout("Dry run — release pointer and integrations would not be changed.");
      return 0;
    }
    await options.runtime.publish(publicationInput(argv));
    io.stdout("Published successfully.");
    return 0;
  }
  if (command === "generate") {
    return generate(cwd, argv, io, options.runtime, dryRun);
  }
  if (command === "codemod") {
    return codemod(cwd, argv, io, options.runtime, dryRun);
  }
  if (command === "adapter" && subcommand === "inspect") {
    return adapterInspect(io, options.runtime);
  }
  if (command === "schedule" && subcommand === "create") {
    return scheduleCreate(cwd, argv, io, dryRun);
  }
  if (command === "schedule" && subcommand === "execute") {
    const scheduleId = option(argv, "--schedule-id");
    const expectedAt = option(argv, "--expected-at");
    if (
      scheduleId === undefined ||
      expectedAt === undefined ||
      options.runtime?.executeSchedule === undefined
    ) {
      io.stderr("Usage: cms schedule execute --schedule-id <id> --expected-at <UTC timestamp>");
      return 1;
    }
    const result = await options.runtime.executeSchedule({ scheduleId, expectedAt });
    io.stdout(`Schedule ${scheduleId}: ${result}.`);
    return 0;
  }
  if (command === "publish" || command === "unpublish") {
    const handler = command === "publish" ? options.runtime?.publish : options.runtime?.unpublish;
    if (handler === undefined) {
      io.stderr(`The project runtime does not configure ${command}.`);
      return 1;
    }
    if (dryRun) {
      io.stdout(`Dry run — ${command} would not change the environment pointer.`);
      return 0;
    }
    await handler(publicationInput(argv));
    io.stdout(`${command === "publish" ? "Published" : "Unpublished"} successfully.`);
    return 0;
  }
  if (command === "mcp") {
    if (options.runtime?.mcpContext === undefined) {
      io.stderr("The project runtime does not configure MCP.");
      return 1;
    }
    await runMcpStdio(options.runtime.mcpContext);
    return 0;
  }
  io.stdout(
    [
      "Git-native CMS",
      "",
      "Commands:",
      "  cms init",
      "  cms dev",
      "  cms doctor",
      "  cms github setup --origin <url> --owner <github-owner>",
      "  cms registry build [--input .cms/registry.source.json]",
      "  cms registry validate [--input .cms/registry.json]",
      "  cms upgrade",
      "  cms content validate <file>",
      "  cms content migrate <file> --target <schema-version>",
      "  cms release build <input.json>",
      "  cms release build --ref <git-ref> --environment <preview|staging|production>",
      "  cms release publish --environment <staging|production> --idempotency-key <key>",
      "  cms generate [--target all]",
      "  cms codemod [--target latest]",
      "  cms adapter inspect",
      "  cms schedule create --cron '<UTC cron>' --environment <staging|production>",
      "  cms schedule execute --schedule-id <id> --expected-at <UTC timestamp>",
      "  cms publish --environment <staging|production> --idempotency-key <key>",
      "  cms unpublish --environment <staging|production> --idempotency-key <key>",
      "  cms mcp",
      "",
      "All mutating commands accept --dry-run.",
    ].join("\n"),
  );
  return command === undefined || command === "help" || command === "--help" ? 0 : 1;
}
