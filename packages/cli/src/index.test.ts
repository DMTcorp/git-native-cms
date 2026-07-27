import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
    await expect(readFile(join(cwd, ".cms/project.yaml"), "utf8")).resolves.toContain(
      "configVersion: 1",
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
});
