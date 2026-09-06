import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const attachmentLedgerMocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  load: vi.fn(),
  persistAttempt: vi.fn(),
  persistMapping: vi.fn(),
  renewLease: vi.fn(),
}));

const localSourceMocks = vi.hoisted(() => ({
  persist: vi.fn(),
  read: vi.fn(),
}));

vi.mock("./knowledge-base-turn-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledge-base-turn-service")>();
  return {
    ...actual,
    finalizeKnowledgeBaseManusV2AttachmentMappings:
      attachmentLedgerMocks.finalize,
    loadKnowledgeBaseManusV2AttachmentLedger: attachmentLedgerMocks.load,
    persistKnowledgeBaseManusV2AttachmentAttempt:
      attachmentLedgerMocks.persistAttempt,
    persistKnowledgeBaseManusV2AttachmentMapping:
      attachmentLedgerMocks.persistMapping,
    renewKnowledgeBaseTurnLease: attachmentLedgerMocks.renewLease,
  };
});

vi.mock("./knowledge-base-local-source-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./knowledge-base-local-source-store")
    >();
  return {
    ...actual,
    persistKnowledgeBaseBuildSource: localSourceMocks.persist,
    readKnowledgeBaseLocalSource: localSourceMocks.read,
  };
});

import {
  finalKnowledgeBaseManusV2AttachmentInspectionAction,
  ensureKnowledgeBaseManusV2Attachments,
  ensureKnowledgeBaseZhipuMapping,
  inspectKnowledgeBaseManusV2AttachmentAttempt,
  knowledgeBaseManusV2FileRejectionRetryDelay,
  nextKnowledgeBaseManusV2FileCreateGeneration,
  shouldInspectReadyMappingBeforeAttachmentAttempt,
  validateReusableKnowledgeBaseManusV2Attachment,
} from "./knowledge-base-manus-v2-attachments";
import { isAllowedManusV2AttachmentAttemptTransition } from "./knowledge-base-turn-service";
import type { DashboardAgentClient } from "./providers/dashboard-agent-provider";
import * as dashboardAgentProvider from "./providers/dashboard-agent-provider";
import { ManusV2ApiError } from "./manus-v2-client";

const mapping = {
  schemaVersion: 1 as const,
  providerProtocol: "manus_v2" as const,
  mappingKey: `g1:0:${"a".repeat(64)}:42`,
  buildGeneration: 1,
  attachmentIndex: 0,
  sourceFileId: "source-file",
  localStorageKey: `knowledge-base/build-sources/1/00000000-0000-4000-8000-000000000001/g1/${"a".repeat(64)}.bin`,
  contentSha256: "a".repeat(64),
  sizeBytes: 42,
  filename: "facts.pdf",
  mimeType: "application/pdf",
  upstreamFileId: "v2-file-ready",
  status: "ready" as const,
  expiresAt: 2_000_000_000,
  providerGeneration: 1,
  verifiedAt: "2026-08-12T00:00:00.000Z",
};

const attempt = {
  schemaVersion: 1 as const,
  mappingKey: mapping.mappingKey,
  buildGeneration: mapping.buildGeneration,
  attachmentIndex: mapping.attachmentIndex,
  sourceFileId: mapping.sourceFileId,
  localStorageKey: mapping.localStorageKey,
  contentSha256: mapping.contentSha256,
  sizeBytes: mapping.sizeBytes,
  filename: mapping.filename,
  mimeType: mapping.mimeType,
  providerGeneration: 1,
  state: "put_outcome_unknown" as const,
  upstreamFileId: "v2-file-candidate",
  uploadExpiresAt: 2_000_000_000,
  code: "MANUS_V2_FILE_PUT_OUTCOME_UNKNOWN",
  recordedAt: "2026-08-12T00:00:00.000Z",
};

type TestSource = ReturnType<typeof testSources>[number];

function testSources() {
  return ["alpha", "bravo", "charlie"].map((text, index) => {
    const bytes = Buffer.from(`attachment-${text}`);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      index,
      bytes,
      contentSha256,
      sizeBytes: bytes.length,
      sourceFileId: `dashboard-source-${index}`,
      filename: `${text}.pdf`,
      mimeType: "application/pdf",
      localStorageKey: `knowledge-base/build-sources/source-${index}.bin`,
    };
  });
}

