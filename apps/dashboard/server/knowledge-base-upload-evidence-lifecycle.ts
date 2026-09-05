import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { knowledgeBaseBuilds } from "../drizzle/schema";
import { getDb } from "./db";

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const USER_ID_PATTERN = /^[1-9][0-9]*$/u;
const GENERATION_PATTERN = /^generation-([1-9][0-9]*)$/u;

export const DEFAULT_KNOWLEDGE_BASE_UPLOAD_EVIDENCE_SWEEP_LIMIT = 50;
export const KNOWLEDGE_BASE_UPLOAD_EVIDENCE_ORPHAN_GRACE_MS =
  24 * 60 * 60 * 1_000;

export type KnowledgeBaseUploadEvidenceCoordinate = {
  userId: number;
  buildId: string;
  generation: number;
};

type KnowledgeBaseLifecycleDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

export type KnowledgeBaseUploadEvidenceRemoval =
  | "removed"
  | "missing"
  | "active";

type KnowledgeBaseUploadEvidenceSweepRemoval =
  | KnowledgeBaseUploadEvidenceRemoval
  | "deferred_young";

function dashboardAssetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertCoordinate(input: KnowledgeBaseUploadEvidenceCoordinate) {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !BUILD_ID_PATTERN.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    throw new Error("知识库上传证据目录坐标无效");
  }
}

/**
 * This exact directory is the only recursively removable local-asset scope.
 * Logo/package siblings and operation candidates remain outside this scope.
 */
export function knowledgeBaseUploadEvidenceStorageKey(
  input: KnowledgeBaseUploadEvidenceCoordinate,
) {
  assertCoordinate(input);
  return path.posix.join(
    "knowledge-builds",
    String(input.userId),
    input.buildId,
    `generation-${input.generation}`,
    "upload-evidence",
  );
}

export function optionalKnowledgeBaseUploadEvidenceStorageKey(
  input: KnowledgeBaseUploadEvidenceCoordinate,
) {
  try {
    return knowledgeBaseUploadEvidenceStorageKey(input);
  } catch {
    // Legacy non-UUID builds predate durable evidence and therefore have no
    // valid evidence scope to queue. Their existing Logo/package cleanup must
    // remain available instead of failing the entire reset/retention action.
    return null;
  }
}

export function parseKnowledgeBaseUploadEvidenceStorageKey(
  storageKey: string,
): KnowledgeBaseUploadEvidenceCoordinate | null {
  const value = String(storageKey || "");
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return null;
  }
  const segments = value.split("/");
  if (
    segments.length !== 5 ||
    segments[0] !== "knowledge-builds" ||
    !USER_ID_PATTERN.test(segments[1] || "") ||
    !BUILD_ID_PATTERN.test(segments[2] || "") ||
    segments[4] !== "upload-evidence"
  ) {
    return null;
  }
  const generationMatch = (segments[3] || "").match(GENERATION_PATTERN);
  if (!generationMatch) return null;
  const coordinate = {
    userId: Number(segments[1]),
    buildId: segments[2]!,
    generation: Number(generationMatch[1]),
  };
  try {
    assertCoordinate(coordinate);
    return coordinate;
  } catch {
    return null;
  }
}

function evidenceAbsolutePath(assetRoot: string, storageKey: string) {
  const coordinate = parseKnowledgeBaseUploadEvidenceStorageKey(storageKey);
  if (!coordinate) throw new Error("知识库上传证据清理范围无效");
  const canonicalKey = knowledgeBaseUploadEvidenceStorageKey(coordinate);
  if (canonicalKey !== storageKey) {
    throw new Error("知识库上传证据清理范围不是规范路径");
  }
  const target = path.resolve(assetRoot, ...canonicalKey.split("/"));
  if (!target.startsWith(`${assetRoot}${path.sep}`)) {
    throw new Error("知识库上传证据清理路径越界");
  }
  return { coordinate, target };
}

function evidenceScopeIsTooYoung(
  metadata: Awaited<ReturnType<typeof lstat>>,
  deferModifiedAfterMs: number | undefined,
) {
  if (deferModifiedAfterMs === undefined) return false;
  if (!Number.isFinite(metadata.mtimeMs)) {
    throw new Error("知识库上传证据目录修改时间无效");
  }
  return metadata.mtimeMs > deferModifiedAfterMs;
}

