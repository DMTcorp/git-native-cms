import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { CmsMcpContext } from "@git-native-cms/mcp";
import { runMcpStdio } from "@git-native-cms/mcp";
import { buildRelease } from "@git-native-cms/release-builder";
import { yamlCodec } from "@git-native-cms/content-codecs";
import {
  createScheduleExecutorWorkflow,
  createScheduledPublicationWorkflow,
} from "@git-native-cms/integrations";
import { migrateContent } from "@git-native-cms/migrations";

const execFileAsync = promisify(execFile);

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliRuntime {
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

async function init(cwd: string, io: CliIo): Promise<number> {
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
    const frameworkServer = isAstro ? "@git-native-cms/astro" : "@git-native-cms/next/server";
    await writeFile(
      runtimePath,
      [
        `import { createHostedCmsRuntime } from ${JSON.stringify(frameworkServer)};`,
        "",
        "export const cmsRuntime = createHostedCmsRuntime({",
        '  origin: process.env.CMS_ORIGIN ?? "http://localhost:3000",',
        '  projectName: process.env.CMS_PROJECT_NAME ?? "Content",',
        "  environment: process.env,",
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
    const frameworkEditor = isAstro ? "@git-native-cms/astro" : "@git-native-cms/next/editor";
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
          'import { CmsHostedApp } from "@git-native-cms/astro";',
          'import { cmsRuntime } from "../../cms/runtime";',
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
          "  <body><CmsHostedApp state={state} client:load /></body>",
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
          "  return <CmsHostedApp state={state} />;",
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
        "      - uses: actions/checkout@v4",
        "      - uses: pnpm/action-setup@v4",
        "        with:",
        "          version: 11",
        "      - uses: actions/setup-node@v4",
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
      ok: nextRoute || astroRoute,
      repair: "Mount the catch-all CMS API route documented for your framework.",
    },
    {
      name: "editor route",
      ok: nextEditor || astroEditor,
      repair: "Run `cms init` to generate the framework editor route.",
    },
    {
      name: "preview route and registry",
      ok:
        (nextPreview || astroPreview) &&
        (await exists(resolve(cwd, "src/cms/registry.tsx"))) &&
        (await exists(resolve(cwd, "src/cms/preview.tsx"))),
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

async function scheduleCreate(cwd: string, argv: readonly string[], io: CliIo): Promise<number> {
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
  await mkdir(workflows, { recursive: true });
  const path = resolve(workflows, `cms-scheduled-${environment}.yml`);
  await writeFile(path, workflow);
  io.stdout(`Created ${path}`);
  return 0;
}

async function upgrade(cwd: string, io: CliIo): Promise<number> {
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
  io.stdout(`Backup created: ${backupPath}`);
  if (backupBranch !== undefined) io.stdout(`Backup branch created: ${backupBranch}`);
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
  if (command === "init") return init(cwd, io);
  if (command === "doctor") return doctor(cwd, io, options.runtime);
  if (command === "upgrade") return upgrade(cwd, io);
  if (command === "content" && subcommand === "validate" && argument !== undefined) {
    return validateContent(resolve(cwd, argument), io);
  }
  if (command === "release" && subcommand === "build" && argument !== undefined) {
    return releaseBuild(resolve(cwd, argument), io);
  }
  if (command === "schedule" && subcommand === "create") {
    return scheduleCreate(cwd, argv, io);
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
      "  cms doctor",
      "  cms upgrade",
      "  cms content validate <file>",
      "  cms release build <input.json>",
      "  cms schedule create --cron '<UTC cron>' --environment <staging|production>",
      "  cms schedule execute --schedule-id <id> --expected-at <UTC timestamp>",
      "  cms publish --environment <staging|production> --idempotency-key <key>",
      "  cms unpublish --environment <staging|production> --idempotency-key <key>",
      "  cms mcp",
    ].join("\n"),
  );
  return command === undefined || command === "help" || command === "--help" ? 0 : 1;
}
