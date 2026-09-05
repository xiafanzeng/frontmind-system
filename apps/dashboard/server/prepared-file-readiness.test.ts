import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPreparedFileStoreWritable,
  evaluatePreparedFileStorage,
} from "./prepared-file-service";

const temporaryRoots: string[] = [];
const GIB = 1024 * 1024 * 1024;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prepared-file persistence readiness", () => {
  it("requires the same 10% or 5 GiB reserve used by PDF processing", () => {
    expect(
      evaluatePreparedFileStorage({
        blocks: 100,
        bavail: 20,
        bsize: GIB,
      }),
    ).toEqual({
      totalBytes: 100 * GIB,
      availableBytes: 20 * GIB,
      reserveBytes: 10 * GIB,
    });

    expect(() =>
      evaluatePreparedFileStorage({
        blocks: 100,
        bavail: 9,
        bsize: GIB,
      }),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_STORAGE" }));
    expect(() =>
      evaluatePreparedFileStorage({ blocks: 100, bavail: 0, bsize: GIB }),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_STORAGE" }));
  });

  it("writes, reads and removes a unique probe without changing existing data", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "frontmind-prepared-ready-"),
    );
    temporaryRoots.push(root);
    await writeFile(path.join(root, "existing.pdf"), "existing-bytes");

    await expect(
      assertPreparedFileStoreWritable(root),
    ).resolves.toBeUndefined();

    expect(await readdir(root)).toEqual(["existing.pdf"]);
    expect(await readFile(path.join(root, "existing.pdf"), "utf8")).toBe(
      "existing-bytes",
    );
  });

  it("rejects a symlink instead of probing outside the configured mount", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-prepared-link-"));
    temporaryRoots.push(root);
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await writeFile(target, "not-a-directory");
    await symlink(root, linked);

    await expect(assertPreparedFileStoreWritable(linked)).rejects.toMatchObject(
      {
        code: "PREPARED_FILE_STORAGE_ROOT_INVALID",
      },
    );
  });
});
