import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";

import { knowledgeBaseWritesAreEmergencyBlocked } from "../knowledge-base-runtime-guard";

const KNOWLEDGE_BASE_FALLBACK_SCHEMA_PROBE =
  "0061_knowledge_base_resilient_manus_v2";
const KNOWLEDGE_BASE_SCHEMA_AUTHORITY = "complete_migration_journal";
export const MIN_DASHBOARD_ASSET_AVAILABLE_BYTES = 512 * 1024 * 1024;

const REQUIRED_COLUMNS = new Map<
  string,
  { type: string; nullable: boolean; defaultValue?: string }
>([
  ["conversation_turns.buildId", { type: "varchar(36)", nullable: true }],
  [
    "conversation_turns.buildGeneration",
    { type: "int unsigned", nullable: true },
  ],
  ["conversation_turns.operationKey", { type: "varchar(128)", nullable: true }],
  ["conversation_turns.operationType", { type: "varchar(32)", nullable: true }],
  ["conversation_turns.expectedRevision", { type: "int", nullable: true }],
  [
    "conversation_turns.expectedLeafId",
    { type: "varchar(191)", nullable: true },
  ],
  ["conversation_turns.requestHash", { type: "varchar(64)", nullable: true }],
  [
    "conversation_turns.upstreamIdempotencyKeyHash",
    { type: "varchar(64)", nullable: true },
  ],
  [
    "conversation_turns.attachmentFileIds",
    { type: "json", nullable: false, defaultValue: "[]" },
  ],
  [
    "conversation_turns.metadata",
    { type: "json", nullable: false, defaultValue: "{}" },
  ],
  ["conversation_turns.leaseExpiresAt", { type: "timestamp", nullable: true }],
  [
    "knowledge_base_build_nodes.sourceTurnId",
    { type: "varchar(36)", nullable: true },
  ],
  [
    "knowledge_base_build_nodes.presentationKey",
    { type: "varchar(191)", nullable: true },
  ],
  [
    "knowledge_base_build_nodes.contentSha256",
    { type: "varchar(64)", nullable: true },
  ],
  [
    "knowledge_base_builds.generation",
    { type: "int unsigned", nullable: false, defaultValue: "1" },
  ],
  [
    "knowledge_base_builds.stateEpoch",
    { type: "int unsigned", nullable: false, defaultValue: "0" },
  ],
  [
    "knowledge_base_builds.activeTurnId",
    { type: "varchar(36)", nullable: true },
  ],
  [
    "knowledge_base_builds.recoveryLeaseOwnerHash",
    { type: "varchar(64)", nullable: true },
  ],
  [
    "knowledge_base_builds.recoveryLeaseExpiresAt",
    { type: "timestamp", nullable: true },
  ],
  [
    "knowledge_base_builds.lastAppliedOperationKey",
    { type: "varchar(128)", nullable: true },
  ],
  [
    "knowledge_base_builds.currentPresentationKey",
    { type: "varchar(191)", nullable: true },
  ],
  [
    "knowledge_base_builds.providerProtocol",
    { type: "varchar(32)", nullable: false, defaultValue: "legacy_v1" },
  ],
  [
    "knowledge_base_builds.canonicalTaskId",
    { type: "varchar(255)", nullable: true },
  ],
  [
    "knowledge_base_builds.canonicalTaskGeneration",
    { type: "int unsigned", nullable: true },
  ],
  [
    "knowledge_base_builds.canonicalCredentialId",
    { type: "varchar(36)", nullable: true },
  ],
  [
    "knowledge_base_builds.canonicalTaskState",
    { type: "varchar(32)", nullable: false, defaultValue: "unbound" },
  ],
  [
    "knowledge_base_builds.canonicalTaskUrl",
    { type: "varchar(1024)", nullable: true },
  ],
  [
    "knowledge_base_builds.canonicalTaskCreatedAt",
    { type: "timestamp", nullable: true },
  ],
  ["knowledge_base_builds.handoffProvenance", { type: "json", nullable: true }],
  [
    "knowledge_base_builds.skillArchiveSha256",
    { type: "varchar(64)", nullable: true },
  ],
  [
    "knowledge_base_builds.skillArchiveBytes",
    { type: "int unsigned", nullable: true },
  ],
  [
    "knowledge_base_builds.skillArchiveStorageKey",
    { type: "varchar(1024)", nullable: true },
  ],
  [
    "knowledge_base_builds.contentCompletedAt",
    { type: "timestamp", nullable: true },
  ],
  [
    "knowledge_base_builds.packageStatus",
    { type: "varchar(32)", nullable: false, defaultValue: "not_started" },
  ],
  [
    "knowledge_base_builds.packageAttemptCount",
    { type: "int unsigned", nullable: false, defaultValue: "0" },
  ],
  [
    "knowledge_base_builds.packageNextRetryAt",
    { type: "timestamp", nullable: true },
  ],
  [
    "knowledge_base_builds.packageLastErrorCode",
    { type: "varchar(128)", nullable: true },
  ],
  [
    "knowledge_base_builds.logoStorageKey",
    { type: "varchar(1024)", nullable: true },
  ],
  ["knowledge_base_builds.logoSha256", { type: "varchar(64)", nullable: true }],
  ["knowledge_base_builds.logoBytes", { type: "int unsigned", nullable: true }],
  [
    "knowledge_base_builds.logoFilename",
    { type: "varchar(512)", nullable: true },
  ],
  [
    "knowledge_base_builds.logoMimeType",
    { type: "varchar(255)", nullable: true },
  ],
  [
    "knowledge_base_builds.packageStorageKey",
    { type: "varchar(1024)", nullable: true },
  ],
  [
    "knowledge_base_builds.packageArchiveSha256",
    { type: "varchar(64)", nullable: true },
  ],
  [
    "knowledge_base_builds.packageSizeBytes",
    { type: "int unsigned", nullable: true },
  ],
  [
    "knowledge_base_builds.protocolErrorCode",
    { type: "varchar(128)", nullable: true },
  ],
]);

