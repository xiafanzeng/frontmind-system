import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Connection } from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertFileRetentionPreflightReady,
  createFileRetentionPreflightEvidenceCache,
  fileRetentionPreflightReadiness,
  fileRetentionPreflightReady,
  inspectFileRetentionPreflight,
  type FileRetentionMigrationPreflight,
  type FileRetentionPreflightReport,
  type FileRetentionVolumePreflight,
} from "./file-retention-preflight";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const migration: FileRetentionMigrationPreflight = {
  uploadedAt: true,
  contentExpiresAt: true,
  contentDeletedAt: true,
  contentExpiryIndex: true,
  conversationResourceIndex: true,
  conversationIdleIndex: true,
};

const volumes: FileRetentionVolumePreflight[] = [
  {
    kind: "original",
    directory: "/private/originals",
    writable: true,
    totalBytes: 1_000,
    availableBytes: 700,
    requiredBytes: 200,
    enoughSpace: true,
  },
  {
    kind: "prepared",
    directory: "/private/prepared",
    writable: true,
    totalBytes: 2_000,
    availableBytes: 1_500,
    requiredBytes: 500,
    enoughSpace: true,
  },
];

function report(): FileRetentionPreflightReport {
  return {
    mode: "read-only-preflight",
    observedAt: "2026-08-04T00:00:00.000Z",
    fileHardExpiry: {
      eligibleUserUploads: 7,
      missingLifecycleUserUploads: 0,
      invalidLifecycleUserUploads: 0,
      expiredFiles: 2,
      estimatedOriginalBytes: 10,
      estimatedPreparedBytes: 20,
      estimatedReclaimBytes: 30,
    },
    conversationIdleExpiry: {
      cutoff: "2026-07-05T00:00:00.000Z",
      conversations: 3,
      messages: 11,
    },
    migration: { ...migration },
    volumes: volumes.map((volume) => ({ ...volume })),
    ready: true,
  };
}

function indexRows(name: string, columns: string[]) {
  return columns.map((column, index) => ({
    Key_name: name,
    Seq_in_index: index + 1,
    Column_name: column,
  }));
}

