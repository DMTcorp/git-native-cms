#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const secretDirectory = "/private/tmp/git-native-cms-live-secrets";
const applications = ["apps/playground-next", "apps/playground-astro"];
const runtimeEnvironment = {
  CMS_STATE_BUCKET: "git-native-cms-sandbox-state",
  CMS_REGISTRY_DIGEST: "sha256:2dd2966dab6a531fd1e3079105da7dc00c4d9f2ad6c4fb5f03dd29436c3f00a3",
};

function secret(name) {
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  chmodSync(secretDirectory, 0o700);
  const path = join(secretDirectory, name);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8").trim();
    if (current.length >= 43) return current;
  }

  const value = randomBytes(32).toString("base64url");
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

function setVercelEnvironment(application, name, value) {
  const result = spawnSync(
    "rtk",
    [
      "pnpm",
      "dlx",
      "vercel@latest",
      "env",
      "add",
      name,
      "production",
      "--force",
      "--cwd",
      application,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
      encoding: "utf8",
      input: `${value}\n`,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Vercel rejected ${name} for ${application}: ${result.stderr || result.stdout}`,
    );
  }
}

const environment = {
  ...runtimeEnvironment,
  CMS_SESSION_SECRET: secret("session-secret"),
  CMS_SCHEDULE_TOKEN: secret("schedule-token"),
  CMS_MCP_TOKEN: secret("mcp-token"),
};

for (const application of applications) {
  for (const [name, value] of Object.entries(environment)) {
    setVercelEnvironment(application, name, value);
    console.log(`READY ${application}: ${name}`);
  }
}

console.log(`READY live runtime secrets are stored with mode 0600 in ${secretDirectory}.`);