function mappingFor(
  source: TestSource,
  providerGeneration: number,
  expiresAt: number,
) {
  return {
    schemaVersion: 1 as const,
    providerProtocol: "manus_v2" as const,
    mappingKey: `g1:${source.index}:${source.contentSha256}:${source.sizeBytes}`,
    buildGeneration: 1,
    attachmentIndex: source.index,
    sourceFileId: source.sourceFileId,
    localStorageKey: source.localStorageKey,
    contentSha256: source.contentSha256,
    sizeBytes: source.sizeBytes,
    filename: source.filename,
    mimeType: source.mimeType,
    upstreamFileId: `${source.filename}-g${providerGeneration}`,
    status: "ready" as const,
    expiresAt,
    providerGeneration,
    verifiedAt: "2026-08-12T00:00:00.000Z",
  };
}

function attemptFor(
  source: TestSource,
  providerGeneration: number,
  state: "put_accepted" | "put_sending",
  expiresAt: number,
) {
  const ready = mappingFor(source, providerGeneration, expiresAt);
  return {
    schemaVersion: 1 as const,
    mappingKey: ready.mappingKey,
    buildGeneration: 1,
    attachmentIndex: source.index,
    sourceFileId: source.sourceFileId,
    localStorageKey: source.localStorageKey,
    contentSha256: source.contentSha256,
    sizeBytes: source.sizeBytes,
    filename: source.filename,
    mimeType: source.mimeType,
    providerGeneration,
    state,
    upstreamFileId: ready.upstreamFileId,
    uploadExpiresAt: expiresAt,
    code: null,
    recordedAt: "2026-08-12T00:00:00.000Z",
  };
}

function testClaim(input?: {
  mappings?: Record<string, ReturnType<typeof mappingFor>>;
  attempts?: Record<string, ReturnType<typeof attemptFor>>;
}) {
  const sources = testSources();
  const preparedDispatch = {
    schemaVersion: 2 as const,
    baseUrl: "https://api.manus.test",
    requestBody: {
      prompt: "Synthetic attachment integration fixture",
      agentProfile: "manus-1.6",
      attachments: sources.map((source) => ({
        file_id: source.sourceFileId,
        filename: source.filename,
      })),
    },
    bodySha256: "b".repeat(64),
    preparedAt: "2026-08-12T00:00:00.000Z",
  };
  const turn = {
    id: "00000000-0000-4000-8000-000000000010",
    userId: 7,
    buildId: "00000000-0000-4000-8000-000000000020",
    buildGeneration: 1,
    apiCredentialId: "00000000-0000-4000-8000-000000000030",
    providerProtocol: "manus_v2" as const,
    attachmentsFrozen: true,
    attachmentFileIds: sources.map((source) => source.sourceFileId),
    manusV2AttachmentMappings: { ...(input?.mappings || {}) },
    manusV2AttachmentAttempts: { ...(input?.attempts || {}) },
    generatedAttachmentReservations: {},
  };
  const recoveryMetadata = {
    attachments: sources.map((source) => ({
      file_id: source.sourceFileId,
      filename: source.filename,
    })),
    attachmentManifest: sources.map((source) => ({
      sizeBytes: source.sizeBytes,
      sha256: source.contentSha256,
      mimeType: source.mimeType,
    })),
    attachmentSourceProofs: sources.map((source) => ({
      fileId: source.sourceFileId,
      localStorageKey: source.localStorageKey,
      sizeBytes: source.sizeBytes,
      contentSha256: source.contentSha256,
      mimeType: source.mimeType,
    })),
  };
  return {
    sources,
    claim: {
      turn,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date("2026-08-12T01:00:00.000Z"),
      upstreamIdempotencyKey: "upstream-operation-token",
      recoveryMetadata,
      preparedDispatch,
    } as any,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  attachmentLedgerMocks.persistAttempt.mockResolvedValue(undefined);
  attachmentLedgerMocks.persistMapping.mockResolvedValue(undefined);
  attachmentLedgerMocks.renewLease.mockResolvedValue(undefined);
  localSourceMocks.persist.mockImplementation(async ({ bytes }) => ({
    storageKey: `knowledge-base/build-sources/test/${createHash("sha256")
      .update(bytes)
      .digest("hex")}.bin`,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  }));
});

