#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { importPKCS8, SignJWT } from "jose";

const target = process.argv[2];
if (target !== "next" && target !== "astro") {
  throw new Error("Usage: node tooling/scripts/provision-github-app.mjs <next|astro>");
}

const settings =
  target === "next"
    ? {
        name: "Git Native CMS Next",
        origin: "https://git-native-cms-next.vercel.app",
        appDirectory: "apps/playground-next",
      }
    : {
        name: "Git Native CMS Astro",
        origin: "https://git-native-cms-astro.vercel.app",
        appDirectory: "apps/playground-astro",
      };

const state = randomBytes(24).toString("base64url");
let appConfiguration;
let resolveConfiguration;
let rejectConfiguration;
const configurationPromise = new Promise((resolve, reject) => {
  resolveConfiguration = resolve;
  rejectConfiguration = reject;
});

function html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/start") {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing server port.");
      const manifest = {
        name: settings.name,
        url: settings.origin,
        redirect_url: `http://127.0.0.1:${address.port}/callback`,
        callback_urls: [`${settings.origin}/api/cms/auth/github/callback`],
        public: false,
        hook_attributes: {
          active: true,
          url: `${settings.origin}/api/cms/webhooks/github`,
        },
        default_permissions: {
          checks: "read",
          contents: "write",
          issues: "write",
          metadata: "read",
          pull_requests: "write",
        },
        default_events: ["check_run", "pull_request", "push"],
      };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>Create GitHub App</title></head>
        <body>
          <p>Redirecting to GitHub to create ${html(settings.name)}…</p>
          <form id="manifest" method="post"
            action="https://github.com/organizations/DMTcorp/settings/apps/new">
            <input type="hidden" name="state" value="${html(state)}">
            <input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}">
          </form>
          <script>document.getElementById("manifest").submit()</script>
        </body></html>`);
      return;
    }
    if (url.pathname === "/callback") {
      if (url.searchParams.get("state") !== state) throw new Error("GitHub App state mismatch.");
      const code = url.searchParams.get("code");
      if (code === null) throw new Error("GitHub did not return a manifest code.");
      const conversion = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!conversion.ok) throw new Error(`Manifest conversion failed (${conversion.status}).`);
      appConfiguration = await conversion.json();
      resolveConfiguration(appConfiguration);
      const slug = appConfiguration.slug;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>Install GitHub App</title></head>
        <body>
          <h1>${html(settings.name)} was created.</h1>
          <p>Install it for the DMTcorp organization and select only
            <strong>git-native-cms-sandbox-content</strong>.</p>
          <p><a href="https://github.com/apps/${html(slug)}/installations/new">Install the app</a></p>
          <p>You can close this page after installation completes.</p>
        </body></html>`);
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    rejectConfiguration(error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("GitHub App provisioning failed. Return to Codex for details.");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing server port.");
console.log(`OPEN http://127.0.0.1:${address.port}/start`);

const converted = await configurationPromise;
if (
  typeof converted.id !== "number" ||
  typeof converted.pem !== "string" ||
  typeof converted.client_id !== "string" ||
  typeof converted.client_secret !== "string" ||
  typeof converted.webhook_secret !== "string" ||
  typeof converted.slug !== "string"
) {
  throw new Error("GitHub returned an incomplete App configuration.");
}

const normalizedPrivateKey = createPrivateKey(converted.pem)
  .export({ format: "pem", type: "pkcs8" })
  .toString();

function setVercelEnvironment(name, value) {
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
      settings.appDirectory,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
      encoding: "utf8",
      input: `${value}\n`,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Vercel rejected ${name}: ${result.stderr || result.stdout}`);
  }
}

const sessionSecret = randomBytes(48).toString("base64url");
const applicationEnvironment = {
  CMS_HOSTED_RUNTIME: "true",
  CMS_SESSION_SECRET: sessionSecret,
  GITHUB_APP_ID: String(converted.id),
  GITHUB_APP_PRIVATE_KEY: normalizedPrivateKey,
  GITHUB_OAUTH_CLIENT_ID: converted.client_id,
  GITHUB_OAUTH_CLIENT_SECRET: converted.client_secret,
  GITHUB_WEBHOOK_SECRET: converted.webhook_secret,
};
for (const [name, value] of Object.entries(applicationEnvironment)) {
  setVercelEnvironment(name, value);
}

async function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(normalizedPrivateKey, "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 8 * 60)
    .setIssuer(String(converted.id))
    .sign(key);
}

async function selectedInstallation() {
  const jwt = await appJwt();
  const installationsResponse = await fetch("https://api.github.com/app/installations", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!installationsResponse.ok) return undefined;
  const installations = await installationsResponse.json();
  const installation = installations.find((candidate) => candidate.account?.login === "DMTcorp");
  if (installation === undefined) return undefined;
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!tokenResponse.ok) return undefined;
  const token = await tokenResponse.json();
  const repositoriesResponse = await fetch("https://api.github.com/installation/repositories", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!repositoriesResponse.ok) return undefined;
  const repositories = await repositoriesResponse.json();
  return repositories.repositories.some(
    (repository) => repository.full_name === "DMTcorp/git-native-cms-sandbox-content",
  )
    ? installation
    : undefined;
}

console.log(
  `INSTALL https://github.com/apps/${converted.slug}/installations/new (select only git-native-cms-sandbox-content)`,
);
let installation;
const installationDeadline = Date.now() + 10 * 60_000;
while (installation === undefined && Date.now() < installationDeadline) {
  installation = await selectedInstallation();
  if (installation === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
if (installation === undefined) {
  throw new Error("The GitHub App was not installed on the sandbox content repository in time.");
}

setVercelEnvironment("GITHUB_APP_INSTALLATION_ID", String(installation.id));

server.close();
console.log(
  `READY ${settings.name} (App ID ${converted.id}, installation ${installation.id}) configured in Vercel production.`,
);
