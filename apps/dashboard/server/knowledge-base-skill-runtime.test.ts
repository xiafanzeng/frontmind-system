import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getKnowledgeBaseSkillDescriptor,
  readKnowledgeBasePinnedSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";

describe("knowledge-base durable physical Skill pins", () => {
  let assetRoot: string;
  let previousAssetRoot: string | undefined;

  beforeEach(async () => {
    previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    assetRoot = await mkdtemp(path.join(os.tmpdir(), "kb-skill-pin-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
  });

  afterEach(async () => {
    if (previousAssetRoot === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
    }
    await rm(assetRoot, { recursive: true, force: true });
  });

  it("installs a new-build descriptor into persistent relative asset storage", async () => {
    const descriptor = await getKnowledgeBaseSkillDescriptor();

    expect(path.isAbsolute(descriptor.storageKey)).toBe(false);
    expect(descriptor.storageKey).toMatch(
      /^knowledge-base\/skill-archives\/[a-f0-9]{64}\.skill\.zip$/u,
    );
    await expect(
      readKnowledgeBasePinnedSkillArchiveAttachment({
        version: descriptor.version,
        contentHash: descriptor.contentHash,
        physicalSha256: descriptor.physicalSha256,
        archiveBytes: descriptor.archiveBytes,
        storageKey: descriptor.storageKey,
      }),
    ).resolves.toMatchObject({
      contentHash: descriptor.contentHash,
      physicalSha256: descriptor.physicalSha256,
      archiveBytes: descriptor.archiveBytes,
      storageKey: descriptor.storageKey,
    });
  });

  it("never falls back to a release alias when a durable pin is missing or corrupt", async () => {
    const descriptor = await getKnowledgeBaseSkillDescriptor();
    const retainedPath = path.join(assetRoot, descriptor.storageKey);
    await rm(retainedPath);

    await expect(
      readKnowledgeBasePinnedSkillArchiveAttachment({
        version: descriptor.version,
        contentHash: descriptor.contentHash,
        physicalSha256: descriptor.physicalSha256,
        archiveBytes: descriptor.archiveBytes,
        storageKey: descriptor.storageKey,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await writeFile(retainedPath, Buffer.alloc(descriptor.archiveBytes, 1));
    await expect(
      readKnowledgeBasePinnedSkillArchiveAttachment({
        version: descriptor.version,
        contentHash: descriptor.contentHash,
        physicalSha256: descriptor.physicalSha256,
        archiveBytes: descriptor.archiveBytes,
        storageKey: descriptor.storageKey,
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("backfills legacy locators only when their physical proof matches", async () => {
    const descriptor = await getKnowledgeBaseSkillDescriptor();
    const backfilled = await readKnowledgeBasePinnedSkillArchiveAttachment({
      version: descriptor.version,
      contentHash: descriptor.contentHash,
      physicalSha256: descriptor.physicalSha256,
      archiveBytes: descriptor.archiveBytes,
      storageKey: "/old-release/private-workflows/socratic.skill",
    });
    expect(path.isAbsolute(backfilled.storageKey)).toBe(false);
    expect(backfilled.storageKey).toBe(descriptor.storageKey);

    await expect(
      readKnowledgeBasePinnedSkillArchiveAttachment({
        version: descriptor.version,
        contentHash: descriptor.contentHash,
        physicalSha256: "0".repeat(64),
        archiveBytes: descriptor.archiveBytes,
        storageKey: "/old-release/private-workflows/socratic.skill",
      }),
    ).rejects.toThrow("does not match the build physical pin");
  });

  it("rejects every pre-v5 runtime selection with reset-required", async () => {
    await expect(
      readKnowledgeBasePinnedSkillArchiveAttachment({
        version: "4",
        contentHash:
          "08d30fed3d992e6e52d3a7fdaba1e7ffd09e0c6d48052f400b12ac680f460fb3",
        physicalSha256:
          "86cf73a2270082fc020d23d1a76b056ba54b0c1f725550e53081acba81b85145",
        archiveBytes: 33_003,
        storageKey: null,
      }),
    ).rejects.toThrow("RESET_REQUIRED");
    await expect(
      getKnowledgeBaseSkillDescriptor({ version: "1" }),
    ).rejects.toThrow("RESET_REQUIRED");
  });
});