const REQUIRED_FOREIGN_KEYS = new Map([
  [
    "conversation_turns.conversation_turns_buildId_knowledge_base_builds_id_fk",
    {
      column: "buildId",
      referencedTable: "knowledge_base_builds",
      referencedColumn: "id",
      deleteRule: "SET NULL",
      updateRule: "NO ACTION",
    },
  ],
]);

const REQUIRED_INDEXES = new Map<
  string,
  { columns: readonly string[]; unique: boolean }
>([
  [
    "conversation_turns.conversation_turns_operation_key_uq",
    { columns: ["operationKey"], unique: true },
  ],
  [
    "conversation_turns.conversation_turns_build_generation_idx",
    { columns: ["buildId", "buildGeneration"], unique: false },
  ],
  [
    "conversation_turns.conversation_turns_lease_idx",
    { columns: ["status", "leaseExpiresAt"], unique: false },
  ],
  [
    "knowledge_base_build_nodes.knowledge_base_build_nodes_source_turn_idx",
    { columns: ["sourceTurnId"], unique: false },
  ],
  [
    "knowledge_base_builds.knowledge_base_builds_active_turn_idx",
    { columns: ["activeTurnId"], unique: false },
  ],
  [
    "knowledge_base_builds.knowledge_base_builds_recovery_lease_idx",
    { columns: ["status", "recoveryLeaseExpiresAt"], unique: false },
  ],
  [
    "knowledge_base_builds.knowledge_base_builds_canonical_task_idx",
    { columns: ["canonicalTaskId"], unique: true },
  ],
  [
    "knowledge_base_builds.knowledge_base_builds_canonical_credential_idx",
    { columns: ["canonicalCredentialId"], unique: false },
  ],
]);

type SchemaDatabase = {
  execute(query: SQL): Promise<unknown>;
};

type SchemaRow = Record<string, unknown>;

function executeRows(result: unknown): SchemaRow[] {
  if (!Array.isArray(result)) return [];
  const candidate = Array.isArray(result[0]) ? result[0] : result;
  return candidate.filter(
    (row): row is SchemaRow => Boolean(row) && typeof row === "object",
  );
}

