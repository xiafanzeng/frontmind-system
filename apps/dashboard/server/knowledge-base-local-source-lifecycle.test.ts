import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  markKnowledgeBaseBuildSourcesTerminal,
  sweepKnowledgeBaseBuildSources,
  type KnowledgeBaseBuildSourceLifecycle,
} from "./knowledge-base-local-source-lifecycle";
import { persistKnowledgeBaseBuildSource } from "./knowledge-base-local-source-store";

const userId = 7;
const buildId = "00000000-0000-4000-8000-000000000007";
const terminalAt = new Date("2026-06-01T00:00:00.000Z");
const sweepAt = new Date("2026-07-02T00:00:00.000Z");

function sourcePath(assetRoot: string, generation: number, sha256: string) {
  return path.join(
    assetRoot,
    "knowledge-base",
    "build-sources",
    String(userId),
    buildId,
    `g${generation}`,
    `${sha256}.bin`,
  );
}

function lifecycle(
  value: Partial<KnowledgeBaseBuildSourceLifecycle>,
): KnowledgeBaseBuildSourceLifecycle {
  return {
    exists: true,
    status: "confirming",
    generation: 1,
    terminalAt: null,
    ...value,
  };
}

describe("knowledge-base build source lifecycle", () => {
  let assetRoot: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    assetRoot = await mkdtemp(path.join(os.tmpdir(), "kb-source-lifecycle-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
  });

  afterEach(async () => {
    if (previous === undefined)
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    else process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previous;
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function retain(generation = 1) {
    return persistKnowledgeBaseBuildSource({
      userId,
      buildId,
      generation,
      bytes: Buffer.from(`retained generation ${generation}`, "utf8"),
    });
  }

  it("never deletes an active build, even when a stale terminal marker exists", async () => {
    const retained = await retain();
    await markKnowledgeBaseBuildSourcesTerminal({
      userId,
      buildId,
      reason: "reset",
      terminalAt,
    });
    const resolveBuildLifecycle = vi
      .fn()
      .mockResolvedValue(lifecycle({ status: "confirming" }));

    await expect(
      sweepKnowledgeBaseBuildSources({
        now: sweepAt,
        resolveBuildLifecycle,
      }),
    ).resolves.toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, retained.contentSha256)),
    ).resolves.toEqual(Buffer.from("retained generation 1"));
    expect(resolveBuildLifecycle).toHaveBeenCalledTimes(1);
  });

  it("retains a recently published build until the full 30 days have elapsed", async () => {
    const retained = await retain();
    const resolveBuildLifecycle = vi.fn().mockResolvedValue(
      lifecycle({
        status: "published",
        terminalAt: new Date("2026-06-15T00:00:00.000Z"),
      }),
    );

    const result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, retained.contentSha256)),
    ).resolves.toBeTruthy();
  });

  it("deletes only the exact generation after two published-state checks", async () => {
    const oldGeneration = await retain(1);
    const currentGeneration = await retain(2);
    const resolveBuildLifecycle = vi.fn(async ({ generation }) =>
      generation === 1
        ? lifecycle({
            status: "published",
            generation: 1,
            terminalAt,
          })
        : lifecycle({ status: "confirming", generation: 2 }),
    );

    const result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 2, deleted: 1, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, oldGeneration.contentSha256)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(sourcePath(assetRoot, 2, currentGeneration.contentSha256)),
    ).resolves.toBeTruthy();
    expect(resolveBuildLifecycle).toHaveBeenCalledTimes(3);
  });

  it("does not let an old marker bypass a live build generation fence", async () => {
    const oldGeneration = await retain(1);
    await markKnowledgeBaseBuildSourcesTerminal({
      userId,
      buildId,
      reason: "published",
      terminalAt,
    });
    const resolveBuildLifecycle = vi.fn().mockResolvedValue(
      lifecycle({
        status: "published",
        generation: 2,
        terminalAt,
      }),
    );

    const result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, oldGeneration.contentSha256)),
    ).resolves.toBeTruthy();
    expect(resolveBuildLifecycle).toHaveBeenCalledTimes(1);
  });

  it("requires a reset marker when the build row no longer exists", async () => {
    const retained = await retain();
    const missing = lifecycle({
      exists: false,
      status: null,
      generation: null,
      terminalAt: null,
    });
    const resolveBuildLifecycle = vi.fn().mockResolvedValue(missing);

    let result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });

    await markKnowledgeBaseBuildSourcesTerminal({
      userId,
      buildId,
      reason: "reset",
      terminalAt,
    });
    result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 1, deleted: 1, retained: 0, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, retained.contentSha256)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts deletion when the second DB fence observes an active build", async () => {
    const retained = await retain();
    const resolveBuildLifecycle = vi
      .fn()
      .mockResolvedValueOnce(
        lifecycle({ status: "published", terminalAt, generation: 1 }),
      )
      .mockResolvedValueOnce(
        lifecycle({ status: "confirming", generation: 1 }),
      );

    const result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle,
    });
    expect(result).toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, retained.contentSha256)),
    ).resolves.toBeTruthy();
    expect(resolveBuildLifecycle).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a malformed immutable marker", async () => {
    const retained = await retain();
    const generationPath = path.dirname(
      sourcePath(assetRoot, 1, retained.contentSha256),
    );
    await mkdir(generationPath, { recursive: true });
    await writeFile(
      path.join(generationPath, ".retention-terminal.json"),
      "not-json",
    );
    await expect(
      markKnowledgeBaseBuildSourcesTerminal({
        userId,
        buildId,
        reason: "reset",
        terminalAt,
      }),
    ).resolves.toEqual({ generations: 1, marked: 0, failed: 1 });

    const missing = lifecycle({
      exists: false,
      status: null,
      generation: null,
      terminalAt: null,
    });
    const result = await sweepKnowledgeBaseBuildSources({
      now: sweepAt,
      resolveBuildLifecycle: vi.fn().mockResolvedValue(missing),
    });
    expect(result).toEqual({ scanned: 1, deleted: 0, retained: 1, failed: 0 });
    await expect(
      readFile(sourcePath(assetRoot, 1, retained.contentSha256)),
    ).resolves.toBeTruthy();
  });
});
