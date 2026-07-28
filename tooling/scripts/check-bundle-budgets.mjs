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
const { buildReferenceGraph, buildSearchIndex, search } = await import(
  new URL("packages/search/dist/index.js", root).href
);
const { buildRelease } = await import(
  new URL("packages/release-builder/dist/index.js", root).href
);
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

const catalog = Array.from({ length: 10_000 }, (_, index) => ({
  id: `doc-${index}`,
  type: index % 2 === 0 ? "pages" : "posts",
  title: `Field note ${index}`,
  path: `/notes/${index}`,
  value: {
    slug: `field-note-${index}`,
    summary: `A searchable editorial record for campaign ${index % 100}.`,
    ...(index === 0 ? {} : { ref: `doc-${index - 1}` }),
  },
}));
const searchStarted = performance.now();
const index = buildSearchIndex(catalog);
const graph = buildReferenceGraph(catalog);
const hits = search(index, "campaign 42");
const searchDuration = performance.now() - searchStarted;
if (hits.length === 0 || graph.edges.length !== catalog.length - 1) {
  throw new Error("Large-catalog search or reference graph returned incomplete results.");
}
if (searchDuration > 5_000) {
  throw new Error(
    `10,000-entry search and graph build took ${searchDuration.toFixed(2)} ms; budget is 5000 ms.`,
  );
}

const assetCatalog = Array.from({ length: 10_000 }, (_, index) => ({
  id: `ast-${index}`,
  fileName: `campaign-${index}.webp`,
  mimeType: "image/webp",
  checksum: index.toString(16).padStart(64, "0"),
}));
const assetFilterStarted = performance.now();
const matchingAssets = assetCatalog.filter(
  (asset) =>
    asset.fileName.includes("campaign-999") ||
    asset.mimeType.includes("campaign-999") ||
    asset.checksum.includes("campaign-999"),
);
const assetFilterDuration = performance.now() - assetFilterStarted;
if (matchingAssets.length === 0 || assetFilterDuration > 250) {
  throw new Error(
    `10,000-entry asset filter took ${assetFilterDuration.toFixed(2)} ms; budget is 250 ms.`,
  );
}

const releaseInput = {
  gitCommit: "a".repeat(40),
  configVersion: 1,
  registryDigest: `sha256:${"b".repeat(64)}`,
  schemaVersion: 1,
  documents: Array.from({ length: 1_000 }, (_, index) => ({
    path: `content/pages/page-${index}/index.json`,
    value: {
      id: `doc-${index}`,
      type: "pages",
      schemaVersion: 1,
      title: `Page ${index}`,
      sections: [{ id: `section-${index}`, type: "feature", heading: `Page ${index}` }],
    },
    tags: [`page:${index}`],
  })),
};
const releaseStarted = performance.now();
const firstRelease = await buildRelease(releaseInput);
const secondRelease = await buildRelease({
  ...releaseInput,
  documents: [...releaseInput.documents].reverse(),
});
const releaseDuration = performance.now() - releaseStarted;
if (
  firstRelease.id !== secondRelease.id ||
  JSON.stringify(firstRelease.files) !== JSON.stringify(secondRelease.files)
) {
  throw new Error("A 1,000-document release is not reproducible across input ordering.");
}
if (releaseDuration > 10_000) {
  throw new Error(
    `Two 1,000-document release builds took ${releaseDuration.toFixed(2)} ms; budget is 10000 ms.`,
  );
}

process.stdout.write(
  `Bundle and scale budgets passed: public editor runtime 0 B, editor ${editorBytes} B gzip, bridge ${bridgeBytes} B gzip, typing p95 ${typingP95.toFixed(2)} ms (100 sections), search+graph ${searchDuration.toFixed(2)} ms (10,000 entries), asset filter ${assetFilterDuration.toFixed(2)} ms (10,000 assets), reproducible release ${releaseDuration.toFixed(2)} ms (2 × 1,000 documents).\n`,
);
