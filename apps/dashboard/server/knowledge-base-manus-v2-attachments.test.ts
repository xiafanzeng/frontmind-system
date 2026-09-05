import { createHash } from "node:crypto";

import axios from "axios";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  inspectKnowledgeBaseManusV2AttachmentAttempt,
  knowledgeBaseManusV2FileRejectionRetryDelay,
  nextKnowledgeBaseManusV2FileCreateGeneration,
  shouldInspectReadyMappingBeforeAttachmentAttempt,
  validateReusableKnowledgeBaseManusV2Attachment,
} from "./knowledge-base-manus-v2-attachments";
import { encryptCredentialSecret } from "./auth-service";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";

const originalCredentialEncryptionKey =
  process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 71).toString("base64")}`;
});

afterAll(() => {
  if (originalCredentialEncryptionKey === undefined) {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      originalCredentialEncryptionKey;
  }
});

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

describe("Manus v2 complete attachment-set recovery", () => {
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
    const upload = vi.spyOn(ManusV2Client.prototype, "uploadFile");
    const detail = vi.spyOn(ManusV2Client.prototype, "fileDetail");

    const result = await ensureKnowledgeBaseManusV2Attachments({
      claim,
      credential: {
        id: claim.turn.apiCredentialId!,
        userId: claim.turn.userId,
        apiKey: "synthetic-manus-key",
      },
      baseUrl: "https://api.manus.test",
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
    expect(upload).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.persistAttempt).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.persistMapping).not.toHaveBeenCalled();
    expect(attachmentLedgerMocks.finalize).not.toHaveBeenCalled();
  });

  it("keeps a customer file with the reserved Skill filename strict while only the exact system slot is inline", async () => {
    const { claim, sources } = testClaim();
    const [customer, skill] = sources;
    const collidingFilename = "socratic-kb-builder.skill.zip";
    claim.preparedDispatch.requestBody.attachments = [
      { file_id: customer!.sourceFileId, filename: collidingFilename },
      { file_id: skill!.sourceFileId, filename: collidingFilename },
    ];
    claim.turn.attachmentFileIds = [
      customer!.sourceFileId,
      skill!.sourceFileId,
    ];
    claim.turn.generatedAttachmentReservations = {
      "skill:1": {
        schemaVersion: 1,
        role: "skill",
        attachmentIndex: 1,
        requestHash: "a".repeat(64),
        idempotencyKeyHash: "b".repeat(64),
        filename: collidingFilename,
        mimeType: "application/zip",
        sizeBytes: skill!.sizeBytes,
        contentSha256: skill!.contentSha256,
        localStorageKey: skill!.localStorageKey,
        status: "reserved",
        reservedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockImplementation(async ({ storageKey }) => {
      const source = [customer, skill].find(
        (candidate) => candidate!.localStorageKey === storageKey,
      );
      return source!.bytes;
    });
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    const upload = vi
      .spyOn(ManusV2Client.prototype, "uploadFile")
      .mockImplementation(async (input: any) => {
        const file = {
          fileId: "customer-collision-file-g1",
          filename: collidingFilename,
          uploadUrl: "https://uploads.manus.test/customer-collision",
          uploadExpiresAt: providerExpiry,
          requestId: "upload-customer-collision",
        };
        await input.observer?.onCandidateCreated?.(file);
        await input.observer?.onPutStarted?.(file);
        await input.observer?.onPutAccepted?.(file);
        return {
          ...file,
          detail: {
            fileId: file.fileId,
            filename: file.filename,
            status: "uploaded",
            bytes: customer!.sizeBytes,
            expiresAt: providerExpiry,
            contentType: customer!.mimeType,
            requestId: "detail-customer-collision",
          },
        };
      });
    const detail = vi
      .spyOn(ManusV2Client.prototype, "fileDetail")
      .mockResolvedValue({
        fileId: "customer-collision-file-g1",
        filename: collidingFilename,
        status: "uploaded",
        bytes: customer!.sizeBytes,
        expiresAt: providerExpiry,
        contentType: customer!.mimeType,
        requestId: "final-detail-customer-collision",
      } as any);

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([
      {
        file_id: "customer-collision-file-g1",
        filename: collidingFilename,
      },
      {
        file_data: `data:application/zip;base64,${skill!.bytes.toString("base64")}`,
        filename: collidingFilename,
        mime_type: "application/zip",
      },
    ]);

    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]![0].bytes).toEqual(customer!.bytes);
    expect(detail).toHaveBeenCalledOnce();
    expect(
      localSourceMocks.read.mock.calls.map(([input]) => input.storageKey),
    ).toEqual([customer!.localStorageKey, skill!.localStorageKey]);
    expect(
      attachmentLedgerMocks.persistMapping.mock.calls.map(
        ([input]) => input.mapping.attachmentIndex,
      ),
    ).toEqual([0, 0]);
    expect(attachmentLedgerMocks.finalize).not.toHaveBeenCalled();
  });

  it("keeps Working Set and customer binary slots on strict file upload around an inline Skill", async () => {
    const { claim, sources } = testClaim();
    const [skill, workingSet, customer] = sources;
    const skillFilename = "socratic-kb-builder.skill.zip";
    const workingSetFilename = "frontmind-kb-active-working-set.zip";
    claim.preparedDispatch.requestBody.attachments = [
      { file_id: skill!.sourceFileId, filename: skillFilename },
      { file_id: workingSet!.sourceFileId, filename: workingSetFilename },
      { file_id: customer!.sourceFileId, filename: customer!.filename },
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
      "working_set:1": {
        schemaVersion: 1,
        role: "working_set",
        attachmentIndex: 1,
        requestHash: "c".repeat(64),
        idempotencyKeyHash: "d".repeat(64),
        filename: workingSetFilename,
        mimeType: "application/zip",
        sizeBytes: workingSet!.sizeBytes,
        contentSha256: workingSet!.contentSha256,
        localStorageKey: workingSet!.localStorageKey,
        status: "reserved",
        reservedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockImplementation(async ({ storageKey }) => {
      const source = sources.find(
        (candidate) => candidate.localStorageKey === storageKey,
      );
      return source!.bytes;
    });
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    const strictSlots = [
      {
        attachmentIndex: 1,
        source: workingSet!,
        filename: workingSetFilename,
        mimeType: "application/zip",
        fileId: "working-set-file-g1",
      },
      {
        attachmentIndex: 2,
        source: customer!,
        filename: customer!.filename,
        mimeType: customer!.mimeType,
        fileId: "customer-file-g1",
      },
    ];
    const upload = vi
      .spyOn(ManusV2Client.prototype, "uploadFile")
      .mockImplementation(async (input: any) => {
        const slot = strictSlots.find(
          (candidate) => candidate.filename === input.filename,
        )!;
        const file = {
          fileId: slot.fileId,
          filename: slot.filename,
          uploadUrl: "https://uploads.manus.test/strict-slot",
          uploadExpiresAt: providerExpiry,
          requestId: `upload-${slot.attachmentIndex}`,
        };
        await input.observer?.onCandidateCreated?.(file);
        await input.observer?.onPutStarted?.(file);
        await input.observer?.onPutAccepted?.(file);
        return {
          ...file,
          detail: {
            fileId: slot.fileId,
            filename: slot.filename,
            status: "uploaded",
            bytes: slot.source.sizeBytes,
            expiresAt: providerExpiry,
            contentType: slot.mimeType,
            requestId: `detail-${slot.attachmentIndex}`,
          },
        };
      });
    const detail = vi
      .spyOn(ManusV2Client.prototype, "fileDetail")
      .mockImplementation(async (fileId) => {
        const slot = strictSlots.find(
          (candidate) => candidate.fileId === fileId,
        )!;
        return {
          fileId: slot.fileId,
          filename: slot.filename,
          status: "uploaded",
          bytes: slot.source.sizeBytes,
          expiresAt: providerExpiry,
          contentType: slot.mimeType,
          requestId: `final-detail-${slot.attachmentIndex}`,
        } as any;
      });

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([
      {
        file_data: `data:application/zip;base64,${skill!.bytes.toString("base64")}`,
        filename: skillFilename,
        mime_type: "application/zip",
      },
      { file_id: "working-set-file-g1", filename: workingSetFilename },
      { file_id: "customer-file-g1", filename: customer!.filename },
    ]);

    expect(upload.mock.calls.map(([input]) => input.filename)).toEqual([
      workingSetFilename,
      customer!.filename,
    ]);
    expect(detail.mock.calls.map(([fileId]) => fileId)).toEqual([
      "working-set-file-g1",
      "customer-file-g1",
    ]);
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([input]) => input.attempt.attachmentIndex,
      ),
    ).not.toContain(0);
    expect(
      attachmentLedgerMocks.persistMapping.mock.calls.map(
        ([input]) => input.mapping.attachmentIndex,
      ),
    ).not.toContain(0);
    expect(attachmentLedgerMocks.finalize).not.toHaveBeenCalled();
  });

  it("never inlines a rejected customer attachment", async () => {
    const { claim, sources } = testClaim();
    const user = sources[0]!;
    claim.preparedDispatch.requestBody.attachments =
      claim.preparedDispatch.requestBody.attachments.slice(0, 1);
    claim.turn.attachmentFileIds = [user.sourceFileId];
    claim.recoveryMetadata.attachments =
      claim.recoveryMetadata.attachments.slice(0, 1);
    claim.recoveryMetadata.attachmentManifest =
      claim.recoveryMetadata.attachmentManifest.slice(0, 1);
    claim.recoveryMetadata.attachmentSourceProofs =
      claim.recoveryMetadata.attachmentSourceProofs.slice(0, 1);
    claim.turn.manusV2AttachmentAttempts = {
      rejectedUser: {
        ...attemptFor(
          user,
          1,
          "put_accepted",
          Math.floor(Date.now() / 1_000) + 60 * 60,
        ),
        state: "create_rejected",
        upstreamFileId: null,
        uploadExpiresAt: null,
        code: "permission_denied",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockResolvedValue(user.bytes);

    const upload = vi
      .spyOn(ManusV2Client.prototype, "uploadFile")
      .mockRejectedValue(new Error("customer upload remains strict"));
    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).rejects.toThrow(/customer upload remains strict/u);
    expect(upload).toHaveBeenCalledOnce();
  });

  it("resumes a durable candidate crash before its first PUT without POST or a replacement generation", async () => {
    const { claim, sources } = testClaim();
    const source = sources[0]!;
    claim.preparedDispatch.requestBody.attachments =
      claim.preparedDispatch.requestBody.attachments.slice(0, 1);
    claim.turn.attachmentFileIds = claim.turn.attachmentFileIds.slice(0, 1);
    claim.recoveryMetadata.attachments =
      claim.recoveryMetadata.attachments.slice(0, 1);
    claim.recoveryMetadata.attachmentManifest =
      claim.recoveryMetadata.attachmentManifest.slice(0, 1);
    claim.recoveryMetadata.attachmentSourceProofs =
      claim.recoveryMetadata.attachmentSourceProofs.slice(0, 1);
    const key = `g1:0:${source.contentSha256}:${source.sizeBytes}`;
    const uploadUrl =
      "https://uploads.manus.test/first-put?signature=never-log-first-put";
    const upstreamFileId = "file-candidate-before-first-put";
    const sealed = encryptCredentialSecret(
      [
        "frontmind-kb-manus-v2-upload-capability:v1",
        claim.turn.userId,
        claim.turn.id,
        key,
        1,
        upstreamFileId,
      ].join(":"),
      uploadUrl,
    );
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    claim.turn.manusV2AttachmentAttempts = {
      [key]: {
        schemaVersion: 1,
        mappingKey: key,
        buildGeneration: 1,
        attachmentIndex: 0,
        sourceFileId: source.sourceFileId,
        localStorageKey: source.localStorageKey,
        contentSha256: source.contentSha256,
        sizeBytes: source.sizeBytes,
        filename: source.filename,
        mimeType: source.mimeType,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId,
        uploadExpiresAt: providerExpiry,
        uploadCapability: {
          schemaVersion: 1,
          encryptionVersion: 1,
          ciphertext: sealed.encryptedKey,
          iv: sealed.encryptionIv,
          authTag: sealed.encryptionAuthTag,
        },
        code: null,
        recordedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockResolvedValue(source.bytes);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: upstreamFileId,
          filename: source.filename,
          status: "uploaded",
          bytes: source.sizeBytes,
          content_type: source.mimeType,
          expires_at: providerExpiry,
        },
      },
    });
    attachmentLedgerMocks.finalize.mockImplementation(async ({ mappings }) => ({
      attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
      manusV2AttachmentMappings: Object.fromEntries(
        mappings.map((item: any) => [item.mappingKey, item]),
      ),
    }));

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([
      { file_id: upstreamFileId, filename: source.filename },
    ]);

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(JSON.stringify(claim.turn.manusV2AttachmentAttempts)).not.toContain(
      "never-log-first-put",
    );
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.some(
        ([input]) => input.attempt.providerGeneration > 1,
      ),
    ).toBe(false);
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.map(
        ([input]) => input.attempt.state,
      ),
    ).toEqual(["put_sending", "put_accepted"]);
  });

  it("uses the single bounded replacement for a historical candidate without a sealed capability", async () => {
    const { claim, sources } = testClaim();
    const source = sources[0]!;
    claim.preparedDispatch.requestBody.attachments =
      claim.preparedDispatch.requestBody.attachments.slice(0, 1);
    claim.turn.attachmentFileIds = claim.turn.attachmentFileIds.slice(0, 1);
    claim.recoveryMetadata.attachments =
      claim.recoveryMetadata.attachments.slice(0, 1);
    claim.recoveryMetadata.attachmentManifest =
      claim.recoveryMetadata.attachmentManifest.slice(0, 1);
    claim.recoveryMetadata.attachmentSourceProofs =
      claim.recoveryMetadata.attachmentSourceProofs.slice(0, 1);
    const key = `g1:0:${source.contentSha256}:${source.sizeBytes}`;
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    claim.turn.manusV2AttachmentAttempts = {
      [key]: {
        schemaVersion: 1,
        mappingKey: key,
        buildGeneration: 1,
        attachmentIndex: 0,
        sourceFileId: source.sourceFileId,
        localStorageKey: source.localStorageKey,
        contentSha256: source.contentSha256,
        sizeBytes: source.sizeBytes,
        filename: source.filename,
        mimeType: source.mimeType,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId: "historical-file-without-capability",
        uploadExpiresAt: providerExpiry,
        code: null,
        recordedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockResolvedValue(source.bytes);
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "replacement-file-g2", filename: source.filename },
        upload_url: "https://uploads.manus.test/replacement-g2",
        upload_expires_at: providerExpiry,
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "replacement-file-g2",
          filename: source.filename,
          status: "uploaded",
          bytes: source.sizeBytes,
          content_type: source.mimeType,
          expires_at: providerExpiry,
        },
      },
    });
    attachmentLedgerMocks.finalize.mockImplementation(async ({ mappings }) => ({
      attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
      manusV2AttachmentMappings: Object.fromEntries(
        mappings.map((item: any) => [item.mappingKey, item]),
      ),
    }));

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([
      { file_id: "replacement-file-g2", filename: source.filename },
    ]);

    expect(post).toHaveBeenCalledOnce();
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.filter(
        ([input]) => input.attempt.state === "creating",
      ),
    ).toHaveLength(1);
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.some(
        ([input]) => input.attempt.providerGeneration === 2,
      ),
    ).toBe(true);
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.some(
        ([input]) => input.attempt.providerGeneration > 2,
      ),
    ).toBe(false);
  });

  it("resumes a durable retryable PUT after process restart on the same signed capability and file id", async () => {
    const { claim, sources } = testClaim();
    const source = sources[0]!;
    claim.preparedDispatch.requestBody.attachments =
      claim.preparedDispatch.requestBody.attachments.slice(0, 1);
    claim.turn.attachmentFileIds = claim.turn.attachmentFileIds.slice(0, 1);
    claim.recoveryMetadata.attachments =
      claim.recoveryMetadata.attachments.slice(0, 1);
    claim.recoveryMetadata.attachmentManifest =
      claim.recoveryMetadata.attachmentManifest.slice(0, 1);
    claim.recoveryMetadata.attachmentSourceProofs =
      claim.recoveryMetadata.attachmentSourceProofs.slice(0, 1);
    const key = `g1:0:${source.contentSha256}:${source.sizeBytes}`;
    const uploadUrl =
      "https://uploads.manus.test/signed-object?signature=never-log-this";
    const sealed = encryptCredentialSecret(
      [
        "frontmind-kb-manus-v2-upload-capability:v1",
        claim.turn.userId,
        claim.turn.id,
        key,
        1,
        "file-put-retry",
      ].join(":"),
      uploadUrl,
    );
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    const retryAttempt = {
      schemaVersion: 1 as const,
      mappingKey: key,
      buildGeneration: 1,
      attachmentIndex: 0,
      sourceFileId: source.sourceFileId,
      localStorageKey: source.localStorageKey,
      contentSha256: source.contentSha256,
      sizeBytes: source.sizeBytes,
      filename: source.filename,
      mimeType: source.mimeType,
      providerGeneration: 1,
      state: "put_retry_wait" as const,
      upstreamFileId: "file-put-retry",
      uploadExpiresAt: providerExpiry,
      uploadCapability: {
        schemaVersion: 1 as const,
        encryptionVersion: 1 as const,
        ciphertext: sealed.encryptedKey,
        iv: sealed.encryptionIv,
        authTag: sealed.encryptionAuthTag,
      },
      code: "MANUS_V2_FILE_PUT_HTTP_429",
      rejectionCount: 1,
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
      recordedAt: "2026-08-12T00:00:00.000Z",
    };
    claim.turn.manusV2AttachmentAttempts = { [key]: retryAttempt };
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockResolvedValue(source.bytes);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-put-retry",
          filename: source.filename,
          status: "uploaded",
          bytes: source.sizeBytes,
          content_type: source.mimeType,
          expires_at: providerExpiry,
        },
      },
    });
    attachmentLedgerMocks.finalize.mockImplementation(async ({ mappings }) => ({
      attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
      manusV2AttachmentMappings: Object.fromEntries(
        mappings.map((item: any) => [item.mappingKey, item]),
      ),
    }));

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([
      { file_id: "file-put-retry", filename: source.filename },
    ]);

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(JSON.stringify(claim.turn.manusV2AttachmentAttempts)).not.toContain(
      "never-log-this",
    );
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.some(
        ([input]) => input.attempt.providerGeneration > 1,
      ),
    ).toBe(false);
  });

  it.each([
    ["deleted", { status: "deleted", bytes: null }],
    ["error", { status: "error", bytes: null }],
    [
      "expiring",
      {
        status: "uploaded",
        expiresAt: Math.floor(Date.now() / 1_000) + 14 * 60,
      },
    ],
  ])(
    "replaces only slot zero when its generation-one file becomes %s during the three-slot final pass",
    async (_label, finalFailure) => {
      const { claim, sources } = testClaim();
      attachmentLedgerMocks.load.mockResolvedValue({
        turn: claim.turn,
        preparedDispatch: claim.preparedDispatch,
      });
      localSourceMocks.read.mockImplementation(async ({ storageKey }) => {
        const source = sources.find(
          (candidate) => candidate.localStorageKey === storageKey,
        );
        if (!source) throw new Error("unexpected source");
        return source.bytes;
      });
      const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
      const uploadCounts = new Map<string, number>();
      const uploadFile = vi
        .spyOn(ManusV2Client.prototype, "uploadFile")
        .mockImplementation(async (input: any) => {
          const generation = (uploadCounts.get(input.filename) || 0) + 1;
          uploadCounts.set(input.filename, generation);
          const source = sources.find(
            (candidate) => candidate.filename === input.filename,
          )!;
          const file = {
            fileId: `${input.filename}-g${generation}`,
            filename: input.filename,
            uploadUrl: "https://upload.manus.test/signed",
            uploadExpiresAt: providerExpiry,
            requestId: `upload-${input.filename}-${generation}`,
          };
          await input.observer?.onCandidateCreated?.(file);
          await input.observer?.onPutStarted?.(file);
          await input.observer?.onPutAccepted?.(file);
          return {
            ...file,
            detail: {
              fileId: file.fileId,
              filename: input.filename,
              status: "uploaded",
              bytes: source.sizeBytes,
              expiresAt: providerExpiry,
              contentType: source.mimeType,
              requestId: file.requestId,
            },
          };
        });
      const detailIds: string[] = [];
      vi.spyOn(ManusV2Client.prototype, "fileDetail").mockImplementation(
        async (fileId) => {
          detailIds.push(fileId);
          const source = sources.find((candidate) =>
            fileId.startsWith(`${candidate.filename}-g`),
          )!;
          if (fileId === `${sources[0]!.filename}-g1`) {
            return {
              fileId,
              filename: source.filename,
              status: "uploaded",
              bytes: source.sizeBytes,
              expiresAt: providerExpiry,
              contentType: source.mimeType,
              requestId: "detail-final-failure",
              ...finalFailure,
            } as any;
          }
          return {
            fileId,
            filename: source.filename,
            status: "uploaded",
            bytes: source.sizeBytes,
            expiresAt: providerExpiry,
            contentType: source.mimeType,
            requestId: "detail-ready",
          } as any;
        },
      );
      attachmentLedgerMocks.finalize.mockImplementation(
        async ({ mappings }) => ({
          attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
          manusV2AttachmentMappings: Object.fromEntries(
            mappings.map((item: any) => [item.mappingKey, item]),
          ),
        }),
      );

      await expect(
        ensureKnowledgeBaseManusV2Attachments({
          claim,
          credential: {
            id: claim.turn.apiCredentialId!,
            userId: claim.turn.userId,
            apiKey: "synthetic-manus-key",
          },
          baseUrl: "https://api.manus.test",
        }),
      ).resolves.toEqual([
        { file_id: "alpha.pdf-g2", filename: "alpha.pdf" },
        { file_id: "bravo.pdf-g1", filename: "bravo.pdf" },
        { file_id: "charlie.pdf-g1", filename: "charlie.pdf" },
      ]);

      expect(uploadFile.mock.calls.map(([input]) => input.filename)).toEqual([
        "alpha.pdf",
        "bravo.pdf",
        "charlie.pdf",
        "alpha.pdf",
      ]);
      expect(uploadCounts).toEqual(
        new Map([
          ["alpha.pdf", 2],
          ["bravo.pdf", 1],
          ["charlie.pdf", 1],
        ]),
      );
      expect(detailIds).toContain("alpha.pdf-g1");
      expect(detailIds).toContain("alpha.pdf-g2");
      expect(
        attachmentLedgerMocks.persistAttempt.mock.calls.some(
          ([input]) =>
            input.attempt.attachmentIndex === 0 &&
            input.attempt.providerGeneration === 1 &&
            input.attempt.state === "unusable",
        ),
      ).toBe(true);
      expect(
        attachmentLedgerMocks.persistAttempt.mock.calls.some(
          ([input]) => input.attempt.providerGeneration > 2,
        ),
      ).toBe(false);
      expect(attachmentLedgerMocks.finalize).toHaveBeenCalledOnce();
    },
  );

  it.each(["put_accepted", "put_sending"] as const)(
    "recovers durable generation-two %s before a stale generation-one mapping without a new upload",
    async (crashState) => {
      const sources = testSources();
      const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
      const readyMappings = sources.map((source) =>
        mappingFor(source, 1, providerExpiry),
      );
      const durableAttempts = sources.map((source, index) =>
        attemptFor(
          source,
          index === 0 ? 2 : 1,
          index === 0 ? crashState : "put_accepted",
          providerExpiry,
        ),
      );
      const { claim } = testClaim({
        mappings: Object.fromEntries(
          readyMappings.map((item) => [item.mappingKey, item]),
        ),
        attempts: Object.fromEntries(
          durableAttempts.map((item) => [item.mappingKey, item]),
        ),
      });
      attachmentLedgerMocks.load.mockResolvedValue({
        turn: claim.turn,
        preparedDispatch: claim.preparedDispatch,
      });
      localSourceMocks.read.mockImplementation(async ({ storageKey }) => {
        const source = sources.find(
          (candidate) => candidate.localStorageKey === storageKey,
        );
        if (!source) throw new Error("unexpected source");
        return source.bytes;
      });
      const detailIds: string[] = [];
      vi.spyOn(ManusV2Client.prototype, "fileDetail").mockImplementation(
        async (fileId) => {
          detailIds.push(fileId);
          const source = sources.find((candidate) =>
            fileId.startsWith(`${candidate.filename}-g`),
          )!;
          return {
            fileId,
            filename: source.filename,
            status: "uploaded",
            bytes: source.sizeBytes,
            expiresAt: providerExpiry,
            contentType: source.mimeType,
            requestId: "detail-recovered",
          } as any;
        },
      );
      const uploadFile = vi.spyOn(ManusV2Client.prototype, "uploadFile");
      attachmentLedgerMocks.finalize.mockImplementation(
        async ({ mappings }) => ({
          attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
          manusV2AttachmentMappings: Object.fromEntries(
            mappings.map((item: any) => [item.mappingKey, item]),
          ),
        }),
      );

      const result = await ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      });

      expect(result[0]).toEqual({
        file_id: "alpha.pdf-g2",
        filename: "alpha.pdf",
      });
      expect(detailIds).toContain("alpha.pdf-g2");
      expect(detailIds).not.toContain("alpha.pdf-g1");
      expect(uploadFile).not.toHaveBeenCalled();
      expect(
        attachmentLedgerMocks.persistAttempt.mock.calls.some(
          ([input]) => input.attempt.providerGeneration >= 3,
        ),
      ).toBe(false);
      expect(attachmentLedgerMocks.finalize).toHaveBeenCalledOnce();
    },
  );

  it("accepts an octet-stream PPTX on generation one and persists MIME evidence", async () => {
    const { claim, sources } = testClaim();
    const source = sources[0]!;
    const filename = "hospital-profile.pptx";
    const mimeType =
      "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    source.filename = filename;
    source.mimeType = mimeType;
    claim.preparedDispatch.requestBody.attachments = [
      { file_id: source.sourceFileId, filename },
    ];
    claim.turn.attachmentFileIds = [source.sourceFileId];
    claim.recoveryMetadata.attachments = [
      { file_id: source.sourceFileId, filename },
    ];
    claim.recoveryMetadata.attachmentManifest = [
      {
        sizeBytes: source.sizeBytes,
        sha256: source.contentSha256,
        mimeType,
      },
    ];
    claim.recoveryMetadata.attachmentSourceProofs = [
      {
        fileId: source.sourceFileId,
        localStorageKey: source.localStorageKey,
        sizeBytes: source.sizeBytes,
        contentSha256: source.contentSha256,
        mimeType,
      },
    ];
    attachmentLedgerMocks.load.mockResolvedValue({
      turn: claim.turn,
      preparedDispatch: claim.preparedDispatch,
    });
    localSourceMocks.read.mockResolvedValue(source.bytes);
    const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "pptx-file-g1", filename },
        upload_url: "https://uploads.manus.test/pptx-g1",
        upload_expires_at: providerExpiry,
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "pptx-file-g1",
          filename,
          status: "uploaded",
          bytes: source.sizeBytes,
          content_type: "application/octet-stream",
          expires_at: providerExpiry,
        },
      },
    });
    attachmentLedgerMocks.finalize.mockImplementation(async ({ mappings }) => ({
      attachmentFileIds: mappings.map((item: any) => item.upstreamFileId),
      manusV2AttachmentMappings: Object.fromEntries(
        mappings.map((item: any) => [item.mappingKey, item]),
      ),
    }));

    await expect(
      ensureKnowledgeBaseManusV2Attachments({
        claim,
        credential: {
          id: claim.turn.apiCredentialId!,
          userId: claim.turn.userId,
          apiKey: "synthetic-manus-key",
        },
        baseUrl: "https://api.manus.test",
      }),
    ).resolves.toEqual([{ file_id: "pptx-file-g1", filename }]);

    expect(post).toHaveBeenCalledOnce();
    expect(
      attachmentLedgerMocks.persistAttempt.mock.calls.some(
        ([input]) => input.attempt.providerGeneration > 1,
      ),
    ).toBe(false);
    expect(
      attachmentLedgerMocks.persistMapping.mock.calls.at(-1)?.[0].mapping,
    ).toMatchObject({
      providerGeneration: 1,
      mimeEvidence: {
        expectedContentType: mimeType,
        providerContentType: "application/octet-stream",
        disposition: "generic",
      },
    });
  });

  it.each([
    [
      "identity conflict",
      1,
      { status: "uploaded", bytes: 999 },
      "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_INTEGRITY_CONFLICT",
    ],
    [
      "exhausted lifecycle",
      2,
      { status: "deleted", bytes: null },
      "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_LIFECYCLE_EXHAUSTED",
    ],
  ] as const)(
    "settles deterministic %s as a stable local-preparation error",
    async (_label, providerGeneration, detailOverride, expectedCode) => {
      const sources = testSources().slice(0, 1);
      const source = sources[0]!;
      const providerExpiry = Math.floor(Date.now() / 1_000) + 60 * 60;
      const ready = mappingFor(source, providerGeneration, providerExpiry);
      const { claim } = testClaim({ mappings: { [ready.mappingKey]: ready } });
      claim.preparedDispatch.requestBody.attachments =
        claim.preparedDispatch.requestBody.attachments.slice(0, 1);
      claim.turn.attachmentFileIds = claim.turn.attachmentFileIds.slice(0, 1);
      claim.recoveryMetadata.attachments =
        claim.recoveryMetadata.attachments.slice(0, 1);
      claim.recoveryMetadata.attachmentManifest =
        claim.recoveryMetadata.attachmentManifest.slice(0, 1);
      claim.recoveryMetadata.attachmentSourceProofs =
        claim.recoveryMetadata.attachmentSourceProofs.slice(0, 1);
      attachmentLedgerMocks.load.mockResolvedValue({
        turn: claim.turn,
        preparedDispatch: claim.preparedDispatch,
      });
      localSourceMocks.read.mockResolvedValue(source.bytes);
      vi.spyOn(ManusV2Client.prototype, "fileDetail").mockResolvedValue({
        fileId: ready.upstreamFileId,
        filename: ready.filename,
        status: "uploaded",
        bytes: ready.sizeBytes,
        expiresAt: providerExpiry,
        contentType: ready.mimeType,
        contentTypeParseStatus: "valid",
        requestId: null,
        ...detailOverride,
      } as any);
      const upload = vi.spyOn(ManusV2Client.prototype, "uploadFile");

      await expect(
        ensureKnowledgeBaseManusV2Attachments({
          claim,
          credential: {
            id: claim.turn.apiCredentialId!,
            userId: claim.turn.userId,
            apiKey: "synthetic-manus-key",
          },
          baseUrl: "https://api.manus.test",
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(upload).not.toHaveBeenCalled();
    },
  );
});

describe("Manus v2 reusable attachment proof", () => {
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
