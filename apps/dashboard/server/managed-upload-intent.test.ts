import * as credentialAgentClient from "./credential-agent-client";
import { ManusV2ApiError } from "./manus-v2-client";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  axiosPut: vi.fn(),
  uploadFile: vi.fn(),
  fileDetail: vi.fn(),
  deleteFile: vi.fn(),
  credential: vi.fn(),
  recordResource: vi.fn(),
  discardResource: vi.fn(),
  markRetention: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { post: mocks.axiosPost, put: mocks.axiosPut },
}));

vi.mock("./auth-service", () => ({
  AuthServiceError: class AuthServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  getDecryptedCredentialForManagedUploadIntent: mocks.credential,
  recordUpstreamResource: mocks.recordResource,
  discardUnboundUpstreamFile: mocks.discardResource,
}));

vi.mock("./file-content-retention", () => ({
  markUploadedFileRetention: mocks.markRetention,
}));

import {
  createManagedUploadIntent,
  createManagedUploadIntentTicket,
  deleteManagedUploadIntent,
  deriveManagedUploadIntentTicketKey,
  ensureManagedUploadIntentWorker,
  getManagedUploadIntentWorkerReadiness,
  managedUploadIntentStorageRoot,
  listManagedUploadIntentsByResumeScope,
  openManagedUploadIntentTicket,
  proveKnowledgeBaseManagedUploadForStage,
  processManagedUploadIntent,
  readKnowledgeBaseManagedUploadIntentByOperation,
  readManagedUploadIntent,
  receiveManagedUploadIntentBody,
  scheduleManagedUploadIntentCleanup,
  stopManagedUploadIntentWorkerForTests,
  sweepManagedUploadIntents,
} from "./managed-upload-intent";
import { AuthServiceError } from "./auth-service";
import {
  acquireManagedUploadDeletionFence,
  completeManagedUploadDeletionFence,
  retireManagedUploadIntentsForAccountDeletion,
  rollbackManagedUploadDeletionFence,
} from "./managed-upload-intent-fence";
import { readStoredPresalesFile } from "./presales-file-store";

const masterKey = `base64:${Buffer.alloc(32, 7).toString("base64")}`;

function createInput(sizeBytes = 11) {
  return {
    operationId: "operation-1",
    batchId: "batch-1",
    ordinal: 1,
    total: 1,
    filename: "document.pdf",
    mimeType: "application/pdf",
    sizeBytes,
    userId: 42,
    projectAssignmentId: null,
    credentialId: "credential-1",
    credentialOwnerUserId: 42,
    credentialVersion: 3,
  };
}

async function sealIntent(content = Buffer.from("hello world")) {
  const manifest = await createManagedUploadIntent(createInput(content.length));
  const { ticket } = createManagedUploadIntentTicket(manifest);
  const request = Readable.from([
    content.subarray(0, 3),
    content.subarray(3),
  ]) as Readable & {
    complete: boolean;
  };
  request.complete = true;
  const sealed = await receiveManagedUploadIntentBody({
    intentId: manifest.intentId,
    ticket,
    userId: 42,
    projectAssignmentId: null,
    contentLength: content.length,
    request,
  });
  return { manifest, sealed, ticket, content };
}

function intentDirectory(intentId: string) {
  return path.join(
    managedUploadIntentStorageRoot(),
    createHash("sha256").update(intentId).digest("hex"),
  );
}

async function successfulZhipuUpload(input: any, fileId = "zhipu-file-1") {
  let bytes = 0;
  for await (const chunk of input.createReadStream()) bytes += chunk.length;
  expect(bytes).toBe(input.byteLength);
  const candidate = {
    fileId,
    filename: input.filename,
    uploadUrl: "",
    uploadExpiresAt: 253402300799,
    requestId: null,
  };
  await input.observer.onCandidateCreated(candidate);
  return { ...candidate, detail: { status: "uploaded", bytes } };
}

async function finalizeIntentForDelete(fileId: string) {
  const sealed = await sealIntent();
  mocks.uploadFile.mockImplementationOnce((input) =>
    successfulZhipuUpload(input, fileId),
  );
  await processManagedUploadIntent({
    intentId: sealed.sealed.intentId,
    userId: 42,
    traceId: `trace-${fileId}`,
  });
  return sealed;
}

async function finalizeKnowledgeBaseIntentForStage(input: {
  fileId: string;
  content: Buffer;
  sha256: string;
}) {
  const create = {
    ...createInput(input.content.length),
    operationId: "kb-stage-batch:1",
    batchId: "kb-stage-batch",
    resumeScope: {
      kind: "knowledge_base" as const,
      conversationId: "kb-stage-conversation",
      turnId: "00000000-0000-4000-8000-000000000055",
      clientRequestId: "kb-stage-client-request",
    },
  };
  const manifest = await createManagedUploadIntent(create);
  const { ticket } = createManagedUploadIntentTicket(manifest);
  const request = Readable.from([input.content]) as Readable & {
    complete: boolean;
  };
  request.complete = true;
  await receiveManagedUploadIntentBody({
    intentId: manifest.intentId,
    ticket,
    userId: 42,
    projectAssignmentId: null,
    contentLength: input.content.length,
    request,
  });
  mocks.uploadFile.mockImplementationOnce((uploadInput) =>
    successfulZhipuUpload(uploadInput, input.fileId),
  );
  await processManagedUploadIntent({
    intentId: manifest.intentId,
    userId: 42,
    traceId: `trace-${input.fileId}`,
  });
  return { create, manifest, sha256: input.sha256 };
}

