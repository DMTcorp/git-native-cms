#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const accountId = "0a535d97b31b6da0b90858e64a2fded6";
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const assetsBucket = "git-native-cms-sandbox-assets";
const releasesBucket = "git-native-cms-sandbox-releases";
const stateBucket = "git-native-cms-sandbox-state";
const assetsUrl = "https://pub-388b5226a5064710ac8fefc6772e1182.r2.dev";
const releasesUrl = "https://pub-028a1270268a4ecf8bdcad27a5b62ef9.r2.dev";
const state = randomBytes(24).toString("base64url");

function html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setVercelEnvironment(appDirectory, name, value) {
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
      appDirectory,
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

function smokeTest(accessKeyId, secretAccessKey) {
  const result = spawnSync(
    "rtk",
    [
      "pnpm",
      "vitest",
      "run",
      "--config",
      "vitest.integration.config.ts",
      "packages/delivery/src/r2.integration.test.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CMS_R2_SMOKE: "true",
        CMS_S3_ENDPOINT: endpoint,
        CMS_S3_REGION: "auto",
        CMS_S3_ACCESS_KEY_ID: accessKeyId,
        CMS_S3_SECRET_ACCESS_KEY: secretAccessKey,
        CMS_RELEASES_BUCKET: releasesBucket,
        FORCE_COLOR: "0",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`R2 credentials failed the adapter smoke test: ${result.stderr}`);
  }
}

async function verifyBucketObjectAccess(accessKeyId, secretAccessKey) {
  const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
  });
  const key = `health/configuration-${randomBytes(12).toString("hex")}.txt`;
  try {
    for (const bucket of [assetsBucket, releasesBucket, stateBucket]) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: "git-native-cms-r2-configuration-check",
            ContentType: "text/plain; charset=utf-8",
          }),
        );
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if ((await object.Body?.transformToString()) !== "git-native-cms-r2-configuration-check") {
          throw new Error("The verification object did not round-trip.");
        }
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown R2 error";
        throw new Error(`R2 object access failed for ${bucket}: ${message}`, { cause: error });
      }
    }
  } finally {
    client.destroy();
  }
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Credential form is too large.");
  }
  return body;
}

const server = createServer(async (request, response) => {
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server port.");
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Configure sandbox R2</title>
            <style>
              body { max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem;
                font: 16px/1.5 system-ui; color: #17212b; background: #f7f8fa; }
              form { display: grid; gap: 1rem; padding: 1.5rem; background: white;
                border: 1px solid #e5eaf0; border-radius: 1rem; }
              label { display: grid; gap: .35rem; font-weight: 650; }
              input { padding: .75rem; border: 1px solid #aeb8c4; border-radius: .5rem;
                font: 14px ui-monospace, monospace; }
              button { padding: .8rem 1rem; border: 0; border-radius: .5rem;
                color: white; background: #315efb; font-weight: 700; cursor: pointer; }
              code { font-size: .9em; }
            </style>
          </head>
          <body>
            <h1>Connect Cloudflare R2</h1>
            <p>Paste the S3 Access Key ID and Secret Access Key shown once by Cloudflare.
              They go directly to both Vercel Production projects and are never printed.</p>
            <p>The token should have Object Read &amp; Write access limited to
              <code>${html(assetsBucket)}</code>, <code>${html(releasesBucket)}</code> and
              private <code>${html(stateBucket)}</code>.</p>
            <p>Bucket CORS is configured separately in the Cloudflare dashboard because this
              least-privilege token intentionally cannot edit bucket settings.</p>
            <form method="post" action="/configure" autocomplete="off">
              <input type="hidden" name="state" value="${html(state)}">
              <label>Access Key ID
                <input name="accessKeyId" required spellcheck="false">
              </label>
              <label>Secret Access Key
                <input name="secretAccessKey" type="password" required spellcheck="false">
              </label>
              <button type="submit">Verify and save to Vercel</button>
            </form>
          </body>
        </html>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/configure") {
      const form = new URLSearchParams(await requestBody(request));
      if (form.get("state") !== state) throw new Error("Credential form state mismatch.");
      const accessKeyId = form.get("accessKeyId")?.trim();
      const secretAccessKey = form.get("secretAccessKey")?.trim();
      if (
        accessKeyId === undefined ||
        !accessKeyId ||
        secretAccessKey === undefined ||
        !secretAccessKey
      ) {
        throw new Error("Both S3 credentials are required.");
      }

      smokeTest(accessKeyId, secretAccessKey);
      await verifyBucketObjectAccess(accessKeyId, secretAccessKey);
      const environment = {
        CMS_S3_ENDPOINT: endpoint,
        CMS_S3_REGION: "auto",
        CMS_S3_ACCESS_KEY_ID: accessKeyId,
        CMS_S3_SECRET_ACCESS_KEY: secretAccessKey,
        CMS_ASSETS_BUCKET: assetsBucket,
        CMS_RELEASES_BUCKET: releasesBucket,
        CMS_STATE_BUCKET: stateBucket,
        CMS_PUBLIC_ASSETS_URL: assetsUrl,
        CMS_PUBLIC_RELEASES_URL: releasesUrl,
      };
      for (const appDirectory of ["apps/playground-next", "apps/playground-astro"]) {
        for (const [name, value] of Object.entries(environment)) {
          setVercelEnvironment(appDirectory, name, value);
        }
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8">
        <title>R2 configured</title><body>
        <h1>R2 is connected.</h1>
        <p>The adapter smoke test passed and both Vercel Production projects were updated.
        Browser CORS remains a separate bucket setting. You can close this tab.</p></body></html>`);
      console.log("READY R2 credentials verified and stored in both Vercel projects.");
      server.close();
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "R2 configuration failed.");
    response.writeHead(500, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("R2 configuration failed. Return to Codex for details.");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing server port.");
console.log(`OPEN http://127.0.0.1:${address.port}/`);
