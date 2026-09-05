import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  knowledgeImportReceipts,
  websiteProjectDeletionTombstones,
} from "../drizzle/schema";
import { buildWebsiteKnowledgeImportV4Fixture } from "./__testutils__/website-knowledge-import-archive";
import { canonicalizeWebsiteKnowledgeImportArchive } from "./website-knowledge-import-archive-adapter";

const candidateBytes = Buffer.from("candidate artifact bytes");
const finalFixture = await buildWebsiteKnowledgeImportV4Fixture();
const finalBytes = finalFixture.buffer;
const canonicalFixture =
  await canonicalizeWebsiteKnowledgeImportArchive(finalBytes);
const candidateSha256 = createHash("sha256")
  .update(candidateBytes)
  .digest("hex");
const finalSha256 = createHash("sha256").update(finalBytes).digest("hex");
const candidateArtifactId = `artifact_${"a".repeat(64)}`;
const finalArtifactId = `artifact_${"b".repeat(64)}`;

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readArtifact: vi.fn(),
  readStoredFile: vi.fn(),
  removeStoredKnowledgeAssets: vi.fn(),
  persistKnowledgeSnapshotArchive: vi.fn(),
  removeKnowledgeSnapshotArchive: vi.fn(),
  createKnowledgeSnapshot: vi.fn(),
  getDashboardWorkspace: vi.fn(),
  getKnowledgeSnapshotById: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./presales-v2-store", () => ({
  readPresalesV2Artifact: mocks.readArtifact,
}));
vi.mock("./presales-file-store", () => ({
  readStoredPresalesFile: mocks.readStoredFile,
}));
vi.mock("./dashboard-api", async () => {
  const actual =
    await vi.importActual<typeof import("./dashboard-api")>("./dashboard-api");
  return {
    ...actual,
    removeStoredKnowledgeAssets: mocks.removeStoredKnowledgeAssets,
  };
});
vi.mock("./dashboard-service", () => ({
  createKnowledgeSnapshot: mocks.createKnowledgeSnapshot,
  getDashboardWorkspace: mocks.getDashboardWorkspace,
  getKnowledgeSnapshotById: mocks.getKnowledgeSnapshotById,
}));
vi.mock("./knowledge-snapshot-archive-store", () => ({
  persistKnowledgeSnapshotArchive: mocks.persistKnowledgeSnapshotArchive,
  removeKnowledgeSnapshotArchive: mocks.removeKnowledgeSnapshotArchive,
}));
vi.mock("./service-entitlement", () => {
  class ServiceEntitlementError extends Error {
    statusCode = 403;
  }
  return {
    assertServiceCapability: mocks.assertServiceCapability,
    ServiceEntitlementError,
  };
});
vi.mock("./knowledge-base-reset-service", () => ({
  assertKnowledgeBaseWritable: mocks.assertKnowledgeBaseWritable,
}));
vi.mock("./delivery-role-service", () => ({
  createKnowledgeMonitoringHandoff: mocks.createKnowledgeMonitoringHandoff,
}));

import { importWebsiteKnowledgeArtifact } from "./knowledge-import-service";

function queryResult<T>(rows: T[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => query,
    for: async () => rows,
  };
  return query;
}

function importDatabase(
  transactionResults: unknown[][] = [[], []],
  provision: {
    userId: number;
    companyName: string;
    status: string;
  } = { userId: 7, companyName: "示例企业", status: "completed" },
) {
  const receiptInserts: Record<string, unknown>[] = [];
  const txUpdate = {
    set: () => txUpdate,
    where: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    select: () => ({
      from: (table: unknown) =>
        table === websiteProjectDeletionTombstones
          ? queryResult([{ status: "active" }])
          : queryResult(transactionResults.shift() ?? []),
    }),
    insert: (table: unknown) => ({
      values:
        table === websiteProjectDeletionTombstones
          ? () => ({
              onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
            })
          : (values: Record<string, unknown>) => {
              if (table === knowledgeImportReceipts) {
                receiptInserts.push(values);
              }
              return Promise.resolve(undefined);
            },
    }),
    update: () => txUpdate,
  };
  const provisionQuery = {
    from: () => provisionQuery,
    where: () => {
      const rows = [provision];
      const result = Promise.resolve(rows) as Promise<typeof rows> & {
        limit: () => Promise<typeof rows>;
      };
      result.limit = async () => rows;
      return result;
    },
  };
  const updateQuery = {
    set: () => updateQuery,
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    receiptInserts,
    select: () => provisionQuery,
    transaction: async (operation: (value: typeof tx) => unknown) =>
      operation(tx),
    update: () => updateQuery,
  };
}

