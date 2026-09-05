import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KnowledgeBaseRecoveryHealthTracker,
  assertKnowledgeBase0045Schema,
  evaluateKnowledgeBaseReadiness,
  knowledgeBaseReadinessHttpStatus,
  probeDashboardAssetStorage,
  runLeasedKnowledgeBaseRecovery,
} from "./knowledge-base-readiness";

const requiredColumns = {
  conversation_turns: [
    "buildId",
    "buildGeneration",
    "operationKey",
    "operationType",
    "expectedRevision",
    "expectedLeafId",
    "requestHash",
    "upstreamIdempotencyKeyHash",
    "attachmentFileIds",
    "metadata",
    "leaseExpiresAt",
  ],
  knowledge_base_build_nodes: [
    "sourceTurnId",
    "presentationKey",
    "contentSha256",
  ],
  knowledge_base_builds: [
    "generation",
    "stateEpoch",
    "activeTurnId",
    "recoveryLeaseOwnerHash",
    "recoveryLeaseExpiresAt",
    "lastAppliedOperationKey",
    "currentPresentationKey",
    "logoStorageKey",
    "logoSha256",
    "logoBytes",
    "logoFilename",
    "logoMimeType",
    "packageStorageKey",
    "packageArchiveSha256",
    "packageSizeBytes",
    "protocolErrorCode",
  ],
} as const;

const requiredIndexes = [
  {
    tableName: "conversation_turns",
    indexName: "conversation_turns_operation_key_uq",
    columns: ["operationKey"],
    nonUnique: 0,
  },
  {
    tableName: "conversation_turns",
    indexName: "conversation_turns_build_generation_idx",
    columns: ["buildId", "buildGeneration"],
    nonUnique: 1,
  },
  {
    tableName: "conversation_turns",
    indexName: "conversation_turns_lease_idx",
    columns: ["status", "leaseExpiresAt"],
    nonUnique: 1,
  },
  {
    tableName: "knowledge_base_build_nodes",
    indexName: "knowledge_base_build_nodes_source_turn_idx",
    columns: ["sourceTurnId"],
    nonUnique: 1,
  },
  {
    tableName: "knowledge_base_builds",
    indexName: "knowledge_base_builds_active_turn_idx",
    columns: ["activeTurnId"],
    nonUnique: 1,
  },
  {
    tableName: "knowledge_base_builds",
    indexName: "knowledge_base_builds_recovery_lease_idx",
    columns: ["status", "recoveryLeaseExpiresAt"],
    nonUnique: 1,
  },
] as const;

function schemaRows() {
  const columns = Object.entries(requiredColumns).flatMap(
    ([tableName, names]) =>
      names.map((columnName) => {
        const columnType =
          columnName === "attachmentFileIds" || columnName === "metadata"
            ? "json"
            : columnName === "leaseExpiresAt" ||
                columnName === "recoveryLeaseExpiresAt"
              ? "timestamp"
              : [
                    "buildGeneration",
                    "generation",
                    "stateEpoch",
                    "logoBytes",
                    "packageSizeBytes",
                  ].includes(columnName)
                ? "int unsigned"
                : columnName === "expectedRevision"
                  ? "int"
                  : `varchar(${
                      ["buildId", "sourceTurnId", "activeTurnId"].includes(
                        columnName,
                      )
                        ? 36
                        : [
                              "requestHash",
                              "upstreamIdempotencyKeyHash",
                              "logoSha256",
                              "contentSha256",
                              "packageArchiveSha256",
                              "recoveryLeaseOwnerHash",
                            ].includes(columnName)
                          ? 64
                          : columnName === "operationType"
                            ? 32
                            : [
                                  "operationKey",
                                  "lastAppliedOperationKey",
                                  "protocolErrorCode",
                                ].includes(columnName)
                              ? 128
                              : [
                                    "expectedLeafId",
                                    "presentationKey",
                                    "currentPresentationKey",
                                  ].includes(columnName)
                                ? 191
                                : [
                                      "logoStorageKey",
                                      "packageStorageKey",
                                    ].includes(columnName)
                                  ? 1024
                                  : columnName === "logoFilename"
                                    ? 512
                                    : 255
                    })`;
        const notNull = [
          "attachmentFileIds",
          "metadata",
          "generation",
          "stateEpoch",
        ].includes(columnName);
        const columnDefault =
          columnName === "attachmentFileIds"
            ? "('[]')"
            : columnName === "metadata"
              ? "('{}')"
              : columnName === "generation"
                ? "1"
                : columnName === "stateEpoch"
                  ? "0"
                  : null;
        return {
          tableName,
          columnName,
          columnType,
          isNullable: notNull ? "NO" : "YES",
          columnDefault,
        };
      }),
  );
  const indexes = requiredIndexes.flatMap((index) =>
    index.columns.map((columnName, ordinal) => ({
      tableName: index.tableName,
      indexName: index.indexName,
      columnName,
      seqInIndex: ordinal + 1,
      nonUnique: index.nonUnique,
    })),
  );
  const foreignKeys = [
    {
      tableName: "conversation_turns",
      constraintName: "conversation_turns_buildId_knowledge_base_builds_id_fk",
      columnName: "buildId",
      referencedTableName: "knowledge_base_builds",
      referencedColumnName: "id",
      deleteRule: "SET NULL",
      updateRule: "NO ACTION",
    },
  ];
  return { columns, indexes, foreignKeys };
}