async function safeRemoveEvidenceDirectory(input: {
  assetRoot: string;
  storageKey: string;
  deferModifiedAfterMs?: number;
}): Promise<Exclude<KnowledgeBaseUploadEvidenceSweepRemoval, "active">> {
  const { target } = evidenceAbsolutePath(input.assetRoot, input.storageKey);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(input.assetRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }

  const relative = path.relative(input.assetRoot, target);
  let current = input.assetRoot;
  let targetMetadata: Awaited<ReturnType<typeof lstat>> | null = null;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const isTarget = index === segments.length - 1;
    if (isTarget) targetMetadata = metadata;
    if (
      isTarget &&
      evidenceScopeIsTooYoung(metadata, input.deferModifiedAfterMs)
    ) {
      return "deferred_young";
    }
    if (metadata.isSymbolicLink()) {
      if (!isTarget) {
        throw new Error("知识库上传证据路径包含符号链接");
      }
      // Removing the link itself is safe and never follows its destination.
      await unlink(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return "removed";
    }
    if (!metadata.isDirectory()) {
      throw new Error("知识库上传证据路径包含非目录节点");
    }
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("知识库上传证据真实路径越界");
  }
  let finalMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    finalMetadata = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (
    !targetMetadata ||
    finalMetadata.isSymbolicLink() ||
    !finalMetadata.isDirectory() ||
    finalMetadata.dev !== targetMetadata.dev ||
    finalMetadata.ino !== targetMetadata.ino
  ) {
    throw new Error("知识库上传证据目录在清理前发生变化");
  }
  if (evidenceScopeIsTooYoung(finalMetadata, input.deferModifiedAfterMs)) {
    return "deferred_young";
  }
  await rm(target, { recursive: true, force: true });
  return "removed";
}

async function removeWithBuildLock(input: {
  db: KnowledgeBaseLifecycleDb;
  assetRoot: string;
  storageKey: string;
  coordinate: KnowledgeBaseUploadEvidenceCoordinate;
  deferModifiedAfterMs?: number;
}): Promise<KnowledgeBaseUploadEvidenceSweepRemoval> {
  return input.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: knowledgeBaseBuilds.id })
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.coordinate.buildId),
          eq(knowledgeBaseBuilds.userId, input.coordinate.userId),
          eq(knowledgeBaseBuilds.generation, input.coordinate.generation),
        ),
      )
      .limit(1)
      .for("update");
    if (rows[0]) return "active" as const;
    return safeRemoveEvidenceDirectory(input);
  });
}

/**
 * Delete one strict evidence scope only while an exact build coordinate is
 * absent under a row/gap lock. Missing paths are successful idempotent cleanup.
 */
export async function removeKnowledgeBaseUploadEvidenceIfOrphaned(input: {
  storageKey: string;
  expectedUserId?: number;
  db?: KnowledgeBaseLifecycleDb;
  assetRoot?: string;
}): Promise<KnowledgeBaseUploadEvidenceRemoval> {
  const coordinate = parseKnowledgeBaseUploadEvidenceStorageKey(
    input.storageKey,
  );
  if (!coordinate) throw new Error("知识库上传证据清理范围无效");
  if (
    input.expectedUserId !== undefined &&
    coordinate.userId !== input.expectedUserId
  ) {
    throw new Error("知识库上传证据清理用户不匹配");
  }
  const db = input.db ?? ((await getDb()) as KnowledgeBaseLifecycleDb | null);
  if (!db) throw new Error("数据库暂不可用，无法核验上传证据孤儿状态");
  const removal = await removeWithBuildLock({
    db,
    assetRoot: path.resolve(input.assetRoot || dashboardAssetRoot()),
    storageKey: input.storageKey,
    coordinate,
  });
  if (removal === "deferred_young") {
    throw new Error("显式上传证据清理不得进入孤儿宽限状态");
  }
  return removal;
}

