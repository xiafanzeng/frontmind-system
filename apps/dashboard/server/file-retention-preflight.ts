import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

import {
  FILE_CONTENT_RETENTION_MS,
  historicalKnowledgeBaseUserUploadReferenceSql,
  historicalMessageUserUploadReferenceSql,
} from "./file-content-retention";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ORIGINAL_VOLUME_RESERVE_BYTES = 64 * 1024 * 1024;
const PREPARED_VOLUME_MINIMUM_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;

type FileRow = RowDataPacket & {
  upstreamId: string;
  createdAt: Date;
  uploadedAt: Date | null;
  contentExpiresAt: Date | null;
  attachmentReferenced: number | string;
  knowledgeBaseUserUploadReferenced: number | string;
};

type ConversationInventoryRow = RowDataPacket & {
  conversations: number | string;
  messages: number | string;
};

type IndexRow = RowDataPacket & {
  Key_name: string;
  Seq_in_index: number;
  Column_name: string;
};

type ColumnRow = RowDataPacket & { Field: string };

export type FileRetentionMigrationPreflight = {
  uploadedAt: boolean;
  contentExpiresAt: boolean;
  contentDeletedAt: boolean;
  contentExpiryIndex: boolean;
  conversationResourceIndex: boolean;
  conversationIdleIndex: boolean;
};

export type FileRetentionVolumePreflight = {
  kind: "original" | "prepared";
  directory: string;
  writable: boolean;
  totalBytes: number;
  availableBytes: number;
  requiredBytes: number;
  enoughSpace: boolean;
  errorCode?: string;
};

export type FileRetentionPreflightReport = {
  mode: "read-only-preflight";
  observedAt: string;
  fileHardExpiry: {
    eligibleUserUploads: number;
    missingLifecycleUserUploads: number;
    invalidLifecycleUserUploads: number;
    expiredFiles: number;
    estimatedOriginalBytes: number;
    estimatedPreparedBytes: number;
    estimatedReclaimBytes: number;
  };
  conversationIdleExpiry: {
    cutoff: string;
    conversations: number;
    messages: number;
  };
  migration: FileRetentionMigrationPreflight;
  volumes: FileRetentionVolumePreflight[];
  ready: boolean;
};

export type FileRetentionPreflightReadiness = Omit<
  FileRetentionPreflightReport,
  "mode" | "volumes"
> & {
  volumes: Array<Omit<FileRetentionVolumePreflight, "directory" | "errorCode">>;
};

type FileRetentionPreflightInput = {
  databaseUrl?: string;
  connection?: Connection;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
};

function storageKey(fileId: string) {
  return createHash("sha256").update(fileId, "utf8").digest("hex");
}

function validTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

async function localUploadInventory(root: string, fileId: string) {
  const key = storageKey(fileId);
  const manifestPath = path.join(root, `${key}.json`);
  const contentPath = path.join(root, `${key}.content`);
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      state?: unknown;
      fileId?: unknown;
      uploadedAt?: unknown;
    };
    if (
      parsed.schemaVersion !== 1 ||
      parsed.state !== "stored" ||
      parsed.fileId !== fileId
    ) {
      return null;
    }
    const content = await fs.lstat(contentPath).catch(() => null);
    const uploadedAt = validTimestamp(parsed.uploadedAt);
    const localOrigin = content
      ? Math.min(
          ...[Number(content.birthtimeMs), Number(content.mtimeMs)].filter(
            (value) => Number.isFinite(value) && value > 0,
          ),
        )
      : undefined;
    return {
      uploadedAt:
        uploadedAt ?? (Number.isFinite(localOrigin) ? localOrigin : undefined),
      bytes: content?.isFile() ? Number(content.size) : 0,
    };
  } catch {
    return null;
  }
}

async function pathBytes(target: string): Promise<number> {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) return 0;
    if (stats.isFile()) return Number(stats.size);
    if (!stats.isDirectory()) return 0;
    const entries = await fs.readdir(target);
    let bytes = 0;
    for (const entry of entries) {
      bytes += await pathBytes(path.join(target, entry));
    }
    return bytes;
  } catch {
    return 0;
  }
}

