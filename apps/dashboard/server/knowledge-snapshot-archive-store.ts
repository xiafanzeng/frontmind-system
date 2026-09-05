import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { installImmutableFileAtomically } from "./atomic-immutable-file";

export const MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES = 250 * 1024 * 1024;

export class KnowledgeSnapshotArchiveError extends Error {
  constructor(
    public readonly code:
      | "ARCHIVE_NOT_FOUND"
      | "ARCHIVE_INVALID"
      | "ARCHIVE_INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeSnapshotArchiveError";
  }
}

function dashboardAssetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertSnapshotIdentity(userId: number, snapshotId: string) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INVALID",
      "知识库归档所属用户无效",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      snapshotId,
    )
  ) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INVALID",
      "知识库版本标识无效",
    );
  }
}

export function knowledgeSnapshotArchiveStorageKey(
  userId: number,
  snapshotId: string,
) {
  assertSnapshotIdentity(userId, snapshotId);
  return path.join("knowledge-archives", String(userId), `${snapshotId}.zip`);
}

function archiveAbsolutePath(userId: number, snapshotId: string) {
  const root = dashboardAssetRoot();
  const absolutePath = path.resolve(
    root,
    knowledgeSnapshotArchiveStorageKey(userId, snapshotId),
  );
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INVALID",
      "知识库归档路径无效",
    );
  }
  return absolutePath;
}

export function hasZipMagic(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return false;
  }
  return (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertArchiveBytes(input: {
  buffer: Buffer;
  expectedSha256: string;
  expectedBytes?: number;
}) {
  if (
    input.buffer.length === 0 ||
    input.buffer.length > MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES ||
    !hasZipMagic(input.buffer)
  ) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INVALID",
      "知识库成品不是有效的 ZIP 归档",
    );
  }
  if (
    input.expectedBytes !== undefined &&
    input.buffer.length !== input.expectedBytes
  ) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INTEGRITY_MISMATCH",
      "知识库 ZIP 字节数与已发布版本不一致",
    );
  }
  if (
    !/^[a-f0-9]{64}$/i.test(input.expectedSha256) ||
    sha256(input.buffer) !== input.expectedSha256.toLowerCase()
  ) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INTEGRITY_MISMATCH",
      "知识库 ZIP 哈希与已发布版本不一致",
    );
  }
}

export async function persistKnowledgeSnapshotArchive(input: {
  userId: number;
  snapshotId: string;
  buffer: Buffer;
  expectedSha256: string;
}) {
  assertArchiveBytes({
    buffer: input.buffer,
    expectedSha256: input.expectedSha256,
  });
  const absolutePath = archiveAbsolutePath(input.userId, input.snapshotId);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const installResult = await installImmutableFileAtomically({
    target: absolutePath,
    buffer: input.buffer,
  });
  if (installResult === "exists") {
    const existing = await readFile(absolutePath);
    assertArchiveBytes({
      buffer: existing,
      expectedSha256: input.expectedSha256,
    });
  }
  return knowledgeSnapshotArchiveStorageKey(input.userId, input.snapshotId);
}

export async function readKnowledgeSnapshotArchive(input: {
  userId: number;
  snapshotId: string;
  expectedSha256: string;
  expectedBytes: number;
}) {
  const absolutePath = archiveAbsolutePath(input.userId, input.snapshotId);
  let archiveStat;
  try {
    archiveStat = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KnowledgeSnapshotArchiveError(
        "ARCHIVE_NOT_FOUND",
        "该知识库版本尚无可下载的 ZIP 归档",
      );
    }
    throw error;
  }
  if (
    !archiveStat.isFile() ||
    archiveStat.size <= 0 ||
    archiveStat.size > MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES ||
    archiveStat.size !== input.expectedBytes
  ) {
    throw new KnowledgeSnapshotArchiveError(
      "ARCHIVE_INTEGRITY_MISMATCH",
      "知识库 ZIP 文件大小与已发布版本不一致",
    );
  }
  const buffer = await readFile(absolutePath);
  assertArchiveBytes({
    buffer,
    expectedSha256: input.expectedSha256,
    expectedBytes: input.expectedBytes,
  });
  return buffer;
}

export async function isKnowledgeSnapshotArchiveAvailable(input: {
  userId: number;
  snapshotId: string;
  expectedBytes?: number;
}) {
  const absolutePath = archiveAbsolutePath(input.userId, input.snapshotId);
  let archiveStat;
  try {
    archiveStat = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !archiveStat.isFile() ||
    archiveStat.size <= 0 ||
    archiveStat.size > MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES
  ) {
    return false;
  }
  return (
    input.expectedBytes === undefined ||
    archiveStat.size === input.expectedBytes
  );
}

export async function removeKnowledgeSnapshotArchive(input: {
  userId: number;
  snapshotId: string;
}) {
  try {
    await unlink(archiveAbsolutePath(input.userId, input.snapshotId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function knowledgeArchiveContentDisposition(filename: string) {
  const safe =
    path
      .basename(String(filename || ""))
      .replace(/[\\/\0"\r\n]/g, "_")
      .trim() || "knowledge-base.zip";
  const zipName = safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
  const encoded = encodeURIComponent(zipName);
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}
