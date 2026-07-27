import { defineConfig, devices } from "@playwright/test";

const nextPort = Number(process.env.CMS_E2E_NEXT_PORT ?? "41731");
const astroPort = Number(process.env.CMS_E2E_ASTRO_PORT ?? "41732");

const frameworks = [
  { name: "next", baseURL: `http://127.0.0.1:${nextPort}` },
  { name: "astro", baseURL: `http://127.0.0.1:${astroPort}` },
] as const;

const browsers = [
  { name: "chromium", use: devices["Desktop Chrome"] },
  { name: "firefox", use: devices["Desktop Firefox"] },
  { name: "webkit", use: devices["Desktop Safari"] },
] as const;

export default defineConfig({
  testDir: "./tests/e2e",
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  tsconfig: "./tsconfig.e2e.json",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    reducedMotion: "reduce",
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
      command: `pnpm --filter @git-native-cms/playground-next exec next start --hostname 127.0.0.1 --port ${nextPort}`,
      url: `http://127.0.0.1:${nextPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `ASTRO_DEV_BACKGROUND=1 pnpm --filter @git-native-cms/playground-astro exec astro dev --host 127.0.0.1 --port ${astroPort} --force`,
      url: `http://127.0.0.1:${astroPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