async function preparedBytesForFiles(root: string, fileIds: Set<string>) {
  if (!fileIds.size) return 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const assetIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{40}\.json$/.test(entry.name)) continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(root, entry.name), "utf8"),
      ) as { version?: unknown; id?: unknown; source?: unknown };
      const source = manifest.source as
        | { kind?: unknown; fileId?: unknown }
        | undefined;
      if (
        manifest.version === 1 &&
        typeof manifest.id === "string" &&
        manifest.id === entry.name.slice(0, -5) &&
        source?.kind === "file" &&
        typeof source.fileId === "string" &&
        fileIds.has(source.fileId)
      ) {
        assetIds.add(manifest.id);
      }
    } catch {
      // Runtime reconciliation owns invalid-manifest diagnostics. This
      // read-only estimate never guesses ownership from malformed data.
    }
  }
  let bytes = 0;
  for (const entry of entries) {
    const assetId = entry.name.match(/^([a-f0-9]{40})(?:\.|$)/)?.[1];
    if (assetId && assetIds.has(assetId)) {
      bytes += await pathBytes(path.join(root, entry.name));
    }
  }
  return bytes;
}

function groupedIndexes(rows: IndexRow[]) {
  const indexes = new Map<string, string[]>();
  for (const row of rows) {
    const columns = indexes.get(row.Key_name) ?? [];
    columns[row.Seq_in_index - 1] = row.Column_name;
    indexes.set(row.Key_name, columns);
  }
  return indexes;
}

async function tableColumns(connection: Connection, table: string) {
  const [rows] = await connection.query<ColumnRow[]>(
    `SHOW COLUMNS FROM \`${table}\``,
  );
  return new Set(rows.map((row) => row.Field));
}

function volumeErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/u.test(error.code)
  ) {
    return error.code;
  }
  return "VOLUME_UNAVAILABLE";
}

async function inspectVolume(input: {
  kind: FileRetentionVolumePreflight["kind"];
  directory: string;
  reserve: (totalBytes: number) => number;
}): Promise<FileRetentionVolumePreflight> {
  try {
    await fs.access(input.directory, fsConstants.R_OK | fsConstants.W_OK);
    const stats = await fs.statfs(input.directory);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const requiredBytes = input.reserve(totalBytes);
    return {
      kind: input.kind,
      directory: input.directory,
      writable: true,
      totalBytes,
      availableBytes,
      requiredBytes,
      enoughSpace:
        Number.isSafeInteger(availableBytes) &&
        Number.isSafeInteger(totalBytes) &&
        availableBytes >= requiredBytes,
    };
  } catch (error) {
    return {
      kind: input.kind,
      directory: input.directory,
      writable: false,
      totalBytes: 0,
      availableBytes: 0,
      requiredBytes: input.reserve(0),
      enoughSpace: false,
      errorCode: volumeErrorCode(error),
    };
  }
}

async function fileInventory(connection: Connection, columns: Set<string>) {
  const uploadedAt = columns.has("uploadedAt")
    ? "ur.uploadedAt"
    : "NULL AS uploadedAt";
  const contentExpiresAt = columns.has("contentExpiresAt")
    ? "ur.contentExpiresAt"
    : "NULL AS contentExpiresAt";
  const knowledgeBaseUserUploadReference =
    historicalKnowledgeBaseUserUploadReferenceSql({
      resourceUserIdExpression: "ur.userId",
      resourceFileIdExpression: "ur.upstreamId",
      turnAlias: "retention_turn",
    });
  const messageUserUploadReference = historicalMessageUserUploadReferenceSql({
    resourceUserIdExpression: "ur.userId",
    resourceFileIdExpression: "ur.upstreamId",
    attachmentAlias: "retention_attachment",
    messageAlias: "retention_message",
  });
  const [rows] = await connection.query<FileRow[]>(
    `SELECT ur.upstreamId, ur.createdAt, ${uploadedAt}, ${contentExpiresAt},
            ${messageUserUploadReference} AS attachmentReferenced,
            ${knowledgeBaseUserUploadReference}
              AS knowledgeBaseUserUploadReferenced
       FROM upstream_resources ur
      WHERE ur.kind = 'file'`,
  );
  return rows;
}