function value(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5 as const,
    companyName: "示例企业",
    candidateArtifactId,
    finalArtifactId,
    candidateSha256,
    finalSha256,
    packageManifestSha256: finalFixture.packageManifestSha256,
    finalizerVersion: "website-kb-finalizer-v1" as const,
    ...overrides,
  };
}

function stored(bytes: Buffer, sha256: string, filename: string) {
  return {
    filename,
    mimeType: "application/zip",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256,
    uploadedAt: new Date(),
    contentExpiresAt: new Date(Date.now() + 60_000),
    contentStoredAt: new Date(),
    manifestUpdatedAt: new Date(),
    createReadStream: () => Readable.from(bytes),
  };
}

describe("website knowledge import v5 local artifact binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue(importDatabase());
    mocks.readArtifact.mockImplementation(async (artifactId: string) =>
      artifactId === candidateArtifactId
        ? {
            artifactId,
            projectId: "project-acceptance-001",
            filename: "candidate.zip",
            mimeType: "application/zip",
            bytes: candidateBytes.length,
            sha256: candidateSha256,
          }
        : artifactId === finalArtifactId
          ? {
              artifactId,
              projectId: "project-acceptance-001",
              filename: "示例企业_knowledge_base.zip",
              mimeType: "application/zip",
              bytes: finalBytes.length,
              sha256: finalSha256,
            }
          : null,
    );
    mocks.readStoredFile.mockImplementation(async (artifactId: string) =>
      artifactId === candidateArtifactId
        ? stored(candidateBytes, candidateSha256, "candidate.zip")
        : artifactId === finalArtifactId
          ? stored(finalBytes, finalSha256, "示例企业_knowledge_base.zip")
          : null,
    );
    mocks.removeStoredKnowledgeAssets.mockResolvedValue(undefined);
    mocks.persistKnowledgeSnapshotArchive.mockResolvedValue(
      "knowledge-archives/7/snapshot-new.zip",
    );
    mocks.removeKnowledgeSnapshotArchive.mockResolvedValue(undefined);
    mocks.getDashboardWorkspace.mockResolvedValue({
      payload: { brandName: "示例企业" },
    });
    mocks.createKnowledgeSnapshot.mockResolvedValue({
      id: "snapshot-new",
      version: 2,
    });
    mocks.getKnowledgeSnapshotById.mockResolvedValue({
      id: "snapshot-existing",
      version: 1,
    });
    mocks.assertServiceCapability.mockResolvedValue(undefined);
    mocks.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
    mocks.createKnowledgeMonitoringHandoff.mockResolvedValue({
      created: [],
      assigned: false,
    });
  });

  it("uses the isolated v4 projection and persists only canonical source bytes", async () => {
    expect(finalSha256).not.toBe(canonicalFixture.sha256);
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v5",
        value: value(),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      snapshot: { id: "snapshot-new" },
    });
    expect(mocks.persistKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 7,
      snapshotId: expect.any(String),
      buffer: canonicalFixture.buffer,
      expectedSha256: canonicalFixture.sha256,
    });
    expect(mocks.createKnowledgeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: candidateArtifactId,
        sourceArtifactHash: candidateSha256,
        archiveHash: canonicalFixture.sha256,
        totalBytes: canonicalFixture.buffer.length,
        documents: expect.arrayContaining([
          expect.objectContaining({ id: "overview-1", customerVisible: true }),
          expect.objectContaining({ id: "leaf-1", customerVisible: true }),
        ]),
      }),
    );
    const snapshotInput = mocks.createKnowledgeSnapshot.mock.calls[0]![0];
    expect(snapshotInput.documents).toHaveLength(2);
    expect(
      snapshotInput.documents.some((document: { path: string }) =>
        document.path.endsWith("README.md"),
      ),
    ).toBe(false);
  });

  it("keeps a new import receipt independent from SiteOps lineage", async () => {
    const database = importDatabase();
    mocks.getDb.mockResolvedValue(database);

    await importWebsiteKnowledgeArtifact({
      projectId: "project-acceptance-001",
      idempotencyKey: "website-kb-project-acceptance-epoch-v5",
      value: value(),
    });

    expect(database.receiptInserts).toEqual([
      expect.objectContaining({
        siteOpsKnowledgeInputEpochId: null,
      }),
    ]);
  });

  it("keeps independent project and user imports isolated", async () => {
    const secondCandidateArtifactId = `artifact_${"c".repeat(64)}`;
    const secondFinalArtifactId = `artifact_${"d".repeat(64)}`;
    mocks.readArtifact.mockImplementation(async (artifactId: string) => {
      const secondProject =
        artifactId === secondCandidateArtifactId ||
        artifactId === secondFinalArtifactId;
      const candidate =
        artifactId === candidateArtifactId ||
        artifactId === secondCandidateArtifactId;
      if (
        !candidate &&
        artifactId !== finalArtifactId &&
        artifactId !== secondFinalArtifactId
      ) {
        return null;
      }
      return {
        artifactId,
        projectId: secondProject
          ? "project-acceptance-002"
          : "project-acceptance-001",
        filename: candidate ? "candidate.zip" : "knowledge-base.zip",
        mimeType: "application/zip",
        bytes: candidate ? candidateBytes.length : finalBytes.length,
        sha256: candidate ? candidateSha256 : finalSha256,
      };
    });
    mocks.readStoredFile.mockImplementation(async (artifactId: string) =>
      artifactId === candidateArtifactId ||
      artifactId === secondCandidateArtifactId
        ? stored(candidateBytes, candidateSha256, "candidate.zip")
        : artifactId === finalArtifactId || artifactId === secondFinalArtifactId
          ? stored(finalBytes, finalSha256, "knowledge-base.zip")
          : null,
    );
    mocks.createKnowledgeSnapshot
      .mockResolvedValueOnce({ id: "snapshot-project-001", version: 1 })
      .mockResolvedValueOnce({ id: "snapshot-project-002", version: 1 });
    mocks.persistKnowledgeSnapshotArchive
      .mockResolvedValueOnce("knowledge-archives/7/project-001.zip")
      .mockResolvedValueOnce("knowledge-archives/8/project-002.zip");

    mocks.getDb.mockResolvedValueOnce(
      importDatabase(undefined, {
        userId: 7,
        companyName: "示例企业",
        status: "completed",
      }),
    );
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-isolation-001",
        value: value(),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      snapshot: { id: "snapshot-project-001" },
    });

    mocks.getDb.mockResolvedValueOnce(
      importDatabase(undefined, {
        userId: 8,
        companyName: "示例企业",
        status: "completed",
      }),
    );
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-002",
        idempotencyKey: "website-kb-project-isolation-002",
        value: value({
          candidateArtifactId: secondCandidateArtifactId,
          finalArtifactId: secondFinalArtifactId,
        }),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      snapshot: { id: "snapshot-project-002" },
    });

    expect(mocks.persistKnowledgeSnapshotArchive.mock.calls).toEqual([
      [expect.objectContaining({ userId: 7 })],
      [expect.objectContaining({ userId: 8 })],
    ]);
    expect(mocks.createKnowledgeSnapshot.mock.calls).toEqual([
      [expect.objectContaining({ userId: 7 })],
      [expect.objectContaining({ userId: 8 })],
    ]);
  });

  it("rejects project ownership and byte/hash mismatches before importing", async () => {
    mocks.readArtifact.mockImplementation(async (artifactId: string) => ({
      artifactId,
      projectId: "different-project",
      filename: "knowledge.zip",
      bytes:
        artifactId === candidateArtifactId
          ? candidateBytes.length
          : finalBytes.length,
      sha256:
        artifactId === candidateArtifactId ? candidateSha256 : finalSha256,
    }));
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-mismatch-v5",
        value: value(),
      }),
    ).rejects.toMatchObject({ code: "TASK_PROJECT_MISMATCH", status: 403 });
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();

    mocks.readArtifact.mockReset();
    mocks.readArtifact.mockResolvedValue({
      artifactId: candidateArtifactId,
      projectId: "project-acceptance-001",
      filename: "bad.zip",
      bytes: candidateBytes.length,
      sha256: "f".repeat(64),
    });
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-hash-mismatch-v5",
        value: value(),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH", status: 409 });
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("rejects the raw final SHA before canonicalization can establish identity", async () => {
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-raw-final-sha-v5",
        value: value({ finalSha256: canonicalFixture.sha256 }),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH", status: 409 });
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the package manifest hash bound to its original bytes", async () => {
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-manifest-mismatch-v5",
        value: value({ packageManifestSha256: "f".repeat(64) }),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH", status: 409 });
    expect(mocks.removeStoredKnowledgeAssets).toHaveBeenCalledWith([]);
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeSnapshot).not.toHaveBeenCalled();
  });
});