describe("file-retention preflight", () => {
  it("requires the complete 0054 schema, lifecycle ledger, and both volumes", () => {
    expect(
      fileRetentionPreflightReady({
        migration,
        missingLifecycleUserUploads: 0,
        invalidLifecycleUserUploads: 0,
        volumes,
      }),
    ).toBe(true);
    expect(
      fileRetentionPreflightReady({
        migration: { ...migration, conversationIdleIndex: false },
        missingLifecycleUserUploads: 0,
        invalidLifecycleUserUploads: 0,
        volumes,
      }),
    ).toBe(false);
    expect(
      fileRetentionPreflightReady({
        migration,
        missingLifecycleUserUploads: 1,
        invalidLifecycleUserUploads: 0,
        volumes,
      }),
    ).toBe(false);
    expect(
      fileRetentionPreflightReady({
        migration,
        missingLifecycleUserUploads: 0,
        invalidLifecycleUserUploads: 0,
        volumes: volumes.map((volume, index) => ({
          ...volume,
          enoughSpace: index !== 1,
        })),
      }),
    ).toBe(false);
  });

  it("caches only aggregate readiness evidence", () => {
    const detailed = report();
    detailed.volumes[1]!.errorCode = "EACCES";
    const cache = createFileRetentionPreflightEvidenceCache();
    const snapshot = cache.store(detailed);

    expect(cache.read()).toEqual(snapshot);
    expect(snapshot).toEqual(fileRetentionPreflightReadiness(detailed));
    expect(JSON.stringify(snapshot)).not.toContain("/private/");
    expect(JSON.stringify(snapshot)).not.toContain("EACCES");
    expect(snapshot).toMatchObject({
      fileHardExpiry: { expiredFiles: 2, estimatedReclaimBytes: 30 },
      conversationIdleExpiry: { conversations: 3, messages: 11 },
      migration: { contentExpiryIndex: true, conversationIdleIndex: true },
      volumes: [
        { kind: "original", writable: true, availableBytes: 700 },
        { kind: "prepared", writable: true, availableBytes: 1_500 },
      ],
      ready: true,
    });
    expect(() => assertFileRetentionPreflightReady(detailed)).not.toThrow();
    expect(() =>
      assertFileRetentionPreflightReady({ ...detailed, ready: false }),
    ).toThrow("FILE_RETENTION_PREFLIGHT_NOT_READY");
  });

  it("uses the shared read-only inventory for file and conversation estimates", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-retention-preflight-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const dashboardAssets = path.join(temporaryRoot, "dashboard-assets");
    const originalRoot = path.join(dashboardAssets, "presales-files");
    const preparedRoot = path.join(temporaryRoot, "prepared-files");
    await Promise.all([
      fs.mkdir(originalRoot, { recursive: true }),
      fs.mkdir(preparedRoot, { recursive: true }),
    ]);

    const fileId = "file_客户资料";
    const storageId = createHash("sha256").update(fileId, "utf8").digest("hex");
    const originalContent = Buffer.from("pdf-original");
    await Promise.all([
      fs.writeFile(
        path.join(originalRoot, `${storageId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          state: "stored",
          fileId,
          uploadedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
      fs.writeFile(
        path.join(originalRoot, `${storageId}.content`),
        originalContent,
      ),
    ]);
    const assetId = "a".repeat(40);
    const preparedManifest = JSON.stringify({
      version: 1,
      id: assetId,
      source: { kind: "file", fileId },
    });
    const preparedContent = Buffer.from("prepared-pdf");
    await Promise.all([
      fs.writeFile(
        path.join(preparedRoot, `${assetId}.json`),
        preparedManifest,
      ),
      fs.writeFile(path.join(preparedRoot, `${assetId}.pdf`), preparedContent),
    ]);

    const query = vi.fn(async (statement: string) => {
      if (statement.startsWith("SHOW COLUMNS")) {
        return [
          ["uploadedAt", "contentExpiresAt", "contentDeletedAt"].map(
            (Field) => ({ Field }),
          ),
        ];
      }
      return [
        [
          {
            upstreamId: fileId,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            uploadedAt: new Date("2026-06-01T00:00:00.000Z"),
            contentExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
            attachmentReferenced: 1,
            knowledgeBaseUserUploadReferenced: 0,
          },
        ],
      ];
    });
    const execute = vi.fn(async (statement: string) => {
      if (statement.includes("COUNT(DISTINCT c.id)")) {
        return [[{ conversations: "4", messages: "19" }]];
      }
      if (statement.includes("upstream_resources")) {
        return [
          [
            ...indexRows("upstream_resources_content_expiry_idx", [
              "kind",
              "contentExpiresAt",
              "contentDeletedAt",
              "id",
            ]),
            ...indexRows("upstream_resources_conversation_kind_idx", [
              "conversationId",
              "kind",
            ]),
          ],
        ];
      }
      return [
        [indexRows("conversations_updated_idx", ["updatedAt", "id"])].flat(),
      ];
    });
    const connection = { query, execute } as unknown as Connection;

    const inventory = await inspectFileRetentionPreflight({
      connection,
      now: new Date("2026-08-04T00:00:00.000Z"),
      env: {
        NODE_ENV: "test",
        FRONTMIND_DASHBOARD_ASSET_DIR: dashboardAssets,
        FRONTMIND_PREPARED_FILE_DIR: preparedRoot,
      },
    });

    expect(inventory.fileHardExpiry).toEqual({
      eligibleUserUploads: 1,
      missingLifecycleUserUploads: 0,
      invalidLifecycleUserUploads: 0,
      expiredFiles: 1,
      estimatedOriginalBytes: originalContent.byteLength,
      estimatedPreparedBytes:
        Buffer.byteLength(preparedManifest) + preparedContent.byteLength,
      estimatedReclaimBytes:
        originalContent.byteLength +
        Buffer.byteLength(preparedManifest) +
        preparedContent.byteLength,
    });
    expect(inventory.conversationIdleExpiry).toMatchObject({
      conversations: 4,
      messages: 19,
    });
    expect(inventory.migration).toEqual(migration);
    expect(
      inventory.volumes.map(({ kind, writable }) => ({ kind, writable })),
    ).toEqual([
      { kind: "original", writable: true },
      { kind: "prepared", writable: true },
    ]);
  });
});
