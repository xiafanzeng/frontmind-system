import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KnowledgeBuildArtifactError,
  knowledgeBuildArtifactStorageKey,
  knowledgeBuildArtifactStorageKeyBelongsTo,
  listStaleKnowledgeBuildArtifactCandidates,
  persistKnowledgeBuildArtifact,
  readKnowledgeBuildArtifact,
  stageKnowledgeBuildArtifact,
} from "./knowledge-build-artifact-store";

const buildId = "10000000-0000-4000-8000-000000000001";
let assetRoot = "";
let previousAssetRoot: string | undefined;

beforeEach(async () => {
  assetRoot = await mkdtemp(path.join(tmpdir(), "frontmind-kb-build-"));
  previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
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

describe("knowledge build immutable artifacts", () => {
  it("persists and verifies one decodable Logo", async () => {
    const logo = await sharp({
      create: {
        width: 32,
        height: 16,
        channels: 4,
        background: "#582080",
      },
    })
      .png()
      .toBuffer();
    const stored = await persistKnowledgeBuildArtifact({
      userId: 7,
      buildId,
      generation: 1,
      kind: "logo",
      buffer: logo,
    });
    expect(stored).toMatchObject({
      bytes: logo.length,
      width: 32,
      height: 16,
      format: "png",
    });
    expect(
      await readKnowledgeBuildArtifact({
        userId: 7,
        buildId,
        generation: 1,
        kind: "logo",
        expectedSha256: stored.sha256,
        expectedBytes: stored.bytes,
      }),
    ).toEqual(logo);
  });

  it("normalizes sharp's HEIF container metadata for a real AVIF Logo", async () => {
    const logo = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: "#582080",
      },
    })
      .avif()
      .toBuffer();
    const stored = await persistKnowledgeBuildArtifact({
      userId: 7,
      buildId,
      generation: 5,
      kind: "logo",
      buffer: logo,
    });

    expect(stored).toMatchObject({
      bytes: logo.length,
      width: 256,
      height: 256,
      format: "avif",
    });
  });

  it("persists the final ZIP idempotently and rejects changed bytes", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    const first = await zip.generateAsync({ type: "nodebuffer" });
    const stored = await persistKnowledgeBuildArtifact({
      userId: 7,
      buildId,
      generation: 2,
      kind: "package",
      buffer: first,
    });
    await expect(
      persistKnowledgeBuildArtifact({
        userId: 7,
        buildId,
        generation: 2,
        kind: "package",
        buffer: first,
      }),
    ).resolves.toMatchObject({ sha256: stored.sha256 });

    const secondZip = new JSZip();
    secondZip.file("manifest.json", '{"changed":true}');
    const second = await secondZip.generateAsync({ type: "nodebuffer" });
    await expect(
      persistKnowledgeBuildArtifact({
        userId: 7,
        buildId,
        generation: 2,
        kind: "package",
        buffer: second,
      }),
    ).rejects.toThrow(KnowledgeBuildArtifactError);
  });

  it("isolates replacement bytes for one descriptor by operation and byte hash", async () => {
    const first = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: "#111111",
      },
    })
      .png()
      .toBuffer();
    const second = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: "#eeeeee",
      },
    })
      .png()
      .toBuffer();
    const common = {
      userId: 7,
      buildId,
      generation: 4,
      turnId: "turn-replacement",
      operationKey: "operation-replacement",
      descriptorHash: "a".repeat(64),
      kind: "logo" as const,
    };
    const firstStored = await stageKnowledgeBuildArtifact({
      ...common,
      buffer: first,
    });
    const secondStored = await stageKnowledgeBuildArtifact({
      ...common,
      buffer: second,
    });
    expect(secondStored.storageKey).not.toBe(firstStored.storageKey);
    for (const [stored, bytes] of [
      [firstStored, first],
      [secondStored, second],
    ] as const) {
      expect(
        knowledgeBuildArtifactStorageKeyBelongsTo({
          ...common,
          storageKey: stored.storageKey,
        }),
      ).toBe(true);
      await expect(
        readKnowledgeBuildArtifact({
          userId: 7,
          buildId,
          generation: 4,
          kind: "logo",
          storageKey: stored.storageKey,
          expectedSha256: stored.sha256,
          expectedBytes: stored.bytes,
        }),
      ).resolves.toEqual(bytes);
    }

    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(path.join(assetRoot, firstStored.storageKey), old, old);
    const stale = await listStaleKnowledgeBuildArtifactCandidates({
      olderThan: new Date(Date.now() - 24 * 60 * 60 * 1_000),
    });
    expect(stale.map((candidate) => candidate.storageKey)).toEqual([
      firstStored.storageKey,
    ]);
  });

  it("never derives a path outside the durable asset root", () => {
    expect(
      knowledgeBuildArtifactStorageKey({
        userId: 7,
        buildId,
        generation: 3,
        kind: "package",
      }),
    ).toBe(
      "knowledge-builds/7/10000000-0000-4000-8000-000000000001/generation-3/knowledge-base.zip",
    );
    expect(() =>
      knowledgeBuildArtifactStorageKey({
        userId: 7,
        buildId: "../../etc",
        generation: 3,
        kind: "package",
      }),
    ).toThrow("构建标识无效");
  });
});
