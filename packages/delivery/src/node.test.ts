import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesystemSource } from "./node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("filesystem delivery source", () => {
  it("reads build-time releases and rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "cms-delivery-"));
    directories.push(root);
    await mkdir(join(root, "environments/production"), { recursive: true });
    await mkdir(join(root, "releases/rel_local/pages"), { recursive: true });
    await writeFile(
      join(root, "environments/production/current.json"),
      '{"releaseId":"rel_local"}',
    );
    await writeFile(join(root, "releases/rel_local/pages/home.json"), '{"title":"Local"}');
    const source = filesystemSource({ root });
    const pointer = await source.readPointer("production");
    await expect(source.readFile(pointer.releaseId, "pages/home.json")).resolves.toBe(
      '{"title":"Local"}',
    );
    expect(() => source.readFile(pointer.releaseId, "../../../../etc/passwd")).toThrow(/escapes/u);
  });
});
