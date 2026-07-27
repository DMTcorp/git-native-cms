import { defineConfig, devices } from "@playwright/test";

const frameworks = [
  { name: "next", baseURL: "http://127.0.0.1:3000" },
  { name: "astro", baseURL: "http://127.0.0.1:3001" },
] as const;

const browsers = [
  { name: "chromium", use: devices["Desktop Chrome"] },
  { name: "firefox", use: devices["Desktop Firefox"] },
  { name: "webkit", use: devices["Desktop Safari"] },
] as const;

export default defineConfig({
  testDir: "./tests/e2e",
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
      command:
        "pnpm --filter @git-native-cms/playground-next exec next dev --hostname 127.0.0.1 --port 3000",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "ASTRO_DEV_BACKGROUND=1 pnpm --filter @git-native-cms/playground-astro exec astro dev --host 127.0.0.1 --port 3001 --force",
      url: "http://127.0.0.1:3001",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
