import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KnowledgeSnapshotArchiveError,
  isKnowledgeSnapshotArchiveAvailable,
  knowledgeArchiveContentDisposition,
  knowledgeSnapshotArchiveStorageKey,
  persistKnowledgeSnapshotArchive,
  readKnowledgeSnapshotArchive,
} from "./knowledge-snapshot-archive-store";

const snapshotId = "00000000-0000-4000-8000-000000000123";
let assetRoot = "";
let previousAssetRoot: string | undefined;

beforeEach(async () => {
  assetRoot = await mkdtemp(
    path.join(tmpdir(), "frontmind-knowledge-archive-store-"),
  );
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

async function archiveBytes() {
  const zip = new JSZip();
  zip.file("company_knowledge_base/README.md", "# 企业知识库");
  return zip.generateAsync({ type: "nodebuffer" });
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("published knowledge snapshot archive store", () => {
  it("persists and reads the exact immutable ZIP by snapshot identity", async () => {
    const buffer = await archiveBytes();
    const expectedSha256 = sha256(buffer);

    await persistKnowledgeSnapshotArchive({
      userId: 42,
      snapshotId,
      buffer,
      expectedSha256,
    });

    await expect(
      readKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        expectedSha256,
        expectedBytes: buffer.length,
      }),
    ).resolves.toEqual(buffer);
  });

  it("reports availability only for a regular file with the expected byte count", async () => {
    const buffer = await archiveBytes();
    const expectedSha256 = sha256(buffer);

    await expect(
      isKnowledgeSnapshotArchiveAvailable({
        userId: 42,
        snapshotId,
        expectedBytes: buffer.length,
      }),
    ).resolves.toBe(false);

    await persistKnowledgeSnapshotArchive({
      userId: 42,
      snapshotId,
      buffer,
      expectedSha256,
    });

    await expect(
      isKnowledgeSnapshotArchiveAvailable({
        userId: 42,
        snapshotId,
        expectedBytes: buffer.length,
      }),
    ).resolves.toBe(true);
    await expect(
      isKnowledgeSnapshotArchiveAvailable({
        userId: 42,
        snapshotId,
        expectedBytes: buffer.length + 1,
      }),
    ).resolves.toBe(false);
  });

  it("rejects stored bytes whose ZIP hash no longer matches the snapshot", async () => {
    const buffer = await archiveBytes();
    const expectedSha256 = sha256(buffer);
    await persistKnowledgeSnapshotArchive({
      userId: 42,
      snapshotId,
      buffer,
      expectedSha256,
    });
    const key = knowledgeSnapshotArchiveStorageKey(42, snapshotId);
    const tampered = Buffer.from(buffer);
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(path.join(assetRoot, key), tampered);

    await expect(
      readKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        expectedSha256,
        expectedBytes: buffer.length,
      }),
    ).rejects.toMatchObject<Partial<KnowledgeSnapshotArchiveError>>({
      code: "ARCHIVE_INTEGRITY_MISMATCH",
    });
  });

  it("rejects a stored file with the expected size and hash metadata but no ZIP signature", async () => {
    const buffer = await archiveBytes();
    const expectedSha256 = sha256(buffer);
    await persistKnowledgeSnapshotArchive({
      userId: 42,
      snapshotId,
      buffer,
      expectedSha256,
    });
    const invalid = Buffer.alloc(buffer.length, 0x61);
    await writeFile(
      path.join(assetRoot, knowledgeSnapshotArchiveStorageKey(42, snapshotId)),
      invalid,
    );

    await expect(
      readKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        expectedSha256,
        expectedBytes: buffer.length,
      }),
    ).rejects.toMatchObject<Partial<KnowledgeSnapshotArchiveError>>({
      code: "ARCHIVE_INVALID",
    });
  });

  it("rejects a ZIP whose persisted byte count differs from the snapshot", async () => {
    const buffer = await archiveBytes();
    const expectedSha256 = sha256(buffer);
    await persistKnowledgeSnapshotArchive({
      userId: 42,
      snapshotId,
      buffer,
      expectedSha256,
    });

    await expect(
      readKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        expectedSha256,
        expectedBytes: buffer.length + 1,
      }),
    ).rejects.toMatchObject<Partial<KnowledgeSnapshotArchiveError>>({
      code: "ARCHIVE_INTEGRITY_MISMATCH",
    });
  });

  it("returns a safe UTF-8 attachment filename", () => {
    const disposition = knowledgeArchiveContentDisposition(
      "企业知识库\r\nunsafe.zip",
    );
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain(
      "filename*=UTF-8''%E4%BC%81%E4%B8%9A%E7%9F%A5%E8%AF%86%E5%BA%93__unsafe.zip",
    );
    expect(disposition).not.toMatch(/[\r\n]/);
  });
});
