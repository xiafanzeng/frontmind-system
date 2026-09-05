import { describe, expect, it, vi } from "vitest";

import {
  FILE_CONTENT_RETENTION_LOCK_NAME,
  cleanupExpiredFileResourcePhases,
  fileContentExpiryFromUpload,
  fileResourceContentExpiry,
  historicalKnowledgeBaseTurnUserUploadFileIds,
  historicalKnowledgeBaseUserUploadReferenceSql,
  historicalMessageUserUploadReferenceSql,
  prepareFileContentRetentionForServing,
  runFileContentRetentionCleanup,
} from "./file-content-retention";

describe("file content retention", () => {
  it("uses an immutable 30-day clock from upload completion", () => {
    const uploadedAt = new Date("2026-07-01T08:30:00.000Z");
    expect(fileContentExpiryFromUpload(uploadedAt).toISOString()).toBe(
      "2026-07-31T08:30:00.000Z",
    );
  });

  it("does not apply the user-upload clock to assistant output resources", () => {
    expect(
      fileResourceContentExpiry({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } as Parameters<typeof fileResourceContentExpiry>[0]),
    ).toBeUndefined();
    expect(
      fileResourceContentExpiry({
        uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toBe(Date.parse("2026-01-31T00:00:00.000Z"));
  });

  it("classifies only customer-upload slots when a KB turn also has generated files", () => {
    const turn = {
      attachmentFileIds: ["file-customer", "file-generated-skill"],
      metadata: {
        userAttachmentCount: 1,
        clientStagedAttachments: [
          { index: 0, file_id: "file-customer", filename: "客户资料.pdf" },
        ],
        generatedAttachmentReservations: {
          "skill:1": {
            status: "completed",
            upstreamFileId: "file-generated-skill",
          },
        },
      },
    };

    expect(historicalKnowledgeBaseTurnUserUploadFileIds(turn)).toEqual([
      "file-customer",
    ]);
    const predicate = historicalKnowledgeBaseUserUploadReferenceSql({
      resourceUserIdExpression: "ur.userId",
      resourceFileIdExpression: "ur.upstreamId",
    });
    expect(predicate).toContain("attachmentFileIds");
    expect(predicate).toContain("clientStagedAttachments[*].file_id");
    expect(predicate).toContain("recovery.attachments[*].file_id");
    expect(predicate).toContain("userAttachmentCount");
  });

  it("classifies ordinary attachment provenance only from user messages", () => {
    const predicate = historicalMessageUserUploadReferenceSql({
      resourceUserIdExpression: "ur.userId",
      resourceFileIdExpression: "ur.upstreamId",
    });

    expect(predicate).toContain("INNER JOIN messages");
    expect(predicate).toContain("retention_message.role = 'user'");
    expect(predicate).not.toContain("deletedAt");
  });

  it("accepts a complete legacy customer recovery ledger but rejects an incomplete one", () => {
    const complete = {
      attachmentFileIds: ["legacy-customer", "generated-prefill"],
      metadata: {
        userAttachmentCount: 1,
        recovery: {
          attachments: [{ file_id: "legacy-customer", filename: "legacy.pdf" }],
        },
      },
    };
    expect(historicalKnowledgeBaseTurnUserUploadFileIds(complete)).toEqual([
      "legacy-customer",
    ]);
    expect(
      historicalKnowledgeBaseTurnUserUploadFileIds({
        ...complete,
        metadata: {
          ...complete.metadata,
          userAttachmentCount: 2,
        },
      }),
    ).toEqual([]);
  });

  it("finishes more than 4,000 historical lifecycle rows before serving", async () => {
    const sweep = vi.fn().mockResolvedValue({
      scannedEntries: 0,
      failures: 0,
      hasMore: false,
      nextCursor: null,
    });
    const backfill = vi
      .fn()
      .mockResolvedValueOnce(4_000)
      .mockResolvedValueOnce(4_000)
      .mockResolvedValueOnce(17);
    const hasBacklog = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const yieldBetweenPasses = vi.fn().mockResolvedValue(undefined);

    const result = await prepareFileContentRetentionForServing({
      database: {} as never,
      sweep: sweep as never,
      backfill: backfill as never,
      hasBacklog,
      yieldBetweenPasses,
    });

    expect(result).toMatchObject({
      databasePasses: 3,
      databaseBackfilled: 8_017,
      filesystemPasses: 1,
    });
    expect(backfill).toHaveBeenCalledTimes(3);
    expect(yieldBetweenPasses).toHaveBeenCalledTimes(2);
  });

  it("purges pending bytes before a backlog of more than 4,000 deleted metadata rows", async () => {
    const expiredAt = new Date("2026-07-01T00:00:00.000Z");
    const uploadedAt = new Date("2026-06-01T00:00:00.000Z");
    const pendingContent = {
      id: "pending-content-after-metadata-backlog",
      userId: 7,
      upstreamId: "file-pending-content",
      projectAssignmentId: null,
      createdAt: uploadedAt,
      uploadedAt,
      contentExpiresAt: expiredAt,
      contentDeletedAt: null,
    };
    const deletedMetadata = Array.from({ length: 4_001 }, (_, index) => ({
      id: `deleted-metadata-${String(index).padStart(4, "0")}`,
      userId: 7,
      upstreamId: `file-deleted-${index}`,
      projectAssignmentId: null,
      createdAt: uploadedAt,
      uploadedAt,
      contentExpiresAt: expiredAt,
      contentDeletedAt: expiredAt,
    }));
    const events: string[] = [];
    let contentLoaded = false;

    const result = await cleanupExpiredFileResourcePhases({
      batchSize: 200,
      maxBatches: 20,
      loadContentCandidates: async () => {
        if (contentLoaded) return [];
        contentLoaded = true;
        return [pendingContent];
      },
      loadMetadataCandidates: async (processed) =>
        deletedMetadata
          .filter((resource) => !processed.has(resource.id))
          .slice(0, 200),
      purgeContent: async (resource) => {
        events.push(`purge:${resource.id}`);
        return { sizeBytes: 512, metadataDeleted: 0 };
      },
      // Simulate compact cards that still have active conversation references.
      // They consume the metadata phase's own 20-batch budget only.
      reclaimMetadata: async (resource) => {
        events.push(`metadata:${resource.id}`);
        return 0;
      },
    });

    expect(events[0]).toBe(`purge:${pendingContent.id}`);
    expect(
      events.filter((event) => event.startsWith("metadata:")),
    ).toHaveLength(4_000);
    expect(result).toMatchObject({
      contentBatches: 1,
      metadataBatches: 20,
      expired: 1,
      bytesReclaimed: 512,
      failures: 0,
    });
  });

  it("runs under a non-blocking advisory lock and always releases it", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], undefined])
      .mockResolvedValueOnce([[{ released: 1 }], undefined]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue({
      cutoff: new Date("2026-08-01T00:00:00.000Z"),
      backfilled: 0,
      batches: 1,
      contentBatches: 1,
      metadataBatches: 0,
      expired: 2,
      metadataDeleted: 1,
      bytesReclaimed: 123,
      failures: 0,
    });

    const result = await runFileContentRetentionCleanup({
      databaseUrl: "mysql://example",
      createConnection: async () => ({ query, end }),
      cleanup,
    });

    expect(result.acquired).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT GET_LOCK(?, 0) AS acquired",
      [FILE_CONTENT_RETENTION_LOCK_NAME],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [FILE_CONTENT_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("does not clean when another instance owns the lock", async () => {
    const query = vi.fn().mockResolvedValue([[{ acquired: 0 }], undefined]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn();

    const result = await runFileContentRetentionCleanup({
      databaseUrl: "mysql://example",
      createConnection: async () => ({ query, end }),
      cleanup,
    });

    expect(result).toEqual({ acquired: false, result: null });
    expect(cleanup).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
