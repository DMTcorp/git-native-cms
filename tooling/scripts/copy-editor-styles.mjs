import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../../packages/editor-ui/dist", import.meta.url), { recursive: true });
await copyFile(
  new URL("../../packages/editor-ui/src/styles.css", import.meta.url),
  new URL("../../packages/editor-ui/dist/styles.css", import.meta.url),
);