describe("Knowledge base Zhipu frozen attachment set", () => {
  it("sends first-path Skill and Instructions inline in frozen order without file create or detail", async () => {
    const { claim, sources } = testClaim();
    const [skill, instructions] = sources;
    const skillFilename = "socratic-kb-builder.skill.zip";
    const instructionsFilename = "frontmind-kb-instructions.md";
    claim.preparedDispatch.requestBody.attachments = [
      {
        file_id: skill!.sourceFileId,
        filename: skillFilename,
      },
      {
        file_id: instructions!.sourceFileId,
        filename: instructionsFilename,
      },
    ];
    claim.turn.attachmentFileIds = [
      skill!.sourceFileId,
      instructions!.sourceFileId,
    ];
    claim.turn.generatedAttachmentReservations = {
      "skill:0": {
        schemaVersion: 1,
        role: "skill",
        attachmentIndex: 0,
        requestHash: "a".repeat(64),
        idempotencyKeyHash: "b".repeat(64),
        filename: skillFilename,
        mimeType: "application/zip",
        sizeBytes: skill!.sizeBytes,
        contentSha256: skill!.contentSha256,
        localStorageKey: skill!.localStorageKey,
        status: "reserved",
        reservedAt: "2026-08-12T00:00:00.000Z",
      },
      "instructions:1": {
        schemaVersion: 1,
        role: "instructions",
        attachmentIndex: 1,
        requestHash: "c".repeat(64),
        idempotencyKeyHash: "d".repeat(64),
        filename: instructionsFilename,
        mimeType: "text/markdown",
        sizeBytes: instructions!.sizeBytes,
        contentSha256: instructions!.contentSha256,
        localStorageKey: instructions!.localStorageKey,
        status: "reserved",
        reservedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockImplementation(async ({ storageKey }) => {
      const source = [skill, instructions].find(
        (candidate) => candidate!.localStorageKey === storageKey,
      );
      return source!.bytes;
    });
    const upload = vi.fn();
    const detail = vi.fn();
    const factory = vi
      .spyOn(dashboardAgentProvider, "createDashboardAgentClient")
      .mockReturnValue({
        uploadFile: upload,
        fileDetail: detail,
      } as unknown as DashboardAgentClient);

    const result = await ensureKnowledgeBaseManusV2Attachments({
      claim,
      credential: {
        id: claim.turn.apiCredentialId!,
        userId: claim.turn.userId,
        apiKey: "synthetic-zhipu-key",
        version: 1,
        provider: "zhipu",
        upstreamModel: "glm-5",
        upstreamEffort: null,
      },
      baseUrl: "https://open.bigmodel.cn",
    });

    expect(result[0]).toEqual({
      file_data: `data:application/zip;base64,${skill!.bytes.toString("base64")}`,
      filename: skillFilename,
      mime_type: "application/zip",
    });
    expect(result[1]).toEqual({
      file_data: `data:text/markdown;base64,${instructions!.bytes.toString("base64")}`,
      filename: instructionsFilename,
      mime_type: "text/markdown",
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "zhipu",
        accountUserId: claim.turn.userId,
        credentialOwnerUserId: claim.turn.userId,
        intentId: claim.turn.id,
      }),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.persistAttempt).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.persistMapping).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.finalize).not.toHaveBeenCalled();
  });

  it.each(["manus", undefined] as const)(
    "requires fresh Zhipu credentials instead of falling back from %s",
    async (provider) => {
      const { claim } = testClaim();
      attachmentLedgerMocks.load.mockResolvedValue({
        turn: claim.turn,
        preparedDispatch: claim.preparedDispatch,
      });
      const factory = vi.spyOn(
        dashboardAgentProvider,
        "createDashboardAgentClient",
      );
      await expect(
        ensureKnowledgeBaseManusV2Attachments({
          claim,
          credential: {
            id: claim.turn.apiCredentialId,
            userId: claim.turn.userId,
            apiKey: "retired",
            version: 1,
            provider,
            upstreamModel: null,
            upstreamEffort: null,
          },
          baseUrl: "https://api.manus.test",
        }),
      ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
      expect(factory).not.toHaveBeenCalled();
      expect(localSourceMocks.read).not.toHaveBeenCalled();
    },
  );

  it("uploads every frozen customer byte through Zhipu and finalizes in source order", async () => {
    const { claim, sources } = testClaim();
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockImplementation(
      async ({ storageKey }) =>
        sources.find((source) => source.localStorageKey === storageKey)!.bytes,
    );
    attachmentLedgerMocks.finalize.mockImplementation(async ({ mappings }) => ({
      attachmentFileIds: mappings.map(
        (mapping: { upstreamFileId: string }) => mapping.upstreamFileId,
      ),
      manusV2AttachmentMappings: Object.fromEntries(
        mappings.map((mapping: { mappingKey: string }) => [
          mapping.mappingKey,
          mapping,
        ]),
      ),
    }));
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const details = sources.map((source, index) => ({
      fileId: `zhipu-file-${index}`,
      filename: source.filename,
      bytes: source.sizeBytes,
      contentType: source.mimeType,
      contentTypeParseStatus: "valid" as const,
      status: "uploaded" as const,
      expiresAt: expiry,
      requestId: null,
    }));
    const uploadFile = vi.fn(async (input) => {
      const detail = details.find((item) => item.filename === input.filename)!;
      return {
        fileId: detail.fileId,
        filename: detail.filename,
        uploadUrl: "",
        uploadExpiresAt: expiry,
        requestId: null,
        detail,
      };
    });
    const fileDetail = vi.fn(
      async (id) => details.find((detail) => detail.fileId === id)!,
    );
    const factory = vi
      .spyOn(dashboardAgentProvider, "createDashboardAgentClient")
      .mockReturnValue({
        uploadFile,
        fileDetail,
      } as unknown as DashboardAgentClient);
    const result = await ensureKnowledgeBaseManusV2Attachments({
      claim,
      credential: {
        id: claim.turn.apiCredentialId,
        userId: claim.turn.userId,
        apiKey: "synthetic-zhipu",
        version: 1,
        provider: "zhipu",
        upstreamModel: "glm-5",
        upstreamEffort: null,
      },
      baseUrl: "https://open.bigmodel.cn",
    });
    expect(result).toEqual(
      details.map((detail) => ({
        file_id: detail.fileId,
        filename: detail.filename,
      })),
    );
    expect(uploadFile.mock.calls.map(([input]) => input.bytes)).toEqual(
      sources.map((source) => source.bytes),
    );
    expect(
      factory.mock.calls.every(
        ([input]) =>
          input.provider === "zhipu" &&
          input.accountUserId === claim.turn.userId &&
          input.credentialOwnerUserId === claim.turn.userId,
      ),
    ).toBe(true);
    expect(attachmentLedgerMocks.finalize).toHaveBeenCalledTimes(1);
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([input]) => input.attempt.state,
      ),
    ).toEqual([
      "creating",
      "complete_upload_accepted",
      "creating",
      "complete_upload_accepted",
      "creating",
      "complete_upload_accepted",
    ]);
  });
});

