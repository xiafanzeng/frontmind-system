import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata } from "sharp";

import {
  MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES,
  hasZipMagic,
} from "./knowledge-snapshot-archive-store";
import { installImmutableFileAtomically } from "./atomic-immutable-file";

const MAX_LOGO_BYTES = 100 * 1024 * 1024;
const MAX_LOGO_PIXELS = 40_000_000;
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type KnowledgeBuildArtifactKind = "logo" | "package";

export class KnowledgeBuildArtifactError extends Error {
  constructor(
    public readonly code:
      | "ARTIFACT_INVALID"
      | "ARTIFACT_NOT_FOUND"
      | "ARTIFACT_INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBuildArtifactError";
  }
}

function storageRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertIdentity(userId: number, buildId: string, generation: number) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库成品所属用户无效",
    );
  }
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库构建标识无效",
    );
  }
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库构建代次无效",
    );
  }
}

export function knowledgeBuildArtifactStorageKey(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
}) {
  assertIdentity(input.userId, input.buildId, input.generation);
  return path.join(
    "knowledge-builds",
    String(input.userId),
    input.buildId,
    `generation-${input.generation}`,
    input.kind === "logo" ? "official-logo.bin" : "knowledge-base.zip",
  );
}

/**
 * A Dashboard-owned package is immutable for a completed revision, not for an
 * entire build generation.  Legacy generations can legitimately reopen and
 * complete a later revision; reusing the compatibility package path in that
 * case would make the immutable-file install reject the new, correct ZIP.
 */
export function knowledgeBuildArtifactLocalPackageStorageKey(input: {
  userId: number;
  buildId: string;
  generation: number;
  revision: number;
}) {
  assertIdentity(input.userId, input.buildId, input.generation);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库本地成品版本无效",
    );
  }
  return path.join(
    "knowledge-builds",
    String(input.userId),
    input.buildId,
    `generation-${input.generation}`,
    "dashboard-local-packages",
    `revision-${input.revision}`,
    "knowledge-base.zip",
  );
}

function identityDigest(value: string, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      `知识库${label}无效`,
    );
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function assertSha256(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/iu.test(String(value || ""))) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      `知识库${label}哈希无效`,
    );
  }
}

/**
 * Provider bytes are first installed under one immutable operation candidate.
 * The byte digest is part of the key, so replacement bytes behind the same
 * provider file/descriptor identity cannot poison the build generation.
 */
export function knowledgeBuildArtifactCandidateStorageKey(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  descriptorHash: string;
  artifactSha256: string;
  kind: KnowledgeBuildArtifactKind;
}) {
  assertIdentity(input.userId, input.buildId, input.generation);
  assertSha256(input.descriptorHash, "资源描述");
  assertSha256(input.artifactSha256, "资源字节");
  return path.join(
    "knowledge-builds",
    String(input.userId),
    input.buildId,
    `generation-${input.generation}`,
    "operations",
    identityDigest(input.turnId, "轮次"),
    identityDigest(input.operationKey, "操作"),
    input.descriptorHash.toLowerCase(),
    input.artifactSha256.toLowerCase(),
    input.kind === "logo" ? "official-logo.bin" : "knowledge-base.zip",
  );
}

export function knowledgeBuildArtifactStorageKeyBelongsTo(input: {
  storageKey: string;
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
}) {
  try {
    assertIdentity(input.userId, input.buildId, input.generation);
    const normalized = path.normalize(String(input.storageKey || ""));
    const legacy = knowledgeBuildArtifactStorageKey(input);
    if (normalized === legacy) return true;
    const prefix = path.join(
      "knowledge-builds",
      String(input.userId),
      input.buildId,
      `generation-${input.generation}`,
      "operations",
    );
    const relative = path.relative(prefix, normalized);
    const segments = relative.split(path.sep);
    const localPackagePrefix = path.join(
      "knowledge-builds",
      String(input.userId),
      input.buildId,
      `generation-${input.generation}`,
      "dashboard-local-packages",
    );
    const localPackageRelative = path.relative(localPackagePrefix, normalized);
    const localPackageSegments = localPackageRelative.split(path.sep);
    const isDashboardLocalPackage =
      input.kind === "package" &&
      localPackageRelative !== "" &&
      !localPackageRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(localPackageRelative) &&
      localPackageSegments.length === 2 &&
      /^revision-[0-9]+$/u.test(localPackageSegments[0] || "") &&
      localPackageSegments[1] === "knowledge-base.zip";
    return (
      isDashboardLocalPackage ||
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      segments.length === 5 &&
      segments
        .slice(0, 4)
        .every((segment) => /^[a-f0-9]{64}$/u.test(segment)) &&
      segments[4] ===
        (input.kind === "logo" ? "official-logo.bin" : "knowledge-base.zip")
    );
  } catch {
    return false;
  }
}

