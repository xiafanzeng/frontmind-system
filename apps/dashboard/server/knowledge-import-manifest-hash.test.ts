import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  axiosGet: vi.fn(),
  collectDescriptors: vi.fn(),
  descriptorHash: vi.fn(),
  downloadArchiveBytes: vi.fn(),
  readKnowledgeArchive: vi.fn(),
  removeStoredKnowledgeAssets: vi.fn(),
  persistKnowledgeSnapshotArchive: vi.fn(),
  removeKnowledgeSnapshotArchive: vi.fn(),
  assertKnowledgeArchiveEnterpriseIdentity: vi.fn(),
  createKnowledgeSnapshot: vi.fn(),
  getDashboardWorkspace: vi.fn(),
  getLatestKnowledgeSnapshot: vi.fn(),
  getPresalesCredentialForResource: vi.fn(),
  getPresalesTaskProjectBinding: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { get: mocks.axiosGet },
}));

vi.mock("./db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("./knowledge-base-artifact", () => ({
  collectKnowledgeArchiveDescriptors: mocks.collectDescriptors,
  knowledgeArchiveDescriptorHash: mocks.descriptorHash,
}));

vi.mock("./dashboard-api", () => ({
  assertKnowledgeArchiveEnterpriseIdentity:
    mocks.assertKnowledgeArchiveEnterpriseIdentity,
  downloadArchiveBytes: mocks.downloadArchiveBytes,
  readKnowledgeArchive: mocks.readKnowledgeArchive,
  removeStoredKnowledgeAssets: mocks.removeStoredKnowledgeAssets,
}));

vi.mock("./dashboard-service", () => ({
  createKnowledgeSnapshot: mocks.createKnowledgeSnapshot,
  getDashboardWorkspace: mocks.getDashboardWorkspace,
  getLatestKnowledgeSnapshot: mocks.getLatestKnowledgeSnapshot,
}));

vi.mock("./knowledge-snapshot-archive-store", () => ({
  persistKnowledgeSnapshotArchive: mocks.persistKnowledgeSnapshotArchive,
  removeKnowledgeSnapshotArchive: mocks.removeKnowledgeSnapshotArchive,
}));

vi.mock("./presales-service", () => ({
  getPresalesCredentialForResource: mocks.getPresalesCredentialForResource,
  getPresalesTaskProjectBinding: mocks.getPresalesTaskProjectBinding,
}));

