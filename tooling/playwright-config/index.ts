import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

export function cmsPlaywrightConfig(input: {
  readonly nextPort: number;
  readonly astroPort: number;
}): PlaywrightTestConfig {
  const frameworks = [
    { name: "next", baseURL: `http://127.0.0.1:${String(input.nextPort)}` },
    { name: "astro", baseURL: `http://127.0.0.1:${String(input.astroPort)}` },
  ] as const;
  const browsers = [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ] as const;

  return defineConfig({
    testDir: "./tests/e2e",
    snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
    tsconfig: "./tsconfig.e2e.json",
    timeout: 30_000,
    expect: { timeout: 7_500 },
    fullyParallel: true,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
    use: {
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
      contextOptions: { reducedMotion: "reduce" },
    },
    projects: frameworks.flatMap((framework) =>
      browsers.map((browser) => ({
        name: `${framework.name}-${browser.name}`,
        use: { ...browser.use, baseURL: framework.baseURL },
        metadata: { framework: framework.name },
      })),
    ),
    webServer: [
      {
        command: `pnpm --filter @git-native-cms/playground-next exec next start --hostname 127.0.0.1 --port ${String(input.nextPort)}`,
        url: `http://127.0.0.1:${String(input.nextPort)}`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
      {
        command: `ASTRO_DEV_BACKGROUND=1 pnpm --filter @git-native-cms/playground-astro exec astro dev --host 127.0.0.1 --port ${String(input.astroPort)} --force`,
        url: `http://127.0.0.1:${String(input.astroPort)}`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
    ],
  });
}
