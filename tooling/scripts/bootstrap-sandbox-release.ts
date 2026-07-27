import { readFile } from "node:fs/promises";
import type { Actor, ActorId, GitCommitSha } from "../../packages/core/src/index.js";
import { RotatingCookieSessionService } from "../../packages/sessions/src/index.js";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const origin = (option("--origin") ?? "https://git-native-cms-next.vercel.app").replace(/\/$/u, "");
const owner = option("--owner") ?? "DMTcorp";
const repository = option("--repository") ?? "git-native-cms-sandbox-content";
const secretPath = option("--session-secret-file");
const secret =
  secretPath === undefined
    ? required(process.env.CMS_SESSION_SECRET, "CMS_SESSION_SECRET")
    : required((await readFile(secretPath, "utf8")).trim(), "session secret file");

const refResponse = await fetch(
  `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/main`,
  { headers: { accept: "application/vnd.github+json" }, redirect: "error" },
);
if (!refResponse.ok) {
  throw new Error(`GitHub main ref request failed with status ${refResponse.status}.`);
}
const refPayload = (await refResponse.json()) as {
  readonly object?: { readonly sha?: string };
};
const mainRevision = required(refPayload.object?.sha, "GitHub main revision") as GitCommitSha;
const actor: Actor = {
  id: "act_00000000000000000000000000" as ActorId,
  githubId: 0,
  login: "sandbox-release-bootstrap",
  displayName: "Sandbox Release Bootstrap",
  roles: ["administrator"],
  source: "action",
};
const session = await new RotatingCookieSessionService(secret).issue(actor);
const idempotencyKey = `bootstrap-production:${mainRevision}`;
const response = await fetch(`${origin}/api/cms/releases/build-and-publish`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: `cms_session=${session.token}`,
    "idempotency-key": idempotencyKey,
    origin,
    "x-csrf-token": session.csrfToken,
  },
  body: JSON.stringify({
    ref: "main",
    expectedRevision: mainRevision,
    environment: "production",
    configVersion: 1,
    registryDigest: "sha256:sandbox-registry-v1",
    schemaVersion: 1,
    idempotencyKey,
  }),
  redirect: "error",
});
const envelope = (await response.json()) as {
  readonly payload?: {
    readonly releaseId?: string;
    readonly error?: { readonly message?: string };
  };
};
if (!response.ok || envelope.payload?.releaseId === undefined) {
  throw new Error(
    envelope.payload?.error?.message ??
      `CMS release bootstrap failed with status ${response.status}.`,
  );
}
process.stdout.write(`Published ${envelope.payload.releaseId} from ${mainRevision}.\n`);