async function strictDirectoryEntries(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function discoverEvidenceScopes(input: {
  assetRoot: string;
  after: string;
  limit: number;
}) {
  const candidates: string[] = [];
  const knowledgeRoot = path.join(input.assetRoot, "knowledge-builds");
  for (const userEntry of await strictDirectoryEntries(knowledgeRoot)) {
    if (!USER_ID_PATTERN.test(userEntry.name)) continue;
    const userRoot = path.join(knowledgeRoot, userEntry.name);
    for (const buildEntry of await strictDirectoryEntries(userRoot)) {
      if (!BUILD_ID_PATTERN.test(buildEntry.name)) continue;
      const buildRoot = path.join(userRoot, buildEntry.name);
      for (const generationEntry of await strictDirectoryEntries(buildRoot)) {
        if (!GENERATION_PATTERN.test(generationEntry.name)) continue;
        const evidence = path.join(
          buildRoot,
          generationEntry.name,
          "upload-evidence",
        );
        let metadata;
        try {
          metadata = await lstat(evidence);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!metadata.isDirectory() && !metadata.isSymbolicLink()) continue;
        const storageKey = path
          .relative(input.assetRoot, evidence)
          .split(path.sep)
          .join("/");
        if (storageKey <= input.after) continue;
        candidates.push(storageKey);
        if (candidates.length >= input.limit) return candidates;
      }
    }
  }
  return candidates;
}

let orphanSweepCursor = "";

export type KnowledgeBaseUploadEvidenceSweepResult = {
  scanned: number;
  removed: number;
  missing: number;
  active: number;
  deferredYoung: number;
  failed: number;
  truncated: boolean;
  nextCursor: string;
};

/**
 * Periodic fallback for rows removed by account deletion or an interrupted
 * reset/retention cleanup. The cursor prevents a stable active prefix from
 * starving later orphan directories, while every pass remains bounded.
 */
export async function sweepOrphanedKnowledgeBaseUploadEvidence(input?: {
  db?: KnowledgeBaseLifecycleDb;
  assetRoot?: string;
  limit?: number;
  cursor?: string;
  now?: Date;
}): Promise<KnowledgeBaseUploadEvidenceSweepResult> {
  const limit =
    input?.limit ?? DEFAULT_KNOWLEDGE_BASE_UPLOAD_EVIDENCE_SWEEP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("知识库上传证据孤儿清理批大小无效");
  }
  const nowMs = (input?.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("知识库上传证据孤儿清理时间无效");
  }
  const db = input?.db ?? ((await getDb()) as KnowledgeBaseLifecycleDb | null);
  if (!db) throw new Error("数据库暂不可用，无法扫描上传证据孤儿");
  const assetRoot = path.resolve(input?.assetRoot || dashboardAssetRoot());
  const cursor = input?.cursor ?? orphanSweepCursor;
  let discovered = await discoverEvidenceScopes({
    assetRoot,
    after: cursor,
    limit: limit + 1,
  });
  if (discovered.length === 0 && cursor) {
    discovered = await discoverEvidenceScopes({
      assetRoot,
      after: "",
      limit: limit + 1,
    });
  }
  const truncated = discovered.length > limit;
  const candidates = discovered.slice(0, limit);
  const result: KnowledgeBaseUploadEvidenceSweepResult = {
    scanned: candidates.length,
    removed: 0,
    missing: 0,
    active: 0,
    deferredYoung: 0,
    failed: 0,
    truncated,
    nextCursor: truncated ? candidates.at(-1) || "" : "",
  };
  for (const storageKey of candidates) {
    try {
      const coordinate = parseKnowledgeBaseUploadEvidenceStorageKey(storageKey);
      if (!coordinate) throw new Error("知识库上传证据清理范围无效");
      const removal = await removeWithBuildLock({
        storageKey,
        db,
        assetRoot,
        coordinate,
        // A builder may create the durable directory immediately before its
        // DB row becomes visible. Only the periodic fallback has this grace;
        // explicit reset/retention jobs already prove intent and delete now.
        deferModifiedAfterMs:
          nowMs - KNOWLEDGE_BASE_UPLOAD_EVIDENCE_ORPHAN_GRACE_MS,
      });
      if (removal === "deferred_young") result.deferredYoung += 1;
      else result[removal] += 1;
    } catch {
      // Periodic sweeps are the durable retry mechanism for account-deletion
      // orphans, whose user-cascaded cleanup jobs cannot survive in MySQL.
      result.failed += 1;
    }
  }
  if (input?.cursor === undefined) orphanSweepCursor = result.nextCursor;
  return result;
}
