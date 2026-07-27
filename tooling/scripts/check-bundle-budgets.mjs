import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../../", import.meta.url);
const nextRoot = new URL("apps/playground-next/.next/", root);

async function routeManifest(path) {
  const source = await readFile(new URL(path, nextRoot), "utf8");
  const assignment = source.indexOf("] = ");
  if (assignment < 0) throw new Error(`Cannot parse Next.js route manifest ${path}.`);
  return {
    source,
    value: JSON.parse(source.slice(assignment + 4).replace(/;\s*$/, "")),
  };
}

async function chunksFor(path) {
  const manifest = await routeManifest(path);
  const chunks = [
    ...new Set(
      Object.values(manifest.value.clientModules ?? {}).flatMap((module) => module.chunks ?? []),
    ),
  ];
  return Promise.all(
    chunks
      .filter((chunk) => chunk.endsWith(".js"))
      .map(async (chunk) => ({
        path: chunk,
        source: await readFile(new URL(chunk.replace(/^\/_next\//, ""), nextRoot), "utf8"),
      })),
  );
}

const publicManifest = await routeManifest("server/app/page_client-reference-manifest.js");
if (
  publicManifest.source.includes("@git-native-cms/editor") ||
  publicManifest.source.includes("cms-demo")
) {
  throw new Error("The public Next.js route references editor modules.");
}
const publicChunks = await chunksFor("server/app/page_client-reference-manifest.js");
const editorLeak = publicChunks.find(
  ({ source }) => source.includes("cms-editor-shell") || source.includes("@git-native-cms/editor"),
);
if (editorLeak !== undefined) {
  throw new Error(`The public Next.js route contains editor runtime: ${editorLeak.path}`);
}

const editorChunks = await chunksFor(
  "server/app/cms/[[...path]]/page_client-reference-manifest.js",
);
const editorBytes = editorChunks.reduce(
  (total, chunk) => total + gzipSync(chunk.source).byteLength,
  0,
);
if (editorBytes > 350 * 1024) {
  throw new Error(`Editor shell is ${editorBytes} bytes gzip; budget is 358400 bytes.`);
}

const bridgeSource = await readFile(new URL("packages/editor-bridge/dist/index.js", root), "utf8");
const bridgeBytes = gzipSync(bridgeSource).byteLength;
if (bridgeBytes > 35 * 1024) {
  throw new Error(`Preview bridge is ${bridgeBytes} bytes gzip; budget is 35840 bytes.`);
}

const { applyPatches } = await import(new URL("packages/document-model/dist/index.js", root).href);
const largePage = {
  title: "Performance fixture",
  sections: Array.from({ length: 100 }, (_, index) => ({
    id: `section-${index}`,
    type: "feature",
    heading: `Feature ${index}`,
    description: "A representative section body for editor typing latency.",
  })),
};
const timings = [];
for (let index = 0; index < 160; index += 1) {
  const started = performance.now();
  applyPatches(largePage, [
    {
      op: "set",
      path: "/sections/50/heading",
      value: `Typed value ${index}`,
      metadata: {
        id: `performance-${index}`,
        actorId: "act_performance",
        createdAt: "2026-07-27T12:00:00.000Z",
        source: "editor",
      },
    },
  ]);
  if (index >= 10) timings.push(performance.now() - started);
}
timings.sort((left, right) => left - right);
const typingP95 = timings[Math.floor(timings.length * 0.95)] ?? Number.POSITIVE_INFINITY;
if (typingP95 > 50) {
  throw new Error(`Document patch typing p95 is ${typingP95.toFixed(2)} ms; budget is 50 ms.`);
}

process.stdout.write(
  `Bundle budgets passed: public editor runtime 0 B, editor ${editorBytes} B gzip, bridge ${bridgeBytes} B gzip, typing p95 ${typingP95.toFixed(2)} ms (100 sections).\n`,
);