function absolutePath(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  storageKey?: string;
}) {
  const root = storageRoot();
  const storageKey =
    input.storageKey || knowledgeBuildArtifactStorageKey(input);
  if (!knowledgeBuildArtifactStorageKeyBelongsTo({ ...input, storageKey })) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库成品存储标识与当前构建不匹配",
    );
  }
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "知识库成品存储路径无效",
    );
  }
  return resolved;
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertExpectedHash(expectedSha256: string, actualSha256: string) {
  if (
    !/^[a-f0-9]{64}$/iu.test(expectedSha256) ||
    expectedSha256.toLowerCase() !== actualSha256
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INTEGRITY_MISMATCH",
      "知识库成品字节哈希不一致",
    );
  }
}

async function validateArtifactBytes(
  kind: KnowledgeBuildArtifactKind,
  buffer: Buffer,
) {
  if (kind === "package") {
    if (
      buffer.length === 0 ||
      buffer.length > MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES ||
      !hasZipMagic(buffer)
    ) {
      throw new KnowledgeBuildArtifactError(
        "ARTIFACT_INVALID",
        "知识库最终成品不是有效 ZIP",
      );
    }
    return {};
  }

  if (buffer.length === 0 || buffer.length > MAX_LOGO_BYTES) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "企业官方主 Logo 文件为空或超过 100 MB",
    );
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, {
      limitInputPixels: MAX_LOGO_PIXELS,
      animated: false,
    }).metadata();
  } catch {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "企业官方主 Logo 不是可解码图片",
    );
  }
  const normalizedFormat =
    metadata.format === "heif" &&
    metadata.mediaType === "image/avif" &&
    metadata.compression === "av1"
      ? "avif"
      : metadata.format;
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_LOGO_PIXELS ||
    !["png", "jpeg", "webp", "avif", "gif"].includes(
      String(normalizedFormat || ""),
    )
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "企业官方主 Logo 图片格式或尺寸无效",
    );
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: normalizedFormat,
  };
}

export async function persistKnowledgeBuildArtifact(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  buffer: Buffer;
  expectedSha256?: string;
  storageKey?: string;
}) {
  const image = await validateArtifactBytes(input.kind, input.buffer);
  const digest = sha256(input.buffer);
  if (input.expectedSha256) {
    assertExpectedHash(input.expectedSha256, digest);
  }
  const target = absolutePath(input);
  await mkdir(path.dirname(target), { recursive: true });
  const installResult = await installImmutableFileAtomically({
    target,
    buffer: input.buffer,
  });
  if (installResult === "exists") {
    const existing = await readFile(target);
    assertExpectedHash(digest, sha256(existing));
  }
  return {
    storageKey: input.storageKey || knowledgeBuildArtifactStorageKey(input),
    sha256: digest,
    bytes: input.buffer.length,
    ...image,
  };
}

export async function stageKnowledgeBuildArtifact(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  descriptorHash: string;
  kind: KnowledgeBuildArtifactKind;
  buffer: Buffer;
  expectedSha256?: string;
}) {
  const image = await validateArtifactBytes(input.kind, input.buffer);
  const digest = sha256(input.buffer);
  if (input.expectedSha256) {
    assertExpectedHash(input.expectedSha256, digest);
  }
  const storageKey = knowledgeBuildArtifactCandidateStorageKey({
    ...input,
    artifactSha256: digest,
  });
  const target = absolutePath({ ...input, storageKey });
  await mkdir(path.dirname(target), { recursive: true });
  const installResult = await installImmutableFileAtomically({
    target,
    buffer: input.buffer,
  });
  if (installResult === "exists") {
    const existing = await readFile(target);
    assertExpectedHash(digest, sha256(existing));
  }
  return {
    storageKey,
    sha256: digest,
    bytes: input.buffer.length,
    ...image,
  };
}