vi.mock("./upstream-config", () => ({
  getUpstreamBaseUrl: () => "https://api.example.test",
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

function importDatabase(transactionResults: unknown[][] = [[], []]) {
  const transactionUpdates: Array<Record<string, unknown>> = [];
  const transactionUpdateQuery = {
    set: (value: Record<string, unknown>) => {
      transactionUpdates.push(value);
      return transactionUpdateQuery;
    },
    where: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    select: () => queryResult(transactionResults.shift() ?? []),
    insert: () => ({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: () => transactionUpdateQuery,
  };
  const provisionQuery = {
    from: () => provisionQuery,
    where: async () => [
      { userId: 7, companyName: "示例企业", status: "completed" },
    ],
  };
  const updateQuery = {
    set: () => updateQuery,
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    select: () => provisionQuery,
    transaction: async (operation: (value: typeof tx) => unknown) =>
      operation(tx),
    update: () => updateQuery,
    transactionUpdates,
    receiptUpdateWhere: updateQuery.where,
  };
}

describe("website knowledge import v3 manifest binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue(importDatabase());
    mocks.getPresalesTaskProjectBinding.mockResolvedValue({
      projectId: "project-acceptance-001",
      apiCredentialId: "credential-1",
      credentialVersion: 3,
    });
    mocks.getPresalesCredentialForResource.mockResolvedValue({
      id: "credential-1",
      version: 3,
      apiKey: "sk-test-credential",
    });
    mocks.assertServiceCapability.mockResolvedValue(undefined);
    mocks.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
    mocks.createKnowledgeMonitoringHandoff.mockResolvedValue({
      created: [],
      assigned: false,
    });
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        task: {
          id: "task-website-kb-v3",
          status: "completed",
          output: [{ type: "output_file" }],
        },
      },
    });
    mocks.collectDescriptors.mockReturnValue([
      {
        outputItemId: "output-v3",
        fileId: "file-v3",
        filename: "knowledge.zip",
      },
    ]);
    mocks.descriptorHash.mockReturnValue("a".repeat(64));
    mocks.downloadArchiveBytes.mockResolvedValue({
      buffer: Buffer.from("validated archive bytes"),
      filename: "knowledge.zip",
    });
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "d".repeat(64),
      storedAssetKeys: [],
      documents: [],
      assets: [],
    });
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
    mocks.getLatestKnowledgeSnapshot.mockResolvedValue({
      id: "snapshot-existing",
      version: 1,
    });
  });

  it("rejects a parsed package manifest whose hash differs from the v3 declaration", async () => {
    const buffer = Buffer.from("validated archive bytes");

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v3",
        value: {
          schemaVersion: 3,
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
          companyName: "示例企业",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactSha256: createHash("sha256").update(buffer).digest("hex"),
          filename: "knowledge.zip",
        },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_HASH_MISMATCH",
      status: 409,
      message: "知识库 package manifest 哈希与官网声明不一致",
    });

    expect(mocks.readKnowledgeArchive).toHaveBeenCalledWith(
      buffer,
      "knowledge.zip",
      expect.any(String),
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 1,
      },
    );
    expect(mocks.createKnowledgeSnapshot).not.toHaveBeenCalled();
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();
    expect(mocks.removeStoredKnowledgeAssets).toHaveBeenCalledWith([]);
  });

  it("strictly revalidates a v3 request that hits a completed legacy v2 receipt", async () => {
    const buffer = Buffer.from("validated archive bytes");
    const artifactSha256 = createHash("sha256").update(buffer).digest("hex");
    const database = importDatabase([
      [
        {
          id: "receipt-v2",
          userId: 7,
          projectId: "project-acceptance-001",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactHash: artifactSha256,
          sourceReference: "project-acceptance-001:task-website-kb-v3",
          status: "completed",
          snapshotId: "snapshot-v2",
          attemptCount: 1,
          updatedAt: new Date("2026-07-29T00:00:00.000Z"),
        },
      ],
    ]);
    mocks.getDb.mockResolvedValue(database);
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "c".repeat(64),
      storedAssetKeys: [],
      documents: [],
      assets: [],
    });

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v3",
        value: {
          schemaVersion: 3,
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
          companyName: "示例企业",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactSha256,
          filename: "knowledge.zip",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      receiptId: "receipt-v2",
      snapshot: { id: "snapshot-new" },
    });

    expect(mocks.readKnowledgeArchive).toHaveBeenCalledWith(
      buffer,
      "knowledge.zip",
      expect.any(String),
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 1,
      },
    );
    expect(mocks.getLatestKnowledgeSnapshot).not.toHaveBeenCalled();
    expect(database.transactionUpdates).toContainEqual(
      expect.objectContaining({
        status: "processing",
        sourceReference: `website-kb:v3:1:website-lead-v1:${"c".repeat(64)}`,
      }),
    );
    expect(mocks.assertKnowledgeBaseWritable).toHaveBeenCalledWith(7);
    expect(mocks.persistKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 7,
      snapshotId: expect.any(String),
      buffer,
      expectedSha256: artifactSha256,
    });
    expect(mocks.createKnowledgeMonitoringHandoff).toHaveBeenCalledWith({
      userId: 7,
      actorUserId: 7,
      knowledgeSnapshotId: "snapshot-new",
    });
  });

  it("preserves committed snapshot assets when the monitoring handoff fails", async () => {
    const buffer = Buffer.from("validated archive bytes");
    const artifactSha256 = createHash("sha256").update(buffer).digest("hex");
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "c".repeat(64),
      storedAssetKeys: ["committed-image.webp"],
      documents: [],
      assets: [],
    });
    mocks.createKnowledgeMonitoringHandoff.mockRejectedValue(
      new Error("simulated handoff failure"),
    );

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-handoff-failure",
        value: {
          schemaVersion: 3,
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
          companyName: "示例企业",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactSha256,
          filename: "knowledge.zip",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      snapshot: { id: "snapshot-new" },
    });

    expect(mocks.createKnowledgeSnapshot).toHaveBeenCalled();
    expect(mocks.createKnowledgeMonitoringHandoff).toHaveBeenCalledTimes(2);
    expect(mocks.removeStoredKnowledgeAssets).not.toHaveBeenCalled();
    expect(mocks.removeKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("retries a zero-row receipt completion and returns the committed snapshot", async () => {
    const buffer = Buffer.from("validated archive bytes");
    const artifactSha256 = createHash("sha256").update(buffer).digest("hex");
    const database = importDatabase();
    database.receiptUpdateWhere
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    mocks.getDb.mockResolvedValue(database);
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "c".repeat(64),
      storedAssetKeys: ["committed-image.webp"],
      documents: [],
      assets: [],
    });

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-receipt-recovery",
        value: {
          schemaVersion: 3,
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
          companyName: "示例企业",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactSha256,
          filename: "knowledge.zip",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      snapshot: { id: "snapshot-new" },
    });

    expect(database.receiptUpdateWhere).toHaveBeenCalledTimes(2);
    expect(mocks.createKnowledgeMonitoringHandoff).toHaveBeenCalledOnce();
    expect(mocks.removeStoredKnowledgeAssets).not.toHaveBeenCalled();
    expect(mocks.removeKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("keeps an identical completed v3 receipt idempotent without revalidation", async () => {
    const buffer = Buffer.from("validated archive bytes");
    const artifactSha256 = createHash("sha256").update(buffer).digest("hex");
    mocks.getDb.mockResolvedValue(
      importDatabase([
        [
          {
            id: "receipt-v3",
            userId: 7,
            projectId: "project-acceptance-001",
            taskId: "task-website-kb-v3",
            outputItemId: "output-v3",
            fileId: "file-v3",
            descriptorHash: "a".repeat(64),
            artifactHash: artifactSha256,
            sourceReference: `website-kb:v3:1:website-lead-v1:${"c".repeat(64)}`,
            status: "completed",
            snapshotId: "snapshot-v3",
            attemptCount: 1,
            updatedAt: new Date("2026-07-29T00:00:00.000Z"),
          },
        ],
      ]),
    );

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v3",
        value: {
          schemaVersion: 3,
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
          companyName: "示例企业",
          taskId: "task-website-kb-v3",
          outputItemId: "output-v3",
          fileId: "file-v3",
          descriptorHash: "a".repeat(64),
          artifactSha256,
          filename: "knowledge.zip",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: true,
      receiptId: "receipt-v3",
      snapshot: { id: "snapshot-existing" },
    });

    expect(mocks.axiosGet).not.toHaveBeenCalled();
    expect(mocks.readKnowledgeArchive).not.toHaveBeenCalled();
    expect(mocks.persistKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("uses the finalized file for v4 while binding lineage to the candidate task", async () => {
    const buffer = Buffer.from("finalized v4 archive bytes");
    const finalSha256 = createHash("sha256").update(buffer).digest("hex");
    mocks.downloadArchiveBytes.mockResolvedValue({
      buffer,
      filename: "示例企业_knowledge_base.zip",
    });
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "d".repeat(64),
      storedAssetKeys: [],
      documents: [],
      assets: [],
    });

    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v4",
        value: {
          schemaVersion: 4,
          companyName: "示例企业",
          candidate: {
            taskId: "task-website-kb-v3",
            outputItemId: "output-v3",
            fileId: "file-v3",
            descriptorHash: "a".repeat(64),
            sha256: "b".repeat(64),
          },
          finalArtifact: {
            fileId: "final-file-v4",
            filename: "示例企业_knowledge_base.zip",
            sha256: finalSha256,
            archiveContractVersion: 3,
            validationProfile: "website-lead-v1",
            packageManifestSha256: "d".repeat(64),
            finalizerVersion: "website-kb-finalizer-v1",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      snapshot: { id: "snapshot-new" },
    });

    expect(mocks.downloadArchiveBytes).toHaveBeenCalledWith({
      descriptor: {
        outputItemId: "output-v3",
        fileId: "final-file-v4",
        filename: "示例企业_knowledge_base.zip",
        mimeType: "application/zip",
      },
      apiKey: "sk-test-credential",
      baseUrl: "https://api.example.test",
    });
    expect(mocks.readKnowledgeArchive).toHaveBeenCalledWith(
      buffer,
      "示例企业_knowledge_base.zip",
      expect.any(String),
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 3,
      },
    );
    expect(mocks.createKnowledgeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: "task-website-kb-v3",
        sourceArtifactHash: "a".repeat(64),
        archiveHash: finalSha256,
      }),
    );
    expect(mocks.persistKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 7,
      snapshotId: expect.any(String),
      buffer,
      expectedSha256: finalSha256,
    });
  });
});
