import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  findRetainedKnowledgeBaseLocalAsset,
  resumeKnowledgeBaseDeferredTurnAttachments,
  type KnowledgeBaseDeferredUploadResumeResult,
} from "./knowledge-base-deferred-upload-recovery";
import {
  inspectKnowledgeBaseDeferredAttachmentStagePolicy,
  requireKnowledgeBaseDeferredAttachmentStageBuild,
} from "./knowledge-base-deferred-attachment-stage-policy";

function manifest(count: number, withSha256 = false) {
  return Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index + 1}`,
    ordinal: index + 1,
    total: count,
    filename: `attachment-${index + 1}.jpg`,
    sizeBytes: 100 + index,
    mimeType: "image/jpeg",
    lastModified: 1_700_000_000_000 + index,
    ...(withSha256 ? { sha256: String(index + 1).repeat(64) } : {}),
  }));
}

function snapshot(input: {
  count: number;
  staged: number;
  withSha256?: boolean;
}) {
  return {
    buildId: "00000000-0000-4000-8000-000000000001",
    turn: {
      id: "00000000-0000-4000-8000-000000000002",
      stagedUserAttachmentCount: input.staged,
      expectedUserAttachmentCount: input.count,
    },
    clientAttachmentManifest: manifest(input.count, input.withSha256),
  } as any;
}

const resumeInput = {
  userId: 27,
  projectAssignmentId: "assignment-1",
  conversationId: "conv-incident",
  turnId: "00000000-0000-4000-8000-000000000002",
  clientRequestId: "request-incident",
  expectedResetRevision: 0,
};

function retained(ordinal: number) {
  return {
    localAssetId: `asset_${String(ordinal).padStart(30, "0")}`,
    bytes: Buffer.from(`retained-${ordinal}`),
    contentSha256: "a".repeat(64),
  };
}

function eligibleBuild(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    activeTurnId: resumeInput.turnId,
    executionMode: "materialized_bundle_v1",
    skillVersion: "5",
    providerProtocol: "manus_v2",
    status: "confirming",
    revision: 73,
    currentLeafId: "8.7",
    totalNodeCount: 56,
    confirmedCount: 55,
    directPrefilledCount: 0,
    logoSha256: null,
    ...overrides,
  } as any;
}

function resumeDependencies() {
  return {
    requireStageBuild: async () => eligibleBuild(),
  };
}

describe("knowledge-base deferred local upload recovery", () => {
  it("recovers the committed fourth file after a lost response and reports only five customer files missing", async () => {
    const callOrder: string[] = [];
    const stageAttachment = vi.fn(async (input: any) => {
      callOrder.push(`stage:${input.index + 1}`);
      return {
        ...snapshot({ count: 9, staged: 4 }).turn,
        stagedUserAttachmentCount: input.index + 1,
        expectedUserAttachmentCount: 9,
      };
    });
    const findRetainedAsset = vi.fn(async (input: any) => {
      const ordinal = Number(input.filename.match(/\d+/u)?.[0]);
      callOrder.push(`find:${ordinal}`);
      return input.filename === "attachment-4.jpg" ? retained(4) : null;
    });

    const result = await resumeKnowledgeBaseDeferredTurnAttachments(
      resumeInput,
      {
        ...resumeDependencies(),
        inspectReservation: async () => snapshot({ count: 9, staged: 3 }),
        deriveIdentity: ((input: any) => ({
          localAssetId: `asset_${String(input.coordinate.ordinal).padStart(30, "0")}`,
        })) as any,
        findRetainedAsset: findRetainedAsset as any,
        stageAttachment: stageAttachment as any,
      },
    );

    expect(result).toMatchObject<KnowledgeBaseDeferredUploadResumeResult>({
      stagedCustomerAttachmentCount: 4,
      retainedCustomerAttachmentCount: 4,
      readyToDispatch: false,
      missingCustomerAttachments: [
        { itemId: "item-5", ordinal: 5, filename: "attachment-5.jpg" },
        { itemId: "item-6", ordinal: 6, filename: "attachment-6.jpg" },
        { itemId: "item-7", ordinal: 7, filename: "attachment-7.jpg" },
        { itemId: "item-8", ordinal: 8, filename: "attachment-8.jpg" },
        { itemId: "item-9", ordinal: 9, filename: "attachment-9.jpg" },
      ],
      attachmentManifest: manifest(9),
    });
    expect(stageAttachment).toHaveBeenCalledTimes(1);
    expect(stageAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 3,
        clientAttachmentManifest: manifest(9),
        managedUploadProof: expect.objectContaining({
          itemId: "item-4",
          contentSha256: "a".repeat(64),
        }),
        managedUploadBytes: Buffer.from("retained-4"),
      }),
    );
    expect(findRetainedAsset).toHaveBeenCalledTimes(6);
    expect(callOrder.slice(0, 3)).toEqual(["find:4", "stage:4", "find:5"]);
    expect(findRetainedAsset).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includeBytes: true }),
    );
    expect(findRetainedAsset).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ includeBytes: false }),
    );
    expect(result.attachmentManifest[0]).not.toHaveProperty("sha256");
  });

  it("keeps later retained content usable but stops staging at the first actual gap", async () => {
    const stageAttachment = vi.fn();
    const result = await resumeKnowledgeBaseDeferredTurnAttachments(
      resumeInput,
      {
        ...resumeDependencies(),
        inspectReservation: async () => snapshot({ count: 6, staged: 3 }),
        deriveIdentity: ((input: any) => ({
          localAssetId: `asset_${String(input.coordinate.ordinal).padStart(30, "0")}`,
        })) as any,
        findRetainedAsset: (async (input: any) =>
          input.filename === "attachment-5.jpg" ? retained(5) : null) as any,
        stageAttachment: stageAttachment as any,
      },
    );

    expect(result).toMatchObject({
      stagedCustomerAttachmentCount: 3,
      retainedCustomerAttachmentCount: 4,
      readyToDispatch: false,
      missingCustomerAttachments: [{ ordinal: 4 }, { ordinal: 6 }],
    });
    expect(stageAttachment).not.toHaveBeenCalled();
  });

  it("stages every contiguous retained file without dispatching and preserves optional manifest hashes", async () => {
    const stageAttachment = vi.fn(async (input: any) => ({
      ...snapshot({ count: 3, staged: input.index + 1 }).turn,
      stagedUserAttachmentCount: input.index + 1,
      expectedUserAttachmentCount: 3,
    }));
    const findRetainedAsset = vi.fn(async (input: any) => {
      const ordinal = Number(input.filename.match(/\d+/u)?.[0]);
      return retained(ordinal);
    });

    const result = await resumeKnowledgeBaseDeferredTurnAttachments(
      resumeInput,
      {
        ...resumeDependencies(),
        inspectReservation: async () =>
          snapshot({ count: 3, staged: 1, withSha256: true }),
        deriveIdentity: (() => ({
          localAssetId: `asset_${"1".repeat(30)}`,
        })) as any,
        findRetainedAsset: findRetainedAsset as any,
        stageAttachment: stageAttachment as any,
      },
    );

    expect(result).toMatchObject({
      stagedCustomerAttachmentCount: 3,
      retainedCustomerAttachmentCount: 3,
      missingCustomerAttachments: [],
      readyToDispatch: true,
    });
    expect(stageAttachment).toHaveBeenCalledTimes(2);
    expect(findRetainedAsset).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sha256: "2".repeat(64) }),
    );
  });

  it("rejects resume before reading bytes when the turn is no longer on the materialized-v5 Manus stage boundary", async () => {
    const findRetainedAsset = vi.fn();
    const stageAttachment = vi.fn();

    await expect(
      resumeKnowledgeBaseDeferredTurnAttachments(resumeInput, {
        inspectReservation: async () => snapshot({ count: 1, staged: 0 }),
        requireStageBuild: () =>
          requireKnowledgeBaseDeferredAttachmentStageBuild(
            {
              userId: resumeInput.userId,
              conversationId: resumeInput.conversationId,
            },
            async () => eligibleBuild({ providerProtocol: "legacy_v1" }),
          ),
        findRetainedAsset: findRetainedAsset as any,
        stageAttachment: stageAttachment as any,
      }),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(findRetainedAsset).not.toHaveBeenCalled();
    expect(stageAttachment).not.toHaveBeenCalled();
  });

  it("applies the byte-authoritative duplicate Logo policy before resumed staging", async () => {
    const stageAttachment = vi.fn();
    const cancelUnprepared = vi.fn(async () => undefined);

    await expect(
      resumeKnowledgeBaseDeferredTurnAttachments(resumeInput, {
        inspectReservation: async () => snapshot({ count: 1, staged: 0 }),
        requireStageBuild: async () =>
          eligibleBuild({ logoSha256: "a".repeat(64) }),
        deriveIdentity: (() => ({
          localAssetId: `asset_${"1".repeat(30)}`,
        })) as any,
        findRetainedAsset: (async () => retained(1)) as any,
        cancelUnprepared: cancelUnprepared as any,
        stageAttachment: stageAttachment as any,
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
    });
    expect(cancelUnprepared).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        turnId: resumeInput.turnId,
      }),
    );
    expect(stageAttachment).not.toHaveBeenCalled();
  });

  it("preserves the shared revise Logo decode rejection", async () => {
    const validateCapturedImage = vi.fn().mockRejectedValue(new Error("bad"));
    const item = manifest(1, true)[0]!;

    const rejection = await inspectKnowledgeBaseDeferredAttachmentStagePolicy({
      build: eligibleBuild({
        providerProtocol: "legacy_v1",
        skillVersion: "4",
        revision: 0,
        currentLeafId: "1.1",
        confirmedCount: 0,
        logoSha256: null,
      }),
      turnId: resumeInput.turnId,
      attachmentManifest: [item],
      index: 0,
      fileId: "asset-logo",
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      contentSha256: item.sha256!,
      validateCapturedImage,
    });

    expect(validateCapturedImage).toHaveBeenCalledOnce();
    expect(rejection).toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: expect.stringContaining("安全解码"),
    });
  });
});

describe("retained local asset content identity", () => {
  const bytes = Buffer.from("dashboard-owned-content");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = {
    userId: 27,
    localAssetId: "asset_deterministic",
    filename: "frozen-name.pdf",
    mimeType: "application/pdf",
    sizeBytes: bytes.length,
    sha256,
  };
  const asset = (overrides: Record<string, unknown> = {}) =>
    ({
      id: input.localAssetId,
      scope: "managed_user",
      accountUserId: input.userId,
      presalesProjectId: null,
      filename: "ingress-name.bin",
      mimeType: "application/octet-stream",
      sizeBytes: bytes.length,
      contentSha256: sha256,
      retainUntil: new Date("2099-01-01T00:00:00.000Z"),
      ...overrides,
    }) as any;
  const stored = (overrides: Record<string, unknown> = {}) =>
    ({
      filename: "stored-name.dat",
      mimeType: "application/x-custom",
      sizeBytes: bytes.length,
      sha256,
      createReadStream: () =>
        (async function* () {
          yield bytes;
        })(),
      ...overrides,
    }) as any;

  it("recovers verified content despite filename and MIME adapter metadata drift", async () => {
    const result = await findRetainedKnowledgeBaseLocalAsset(input, {
      loadOwnedAsset: async () => asset(),
      readStoredFile: async () => stored(),
    });

    expect(result).toEqual({
      localAssetId: input.localAssetId,
      contentSha256: sha256,
      bytes,
    });
  });

  it("resumes and stages the frozen manifest after row and stored display metadata drift", async () => {
    const frozenManifest = [
      {
        itemId: "item-drifted-display",
        ordinal: 1,
        total: 1,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        lastModified: 1_700_000_000_000,
        sha256,
      },
    ];
    const stageAttachment = vi.fn(async () => ({
      ...snapshot({ count: 1, staged: 1 }).turn,
      stagedUserAttachmentCount: 1,
      expectedUserAttachmentCount: 1,
    }));

    const result = await resumeKnowledgeBaseDeferredTurnAttachments(
      resumeInput,
      {
        ...resumeDependencies(),
        inspectReservation: async () => ({
          buildId: "00000000-0000-4000-8000-000000000001",
          turn: {
            ...snapshot({ count: 1, staged: 0 }).turn,
            stagedUserAttachmentCount: 0,
            expectedUserAttachmentCount: 1,
          },
          clientAttachmentManifest: frozenManifest,
        }),
        deriveIdentity: (() => ({
          localAssetId: input.localAssetId,
        })) as any,
        findRetainedAsset: ((candidate: any) =>
          findRetainedKnowledgeBaseLocalAsset(candidate, {
            loadOwnedAsset: async () => asset(),
            readStoredFile: async () => stored(),
          })) as any,
        stageAttachment: stageAttachment as any,
      },
    );

    expect(result).toMatchObject({
      stagedCustomerAttachmentCount: 1,
      retainedCustomerAttachmentCount: 1,
      missingCustomerAttachments: [],
      readyToDispatch: true,
    });
    expect(stageAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: {
          file_id: input.localAssetId,
          filename: input.filename,
        },
        managedUploadProof: expect.objectContaining({
          itemId: "item-drifted-display",
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          contentSha256: sha256,
        }),
        managedUploadBytes: bytes,
      }),
    );
  });

  it("treats a cleaned retained body as missing even while its deterministic row remains", async () => {
    const result = await findRetainedKnowledgeBaseLocalAsset(input, {
      loadOwnedAsset: async () => asset(),
      readStoredFile: async () => null,
    });

    expect(result).toBeNull();
  });

  it("treats an expired row as missing before reading bytes that await the sweeper", async () => {
    const readStoredFile = vi.fn(async () => stored());
    const result = await findRetainedKnowledgeBaseLocalAsset(input, {
      loadOwnedAsset: async () =>
        asset({ retainUntil: new Date("2026-01-01T00:00:00.000Z") }),
      readStoredFile,
    });

    expect(result).toBeNull();
    expect(readStoredFile).not.toHaveBeenCalled();
  });

  it("rejects stored size, explicit hash, and actual byte drift", async () => {
    await expect(
      findRetainedKnowledgeBaseLocalAsset(input, {
        loadOwnedAsset: async () => asset(),
        readStoredFile: async () => stored({ sizeBytes: bytes.length + 1 }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      findRetainedKnowledgeBaseLocalAsset(
        { ...input, sha256: "f".repeat(64) },
        {
          loadOwnedAsset: async () => asset(),
          readStoredFile: async () => stored(),
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      findRetainedKnowledgeBaseLocalAsset(input, {
        loadOwnedAsset: async () => asset(),
        readStoredFile: async () =>
          stored({
            createReadStream: () =>
              (async function* () {
                yield Buffer.alloc(bytes.length, 0x78);
              })(),
          }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a retained row outside the deterministic owner coordinate", async () => {
    await expect(
      findRetainedKnowledgeBaseLocalAsset(input, {
        loadOwnedAsset: async () => asset({ accountUserId: input.userId + 1 }),
        readStoredFile: async () => stored(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      findRetainedKnowledgeBaseLocalAsset(input, {
        loadOwnedAsset: async () => asset({ id: "asset_other" }),
        readStoredFile: async () => stored(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("hashes a noncontiguous suffix without returning a retained body", async () => {
    const result = await findRetainedKnowledgeBaseLocalAsset(
      { ...input, includeBytes: false },
      {
        loadOwnedAsset: async () => asset(),
        readStoredFile: async () => stored(),
      },
    );

    expect(result).toEqual({
      localAssetId: input.localAssetId,
      contentSha256: sha256,
    });
  });
});