describe("Managed reusable attachment proof", () => {
  it("uses only one bounded replacement for a definite final-pass failure", () => {
    expect(
      finalKnowledgeBaseManusV2AttachmentInspectionAction({
        inspection: {
          state: "replaceable_unusable",
          code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
        },
        providerGeneration: 1,
      }),
    ).toBe("replace");
    expect(
      finalKnowledgeBaseManusV2AttachmentInspectionAction({
        inspection: {
          state: "replaceable_unusable",
          code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
        },
        providerGeneration: 2,
      }),
    ).toBe("isolate");
  });

  it("waits without replacement when final detail remains ambiguous", () => {
    expect(
      finalKnowledgeBaseManusV2AttachmentInspectionAction({
        inspection: {
          state: "unresolved",
          code: "MANUS_V2_FILE_DETAIL_UNRESOLVED",
        },
        providerGeneration: 1,
      }),
    ).toBe("wait");
  });

  it("rejects an integrity conflict without consuming a replacement generation", () => {
    expect(
      finalKnowledgeBaseManusV2AttachmentInspectionAction({
        inspection: {
          state: "integrity_conflict",
          code: "KB_ATTACHMENT_BYTES_CONFLICT",
        },
        providerGeneration: 1,
      }),
    ).toBe("reject");
  });

  it("reconciles a newer durable candidate before the stale ready mapping after a crash", () => {
    expect(
      shouldInspectReadyMappingBeforeAttachmentAttempt({
        mappingProviderGeneration: 1,
        attemptProviderGeneration: 2,
      }),
    ).toBe(false);
    expect(
      shouldInspectReadyMappingBeforeAttachmentAttempt({
        mappingProviderGeneration: 1,
        attemptProviderGeneration: 1,
      }),
    ).toBe(true);
    expect(
      shouldInspectReadyMappingBeforeAttachmentAttempt({
        mappingProviderGeneration: 1,
        attemptProviderGeneration: null,
      }),
    ).toBe(true);
  });

  it("keeps explicit file rejection backoff independent from replacement generations", () => {
    expect(
      knowledgeBaseManusV2FileRejectionRetryDelay({
        mappingKey: mapping.mappingKey,
        rejectionCount: 1,
        providerRetryAfterMs: 7_000,
      }),
    ).toBe(7_000);
    expect(
      nextKnowledgeBaseManusV2FileCreateGeneration({
        ...attempt,
        state: "create_rejected",
        upstreamFileId: null,
        uploadExpiresAt: null,
      }),
    ).toBeNull();
  });

  it("reuses the same ready id after a crash only with exact id/name/bytes/expiry", async () => {
    const detail = vi.fn().mockResolvedValue({
      fileId: mapping.upstreamFileId,
      filename: mapping.filename,
      status: "uploaded",
      bytes: mapping.sizeBytes,
      expiresAt: mapping.expiresAt,
      contentType: mapping.mimeType,
      requestId: "request-detail",
    });

    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: { fileDetail: detail } as any,
        mapping,
        minimumExpirySeconds: mapping.expiresAt - 1,
      }),
    ).resolves.toMatchObject({ fileId: mapping.upstreamFileId });
    expect(detail).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledWith(mapping.upstreamFileId);
  });

  it.each([
    ["generated.zip", "application/zip"],
    ["instructions.txt", "text/plain"],
    ["facts.pdf", "application/pdf"],
  ])(
    "uses the same generic-MIME allowance when recovering %s",
    async (filename, mimeType) => {
      const genericMapping = {
        ...mapping,
        filename,
        mimeType,
        upstreamFileId: "v2-file-generic-mime",
      };
      const genericAttempt = {
        ...attempt,
        filename,
        mimeType,
        upstreamFileId: "v2-file-generic-mime",
      };
      const detail = vi.fn().mockResolvedValue({
        fileId: "v2-file-generic-mime",
        filename,
        status: "uploaded",
        bytes: mapping.sizeBytes,
        expiresAt: mapping.expiresAt,
        contentType: "application/octet-stream",
        requestId: "request-detail",
      });
      const client = { fileDetail: detail } as any;

      await expect(
        validateReusableKnowledgeBaseManusV2Attachment({
          client,
          mapping: genericMapping,
          minimumExpirySeconds: mapping.expiresAt - 1,
        }),
      ).resolves.toMatchObject({ fileId: "v2-file-generic-mime" });
      await expect(
        inspectKnowledgeBaseManusV2AttachmentAttempt({
          client,
          attempt: genericAttempt,
          minimumExpirySeconds: mapping.expiresAt - 1,
        }),
      ).resolves.toMatchObject({ state: "ready" });
    },
  );

  it("keeps a byte-exact KB mapping reusable when Provider reports a different MIME", async () => {
    const detail = vi.fn().mockResolvedValue({
      fileId: mapping.upstreamFileId,
      filename: mapping.filename,
      status: "uploaded",
      bytes: mapping.sizeBytes,
      expiresAt: mapping.expiresAt,
      contentType: "text/html",
      contentTypeParseStatus: "valid",
      requestId: "request-detail",
    });

    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: { fileDetail: detail } as any,
        mapping,
        minimumExpirySeconds: mapping.expiresAt - 1,
      }),
    ).resolves.toMatchObject({ fileId: mapping.upstreamFileId });
  });

  it.each([
    ["wrong filename", { filename: "other.pdf" }],
    ["wrong bytes", { bytes: 41 }],
    ["not uploaded", { status: "pending" }],
    ["expires too soon", { expiresAt: mapping.expiresAt - 2 }],
  ])("requires replacement for %s", async (_label, override) => {
    const detail = vi.fn().mockResolvedValue({
      fileId: mapping.upstreamFileId,
      filename: mapping.filename,
      status: "uploaded",
      bytes: mapping.sizeBytes,
      expiresAt: mapping.expiresAt,
      contentType: mapping.mimeType,
      requestId: "request-detail",
      ...override,
    });

    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: { fileDetail: detail } as any,
        mapping,
        minimumExpirySeconds: mapping.expiresAt - 1,
      }),
    ).resolves.toBeNull();
  });

  it("treats only a definite 404 as replaceable and never replaces on ambiguous detail", async () => {
    const missing = {
      fileDetail: vi
        .fn()
        .mockRejectedValue(
          new ManusV2ApiError("file.detail", 404, "HTTP_404", false, false),
        ),
    };
    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: missing as any,
        mapping,
        minimumExpirySeconds: 1,
      }),
    ).resolves.toBeNull();

    const responseLoss = new ManusV2ApiError(
      "file.detail",
      null,
      "TRANSPORT_UNKNOWN",
      true,
      true,
    );
    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: {
          fileDetail: vi.fn().mockRejectedValue(responseLoss),
        } as any,
        mapping,
        minimumExpirySeconds: 1,
      }),
    ).rejects.toBe(responseLoss);

    const malformed = new ManusV2ApiError(
      "file.detail",
      502,
      "INVALID_RESPONSE",
      false,
      false,
    );
    await expect(
      validateReusableKnowledgeBaseManusV2Attachment({
        client: {
          fileDetail: vi.fn().mockRejectedValue(malformed),
        } as any,
        mapping,
        minimumExpirySeconds: 1,
      }),
    ).rejects.toBe(malformed);
  });

  it("recovers a PUT response-loss candidate by detailing the same id", async () => {
    const detail = vi.fn().mockResolvedValue({
      fileId: attempt.upstreamFileId,
      filename: attempt.filename,
      status: "uploaded",
      bytes: attempt.sizeBytes,
      expiresAt: attempt.uploadExpiresAt,
      contentType: attempt.mimeType,
      requestId: "detail-request",
    });
    await expect(
      inspectKnowledgeBaseManusV2AttachmentAttempt({
        client: { fileDetail: detail } as any,
        attempt,
        minimumExpirySeconds: attempt.uploadExpiresAt - 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      detail: { fileId: attempt.upstreamFileId },
    });
    expect(detail).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledWith(attempt.upstreamFileId);
  });

  it.each([
    ["pending", { status: "pending", bytes: null }, "unresolved"],
    ["deleted", { status: "deleted", bytes: null }, "replaceable_unusable"],
    ["error", { status: "error", bytes: null }, "replaceable_unusable"],
    ["wrong bytes", { status: "uploaded", bytes: 41 }, "integrity_conflict"],
    ["wrong MIME", { contentType: "text/plain" }, "ready"],
    [
      "generic binary MIME for PDF",
      { contentType: "application/octet-stream" },
      "ready",
    ],
    [
      "expired",
      { status: "uploaded", bytes: attempt.sizeBytes, expiresAt: 5 },
      "replaceable_unusable",
    ],
  ])(
    "classifies a durable candidate as %s",
    async (_label, override, state) => {
      await expect(
        inspectKnowledgeBaseManusV2AttachmentAttempt({
          client: {
            fileDetail: vi.fn().mockResolvedValue({
              fileId: attempt.upstreamFileId,
              filename: attempt.filename,
              status: "uploaded",
              bytes: attempt.sizeBytes,
              expiresAt: attempt.uploadExpiresAt,
              contentType: attempt.mimeType,
              requestId: null,
              ...override,
            }),
          } as any,
          attempt,
          minimumExpirySeconds: attempt.uploadExpiresAt - 1,
        }),
      ).resolves.toMatchObject({ state });
    },
  );

  it("never calls file.create when candidate detail is transport-ambiguous", async () => {
    const responseLoss = new ManusV2ApiError(
      "file.detail",
      null,
      "TRANSPORT_UNKNOWN",
      false,
      false,
    );
    const client = {
      fileDetail: vi.fn().mockRejectedValue(responseLoss),
      createFile: vi.fn(),
    };
    await expect(
      inspectKnowledgeBaseManusV2AttachmentAttempt({
        client: client as any,
        attempt,
        minimumExpirySeconds: 1,
      }),
    ).resolves.toMatchObject({ state: "unresolved" });
    expect(client.createFile).not.toHaveBeenCalled();
  });

  it("replaces pending only after the provider upload window is provably expired", async () => {
    const expiredAttempt = {
      ...attempt,
      uploadExpiresAt: Math.floor(Date.now() / 1_000) - 1,
    };
    await expect(
      inspectKnowledgeBaseManusV2AttachmentAttempt({
        client: {
          fileDetail: vi.fn().mockResolvedValue({
            fileId: attempt.upstreamFileId,
            filename: attempt.filename,
            status: "pending",
            bytes: null,
            expiresAt: attempt.uploadExpiresAt,
            contentType: attempt.mimeType,
            requestId: null,
          }),
        } as any,
        attempt: expiredAttempt,
        minimumExpirySeconds: 1,
      }),
    ).resolves.toMatchObject({
      state: "replaceable_unusable",
      code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
    });
  });

  it("allows a replacement only after a definite 404", async () => {
    await expect(
      inspectKnowledgeBaseManusV2AttachmentAttempt({
        client: {
          fileDetail: vi
            .fn()
            .mockRejectedValue(
              new ManusV2ApiError("file.detail", 404, "HTTP_404", false, false),
            ),
        } as any,
        attempt,
        minimumExpirySeconds: 1,
      }),
    ).resolves.toMatchObject({
      state: "replaceable_unusable",
      code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
    });
  });

  it("turns a durable creating crash into one replacement and then stops POST authority", () => {
    const firstCrash = {
      ...attempt,
      state: "creating" as const,
      upstreamFileId: null,
      uploadExpiresAt: null,
      code: null,
    };
    expect(nextKnowledgeBaseManusV2FileCreateGeneration(firstCrash)).toBe(2);
    expect(
      nextKnowledgeBaseManusV2FileCreateGeneration({
        ...firstCrash,
        providerGeneration: 2,
      }),
    ).toBeNull();
    expect(
      nextKnowledgeBaseManusV2FileCreateGeneration({
        ...firstCrash,
        providerGeneration: 2,
        state: "create_outcome_unknown",
      }),
    ).toBeNull();
  });
});

