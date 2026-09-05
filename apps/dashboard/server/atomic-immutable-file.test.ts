import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installImmutableFileAtomically } from "./atomic-immutable-file";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frontmind-immutable-file-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("atomic immutable file installation", () => {
  it("ignores an orphaned crash temp file and exposes only complete bytes", async () => {
    const directory = path.join(root, "artifacts");
    const target = path.join(directory, "knowledge-base.zip");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, ".knowledge-base.zip.crashed.tmp"),
      Buffer.from("partial"),
    );

    await expect(
      installImmutableFileAtomically({
        target,
        buffer: Buffer.from("complete archive"),
      }),
    ).resolves.toBe("installed");
    await expect(readFile(target, "utf8")).resolves.toBe("complete archive");
  });

  it("allows exactly one concurrent writer to install the target", async () => {
    const directory = path.join(root, "artifacts");
    const target = path.join(directory, "official-logo.bin");
    await mkdir(directory, { recursive: true });
    const first = Buffer.from("first complete payload");
    const second = Buffer.from("second complete payload");

    const outcomes = await Promise.all([
      installImmutableFileAtomically({ target, buffer: first }),
      installImmutableFileAtomically({ target, buffer: second }),
    ]);
    expect(outcomes.sort()).toEqual(["exists", "installed"]);
    const stored = await readFile(target);
    expect([first.equals(stored), second.equals(stored)]).toContain(true);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