describe("stage-first managed upload intents", () => {
  let assetDirectory: string;

  beforeEach(async () => {
    assetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "managed-intent-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = masterKey;
    process.env.FRONTMIND_UPSTREAM_BASE_URL = "https://api.example.com";
    mocks.axiosPost.mockReset();
    mocks.axiosPut.mockReset();
    mocks.uploadFile.mockReset().mockImplementation(successfulZhipuUpload);
    mocks.fileDetail.mockReset();
    mocks.deleteFile.mockReset().mockResolvedValue(undefined);
    vi.spyOn(
      credentialAgentClient,
      "createCredentialAgentClient",
    ).mockReturnValue({
      uploadFile: mocks.uploadFile,
      fileDetail: mocks.fileDetail,
      deleteFile: mocks.deleteFile,
    } as any);
    mocks.credential.mockReset().mockResolvedValue({
      id: "credential-1",
      userId: 42,
      version: 3,
      apiKey: "test-key",
      provider: "zhipu",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: null,
    });
    mocks.recordResource.mockReset().mockResolvedValue({
      apiCredentialId: "credential-1",
    });
    mocks.discardResource.mockReset().mockImplementation(async (input) => {
      await input.discard({
        credential: await mocks.credential(),
        apiKey: "test-key",
        userId: 42,
        fileId: input.fileId,
        projectAssignmentId: null,
        apiCredentialId: "credential-1",
      });
      return { discarded: true };
    });
    mocks.markRetention.mockReset().mockImplementation(async () => ({
      uploadedAt: new Date(),
      contentExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      contentDeletedAt: null,
    }));
  });

  afterEach(async () => {
    if (vi.isMockFunction(credentialAgentClient.createCredentialAgentClient)) {
      credentialAgentClient.createCredentialAgentClient.mockRestore();
    }
    vi.useRealTimers();
    await stopManagedUploadIntentWorkerForTests();
    delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.FRONTMIND_UPSTREAM_BASE_URL;
    await fs.rm(assetDirectory, { recursive: true, force: true });
  });

  it("materializes the original sealed bytes through Zhipu and replays the same uploaded receipt", async () => {
    const credential = {
      ...(await mocks.credential()),
      provider: "zhipu",
      upstreamModel: "glm-5.3",
      upstreamEffort: "high",
      status: "retired",
    };
    mocks.credential.mockResolvedValue(credential);
    const { sealed, content } = await sealIntent();
    const upload = vi.fn(async (input) => {
      const chunks = [];
      for await (const chunk of input.createReadStream()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(content);
      expect(input.filename).toBe("document.pdf");
      expect(input.byteLength).toBe(content.length);
      expect(input).not.toHaveProperty("uploadUrl");
      const candidate = {
        fileId: "zhipu-file-1",
        filename: input.filename,
        uploadUrl: "",
        uploadExpiresAt: 253402300799,
        requestId: null,
      };
      await input.observer.onCandidateCreated(candidate);
      return {
        ...candidate,
        detail: { status: "uploaded", bytes: content.length },
      };
    });
    const factory = vi
      .spyOn(credentialAgentClient, "createCredentialAgentClient")
      .mockReturnValue({ uploadFile: upload } as any);
    const input = {
      intentId: sealed.intentId,
      userId: 42,
      traceId: "zhipu-upload",
    };
    const first = await processManagedUploadIntent(input);
    expect(first).toMatchObject({
      state: "uploaded",
      fileId: "zhipu-file-1",
      sizeBytes: content.length,
      recreated: false,
    });
    expect(await processManagedUploadIntent(input)).toEqual(first);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(credential, {
      accountUserId: 42,
      intentId: `managed-upload:${sealed.intentId}`,
    });
    expect(mocks.recordResource).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        apiCredentialId: credential.id,
        upstreamId: "zhipu-file-1",
      }),
    );
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.axiosPut).not.toHaveBeenCalled();
  });

  it("requires a fresh upload after an unknown outcome without resending", async () => {
    mocks.credential.mockResolvedValue({
      ...(await mocks.credential()),
      provider: "zhipu",
    });
    const { sealed } = await sealIntent();
    const upload = vi
      .fn()
      .mockRejectedValue(
        new ManusV2ApiError(
          "file.upload",
          null,
          "ZHIPU_MUTATION_OUTCOME_UNKNOWN",
          false,
          true,
        ),
      );
    const factory = vi
      .spyOn(credentialAgentClient, "createCredentialAgentClient")
      .mockReturnValue({ uploadFile: upload } as any);
    const input = {
      intentId: sealed.intentId,
      userId: 42,
      traceId: "zhipu-unknown",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(processManagedUploadIntent(input)).rejects.toMatchObject({
        code: "UPLOAD_PROVIDER_CREATE_UNKNOWN",
        retryable: false,
        recoveryAction: "discard_and_recreate",
      });
    }
    expect(upload).toHaveBeenCalledTimes(1);
    const manifest = await readManagedUploadIntent(sealed.intentId);
    expect(manifest).toMatchObject({
      providerGeneration: 1,
      provider: [{ state: "create_unknown" }],
    });
    expect(
      new Set(factory.mock.calls.map((call) => call[1]?.intentId)).size,
    ).toBe(1);
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.axiosPut).not.toHaveBeenCalled();
    expect(mocks.markRetention).not.toHaveBeenCalled();
  });

  it("rejects corrupted sealed Zhipu inputs before any provider mutation", async () => {
    mocks.credential.mockResolvedValue({
      ...(await mocks.credential()),
      provider: "zhipu",
    });
    const { sealed } = await sealIntent();
    await fs.writeFile(
      path.join(intentDirectory(sealed.intentId), "upload.content"),
      "other bytes",
    );
    const factory = vi.spyOn(
      credentialAgentClient,
      "createCredentialAgentClient",
    );
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "zhipu-corrupt",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH" });
    expect(factory).not.toHaveBeenCalled();
    expect(mocks.recordResource).not.toHaveBeenCalled();
  });

  it("creates an idempotent local intent without touching the provider", async () => {
    const first = await createManagedUploadIntent(createInput());
    const second = await createManagedUploadIntent(createInput());

    expect(second.intentId).toBe(first.intentId);
    expect(first.state).toBe("awaiting_browser");
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.recordResource).not.toHaveBeenCalled();
    expect(managedUploadIntentStorageRoot()).toContain(
      "managed-upload-intents",
    );
  });

  it("rejects create replay, resume, body, status and worker entry after a user deletion fence", async () => {
    const input = {
      ...createInput(),
      resumeScope: {
        kind: "knowledge_base" as const,
        conversationId: "conversation-deleted-user",
        turnId: "00000000-0000-4000-8000-000000000042",
        clientRequestId: "client-request-deleted-user",
      },
    };
    const manifest = await createManagedUploadIntent(input);
    const { ticket } = createManagedUploadIntentTicket(manifest);
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      { disposition: "cancel_active_intents" },
    );

    for (const operation of [
      () => createManagedUploadIntent(input),
      () =>
        listManagedUploadIntentsByResumeScope({
          userId: 42,
          conversationId: input.resumeScope.conversationId,
          turnId: input.resumeScope.turnId,
        }),
      () =>
        readKnowledgeBaseManagedUploadIntentByOperation({
          userId: 42,
          operationId: input.operationId,
        }),
      () =>
        receiveManagedUploadIntentBody({
          intentId: manifest.intentId,
          ticket,
          userId: 42,
          contentLength: manifest.declaredSizeBytes,
          request: Object.assign(Readable.from([Buffer.alloc(11)]), {
            complete: true,
          }),
        }),
      () =>
        processManagedUploadIntent({
          intentId: manifest.intentId,
          userId: 42,
          traceId: "deleted-user-worker",
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "UPLOAD_IDENTITY_DELETION_IN_PROGRESS",
      });
    }
    await completeManagedUploadDeletionFence(token);
  });

  it("keeps reset operation and resume indexes retired after its temporary fence rolls back", async () => {
    const input = {
      ...createInput(),
      operationId: "operation-reset-retired",
      resumeScope: {
        kind: "knowledge_base" as const,
        conversationId: "conversation-reset-retired",
        turnId: "00000000-0000-4000-8000-000000000043",
        clientRequestId: "client-request-reset-retired",
      },
    };
    await createManagedUploadIntent(input);
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      { disposition: "cancel_active_intents" },
    );
    await retireManagedUploadIntentsForAccountDeletion({
      userId: 42,
      token,
      knowledgeBaseConversationIds: new Set([input.resumeScope.conversationId]),
    });
    await rollbackManagedUploadDeletionFence(token);

    await expect(createManagedUploadIntent(input)).rejects.toMatchObject({
      code: "UPLOAD_OPERATION_RETIRED",
    });
    await expect(
      listManagedUploadIntentsByResumeScope({
        userId: 42,
        conversationId: input.resumeScope.conversationId,
        turnId: input.resumeScope.turnId,
      }),
    ).resolves.toEqual([]);
  });

  it("retires and quarantines a corrupt intent proven by its server-owned operation/resume authority", async () => {
    const input = {
      ...createInput(),
      userId: 84,
      credentialOwnerUserId: 42,
      operationId: "operation-corrupt-proven-reset",
      resumeScope: {
        kind: "knowledge_base" as const,
        conversationId: "conversation-corrupt-proven-reset",
        turnId: "00000000-0000-4000-8000-000000000044",
        clientRequestId: "client-corrupt-proven-reset",
      },
    };
    const manifest = await createManagedUploadIntent(input);
    const root = managedUploadIntentStorageRoot();
    const directory = path.join(
      root,
      createHash("sha256").update(manifest.intentId).digest("hex"),
    );
    await fs.writeFile(path.join(directory, "upload.part"), "partial-secret");
    await fs.writeFile(path.join(directory, "manifest.json"), "{broken-json");
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      { disposition: "cancel_active_intents" },
    );

    await expect(
      retireManagedUploadIntentsForAccountDeletion({
        userId: 42,
        token,
        knowledgeBaseConversationIds: new Set([
          input.resumeScope.conversationId,
        ]),
      }),
    ).resolves.toMatchObject({
      matched: 1,
      retired: 1,
      corrupt: 1,
    });
    await rollbackManagedUploadDeletionFence(token);

    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = path.join(root, "deletion-fences", "quarantine");
    const quarantined = await fs.readdir(quarantine);
    expect(quarantined).toHaveLength(1);
    await expect(
      fs.stat(path.join(quarantine, quarantined[0]!, "upload.part")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readKnowledgeBaseManagedUploadIntentByOperation({
        userId: 84,
        operationId: input.operationId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_OPERATION_RETIRED" });
    await expect(
      listManagedUploadIntentsByResumeScope({
        userId: 84,
        conversationId: input.resumeScope.conversationId,
        turnId: input.resumeScope.turnId,
      }),
    ).resolves.toEqual([]);
  });

  it("holds deletion behind Zhipu multipart upload through the uploaded receipt CAS", async () => {
    const { sealed } = await sealIntent();
    let finishUpload!: () => void;
    let reachedUpload!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedUpload = resolve;
    });
    mocks.uploadFile.mockImplementationOnce(async (input) => {
      reachedUpload();
      await new Promise<void>((resolve) => {
        finishUpload = resolve;
      });
      return successfulZhipuUpload(input, "provider-upload-delete-race");
    });
    const running = processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "provider-upload-delete-race",
    });
    await reached;
    let fenceSettled = false;
    const fencePromise = acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      { disposition: "cancel_active_intents" },
    ).then((token) => {
      fenceSettled = true;
      return token;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(fenceSettled).toBe(false);
    finishUpload();
    await expect(running).resolves.toMatchObject({
      state: "uploaded",
      fileId: "provider-upload-delete-race",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "uploaded",
      receipt: expect.objectContaining({
        fileId: "provider-upload-delete-race",
      }),
    });
    await completeManagedUploadDeletionFence(await fencePromise);
  });

  it("discovers a knowledge-base upload on another session and reissues its ticket", async () => {
    const first = await createManagedUploadIntent({
      ...createInput(),
      resumeScope: {
        kind: "knowledge_base",
        conversationId: "conversation-cross-device",
        turnId: "00000000-0000-4000-8000-000000000042",
        clientRequestId: "client-request-cross-device",
      },
    });
    const originalTicket = createManagedUploadIntentTicket(first, {
      now: 1_000,
    });
    const discovered = await listManagedUploadIntentsByResumeScope({
      userId: 42,
      projectAssignmentId: null,
      conversationId: "conversation-cross-device",
      turnId: "00000000-0000-4000-8000-000000000042",
    });

    expect(first.schemaVersion).toBe(2);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      intentId: first.intentId,
      ordinal: 1,
      total: 1,
      state: "awaiting_browser",
      clientRequestId: "client-request-cross-device",
      intentTicket: expect.stringMatching(/^mi1\./u),
    });
    expect(discovered[0]!.ticketExpiresAt).toBeGreaterThan(
      originalTicket.expiresAt,
    );

    await expect(
      listManagedUploadIntentsByResumeScope({
        userId: 43,
        projectAssignmentId: null,
        conversationId: "conversation-cross-device",
        turnId: "00000000-0000-4000-8000-000000000042",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "UPLOAD_INTENT_FORBIDDEN",
    });

    await expect(
      listManagedUploadIntentsByResumeScope({
        userId: 42,
        projectAssignmentId: "00000000-0000-4000-8000-000000000099",
        conversationId: "conversation-cross-device",
        turnId: "00000000-0000-4000-8000-000000000042",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "UPLOAD_INTENT_FORBIDDEN",
    });
  });

  it("proves an uploaded KB operation through the exact index and rehashes retained EOF bytes", async () => {
    const content = Buffer.from("knowledge-base-stage-proof");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const uploaded = await finalizeKnowledgeBaseIntentForStage({
      fileId: "provider-kb-stage-proof",
      content,
      sha256,
    });

    await expect(
      readKnowledgeBaseManagedUploadIntentByOperation({
        userId: 42,
        projectAssignmentId: null,
        operationId: uploaded.create.operationId,
      }),
    ).resolves.toMatchObject({
      intentId: uploaded.manifest.intentId,
      state: "uploaded",
      schemaVersion: 2,
    });

    const proof = await proveKnowledgeBaseManagedUploadForStage({
      userId: 42,
      projectAssignmentId: null,
      conversationId: uploaded.create.resumeScope.conversationId,
      turnId: uploaded.create.resumeScope.turnId,
      clientRequestId: uploaded.create.resumeScope.clientRequestId,
      credential: { id: "credential-1", userId: 42, version: 3 },
      manifestItem: {
        itemId: uploaded.create.operationId,
        filename: uploaded.create.filename,
        mimeType: uploaded.create.mimeType,
        sizeBytes: content.length,
        sha256,
        ordinal: 1,
        total: 1,
      },
      index: 0,
      total: 1,
      fileId: "provider-kb-stage-proof",
    });
    expect(proof).toMatchObject({
      intentId: uploaded.manifest.intentId,
      operationId: uploaded.create.operationId,
      fileId: "provider-kb-stage-proof",
      filename: "document.pdf",
      mimeType: "application/pdf",
      sizeBytes: content.length,
      sha256,
      storageDescriptor: {
        kind: "presales_file",
        fileId: "provider-kb-stage-proof",
        sizeBytes: content.length,
        sha256,
      },
    });
    expect(proof.bytes).toEqual(content);

    const retainedContentPath = path.join(
      assetDirectory,
      "presales-files",
      `${createHash("sha256")
        .update("provider-kb-stage-proof")
        .digest("hex")}.content`,
    );
    await fs.writeFile(
      retainedContentPath,
      Buffer.concat([content.subarray(0, -1), Buffer.from("x")]),
    );
    await expect(
      proveKnowledgeBaseManagedUploadForStage({
        userId: 42,
        projectAssignmentId: null,
        conversationId: uploaded.create.resumeScope.conversationId,
        turnId: uploaded.create.resumeScope.turnId,
        clientRequestId: uploaded.create.resumeScope.clientRequestId,
        credential: { id: "credential-1", userId: 42, version: 3 },
        manifestItem: {
          itemId: uploaded.create.operationId,
          filename: uploaded.create.filename,
          mimeType: uploaded.create.mimeType,
          sizeBytes: content.length,
          sha256,
          ordinal: 1,
          total: 1,
        },
        index: 0,
        total: 1,
        fileId: "provider-kb-stage-proof",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_STAGE_RETAINED_BYTES_MISMATCH",
    });

    await expect(
      proveKnowledgeBaseManagedUploadForStage({
        userId: 42,
        projectAssignmentId: null,
        conversationId: uploaded.create.resumeScope.conversationId,
        turnId: uploaded.create.resumeScope.turnId,
        clientRequestId: uploaded.create.resumeScope.clientRequestId,
        credential: { id: "credential-1", userId: 42, version: 3 },
        manifestItem: {
          itemId: uploaded.create.operationId,
          filename: uploaded.create.filename,
          mimeType: uploaded.create.mimeType,
          sizeBytes: content.length,
          sha256: "0".repeat(64),
          ordinal: 1,
          total: 1,
        },
        index: 0,
        total: 1,
        fileId: "provider-kb-stage-proof",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_STAGE_PROOF_MISMATCH" });
  });

  it("takes over a stale operation lock after a process crash", async () => {
    const input = createInput();
    const operationKey = createHash("sha256")
      .update(
        JSON.stringify([
          input.userId,
          input.projectAssignmentId,
          input.operationId,
        ]),
      )
      .digest("hex");
    const operationDirectory = path.join(
      managedUploadIntentStorageRoot(),
      "by-operation",
    );
    await fs.mkdir(operationDirectory, { recursive: true });
    const staleLock = path.join(
      operationDirectory,
      `${operationKey}.json.lock`,
    );
    await fs.writeFile(staleLock, "crashed\n", { mode: 0o600 });
    const old = new Date(Date.now() - 31_000);
    await fs.utimes(staleLock, old, old);

    const created = await createManagedUploadIntent(input);

    expect(created.state).toBe("awaiting_browser");
    await expect(fs.stat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a missing operation index without allocating a second intent", async () => {
    const input = createInput();
    const first = await createManagedUploadIntent(input);
    const operationKey = createHash("sha256")
      .update(
        JSON.stringify([
          input.userId,
          input.projectAssignmentId,
          input.operationId,
        ]),
      )
      .digest("hex");
    const indexPath = path.join(
      managedUploadIntentStorageRoot(),
      "by-operation",
      `${operationKey}.json`,
    );
    await fs.rm(indexPath);

    const recovered = await createManagedUploadIntent(input);

    expect(recovered.intentId).toBe(first.intentId);
    const intentDirectories = (
      await fs.readdir(managedUploadIntentStorageRoot(), {
        withFileTypes: true,
      })
    ).filter(
      (entry) => entry.isDirectory() && /^[a-f\d]{64}$/u.test(entry.name),
    );
    expect(intentDirectories).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(indexPath, "utf8"))).toMatchObject({
      intentId: first.intentId,
      requestHash: first.requestHash,
    });
  });

  it("fails closed on a corrupt durable manifest before provider side effects", async () => {
    const created = await createManagedUploadIntent(createInput());
    const directory = path.join(
      managedUploadIntentStorageRoot(),
      createHash("sha256").update(created.intentId).digest("hex"),
    );
    const manifestPath = path.join(directory, "manifest.json");
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    raw.untrustedState = "execute-provider";
    await fs.writeFile(manifestPath, `${JSON.stringify(raw)}\n`, {
      mode: 0o600,
    });

    await expect(readManagedUploadIntent(created.intentId)).rejects.toThrow(
      "MANAGED_UPLOAD_INTENT_MANIFEST_INVALID",
    );
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.axiosPut).not.toHaveBeenCalled();
  });

  it("boots the worker only after explicit durable-storage preflight", async () => {
    expect(getManagedUploadIntentWorkerReadiness()).toMatchObject({
      started: false,
      storageReady: false,
    });

    await ensureManagedUploadIntentWorker({
      allowInTest: true,
      runImmediately: false,
      intervalMs: 60_000,
    });

    expect(getManagedUploadIntentWorkerReadiness()).toMatchObject({
      started: true,
      storageReady: true,
      scans: 0,
    });
    const entries = await fs.readdir(managedUploadIntentStorageRoot());
    expect(entries).toContain("by-operation");
    expect(
      entries.some((entry) => entry.startsWith(".worker-preflight-")),
    ).toBe(false);
  });

  it("binds mi1 tickets to owner, credential and request hash", async () => {
    const manifest = await createManagedUploadIntent(createInput());
    const key = deriveManagedUploadIntentTicketKey(masterKey);
    const created = createManagedUploadIntentTicket(manifest, { key });

    expect(created.ticket.startsWith("mi1.")).toBe(true);
    expect(
      openManagedUploadIntentTicket(created.ticket, manifest, { key }),
    ).toMatchObject({ intentId: manifest.intentId, ownerUserId: 42 });
    expect(() =>
      openManagedUploadIntentTicket(
        `${created.ticket.slice(0, -1)}x`,
        manifest,
        { key },
      ),
    ).toThrow(/上传凭证/u);
    expect(() =>
      openManagedUploadIntentTicket(
        created.ticket,
        {
          ...manifest,
          userId: 43,
        },
        { key },
      ),
    ).toThrow(/不匹配/u);
  });

  it("fsync-seals the complete browser body before any provider create", async () => {
    const { sealed } = await sealIntent();

    expect(sealed.state).toBe("sealed");
    expect(sealed.sizeBytes).toBe(11);
    expect(sealed.sha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.axiosPut).not.toHaveBeenCalled();
  });

  it("keeps 43 MiB and 42.5 MiB slow browser streams local until seal, then uploads the complete multipart copy", async () => {
    vi.useFakeTimers();
    let virtualNow = Date.UTC(2026, 7, 12, 0, 0, 0);
    vi.setSystemTime(virtualNow);
    const sizes = [43 * 1024 * 1024, Math.floor(42.5 * 1024 * 1024)];
    let browserBodies = 0;

    for (const [index, sizeBytes] of sizes.entries()) {
      const input = {
        ...createInput(sizeBytes),
        operationId: `slow-operation-${index + 1}`,
        batchId: "slow-batch",
        ordinal: index + 1,
        total: sizes.length,
        filename: `slow-${index + 1}.pdf`,
      };
      const created = await createManagedUploadIntent(input);
      const { ticket } = createManagedUploadIntentTicket(created);
      let outstandingChunks = 0;
      let maximumOutstandingChunks = 0;
      const chunkSize = 64 * 1024;
      async function* slowBrowserBody() {
        browserBodies += 1;
        let remaining = sizeBytes;
        while (remaining > 0) {
          const length = Math.min(chunkSize, remaining);
          outstandingChunks += 1;
          maximumOutstandingChunks = Math.max(
            maximumOutstandingChunks,
            outstandingChunks,
          );
          // 1.2 Mbps = 150,000 bytes/s. Advance a monotonic test clock
          // without sleeping in CI; the stream/file/hash work is real.
          virtualNow += Math.ceil((length / 150_000) * 1_000);
          vi.setSystemTime(virtualNow);
          yield Buffer.alloc(length, index + 1);
          outstandingChunks -= 1;
          remaining -= length;
        }
      }
      const request = Readable.from(slowBrowserBody(), {
        highWaterMark: chunkSize,
      }) as Readable & { complete: boolean };
      request.complete = true;

      expect(mocks.uploadFile).toHaveBeenCalledTimes(index);
      const sealed = await receiveManagedUploadIntentBody({
        intentId: created.intentId,
        ticket,
        userId: 42,
        contentLength: sizeBytes,
        request,
      });
      expect(sealed).toMatchObject({
        state: "sealed",
        sizeBytes,
      });
      expect(maximumOutstandingChunks).toBe(1);
      expect(mocks.uploadFile).toHaveBeenCalledTimes(index);

      const providerFileId = `provider-slow-${index + 1}`;
      mocks.uploadFile.mockImplementationOnce((uploadInput) =>
        successfulZhipuUpload(uploadInput, providerFileId),
      );

      await expect(
        processManagedUploadIntent({
          intentId: created.intentId,
          userId: 42,
          traceId: `trace-slow-${index + 1}`,
        }),
      ).resolves.toMatchObject({ state: "uploaded", fileId: providerFileId });
    }

    expect(browserBodies).toBe(2);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.axiosPut).not.toHaveBeenCalled();
  }, 30_000);

  it("reconciles a crash after content rename without asking for the body again", async () => {
    const { sealed, ticket, content } = await sealIntent();
    const manifestPath = path.join(
      intentDirectory(sealed.intentId),
      "manifest.json",
    );
    const crashed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    Object.assign(crashed, {
      state: "receiving",
      phase: "receiving",
      sizeBytes: null,
      sha256: null,
      sealedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      revision: crashed.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(crashed)}\n`, {
      mode: 0o600,
    });
    const request = Readable.from([content]) as Readable & {
      complete: boolean;
    };
    request.complete = true;

    await expect(
      receiveManagedUploadIntentBody({
        intentId: sealed.intentId,
        ticket,
        userId: 42,
        contentLength: content.length,
        request,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_BODY_ALREADY_RECEIVED" });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "sealed",
      sizeBytes: content.length,
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it("resets stale receiving partial state to needs-browser-body", async () => {
    const created = await createManagedUploadIntent(createInput());
    const directory = intentDirectory(created.intentId);
    const manifestPath = path.join(directory, "manifest.json");
    await fs.writeFile(path.join(directory, "upload.part"), "partial", {
      mode: 0o600,
    });
    const stale = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    Object.assign(stale, {
      state: "receiving",
      phase: "receiving",
      leaseOwner: null,
      leaseExpiresAt: null,
      revision: stale.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(stale)}\n`, {
      mode: 0o600,
    });

    const result = await processManagedUploadIntent({
      intentId: created.intentId,
      userId: 42,
      traceId: "trace-stale-partial",
    });

    expect(result).toMatchObject({
      state: "needs_browser_body",
      intentId: created.intentId,
    });
    expect(await readManagedUploadIntent(created.intentId)).toMatchObject({
      state: "awaiting_browser",
      leaseOwner: null,
    });
    await expect(
      fs.stat(path.join(directory, "upload.part")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it("releases receiving state when opening the local part fails", async () => {
    const created = await createManagedUploadIntent(createInput());
    const { ticket } = createManagedUploadIntentTicket(created);
    const directory = intentDirectory(created.intentId);
    const request = Readable.from([Buffer.from("hello world")]) as Readable & {
      complete: boolean;
    };
    request.complete = true;

    await expect(
      receiveManagedUploadIntentBody({
        intentId: created.intentId,
        ticket,
        userId: 42,
        contentLength: 11,
        request,
        onBeforePartOpen: async () => {
          await fs.writeFile(path.join(directory, "upload.part"), "collision", {
            mode: 0o600,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_STORAGE_UNAVAILABLE" });
    expect(await readManagedUploadIntent(created.intentId)).toMatchObject({
      state: "awaiting_browser",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("resumes cleanup after provider and ownership discard committed before manifest CAS", async () => {
    const uploaded = await finalizeIntentForDelete("provider-delete-crash");
    mocks.deleteFile.mockResolvedValue({ status: 204, data: "" });
    mocks.fileDetail.mockRejectedValue(
      new ManusV2ApiError("file.detail", 404, "NOT_FOUND", false),
    );
    let discardCalls = 0;
    mocks.discardResource.mockImplementation(async (input) => {
      discardCalls += 1;
      if (discardCalls <= 2) {
        await input.discard({
          credential: await mocks.credential(),
          apiKey: "test-key",
          userId: 42,
          fileId: input.fileId,
          projectAssignmentId: null,
          apiCredentialId: "credential-1",
        });
      }
      if (discardCalls === 2) {
        throw new Error("crash-after-discard-commit");
      }
      return { discarded: false };
    });

    await expect(
      deleteManagedUploadIntent({
        intentId: uploaded.sealed.intentId,
        ticket: uploaded.ticket,
        userId: 42,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_DISCARD_FAILED" });
    expect(
      await readManagedUploadIntent(uploaded.sealed.intentId),
    ).toMatchObject({
      state: "cleanup_pending",
      phase: "cleanup_pending",
      receipt: expect.objectContaining({ fileId: "provider-delete-crash" }),
      provider: [expect.objectContaining({ state: "discard_sending" })],
    });

    await expect(
      deleteManagedUploadIntent({
        intentId: uploaded.sealed.intentId,
        ticket: uploaded.ticket,
        userId: 42,
      }),
    ).resolves.toMatchObject({ state: "cancelled" });
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
    expect(mocks.fileDetail).toHaveBeenCalledOnce();
    expect(
      await readManagedUploadIntent(uploaded.sealed.intentId),
    ).toMatchObject({ state: "cancelled", receipt: null });
  });

  it("durably schedules uploaded provider files for background cleanup without using the revoked credential", async () => {
    const uploaded = await finalizeIntentForDelete("provider-deferred-delete");
    mocks.credential.mockResolvedValue(null);

    await expect(
      scheduleManagedUploadIntentCleanup({
        intentId: uploaded.sealed.intentId,
        ticket: uploaded.ticket,
        userId: 42,
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      state: "cleanup_pending",
    });
    expect(
      await readManagedUploadIntent(uploaded.sealed.intentId),
    ).toMatchObject({
      state: "cleanup_pending",
      phase: "cleanup_pending",
      safeErrorCode: "UPLOAD_CUSTOMER_CANCELLATION",
      receipt: expect.objectContaining({ fileId: "provider-deferred-delete" }),
      provider: [
        expect.objectContaining({
          fileId: "provider-deferred-delete",
          state: "uploaded",
          ownershipRecorded: true,
        }),
      ],
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();

    await expect(
      processManagedUploadIntent({
        intentId: uploaded.sealed.intentId,
        userId: 42,
        traceId: "revoked-cleanup-worker",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_CREDENTIAL_UNAVAILABLE" });
    expect(
      await readManagedUploadIntent(uploaded.sealed.intentId),
    ).toMatchObject({
      state: "cleanup_pending",
      phase: "cleanup_pending",
      receipt: expect.objectContaining({ fileId: "provider-deferred-delete" }),
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();

    await expect(
      scheduleManagedUploadIntentCleanup({
        intentId: uploaded.sealed.intentId,
        ticket: uploaded.ticket,
        userId: 42,
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      state: "cleanup_pending",
    });
    expect(
      await readManagedUploadIntent(uploaded.sealed.intentId),
    ).toMatchObject({
      state: "cleanup_pending",
      receipt: expect.objectContaining({ fileId: "provider-deferred-delete" }),
    });
  });

  it("lets an in-flight worker observe a durable cleanup request at its next CAS", async () => {
    const { sealed, ticket } = await sealIntent();
    let finishUpload!: () => void;
    mocks.uploadFile.mockImplementationOnce(async (uploadInput) => {
      await new Promise<void>((resolve) => {
        finishUpload = resolve;
      });
      return successfulZhipuUpload(
        uploadInput,
        "provider-created-after-cancel",
      );
    });
    const running = processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "active-upload-worker",
    });
    await vi.waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledOnce());

    await expect(
      scheduleManagedUploadIntentCleanup({
        intentId: sealed.intentId,
        ticket,
        userId: 42,
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      state: "cleanup_pending",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "processing",
      phase: "uploading_provider",
      leaseOwner: expect.any(String),
    });
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "competing-cleanup-worker",
      }),
    ).resolves.toMatchObject({
      state: "processing",
      phase: "uploading_provider",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "processing",
      phase: "uploading_provider",
      leaseOwner: expect.any(String),
    });
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    finishUpload();
    await expect(running).resolves.toMatchObject({
      state: "processing",
      phase: "cleanup_pending",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "cleanup_pending",
      phase: "cleanup_pending",
      leaseOwner: null,
      provider: [
        expect.objectContaining({ fileId: "provider-created-after-cancel" }),
      ],
    });
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.axiosPut).not.toHaveBeenCalled();

    mocks.deleteFile.mockResolvedValue({ status: 204, data: "" });
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "cleanup-request-handoff",
      }),
    ).resolves.toMatchObject({ state: "processing" });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "cancelled",
      phase: null,
      leaseOwner: null,
    });
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
  });

  it("restores an uploaded receipt when binding wins the DELETE preflight race", async () => {
    const uploaded = await finalizeIntentForDelete("provider-bound-race");
    const before = await readManagedUploadIntent(uploaded.sealed.intentId);
    expect(await readStoredPresalesFile("provider-bound-race")).not.toBeNull();
    let discardCalls = 0;
    mocks.discardResource.mockImplementation(async (input) => {
      discardCalls += 1;
      if (discardCalls === 1) {
        return input.discard({
          credential: await mocks.credential(),
          apiKey: "test-key",
          userId: 42,
          fileId: input.fileId,
          projectAssignmentId: null,
          apiCredentialId: "credential-1",
        });
      }
      throw new AuthServiceError("CONFLICT", "bound after preflight");
    });

    await expect(
      deleteManagedUploadIntent({
        intentId: uploaded.sealed.intentId,
        ticket: uploaded.ticket,
        userId: 42,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_ALREADY_BOUND" });

    const after = await readManagedUploadIntent(uploaded.sealed.intentId);
    expect(after).toMatchObject({
      state: "uploaded",
      phase: null,
      receipt: before?.receipt,
      provider: [
        expect.objectContaining({
          fileId: "provider-bound-race",
          state: "uploaded",
          ownershipRecorded: true,
        }),
      ],
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(await readStoredPresalesFile("provider-bound-race")).not.toBeNull();
  });

  it("removes stale partial bytes without touching fresh sealed evidence", async () => {
    const awaiting = await createManagedUploadIntent(createInput());
    const directory = path.join(
      managedUploadIntentStorageRoot(),
      Buffer.from(awaiting.intentId).toString("hex"),
    );
    const result = await sweepManagedUploadIntents(
      Date.now() + 7 * 60 * 60 * 1_000,
    );
    expect(result.removedSealed).toBe(0);
  });

  it("tombstones an expired sealed copy before unlink and never runs provider work", async () => {
    const { sealed } = await sealIntent();

    const result = await sweepManagedUploadIntents(
      Date.now() + 31 * 24 * 60 * 60 * 1_000,
    );

    expect(result.removedSealed).toBe(1);
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "expired",
      safeErrorCode: "UPLOAD_LOCAL_COPY_EXPIRED_RECREATE_REQUIRED",
    });
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-expired",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_LOCAL_COPY_EXPIRED_RECREATE_REQUIRED",
      recoveryAction: "discard_and_recreate",
    });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.axiosPut).not.toHaveBeenCalled();
  });

  it("routes an expired sealed intent with a known provider through authorized cleanup before unlink", async () => {
    const { sealed } = await sealIntent();
    mocks.uploadFile.mockImplementationOnce(async (uploadInput) => {
      await uploadInput.observer.onCandidateCreated({
        fileId: "provider-expiring",
        filename: uploadInput.filename,
      });
      throw new ManusV2ApiError(
        "file.upload",
        null,
        "ZHIPU_MUTATION_OUTCOME_UNKNOWN",
        false,
        true,
      );
    });
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-pending-retention",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_CREATE_UNKNOWN" });
    const contentPath = path.join(
      intentDirectory(sealed.intentId),
      "upload.content",
    );
    const sweepAt = Date.now() + 31 * 24 * 60 * 60 * 1_000;
    const swept = await sweepManagedUploadIntents(sweepAt);

    expect(swept.removedSealed).toBe(0);
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "cleanup_pending",
      phase: "cleanup_pending",
      safeErrorCode: "UPLOAD_LOCAL_COPY_RETENTION_CLEANUP",
    });
    await expect(fs.stat(contentPath)).resolves.toBeDefined();
    expect(mocks.deleteFile).not.toHaveBeenCalled();

    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-retention-cleanup",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "cancelled",
    });
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
    await expect(fs.stat(contentPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("compacts terminal intent identity into a bounded hash tombstone and later removes it", async () => {
    const base = Date.now();
    const { sealed } = await sealIntent();
    const operationKey = createHash("sha256")
      .update(JSON.stringify([42, null, "operation-1"]))
      .digest("hex");
    const indexPath = path.join(
      managedUploadIntentStorageRoot(),
      "by-operation",
      `${operationKey}.json`,
    );

    await sweepManagedUploadIntents(base + 31 * 24 * 60 * 60 * 1_000);
    await sweepManagedUploadIntents(base + 62 * 24 * 60 * 60 * 1_000);

    expect(await readManagedUploadIntent(sealed.intentId)).toBeNull();
    const retiredRaw = await fs.readFile(indexPath, "utf8");
    const retired = JSON.parse(retiredRaw);
    expect(retired).toEqual({
      schemaVersion: 1,
      state: "retired",
      requestHash: expect.stringMatching(/^[a-f\d]{64}$/u),
      retiredAt: new Date(base + 62 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    expect(retiredRaw).not.toContain(sealed.intentId);
    expect(retiredRaw).not.toContain("document.pdf");
    expect(retiredRaw).not.toContain("provider");
    await expect(
      createManagedUploadIntent(createInput()),
    ).rejects.toMatchObject({ code: "UPLOAD_OPERATION_RETIRED" });

    await sweepManagedUploadIntents(base + 93 * 24 * 60 * 60 * 1_000);
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
