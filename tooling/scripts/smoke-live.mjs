#!/usr/bin/env node

const applications = [
  {
    name: "Next.js",
    origin: process.env.CMS_NEXT_ORIGIN ?? "https://git-native-cms-next.vercel.app",
  },
  {
    name: "Astro",
    origin: process.env.CMS_ASTRO_ORIGIN ?? "https://git-native-cms-astro.vercel.app",
  },
];
const releasesOrigin =
  process.env.CMS_PUBLIC_RELEASES_URL ?? "https://pub-028a1270268a4ecf8bdcad27a5b62ef9.r2.dev";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkedFetch(url, init, expectedStatus = 200) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  assert(
    response.status === expectedStatus,
    `${url} returned ${response.status}; expected ${expectedStatus}.`,
  );
  return response;
}

for (const application of applications) {
  const publicPage = await checkedFetch(`${application.origin}/`);
  assert(
    (publicPage.headers.get("content-type") ?? "").includes("text/html"),
    `${application.name} public page is not HTML.`,
  );

  const editor = await checkedFetch(`${application.origin}/cms`);
  const editorHtml = await editor.text();
  assert(editorHtml.includes("Sign in with GitHub"), `${application.name} editor is unavailable.`);

  const login = await checkedFetch(
    `${application.origin}/api/cms/auth/github/start`,
    { redirect: "manual" },
    302,
  );
  const location = login.headers.get("location") ?? "";
  assert(location.startsWith("https://github.com/login/oauth/authorize"), "Invalid OAuth origin.");
  assert(location.includes("code_challenge="), "OAuth PKCE challenge is missing.");

  const scheduler = await checkedFetch(
    `${application.origin}/api/cms/schedules/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    401,
  );
  assert(
    (await scheduler.text()).includes("CMS_AUTH_011"),
    `${application.name} scheduler did not enforce its bearer token.`,
  );

  const mcp = await checkedFetch(
    `${application.origin}/api/cms/mcp`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    },
    401,
  );
  const mcpBody = await mcp.json();
  assert(mcpBody.error?.code === -32001, `${application.name} MCP accepted an anonymous request.`);

  console.log(`READY ${application.name} public, editor, OAuth, scheduler and MCP.`);
}

const pointerResponse = await checkedFetch(
  `${releasesOrigin}/environments/production/current.json`,
);
const pointer = await pointerResponse.json();
assert(
  typeof pointer.releaseId === "string" && /^rel_[a-f0-9]{24}$/u.test(pointer.releaseId),
  "The production release pointer is invalid.",
);
assert(
  typeof pointer.revision === "string" && pointer.revision.length > 0,
  "The production release revision is invalid.",
);

const manifestResponse = await checkedFetch(
  `${releasesOrigin}/releases/${pointer.releaseId}/manifest.json`,
);
const manifest = await manifestResponse.json();
assert(manifest.releaseId === pointer.releaseId, "The immutable release manifest does not match.");
assert(
  /^[a-f0-9]{40}$/u.test(manifest.gitCommit ?? ""),
  "The immutable release has no exact Git revision.",
);
assert(
  manifest.registryDigest ===
    "sha256:2dd2966dab6a531fd1e3079105da7dc00c4d9f2ad6c4fb5f03dd29436c3f00a3",
  "The immutable release registry digest does not match the deployed registry.",
);

console.log(`READY immutable production release ${pointer.releaseId}.`);