function schemaDb(overrides?: {
  columns?: Record<string, unknown>[];
  indexes?: Record<string, unknown>[];
  foreignKeys?: Record<string, unknown>[];
}) {
  const rows = schemaRows();
  return {
    execute: vi
      .fn()
      .mockResolvedValueOnce([overrides?.columns ?? rows.columns, []])
      .mockResolvedValueOnce([overrides?.indexes ?? rows.indexes, []])
      .mockResolvedValueOnce([overrides?.foreignKeys ?? rows.foreignKeys, []]),
  };
}

function uppercaseInformationSchemaRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase(),
        value,
      ]),
    ),
  );
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("knowledge-base production readiness", () => {
  it("requires every 0045 column and the exact ordered indexes", async () => {
    await expect(
      assertKnowledgeBase0045Schema(schemaDb()),
    ).resolves.toBeUndefined();

    const missingColumnRows = schemaRows().columns.slice(1);
    await expect(
      assertKnowledgeBase0045Schema(schemaDb({ columns: missingColumnRows })),
    ).rejects.toMatchObject({ code: "KB_SCHEMA_0045_INCOMPLETE" });

    const wrongIndexRows = schemaRows().indexes.filter(
      (row) =>
        !(
          row.indexName === "conversation_turns_lease_idx" &&
          row.columnName === "leaseExpiresAt"
        ),
    );
    await expect(
      assertKnowledgeBase0045Schema(schemaDb({ indexes: wrongIndexRows })),
    ).rejects.toMatchObject({ code: "KB_SCHEMA_0045_INCOMPLETE" });

    const wrongDefaultRows = schemaRows().columns.map((row) =>
      row.columnName === "generation" ? { ...row, columnDefault: "2" } : row,
    );
    await expect(
      assertKnowledgeBase0045Schema(schemaDb({ columns: wrongDefaultRows })),
    ).rejects.toMatchObject({ code: "KB_SCHEMA_0045_INCOMPLETE" });

    await expect(
      assertKnowledgeBase0045Schema(schemaDb({ foreignKeys: [] })),
    ).rejects.toMatchObject({ code: "KB_SCHEMA_0045_INCOMPLETE" });
  });

  it("normalizes MySQL 8.4 aliases and semantic JSON defaults without hiding drift", async () => {
    const rows = schemaRows();
    const mysql84Columns = rows.columns.map((row) => {
      const normalized: Record<string, unknown> = { ...row };
      if (row.columnName === "attachmentFileIds") {
        normalized.columnDefault = Buffer.from("( JSON_ARRAY ( ) )", "utf8");
      }
      if (row.columnName === "metadata") {
        normalized.columnDefault = {};
      }
      return normalized;
    });

    await expect(
      assertKnowledgeBase0045Schema(
        schemaDb({
          columns: uppercaseInformationSchemaRows(mysql84Columns),
          indexes: uppercaseInformationSchemaRows(rows.indexes),
          foreignKeys: uppercaseInformationSchemaRows(rows.foreignKeys),
        }),
      ),
    ).resolves.toBeUndefined();

    const nonEmptyDefaultColumns = mysql84Columns.map((row) =>
      row.columnName === "attachmentFileIds"
        ? { ...row, columnDefault: Buffer.from("('[1]')", "utf8") }
        : row,
    );
    await expect(
      assertKnowledgeBase0045Schema(
        schemaDb({
          columns: uppercaseInformationSchemaRows(nonEmptyDefaultColumns),
          indexes: uppercaseInformationSchemaRows(rows.indexes),
          foreignKeys: uppercaseInformationSchemaRows(rows.foreignKeys),
        }),
      ),
    ).rejects.toMatchObject({ code: "KB_SCHEMA_0045_INCOMPLETE" });
  });

  it("really writes, reads and deletes a probe while reporting only byte counts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    const result = await probeDashboardAssetStorage({
      rootDir: root,
      minimumAvailableBytes: 1,
      nonce: "fixed-probe",
    });

    expect(result.availableBytes).toBeGreaterThan(0);
    expect(result.minimumAvailableBytes).toBe(1);
    await expect(
      fs.readFile(path.join(root, ".frontmind-readiness-fixed-probe.tmp")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("fails closed for unwritable or low-space asset storage without exposing paths", async () => {
    const secretPath = "/private/volumes/customer-secret-assets";
    const unavailable = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: false,
      assetRootDir: secretPath,
      minimumAvailableBytes: 1,
      fileSystem: {
        mkdir: vi.fn().mockRejectedValue(new Error(`EACCES ${secretPath}`)),
        writeFile: vi.fn(),
        readFile: vi.fn(),
        unlink: vi.fn(),
        statfs: vi.fn(),
      } as unknown as Pick<
        typeof fs,
        "mkdir" | "writeFile" | "readFile" | "unlink" | "statfs"
      >,
      writesBlocked: () => null,
    });
    expect(unavailable.ready).toBe(false);
    expect(knowledgeBaseReadinessHttpStatus(unavailable)).toBe(503);
    expect(unavailable.dto.assetStorage).toMatchObject({
      status: "unavailable",
      readWriteDelete: false,
      availableBytes: null,
    });
    expect(JSON.stringify(unavailable.dto)).not.toContain(secretPath);

    const lowSpaceFs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      statfs: vi.fn().mockResolvedValue({ bavail: 1, bsize: 1 }),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      unlink: vi.fn(),
    } as unknown as Pick<
      typeof fs,
      "mkdir" | "writeFile" | "readFile" | "unlink" | "statfs"
    >;
    await expect(
      probeDashboardAssetStorage({
        rootDir: secretPath,
        minimumAvailableBytes: 2,
        fileSystem: lowSpaceFs,
      }),
    ).rejects.toMatchObject({ code: "KB_ASSET_STORAGE_LOW_SPACE" });
    expect(lowSpaceFs.writeFile).not.toHaveBeenCalled();
  });

  it("uses the complete journal contract instead of repeating the legacy 0045 metadata probe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("LEGACY_METADATA_PROBE_MUST_NOT_RUN"));
    const result = await evaluateKnowledgeBaseReadiness({
      db: { execute },
      schemaVerified: true,
      recoveryRequired: false,
      assetRootDir: root,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.ready).toBe(true);
    expect(result.dto.schema).toEqual({
      migration: "complete_migration_journal",
      status: "ok",
    });
  });

  it("requires the configured dashboard asset volume in production readiness", async () => {
    vi.stubEnv("FRONTMIND_DASHBOARD_ASSET_DIR", "");
    await expect(
      probeDashboardAssetStorage({
        configuredRootRequired: true,
        minimumAvailableBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "KB_ASSET_STORAGE_UNAVAILABLE" });
  });

  it("returns 503 for a runtime write block without exposing its reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    const secret = "sk-secret-in-invariant-reason";
    const result = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: false,
      assetRootDir: root,
      minimumAvailableBytes: 1,
      writesBlocked: () => ({ reason: secret, activatedAt: new Date() }),
    });

    expect(result.ready).toBe(false);
    expect(knowledgeBaseReadinessHttpStatus(result)).toBe(503);
    expect(result.dto.writes).toEqual({ status: "blocked" });
    expect(JSON.stringify(result.dto)).not.toContain(secret);
  });
});

