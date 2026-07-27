import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { CmsMcpContext } from "@git-native-cms/mcp";
import { runMcpStdio } from "@git-native-cms/mcp";
import { buildRelease } from "@git-native-cms/release-builder";
import { yamlCodec } from "@git-native-cms/content-codecs";
import { createScheduledPublicationWorkflow } from "@git-native-cms/integrations";
import { migrateContent } from "@git-native-cms/migrations";

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
  const configPath = resolve(cwd, "cms.config.ts");
  if (!(await exists(configPath))) {
    await writeFile(
      configPath,
      `import { defineCms } from "@git-native-cms/next";\n\nexport default defineCms({\n  configVersion: 1,\n  editor: { path: "/cms" },\n  preview: { path: "/__cms/preview" },\n  api: { path: "/api/cms" },\n});\n`,
      { flag: "wx" },
    );
  }
  await mkdir(resolve(cwd, "src/cms"), { recursive: true });
  io.stdout("CMS routes and configuration are ready.");
  return 0;
}

async function doctor(cwd: string, io: CliIo): Promise<number> {
  const checks = [
    {
      name: "Node.js",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
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
  ];
  for (const check of checks)
    io.stdout(`${check.ok ? "✓" : "✗"} ${check.name}${check.ok ? "" : ` — ${check.repair}`}`);
  return checks.every((check) => check.ok) ? 0 : 1;
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
  await writeFile(projectPath, yamlCodec.serialize({ ...migrated, configVersion: 1 }));
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
  if (command === "doctor") return doctor(cwd, io);
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
      "  cms publish --environment <staging|production> --idempotency-key <key>",
      "  cms unpublish --environment <staging|production> --idempotency-key <key>",
      "  cms mcp",
    ].join("\n"),
  );
  return command === undefined || command === "help" || command === "--help" ? 0 : 1;
}