export function fileRetentionPreflightReady(input: {
  migration: FileRetentionMigrationPreflight;
  missingLifecycleUserUploads: number;
  invalidLifecycleUserUploads: number;
  volumes: FileRetentionVolumePreflight[];
}) {
  return (
    Object.values(input.migration).every(Boolean) &&
    input.missingLifecycleUserUploads === 0 &&
    input.invalidLifecycleUserUploads === 0 &&
    input.volumes.length === 2 &&
    input.volumes.every((volume) => volume.writable && volume.enoughSpace)
  );
}

export async function inspectFileRetentionPreflight(
  input: FileRetentionPreflightInput = {},
): Promise<FileRetentionPreflightReport> {
  const env = input.env ?? process.env;
  const databaseUrl = input.databaseUrl ?? env.DATABASE_URL?.trim();
  if (!input.connection && !databaseUrl) {
    throw new Error("DATABASE_URL 未配置");
  }
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - FILE_CONTENT_RETENTION_MS);
  const cwd = input.cwd ?? process.cwd();
  const dashboardAssetRoot = path.resolve(
    env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(cwd, ".frontmind-dashboard-assets"),
  );
  const fileRoot = path.join(dashboardAssetRoot, "presales-files");
  const preparedRoot = path.resolve(
    env.FRONTMIND_PREPARED_FILE_DIR ||
      (env.NODE_ENV === "production"
        ? "/var/lib/frontmind/prepared-files"
        : path.join(cwd, ".frontmind-prepared-files")),
  );
  const connection =
    input.connection ?? (await mysql.createConnection(databaseUrl!));
  const ownsConnection = !input.connection;
  try {
    const resourceColumns = await tableColumns(
      connection,
      "upstream_resources",
    );
    const files = await fileInventory(connection, resourceColumns);
    let eligibleUserUploads = 0;
    let missingLifecycleUserUploads = 0;
    let invalidLifecycleUserUploads = 0;
    const expiredFileIds = new Set<string>();
    let originalBytes = 0;
    for (const file of files) {
      const local = await localUploadInventory(fileRoot, file.upstreamId);
      const hasLifecycle = Boolean(file.uploadedAt || file.contentExpiresAt);
      const isUserUpload =
        hasLifecycle ||
        Number(file.attachmentReferenced) > 0 ||
        Number(file.knowledgeBaseUserUploadReferenced) > 0 ||
        Boolean(local);
      if (!isUserUpload) continue;
      eligibleUserUploads += 1;
      if (!file.uploadedAt || !file.contentExpiresAt) {
        missingLifecycleUserUploads += 1;
      } else if (
        Math.abs(
          file.contentExpiresAt.getTime() -
            file.uploadedAt.getTime() -
            FILE_CONTENT_RETENTION_MS,
        ) > 1_000
      ) {
        invalidLifecycleUserUploads += 1;
      }
      const origin =
        file.uploadedAt?.getTime() ??
        local?.uploadedAt ??
        file.createdAt.getTime();
      const expiresAt =
        file.contentExpiresAt?.getTime() ?? origin + FILE_CONTENT_RETENTION_MS;
      if (expiresAt > now.getTime()) continue;
      expiredFileIds.add(file.upstreamId);
      originalBytes += local?.bytes ?? 0;
    }
    const preparedBytes = await preparedBytesForFiles(
      preparedRoot,
      expiredFileIds,
    );

    const [conversationInventory] = await connection.execute<
      ConversationInventoryRow[]
    >(
      `SELECT COUNT(DISTINCT c.id) AS conversations,
              COUNT(m.id) AS messages
         FROM conversations c
         LEFT JOIN messages m ON m.conversationId = c.id
        WHERE c.updatedAt <= ?`,
      [cutoff],
    );

    const [resourceIndexRows] = await connection.execute<IndexRow[]>(
      "SHOW INDEX FROM upstream_resources",
    );
    const [conversationIndexRows] = await connection.execute<IndexRow[]>(
      "SHOW INDEX FROM conversations",
    );
    const resourceIndexes = groupedIndexes(resourceIndexRows);
    const conversationIndexes = groupedIndexes(conversationIndexRows);
    const migration = {
      uploadedAt: resourceColumns.has("uploadedAt"),
      contentExpiresAt: resourceColumns.has("contentExpiresAt"),
      contentDeletedAt: resourceColumns.has("contentDeletedAt"),
      contentExpiryIndex:
        JSON.stringify(
          resourceIndexes.get("upstream_resources_content_expiry_idx"),
        ) ===
        JSON.stringify(["kind", "contentExpiresAt", "contentDeletedAt", "id"]),
      conversationResourceIndex:
        JSON.stringify(
          resourceIndexes.get("upstream_resources_conversation_kind_idx"),
        ) === JSON.stringify(["conversationId", "kind"]),
      conversationIdleIndex:
        JSON.stringify(conversationIndexes.get("conversations_updated_idx")) ===
        JSON.stringify(["updatedAt", "id"]),
    } satisfies FileRetentionMigrationPreflight;
    const volumes = await Promise.all([
      inspectVolume({
        kind: "original",
        directory: fileRoot,
        reserve: () => MAX_UPLOAD_BYTES + ORIGINAL_VOLUME_RESERVE_BYTES,
      }),
      inspectVolume({
        kind: "prepared",
        directory: preparedRoot,
        reserve: (totalBytes) =>
          Math.max(
            Math.floor(totalBytes * 0.1),
            PREPARED_VOLUME_MINIMUM_RESERVE_BYTES,
          ),
      }),
    ]);
    const ready = fileRetentionPreflightReady({
      migration,
      missingLifecycleUserUploads,
      invalidLifecycleUserUploads,
      volumes,
    });
    return {
      mode: "read-only-preflight",
      observedAt: now.toISOString(),
      fileHardExpiry: {
        eligibleUserUploads,
        missingLifecycleUserUploads,
        invalidLifecycleUserUploads,
        expiredFiles: expiredFileIds.size,
        estimatedOriginalBytes: originalBytes,
        estimatedPreparedBytes: preparedBytes,
        estimatedReclaimBytes: originalBytes + preparedBytes,
      },
      conversationIdleExpiry: {
        cutoff: cutoff.toISOString(),
        conversations: Number(conversationInventory[0]?.conversations ?? 0),
        messages: Number(conversationInventory[0]?.messages ?? 0),
      },
      migration,
      volumes,
      ready,
    };
  } finally {
    if (ownsConnection) await connection.end();
  }
}

export function fileRetentionPreflightReadiness(
  report: FileRetentionPreflightReport,
): FileRetentionPreflightReadiness {
  return {
    observedAt: report.observedAt,
    fileHardExpiry: { ...report.fileHardExpiry },
    conversationIdleExpiry: { ...report.conversationIdleExpiry },
    migration: { ...report.migration },
    volumes: report.volumes.map(
      ({ directory: _directory, errorCode: _errorCode, ...volume }) => volume,
    ),
    ready: report.ready,
  };
}

export function assertFileRetentionPreflightReady(
  report: FileRetentionPreflightReport,
) {
  if (!report.ready) {
    throw new Error("FILE_RETENTION_PREFLIGHT_NOT_READY");
  }
}

export function createFileRetentionPreflightEvidenceCache() {
  let snapshot: FileRetentionPreflightReadiness | null = null;
  return {
    store(report: FileRetentionPreflightReport) {
      snapshot = fileRetentionPreflightReadiness(report);
      return snapshot;
    },
    read() {
      return snapshot;
    },
  };
}