describe("leased recovery worker health", () => {
  it("is pending until the first production scan and unhealthy after a failure", () => {
    let now = new Date("2026-08-01T10:00:00.000Z");
    const tracker = new KnowledgeBaseRecoveryHealthTracker(() => now);
    expect(tracker.snapshot({ required: true })).toMatchObject({
      status: "pending",
      running: false,
      lastSucceededAt: null,
      lastFailedAt: null,
    });
    expect(tracker.begin()).toBe(true);
    expect(tracker.snapshot({ required: true })).toMatchObject({
      status: "running",
      running: true,
    });
    tracker.fail("RECOVERY_SCAN_FAILED");
    expect(tracker.snapshot({ required: true })).toEqual({
      status: "failed",
      running: false,
      lastSucceededAt: null,
      lastFailedAt: "2026-08-01T10:00:00.000Z",
      lastFailureCode: "RECOVERY_SCAN_FAILED",
      lastItemFailureAt: null,
      lastItemFailureCount: 0,
    });

    now = new Date("2026-08-01T10:00:30.000Z");
    expect(tracker.begin()).toBe(true);
    tracker.succeed();
    expect(tracker.snapshot({ required: true })).toEqual({
      status: "ok",
      running: false,
      lastSucceededAt: "2026-08-01T10:00:30.000Z",
      lastFailedAt: "2026-08-01T10:00:00.000Z",
      lastFailureCode: "RECOVERY_SCAN_FAILED",
      lastItemFailureAt: null,
      lastItemFailureCount: 0,
    });
  });

  it("serializes scans and reports item failures without failing readiness", async () => {
    const tracker = new KnowledgeBaseRecoveryHealthTracker(
      () => new Date("2026-08-01T11:00:00.000Z"),
    );
    let release!: (value: { failed: number; scanned: number }) => void;
    const recover = vi.fn(
      () =>
        new Promise<{ failed: number; scanned: number }>((resolve) => {
          release = resolve;
        }),
    );
    const first = runLeasedKnowledgeBaseRecovery({ tracker, recover });
    await expect(
      runLeasedKnowledgeBaseRecovery({ tracker, recover }),
    ).resolves.toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    release({ failed: 2, scanned: 3 });
    await expect(first).resolves.toEqual({ failed: 2, scanned: 3 });
    expect(tracker.snapshot({ required: true })).toMatchObject({
      status: "ok",
      lastFailureCode: null,
      lastItemFailureAt: "2026-08-01T11:00:00.000Z",
      lastItemFailureCount: 2,
    });

    const credential = "sk-recovery-secret";
    await expect(
      runLeasedKnowledgeBaseRecovery({
        tracker,
        recover: async () => {
          throw new Error(`Authorization: Bearer ${credential}`);
        },
      }),
    ).rejects.toMatchObject({
      name: "KnowledgeBaseRecoveryRunError",
      code: "RECOVERY_SCAN_FAILED",
      message: "RECOVERY_SCAN_FAILED",
    });
    expect(JSON.stringify(tracker.snapshot({ required: true }))).not.toContain(
      credential,
    );
  });

  it("keeps production healthy across consecutive sweeps with one 404 item and one recovered build", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    let now = new Date("2026-08-01T11:30:00.000Z");
    const tracker = new KnowledgeBaseRecoveryHealthTracker(() => now);
    const recover = vi
      .fn()
      .mockResolvedValueOnce({
        failed: 1,
        scanned: 2,
        reconciled: 1,
        taskRead404: 1,
      })
      .mockResolvedValueOnce({
        failed: 1,
        scanned: 2,
        reconciled: 1,
        taskRead404: 1,
      });

    await expect(
      runLeasedKnowledgeBaseRecovery({ tracker, recover }),
    ).resolves.toMatchObject({
      failed: 1,
      scanned: 2,
      reconciled: 1,
      taskRead404: 1,
    });
    let readiness = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: true,
      recoveryTracker: tracker,
      assetRootDir: root,
      assetRootRequired: true,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });
    expect(knowledgeBaseReadinessHttpStatus(readiness)).toBe(200);
    expect(readiness.dto.recovery).toMatchObject({
      status: "ok",
      lastItemFailureAt: "2026-08-01T11:30:00.000Z",
      lastItemFailureCount: 1,
    });

    now = new Date("2026-08-01T11:30:30.000Z");
    await expect(
      runLeasedKnowledgeBaseRecovery({ tracker, recover }),
    ).resolves.toMatchObject({ failed: 1, reconciled: 1 });
    readiness = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: true,
      recoveryTracker: tracker,
      assetRootDir: root,
      assetRootRequired: true,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });
    expect(knowledgeBaseReadinessHttpStatus(readiness)).toBe(200);
    expect(readiness.dto.recovery).toMatchObject({
      status: "ok",
      lastSucceededAt: "2026-08-01T11:30:30.000Z",
      lastItemFailureAt: "2026-08-01T11:30:30.000Z",
      lastItemFailureCount: 1,
    });
    expect(recover).toHaveBeenCalledTimes(2);

    now = new Date("2026-08-01T11:31:00.000Z");
    await expect(
      runLeasedKnowledgeBaseRecovery({
        tracker,
        recover: async () => {
          throw new Error("database scan unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_SCAN_FAILED" });
    readiness = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: true,
      recoveryTracker: tracker,
      assetRootDir: root,
      assetRootRequired: true,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });
    expect(knowledgeBaseReadinessHttpStatus(readiness)).toBe(503);
    expect(readiness.dto.recovery).toMatchObject({
      status: "failed",
      lastFailedAt: "2026-08-01T11:31:00.000Z",
      lastFailureCode: "RECOVERY_SCAN_FAILED",
      lastItemFailureAt: "2026-08-01T11:30:30.000Z",
      lastItemFailureCount: 1,
    });
  });

  it("keeps recovery disabled outside production without weakening other gates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    const tracker = new KnowledgeBaseRecoveryHealthTracker();
    const result = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: false,
      recoveryTracker: tracker,
      assetRootDir: root,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });

    expect(result.ready).toBe(true);
    expect(knowledgeBaseReadinessHttpStatus(result)).toBe(200);
    expect(result.dto.recovery).toMatchObject({
      status: "disabled",
      running: false,
    });
  });

  it("returns 503 until the production leased worker has completed a scan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-health-"));
    temporaryRoots.push(root);
    const tracker = new KnowledgeBaseRecoveryHealthTracker(
      () => new Date("2026-08-01T12:00:00.000Z"),
    );
    const pending = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: true,
      recoveryTracker: tracker,
      assetRootDir: root,
      assetRootRequired: true,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });
    expect(pending.dto.recovery.status).toBe("pending");
    expect(knowledgeBaseReadinessHttpStatus(pending)).toBe(503);

    expect(tracker.begin()).toBe(true);
    tracker.succeed();
    const recovered = await evaluateKnowledgeBaseReadiness({
      db: schemaDb(),
      recoveryRequired: true,
      recoveryTracker: tracker,
      assetRootDir: root,
      assetRootRequired: true,
      minimumAvailableBytes: 1,
      writesBlocked: () => null,
    });
    expect(recovered.dto.recovery).toMatchObject({
      status: "ok",
      running: false,
      lastSucceededAt: "2026-08-01T12:00:00.000Z",
    });
    expect(knowledgeBaseReadinessHttpStatus(recovered)).toBe(200);
  });
});