function rowValue(row: SchemaRow, ...keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  const normalizedKeys = new Set(
    keys.map((key) => key.replaceAll("_", "").toLowerCase()),
  );
  for (const [key, value] of Object.entries(row)) {
    if (normalizedKeys.has(key.replaceAll("_", "").toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

function normalizedColumnDefault(value: unknown) {
  if (value === null || value === undefined) return null;
  let normalized: string;
  if (Buffer.isBuffer(value)) {
    normalized = value.toString("utf8");
  } else if (value instanceof Uint8Array) {
    normalized = Buffer.from(value).toString("utf8");
  } else if (Array.isArray(value) || typeof value === "object") {
    try {
      normalized = JSON.stringify(value);
    } catch {
      return String(value);
    }
  } else {
    normalized = String(value);
  }
  normalized = normalized.trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  const compactExpression = normalized.replace(/\s+/gu, "").toLowerCase();
  if (compactExpression === "json_array()") return "[]";
  if (compactExpression === "json_object()") return "{}";
  normalized = normalized.replace(/^_[a-z0-9]+(?=')/iu, "");
  if (
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith('"') && normalized.endsWith('"'))
  ) {
    normalized = normalized.slice(1, -1);
  }
  try {
    return JSON.stringify(JSON.parse(normalized));
  } catch {
    return normalized;
  }
}

function systemErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export class KnowledgeBaseReadinessError extends Error {
  constructor(
    public readonly code:
      | "KB_SCHEMA_0045_INCOMPLETE"
      | "KB_ASSET_STORAGE_UNAVAILABLE"
      | "KB_ASSET_STORAGE_LOW_SPACE",
  ) {
    super(code);
    this.name = "KnowledgeBaseReadinessError";
  }
}

/**
 * Fallback schema authority used when the complete migration-journal verifier
 * is unavailable. It covers the 0045 exactly-once state machine together with
 * every 0061 Manus-v2 resilience column and index. Only fixed metadata names
 * are queried; missing details never leave this process through the health DTO.
 */
export async function assertKnowledgeBaseResilientSchema(db: SchemaDatabase) {
  const [columnResult, indexResult, foreignKeyResult] = await Promise.all([
    db.execute(sql`
      SELECT
        table_name AS table_name,
        column_name AS column_name,
        column_type AS column_type,
        is_nullable AS is_nullable,
        column_default AS column_default
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN (
          'conversation_turns',
          'knowledge_base_build_nodes',
          'knowledge_base_builds'
        )
    `),
    db.execute(sql`
      SELECT
        table_name AS table_name,
        index_name AS index_name,
        column_name AS column_name,
        seq_in_index AS seq_in_index,
        non_unique AS non_unique
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name IN (
          'conversation_turns',
          'knowledge_base_build_nodes',
          'knowledge_base_builds'
        )
      ORDER BY table_name, index_name, seq_in_index
    `),
    db.execute(sql`
      SELECT
        kcu.table_name AS table_name,
        kcu.constraint_name AS constraint_name,
        kcu.column_name AS column_name,
        kcu.referenced_table_name AS referenced_table_name,
        kcu.referenced_column_name AS referenced_column_name,
        rc.delete_rule AS delete_rule,
        rc.update_rule AS update_rule
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = kcu.constraint_schema
       AND rc.table_name = kcu.table_name
       AND rc.constraint_name = kcu.constraint_name
      WHERE kcu.constraint_schema = DATABASE()
        AND kcu.table_name IN (
          'conversation_turns',
          'knowledge_base_build_nodes',
          'knowledge_base_builds'
        )
        AND kcu.referenced_table_name IS NOT NULL
    `),
  ]);

  const availableColumns = new Map(
    executeRows(columnResult).map((row) => [
      [
        String(rowValue(row, "tableName", "table_name") || ""),
        String(rowValue(row, "columnName", "column_name") || ""),
      ].join("."),
      row,
    ]),
  );
  for (const [column, expected] of REQUIRED_COLUMNS) {
    const actual = availableColumns.get(column);
    if (
      !actual ||
      String(
        rowValue(actual, "columnType", "column_type") || "",
      ).toLowerCase() !== expected.type ||
      (String(
        rowValue(actual, "isNullable", "is_nullable") || "",
      ).toUpperCase() ===
        "YES") !==
        expected.nullable ||
      (expected.defaultValue !== undefined &&
        normalizedColumnDefault(
          rowValue(actual, "columnDefault", "column_default"),
        ) !== expected.defaultValue)
    ) {
      throw new KnowledgeBaseReadinessError("KB_SCHEMA_0045_INCOMPLETE");
    }
  }

  const availableIndexes = new Map<
    string,
    { columns: Array<{ ordinal: number; name: string }>; unique: boolean }
  >();
  for (const row of executeRows(indexResult)) {
    const key = [
      String(rowValue(row, "tableName", "table_name") || ""),
      String(rowValue(row, "indexName", "index_name") || ""),
    ].join(".");
    const existing = availableIndexes.get(key) || {
      columns: [],
      unique: Number(rowValue(row, "nonUnique", "non_unique")) === 0,
    };
    existing.columns.push({
      ordinal: Number(rowValue(row, "seqInIndex", "seq_in_index")),
      name: String(rowValue(row, "columnName", "column_name") || ""),
    });
    availableIndexes.set(key, existing);
  }
  for (const [key, expected] of REQUIRED_INDEXES) {
    const actual = availableIndexes.get(key);
    const columns = actual?.columns
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((column) => column.name);
    if (
      !actual ||
      actual.unique !== expected.unique ||
      columns?.length !== expected.columns.length ||
      columns.some((column, index) => column !== expected.columns[index])
    ) {
      throw new KnowledgeBaseReadinessError("KB_SCHEMA_0045_INCOMPLETE");
    }
  }

  const availableForeignKeys = new Map(
    executeRows(foreignKeyResult).map((row) => [
      [
        String(rowValue(row, "tableName", "table_name") || ""),
        String(rowValue(row, "constraintName", "constraint_name") || ""),
      ].join("."),
      row,
    ]),
  );
  for (const [key, expected] of REQUIRED_FOREIGN_KEYS) {
    const actual = availableForeignKeys.get(key);
    if (
      !actual ||
      String(rowValue(actual, "columnName", "column_name") || "") !==
        expected.column ||
      String(
        rowValue(actual, "referencedTableName", "referenced_table_name") || "",
      ) !== expected.referencedTable ||
      String(
        rowValue(actual, "referencedColumnName", "referenced_column_name") ||
          "",
      ) !== expected.referencedColumn ||
      String(
        rowValue(actual, "deleteRule", "delete_rule") || "",
      ).toUpperCase() !== expected.deleteRule ||
      String(
        rowValue(actual, "updateRule", "update_rule") || "",
      ).toUpperCase() !== expected.updateRule
    ) {
      throw new KnowledgeBaseReadinessError("KB_SCHEMA_0045_INCOMPLETE");
    }
  }
}

/** @deprecated Use assertKnowledgeBaseResilientSchema. */
export const assertKnowledgeBase0045Schema = assertKnowledgeBaseResilientSchema;

type AssetProbeFileSystem = Pick<
  typeof fs,
  "mkdir" | "writeFile" | "readFile" | "unlink" | "statfs"
>;

export async function probeDashboardAssetStorage(
  input: {
    rootDir?: string;
    configuredRootRequired?: boolean;
    minimumAvailableBytes?: number;
    fileSystem?: AssetProbeFileSystem;
    nonce?: string;
  } = {},
) {
  const fileSystem = input.fileSystem ?? fs;
  const configuredRoot =
    input.rootDir || process.env.FRONTMIND_DASHBOARD_ASSET_DIR?.trim();
  if (input.configuredRootRequired && !configuredRoot) {
    throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_UNAVAILABLE");
  }
  const rootDir = path.resolve(
    configuredRoot || path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  const minimumAvailableBytes = Math.max(
    1,
    Math.trunc(
      input.minimumAvailableBytes ?? MIN_DASHBOARD_ASSET_AVAILABLE_BYTES,
    ),
  );
  const probePath = path.join(
    rootDir,
    `.frontmind-readiness-${input.nonce || randomUUID()}.tmp`,
  );
  const payload = Buffer.from(`frontmind-readiness:${randomUUID()}`, "utf8");
  let probeExists = false;
  try {
    await fileSystem.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const stats = await fileSystem.statfs(rootDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (
      !Number.isFinite(availableBytes) ||
      availableBytes < minimumAvailableBytes
    ) {
      throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_LOW_SPACE");
    }
    await fileSystem.writeFile(probePath, payload, {
      flag: "wx",
      mode: 0o600,
    });
    probeExists = true;
    const readBack = await fileSystem.readFile(probePath);
    if (!Buffer.from(readBack).equals(payload)) {
      throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_UNAVAILABLE");
    }
    await fileSystem.unlink(probePath);
    try {
      await fileSystem.readFile(probePath);
      throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_UNAVAILABLE");
    } catch (error) {
      if (error instanceof KnowledgeBaseReadinessError) throw error;
      if (systemErrorCode(error) !== "ENOENT") {
        throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_UNAVAILABLE");
      }
    }
    probeExists = false;
    return { availableBytes, minimumAvailableBytes };
  } catch (error) {
    if (error instanceof KnowledgeBaseReadinessError) throw error;
    throw new KnowledgeBaseReadinessError("KB_ASSET_STORAGE_UNAVAILABLE");
  } finally {
    if (probeExists) {
      await fileSystem.unlink(probePath).catch(() => undefined);
    }
  }
}

export type KnowledgeBaseRecoveryHealthDto = {
  status: "pending" | "running" | "ok" | "failed" | "disabled";
  running: boolean;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastFailureCode: "RECOVERY_SCAN_FAILED" | null;
  /**
   * Per-item failures are upstream/build outcomes, not proof that the recovery
   * worker itself is unavailable. Keep coarse telemetry without putting task
   * ids, customer content or provider errors in the public health response.
   */
  lastItemFailureAt: string | null;
  lastItemFailureCount: number;
};

export class KnowledgeBaseRecoveryHealthTracker {
  private running = false;
  private lastSucceededAt: Date | null = null;
  private lastFailedAt: Date | null = null;
  private lastFailureCode: KnowledgeBaseRecoveryHealthDto["lastFailureCode"] =
    null;
  private lastItemFailureAt: Date | null = null;
  private lastItemFailureCount = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  begin() {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  succeed(input: { itemFailureCount?: number } = {}) {
    const rawItemFailureCount = Number(input.itemFailureCount);
    const itemFailureCount = Number.isFinite(rawItemFailureCount)
      ? Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(0, Math.trunc(rawItemFailureCount)),
        )
      : 0;
    this.running = false;
    const completedAt = this.now();
    this.lastSucceededAt = completedAt;
    this.lastItemFailureCount = itemFailureCount;
    if (itemFailureCount > 0) {
      this.lastItemFailureAt = completedAt;
    }
  }

  fail(code: Exclude<KnowledgeBaseRecoveryHealthDto["lastFailureCode"], null>) {
    this.running = false;
    this.lastFailedAt = this.now();
    this.lastFailureCode = code;
  }

  snapshot(options: { required: boolean }): KnowledgeBaseRecoveryHealthDto {
    if (!options.required) {
      return {
        status: "disabled",
        running: this.running,
        lastSucceededAt: this.lastSucceededAt?.toISOString() ?? null,
        lastFailedAt: this.lastFailedAt?.toISOString() ?? null,
        lastFailureCode: this.lastFailureCode,
        lastItemFailureAt: this.lastItemFailureAt?.toISOString() ?? null,
        lastItemFailureCount: this.lastItemFailureCount,
      };
    }
    const hasActiveFailure =
      Boolean(this.lastFailedAt) &&
      (!this.lastSucceededAt || this.lastFailedAt! > this.lastSucceededAt);
    const status = hasActiveFailure
      ? "failed"
      : this.running
        ? "running"
        : this.lastSucceededAt
          ? "ok"
          : "pending";
    return {
      status,
      running: this.running,
      lastSucceededAt: this.lastSucceededAt?.toISOString() ?? null,
      lastFailedAt: this.lastFailedAt?.toISOString() ?? null,
      lastFailureCode: this.lastFailureCode,
      lastItemFailureAt: this.lastItemFailureAt?.toISOString() ?? null,
      lastItemFailureCount: this.lastItemFailureCount,
    };
  }
}

export class KnowledgeBaseRecoveryRunError extends Error {
  readonly code = "RECOVERY_SCAN_FAILED";

  constructor() {
    super("RECOVERY_SCAN_FAILED");
    this.name = "KnowledgeBaseRecoveryRunError";
  }
}

export const knowledgeBaseRecoveryHealth =
  new KnowledgeBaseRecoveryHealthTracker();

export async function runLeasedKnowledgeBaseRecovery<
  T extends { failed: number },
>(input: {
  recover: () => Promise<T>;
  tracker?: KnowledgeBaseRecoveryHealthTracker;
}) {
  const tracker = input.tracker ?? knowledgeBaseRecoveryHealth;
  if (!tracker.begin()) return null;
  try {
    const result = await input.recover();
    // A single inaccessible/stale upstream task must not turn the whole
    // Dashboard unhealthy. The recovery function already records per-build
    // failures and returns their aggregate for logs/alerts; readiness only
    // represents whether the scan infrastructure itself completed.
    tracker.succeed({ itemFailureCount: result.failed });
    return result;
  } catch {
    tracker.fail("RECOVERY_SCAN_FAILED");
    throw new KnowledgeBaseRecoveryRunError();
  }
}

export type KnowledgeBaseReadinessDto = {
  schema: {
    migration:
      | typeof KNOWLEDGE_BASE_FALLBACK_SCHEMA_PROBE
      | typeof KNOWLEDGE_BASE_SCHEMA_AUTHORITY;
    status: "ok" | "unavailable";
  };
  assetStorage: {
    status: "ok" | "unavailable";
    readWriteDelete: boolean;
    availableBytes: number | null;
    minimumAvailableBytes: number;
  };
  writes: { status: "writable" | "blocked" };
  recovery: KnowledgeBaseRecoveryHealthDto;
  /** Build-local findings are diagnostic only and never change `ready`. */
  degradedBuildCount: number;
};

export async function evaluateKnowledgeBaseReadiness(input: {
  db: SchemaDatabase;
  schemaVerified?: boolean;
  recoveryRequired: boolean;
  recoveryTracker?: KnowledgeBaseRecoveryHealthTracker;
  assetRootDir?: string;
  assetRootRequired?: boolean;
  minimumAvailableBytes?: number;
  fileSystem?: AssetProbeFileSystem;
  writesBlocked?: () => unknown;
  degradedBuildCount?: number;
}) {
  const [schemaResult, assetResult] = await Promise.allSettled([
    input.schemaVerified
      ? Promise.resolve()
      : assertKnowledgeBaseResilientSchema(input.db),
    probeDashboardAssetStorage({
      rootDir: input.assetRootDir,
      configuredRootRequired: input.assetRootRequired,
      minimumAvailableBytes: input.minimumAvailableBytes,
      fileSystem: input.fileSystem,
    }),
  ]);
  const recovery = (
    input.recoveryTracker ?? knowledgeBaseRecoveryHealth
  ).snapshot({
    required: input.recoveryRequired,
  });
  const writesBlocked = Boolean(
    (input.writesBlocked ?? knowledgeBaseWritesAreEmergencyBlocked)(),
  );
  const dto: KnowledgeBaseReadinessDto = {
    schema: {
      migration: input.schemaVerified
        ? KNOWLEDGE_BASE_SCHEMA_AUTHORITY
        : KNOWLEDGE_BASE_FALLBACK_SCHEMA_PROBE,
      status: schemaResult.status === "fulfilled" ? "ok" : "unavailable",
    },
    assetStorage: {
      status: assetResult.status === "fulfilled" ? "ok" : "unavailable",
      readWriteDelete: assetResult.status === "fulfilled",
      availableBytes:
        assetResult.status === "fulfilled"
          ? assetResult.value.availableBytes
          : null,
      minimumAvailableBytes:
        assetResult.status === "fulfilled"
          ? assetResult.value.minimumAvailableBytes
          : Math.max(
              1,
              Math.trunc(
                input.minimumAvailableBytes ??
                  MIN_DASHBOARD_ASSET_AVAILABLE_BYTES,
              ),
            ),
    },
    writes: { status: writesBlocked ? "blocked" : "writable" },
    recovery,
    degradedBuildCount: Math.max(0, Math.trunc(input.degradedBuildCount ?? 0)),
  };
  const recoveryReady =
    recovery.status === "ok" || recovery.status === "disabled";
  return {
    ready:
      dto.schema.status === "ok" &&
      dto.assetStorage.status === "ok" &&
      dto.writes.status === "writable" &&
      recoveryReady,
    dto,
  };
}

export function knowledgeBaseReadinessHttpStatus(input: { ready: boolean }) {
  return input.ready ? 200 : 503;
}
