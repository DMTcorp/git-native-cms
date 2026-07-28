import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCmsCli } from "./index.js";

const directories: string[] = [];

async function workspace(packageJson: Readonly<Record<string, unknown>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-native-cms-cli-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify(packageJson));
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("cms CLI", () => {
  it("initializes a complete Next editor, preview, API and schedule executor", async () => {
    const cwd = await workspace({
      dependencies: { next: "16.0.0", "@git-native-cms/next": "0.1.0" },
    });
    const output: string[] = [];
    await expect(
      runCmsCli(["init"], {
        cwd,
        io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
      }),
    ).resolves.toBe(0);
    await expect(readFile(join(cwd, "src/cms/runtime.ts"), "utf8")).resolves.toContain(
      "createHostedCmsRuntime",
    );
    await expect(readFile(join(cwd, "app/cms/[[...path]]/page.tsx"), "utf8")).resolves.toContain(
      "CmsHostedApp",
    );
    await expect(
      readFile(join(cwd, "app/%5F%5Fcms/preview/[[...slug]]/page.tsx"), "utf8"),
    ).resolves.toContain("CmsPreview");
    await expect(
      readFile(join(cwd, ".github/workflows/cms-schedules.yml"), "utf8"),
    ).resolves.toContain("cms-schedule-executor");
  });

  it("initializes an Astro SSR editor with a routable reserved preview URL", async () => {
    const cwd = await workspace({
      dependencies: { astro: "7.0.0", "@git-native-cms/astro": "0.1.0" },
    });
    await expect(
      runCmsCli(["init"], {
        cwd,
        io: { stdout: () => undefined, stderr: () => undefined },
      }),
    ).resolves.toBe(0);
    await expect(
      readFile(join(cwd, "src/pages/[cmsRoot]/preview/[...slug].astro"), "utf8"),
    ).resolves.toContain('Astro.params.cmsRoot === "__cms"');
    await expect(readFile(join(cwd, "src/pages/cms/[...path].astro"), "utf8")).resolves.toContain(
      "CmsHostedApp",
    );
    await expect(readFile(join(cwd, "src/pages/api/cms/[...path].ts"), "utf8")).resolves.toContain(
      "cmsRuntime.handle",
    );
  });

  it("creates a recoverable backup before an upgrade", async () => {
    const cwd = await workspace({});
    await runCmsCli(["init"], {
      cwd,
      io: { stdout: () => undefined, stderr: () => undefined },
    });
    await expect(
      runCmsCli(["upgrade"], {
        cwd,
        io: { stdout: () => undefined, stderr: () => undefined },
      }),
    ).resolves.toBe(0);
    const backups = await readdir(join(cwd, ".cms/backups"));
    expect(backups).toHaveLength(1);
    const reports = await readdir(join(cwd, ".cms/upgrades"));
    expect(reports).toHaveLength(1);
    await expect(readFile(join(cwd, ".cms/project.yaml"), "utf8")).resolves.toContain(
      "configVersion: 1",
    );
  });

  it("runs an AST codemod for legacy package names and API identifiers", async () => {
    const cwd = await workspace({});
    const path = join(cwd, "cms.config.ts");
    await writeFile(
      path,
      'import { defineCMS } from "@cms/next";\nexport default defineCMS({ configVersion: 1 });\n',
    );
    const output: string[] = [];
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => output.push(line),
    };
    await expect(
      runCmsCli(["codemod", "--target", "latest", "--dry-run"], { cwd, io }),
    ).resolves.toBe(0);
    await expect(readFile(path, "utf8")).resolves.toContain("@cms/next");
    await expect(runCmsCli(["codemod", "--target", "latest"], { cwd, io })).resolves.toBe(0);
    await expect(readFile(path, "utf8")).resolves.toContain(
      'import { defineCms } from "@git-native-cms/next";',
    );
  });

  it("reports an incomplete installation through doctor", async () => {
    const cwd = await workspace({});
    const output: string[] = [];
    await expect(
      runCmsCli(["doctor"], {
        cwd,
        io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
      }),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain("cms.config.ts");
    expect(output.join("\n")).toContain("editor route");
  });

  it("supports deterministic registry build, validation, generation and inspection", async () => {
    const cwd = await workspace({});
    await runCmsCli(["init"], {
      cwd,
      io: { stdout: () => undefined, stderr: () => undefined },
    });
    await writeFile(
      join(cwd, ".cms/registry.source.json"),
      JSON.stringify([{ name: "hero", version: 1, fields: ["heading"] }]),
    );
    const output: string[] = [];
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => output.push(line),
    };
    await expect(runCmsCli(["registry", "build"], { cwd, io })).resolves.toBe(0);
    await expect(runCmsCli(["registry", "validate"], { cwd, io })).resolves.toBe(0);
    await expect(runCmsCli(["generate"], { cwd, io })).resolves.toBe(0);
    await expect(runCmsCli(["adapter", "inspect"], { cwd, io })).resolves.toBe(0);
    await expect(readFile(join(cwd, ".cms/registry.sha256"), "utf8")).resolves.toMatch(
      /^sha256:[a-f0-9]{64}\n$/u,
    );
    await expect(readFile(join(cwd, ".cms/generated/registry.d.ts"), "utf8")).resolves.toContain(
      "registryManifest",
    );
    expect(output.join("\n")).toContain('"sessions"');
  });

  it("generates a valid GitHub App manifest without unsupported installation defaults", async () => {
    const cwd = await workspace({});
    await expect(
      runCmsCli(
        [
          "github",
          "setup",
          "--origin",
          "https://cms.example",
          "--owner",
          "example",
          "--manifest-only",
        ],
        {
          cwd,
          io: { stdout: () => undefined, stderr: () => undefined },
        },
      ),
    ).resolves.toBe(0);
    const manifest = JSON.parse(
      await readFile(join(cwd, ".cms/github-app-manifest.json"), "utf8"),
    ) as { readonly default_events: readonly string[] };
    expect(manifest.default_events).toContain("installation_repositories");
    expect(manifest.default_events).not.toContain("installation");
  });

  it("automatically converts and installs a GitHub App without printing its credentials", async () => {
    const cwd = await workspace({});
    const output: string[] = [];
    let manifest:
      | {
          readonly redirect_url: string;
          readonly setup_url: string;
        }
      | undefined;
    const openUrl = async (url: string): Promise<void> => {
      if (url.startsWith("file:")) {
        manifest = JSON.parse(
          await readFile(join(cwd, ".cms/github-app-manifest.json"), "utf8"),
        ) as { readonly redirect_url: string; readonly setup_url: string };
        return;
      }
      if (manifest === undefined) throw new Error("Manifest callback was not configured.");
      expect(url).toBe("https://github.com/apps/test-cms/installations/new");
    };
    await expect(
      runCmsCli(
        ["github", "setup", "--origin", "https://cms.example", "--owner", "example"],
        {
          cwd,
          io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
          runtime: {
            openUrl,
            githubSetupTransport: async () => ({
              origin: "http://127.0.0.1:49309",
              redirectUrl: "http://127.0.0.1:49309/callback/state",
              setupUrl: "http://127.0.0.1:49309/installed/state",
              code: Promise.resolve("one-time-code"),
              installationId: Promise.resolve(98765),
              close: async () => undefined,
            }),
            fetch: async () =>
              Response.json({
                id: 12345,
                slug: "test-cms",
                html_url: "https://github.com/apps/test-cms",
                pem: "-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----",
                client_id: "client-id",
                client_secret: "oauth-secret",
                webhook_secret: "webhook-secret",
              }),
          },
        },
      ),
    ).resolves.toBe(0);
    const environment = await readFile(join(cwd, ".env.cms.local"), "utf8");
    expect(environment).toContain("GITHUB_APP_ID=12345");
    expect(environment).toContain("GITHUB_APP_INSTALLATION_ID=98765");
    expect(environment).toContain('GITHUB_OAUTH_CLIENT_SECRET="oauth-secret"');
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toContain(".env.cms.local");
    expect((await stat(join(cwd, ".env.cms.local"))).mode & 0o777).toBe(0o600);
    expect(output.join("\n")).not.toContain("oauth-secret");
    expect(output.join("\n")).not.toContain("PRIVATE KEY");
  });

  it("keeps every mutating command side-effect free in dry-run mode", async () => {
    const cwd = await workspace({});
    let publications = 0;
    const output: string[] = [];
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => output.push(line),
    };
    await expect(runCmsCli(["init", "--dry-run"], { cwd, io })).resolves.toBe(0);
    await expect(readFile(join(cwd, "cms.config.ts"), "utf8")).rejects.toThrow();
    await expect(
      runCmsCli(
        [
          "release",
          "publish",
          "--environment",
          "production",
          "--idempotency-key",
          "dry-publication",
          "--dry-run",
        ],
        {
          cwd,
          io,
          runtime: {
            publish: async () => {
              publications += 1;
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(publications).toBe(0);
    expect(output.join("\n")).toContain("Dry run");
  });
});