describe("Knowledge base Zhipu complete-byte attachment recovery", () => {
  function setup() {
    const { claim, sources } = testClaim();
    const source = sources[0]!;
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const detail = {
      fileId: "zhipu-file-1",
      filename: source.filename,
      bytes: source.sizeBytes,
      contentType: source.mimeType,
      contentTypeParseStatus: "valid" as const,
      status: "uploaded" as const,
      expiresAt: expiry,
      requestId: null,
    };
    const uploadFile = vi.fn(async () => ({
      fileId: detail.fileId,
      filename: source.filename,
      uploadUrl: "",
      uploadExpiresAt: expiry,
      requestId: null,
      detail,
    }));
    const fileDetail = vi.fn(async () => detail);
    const client = {
      uploadFile,
      fileDetail,
    } as unknown as DashboardAgentClient;
    const generations: number[] = [];
    const entry = {
      claim,
      source,
      attachmentIndex: 0,
      clientForGeneration: (generation: number) => {
        generations.push(generation);
        return client;
      },
    };
    return { entry, detail, uploadFile, fileDetail, generations };
  }
  it("keeps lease, frozen bytes and mapping finalization without signed PUT or false PUT states", async () => {
    const f = setup();
    const mapping = await ensureKnowledgeBaseZhipuMapping(f.entry);
    expect(f.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: f.entry.source.bytes,
        filename: f.entry.source.filename,
      }),
    );
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([value]) => value.attempt.state,
      ),
    ).toEqual(["creating", "complete_upload_accepted"]);
    const [creating, accepted] =
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([value]) => value.attempt,
      );
    expect(
      isAllowedManusV2AttachmentAttemptTransition(undefined, creating),
    ).toBe(true);
    expect(
      isAllowedManusV2AttachmentAttemptTransition(creating, accepted),
    ).toBe(true);
    expect(accepted.uploadCapability).toBeUndefined();
    expect(mapping.contentSha256).toBe(f.entry.source.contentSha256);
    expect(attachmentLedgerMocks.persistMapping).toHaveBeenCalledTimes(1);
    await ensureKnowledgeBaseZhipuMapping(f.entry);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    expect(attachmentLedgerMocks.renewLease).toHaveBeenCalledTimes(2);
  });
  it("retains unknown complete uploads at the same generation until the transport observes their acknowledgement", async () => {
    const f = setup();
    f.uploadFile.mockRejectedValueOnce(
      new ManusV2ApiError(
        "file.upload",
        null,
        "ZHIPU_MUTATION_OUTCOME_UNKNOWN",
        false,
        true,
      ),
    );
    await expect(
      ensureKnowledgeBaseZhipuMapping(f.entry),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING" });
    const [creating, unknown] =
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([value]) => value.attempt,
      );
    expect(unknown.state).toBe("complete_upload_outcome_unknown");
    expect(isAllowedManusV2AttachmentAttemptTransition(creating, unknown)).toBe(
      true,
    );
    const ready = await ensureKnowledgeBaseZhipuMapping(f.entry);
    const accepted =
      attachmentLedgerMocks.persistAttempt.mock.calls.at(-1)![0].attempt;
    expect(isAllowedManusV2AttachmentAttemptTransition(unknown, accepted)).toBe(
      true,
    );
    expect(ready.providerGeneration).toBe(1);
    expect(new Set(f.generations)).toEqual(new Set([1]));
  });
  it("does not reupload after acknowledgement when only metadata inspection fails", async () => {
    const f = setup();
    f.fileDetail.mockRejectedValueOnce(
      new ManusV2ApiError("file.detail", 503, "ZHIPU_HTTP_503", false, false),
    );
    await expect(
      ensureKnowledgeBaseZhipuMapping(f.entry),
    ).rejects.toBeDefined();
    await ensureKnowledgeBaseZhipuMapping(f.entry);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
  });
  it("uses one bounded replacement only after authoritative missing-file evidence", async () => {
    const f = setup();
    await ensureKnowledgeBaseZhipuMapping(f.entry);
    f.fileDetail.mockRejectedValueOnce(
      new ManusV2ApiError("file.detail", 404, "ZHIPU_HTTP_404", false, false),
    );
    const next = { ...f.detail, fileId: "zhipu-file-2" };
    f.fileDetail.mockResolvedValue(next);
    f.uploadFile.mockResolvedValue({
      fileId: next.fileId,
      filename: next.filename,
      uploadUrl: "",
      uploadExpiresAt: next.expiresAt,
      requestId: null,
      detail: next,
    });
    const ready = await ensureKnowledgeBaseZhipuMapping(f.entry);
    expect(ready.providerGeneration).toBe(2);
    expect(f.uploadFile).toHaveBeenCalledTimes(2);
    const attempts = attachmentLedgerMocks.persistAttempt.mock.calls.map(
      ([value]) => value.attempt,
    );
    expect(attempts.map((item) => item.state)).toEqual([
      "creating",
      "complete_upload_accepted",
      "unusable",
      "creating",
      "complete_upload_accepted",
    ]);
    for (let i = 1; i < attempts.length; i++)
      expect(
        isAllowedManusV2AttachmentAttemptTransition(
          attempts[i - 1],
          attempts[i],
        ),
      ).toBe(true);
  });
});