export async function readKnowledgeBuildArtifact(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  expectedSha256: string;
  expectedBytes: number;
  storageKey?: string;
}) {
  const target = absolutePath(input);
  let fileStat;
  try {
    fileStat = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KnowledgeBuildArtifactError(
        "ARTIFACT_NOT_FOUND",
        "知识库构建成品尚未完成持久化",
      );
    }
    throw error;
  }
  if (
    !fileStat.isFile() ||
    !Number.isInteger(input.expectedBytes) ||
    input.expectedBytes <= 0 ||
    fileStat.size !== input.expectedBytes
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INTEGRITY_MISMATCH",
      "知识库构建成品字节数不一致",
    );
  }
  const buffer = await readFile(target);
  await validateArtifactBytes(input.kind, buffer);
  assertExpectedHash(input.expectedSha256, sha256(buffer));
  return buffer;
}

export async function removeKnowledgeBuildArtifact(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  storageKey?: string;
}) {
  await unlink(absolutePath(input)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export async function removeStagedKnowledgeBuildArtifact(input: {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  storageKey: string;
}) {
  if (
    path.normalize(input.storageKey) ===
    path.normalize(knowledgeBuildArtifactStorageKey(input))
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_INVALID",
      "不能通过暂存清理接口删除权威兼容工件",
    );
  }
  await unlink(absolutePath(input)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export interface StaleKnowledgeBuildArtifactCandidate {
  userId: number;
  buildId: string;
  generation: number;
  kind: KnowledgeBuildArtifactKind;
  storageKey: string;
  mtimeMs: number;
}

/**
 * Enumerate only operation candidate files under the strict storage grammar.
 * Deletion is deliberately performed by the DB-aware binding service after it
 * locks the owning build and rechecks both authoritative pointers.
 */
export async function listStaleKnowledgeBuildArtifactCandidates(input: {
  olderThan: Date;
  limit?: number;
}) {
  const root = storageRoot();
  const candidates: StaleKnowledgeBuildArtifactCandidate[] = [];
  const limit = Math.min(5_000, Math.max(1, Math.trunc(input.limit ?? 250)));
  const knowledgeRoot = path.join(root, "knowledge-builds");

  async function walk(directory: string, relativeSegments: string[]) {
    if (candidates.length >= limit || relativeSegments.length > 10) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (candidates.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const segments = [...relativeSegments, entry.name];
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // The fifth segment must be the literal operation-candidate boundary.
        if (segments.length === 4 && entry.name !== "operations") continue;
        await walk(target, segments);
        continue;
      }
      if (!entry.isFile() || segments.length !== 9) continue;
      const [rawUserId, buildId, generationSegment, operations, ...tail] =
        segments;
      if (
        operations !== "operations" ||
        !/^generation-[1-9][0-9]*$/u.test(generationSegment || "") ||
        !BUILD_ID_PATTERN.test(buildId || "") ||
        !tail.slice(0, 4).every((value) => /^[a-f0-9]{64}$/u.test(value)) ||
        (tail[4] !== "official-logo.bin" && tail[4] !== "knowledge-base.zip")
      ) {
        continue;
      }
      const userId = Number(rawUserId);
      const generation = Number((generationSegment || "").slice(11));
      if (!Number.isSafeInteger(userId) || userId <= 0) continue;
      if (!Number.isSafeInteger(generation) || generation <= 0) continue;
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.mtimeMs > input.olderThan.getTime()) {
        continue;
      }
      candidates.push({
        userId,
        buildId: buildId!,
        generation,
        kind: tail[4] === "official-logo.bin" ? "logo" : "package",
        storageKey: path.join("knowledge-builds", ...segments),
        mtimeMs: metadata.mtimeMs,
      });
    }
  }

  await walk(knowledgeRoot, []);
  return candidates;
}
