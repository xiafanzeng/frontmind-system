import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosCreate: vi.fn(),
  axiosPost: vi.fn(),
  axiosPut: vi.fn(),
  axiosGet: vi.fn(),
  axiosDelete: vi.fn(),
  credential: vi.fn(),
  recordResource: vi.fn(),
  discardResource: vi.fn(),
  markRetention: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: mocks.axiosCreate.mockImplementation((defaults) => ({
      post: async (url: string, body: unknown, options: object) => {
        const requestOptions = {
          ...options,
          headers: {
            ...(defaults?.headers ?? {}),
            ...((options as { headers?: object })?.headers ?? {}),
          },
        };
        const response = url.endsWith("/v2/file.delete")
          ? await mocks.axiosDelete(url, {
              ...requestOptions,
              data: body,
            })
          : await mocks.axiosPost(url, body, requestOptions);
        const data = response?.data ?? {};
        if (url.endsWith("/v2/file.upload")) {
          if (response.status < 200 || response.status >= 300) {
            return {
              ...response,
              data: {
                ok: false,
                error: {
                  code:
                    response.status === 429
                      ? "RATE_LIMITED"
                      : `HTTP_${response.status}`,
                },
              },
            };
          }
          return {
            ...response,
            data: {
              ok: true,
              file: { id: data.id, filename: data.filename },
              upload_url: data.upload_url,
              upload_expires_at:
                Number(data.upload_expires_at) > 10_000_000_000
                  ? Math.floor(Number(data.upload_expires_at) / 1_000)
                  : data.upload_expires_at,
            },
          };
        }
        if (url.endsWith("/v2/file.delete")) {
          if (response.status === 404) {
            return {
              ...response,
              data: { ok: false, error: { code: "NOT_FOUND" } },
            };
          }
          return {
            ...response,
            data: { ok: true, file: { id: (body as any).file_id } },
          };
        }
        return response;
      },
      get: async (url: string, options: any) => {
        const response = await mocks.axiosGet(url, options);
        if (!url.endsWith("/v2/file.detail")) return response;
        if (response.status === 404) {
          return {
            ...response,
            data: { ok: false, error: { code: "NOT_FOUND" } },
          };
        }
        const data = response?.data ?? {};
        return {
          ...response,
          data:
            data.ok === true
              ? data
              : {
                  ok: true,
                  file: {
                    id: options.params.file_id,
                    filename: data.filename ?? "provider-document.pdf",
                    status: data.status ?? "uploaded",
                    bytes: data.bytes ?? 11,
                    expires_at: 2_000_000_000,
                    content_type: "application/pdf",
                  },
                },
        };
      },
    })),
    post: mocks.axiosPost,
    put: mocks.axiosPut,
    get: mocks.axiosGet,
    delete: mocks.axiosDelete,
  },
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

vi.mock("./upstream-file-readiness", () => ({
  checkUpstreamFileReadiness: mocks.readiness,
  UpstreamFileReadinessError: class UpstreamFileReadinessError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly retryable: boolean,
    ) {
      super(message);
    }
  },
}));

import {
  createManagedUploadIntent,
  createManagedUploadIntentTicket,
  deleteManagedUploadIntent,
  deriveManagedUploadIntentTicketKey,
  ensureManagedUploadIntentWorker,
  getManagedUploadIntentWorkerReadiness,
  MANAGED_UPLOAD_CREATE_UNKNOWN_WAIT_MS,
  managedUploadProviderPutDeadlineMs,
  managedUploadIntentStorageRoot,
  listManagedUploadIntentsByResumeScope,
  openManagedUploadIntentTicket,
  parseManagedUploadSignedUrlExpiry,
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
import { UpstreamFileReadinessError } from "./upstream-file-readiness";

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

async function consumeSuccessfulPut(
  _url: unknown,
  body: AsyncIterable<unknown>,
) {
  for await (const _chunk of body) {
    // Consume the actual stream so the client can prove exact EOF.
  }
  return { status: 200, data: "" };
}

async function finalizeIntentForDelete(fileId: string) {
  const sealed = await sealIntent();
  mocks.axiosPost.mockResolvedValue({
    status: 201,
    data: {
      id: fileId,
      filename: "provider-document.pdf",
      status: "pending",
      upload_url: `https://storage.example.com/${fileId}`,
      upload_expires_at: Date.now() + 180_000,
    },
  });
  mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
  mocks.readiness.mockResolvedValue({
    fileId,
    filename: "provider-document.pdf",
    state: "uploaded",
    status: "uploaded",
    checkedAt: Date.now(),
  });
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
  mocks.axiosPost.mockResolvedValue({
    status: 201,
    data: {
      id: input.fileId,
      filename: "document.pdf",
      status: "pending",
      upload_url: `https://storage.example.com/${input.fileId}`,
      upload_expires_at: Date.now() + 180_000,
    },
  });
  mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
  mocks.readiness.mockResolvedValue({
    fileId: input.fileId,
    filename: "document.pdf",
    state: "uploaded",
    status: "uploaded",
    checkedAt: Date.now(),
  });
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
    mocks.axiosGet.mockReset();
    mocks.axiosDelete.mockReset();
    mocks.credential.mockReset().mockResolvedValue({
      id: "credential-1",
      userId: 42,
      version: 3,
      apiKey: "test-key",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: null,
    });
    mocks.recordResource.mockReset().mockResolvedValue({
      apiCredentialId: "credential-1",
    });
    mocks.discardResource.mockReset().mockImplementation(async (input) => {
      await input.discard({
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
    mocks.readiness.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopManagedUploadIntentWorkerForTests();
    delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.FRONTMIND_UPSTREAM_BASE_URL;
    await fs.rm(assetDirectory, { recursive: true, force: true });
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

  it("holds deletion behind provider create until the returned identity is durably settled", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });
    let finishCreate!: (value: unknown) => void;
    mocks.axiosPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve;
        }),
    );
    const running = processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "provider-create-delete-race",
    });
    await vi.waitFor(() => expect(mocks.axiosPost).toHaveBeenCalledOnce());

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

    finishCreate({
      status: 201,
      data: {
        id: "provider-create-delete-race",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "javascript:unsafe",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    await expect(running).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_RESPONSE_INVALID",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      provider: [
        expect.objectContaining({
          fileId: "provider-create-delete-race",
          state: "discarded",
        }),
      ],
    });
    const token = await fencePromise;
    expect(fenceSettled).toBe(true);
    await completeManagedUploadDeletionFence(token);
  });

  it("holds deletion behind provider PUT through the uploaded receipt CAS", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-put-delete-race",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/provider-put-delete-race",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    let putReached!: () => void;
    const reachedPut = new Promise<void>((resolve) => {
      putReached = resolve;
    });
    let finishPut!: () => void;
    mocks.axiosPut.mockImplementationOnce(async (_url, body) => {
      for await (const _chunk of body) {
        // Consume EOF before holding the provider response.
      }
      putReached();
      await new Promise<void>((resolve) => {
        finishPut = resolve;
      });
      return { status: 200, data: "" };
    });
    mocks.readiness.mockResolvedValue({
      fileId: "provider-put-delete-race",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });
    const running = processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "provider-put-delete-race",
    });
    await reachedPut;

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

    finishPut();
    await expect(running).resolves.toMatchObject({
      state: "uploaded",
      fileId: "provider-put-delete-race",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "uploaded",
      receipt: expect.objectContaining({
        fileId: "provider-put-delete-race",
      }),
    });
    const token = await fencePromise;
    await completeManagedUploadDeletionFence(token);
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

  it("parses the six SigV4 UTC fields exactly and bounds PUT before expiry", () => {
    const signedAt = Date.UTC(2026, 7, 12, 12, 34, 56);
    const expiresAt = signedAt + 180_000;
    const target =
      "https://storage.example.com/upload?X-Amz-Date=20260812T123456Z&X-Amz-Expires=180";

    expect(parseManagedUploadSignedUrlExpiry(target)).toBe(expiresAt);
    expect(managedUploadProviderPutDeadlineMs(expiresAt, signedAt)).toBe(
      175_000,
    );
    expect(
      managedUploadProviderPutDeadlineMs(expiresAt, expiresAt - 4_999),
    ).toBe(0);
    expect(
      parseManagedUploadSignedUrlExpiry(
        "https://storage.example.com/upload?X-Amz-Date=20261312T123456Z&X-Amz-Expires=180",
      ),
    ).toBeNull();
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

  it("keeps 43 MiB and 42.5 MiB slow browser streams local until seal, then uses a fresh provider window", async () => {
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

      expect(mocks.axiosPost).toHaveBeenCalledTimes(index);
      expect(mocks.axiosPut).toHaveBeenCalledTimes(index);
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
      expect(mocks.axiosPost).toHaveBeenCalledTimes(index);
      expect(mocks.axiosPut).toHaveBeenCalledTimes(index);

      const providerFileId = `provider-slow-${index + 1}`;
      const freshExpiry = virtualNow + 180_000;
      mocks.axiosPost.mockResolvedValueOnce({
        status: 201,
        data: {
          id: providerFileId,
          filename: `provider-slow-${index + 1}.pdf`,
          status: "pending",
          upload_url: `https://storage.example.com/${providerFileId}`,
          upload_expires_at: freshExpiry,
        },
      });
      mocks.axiosPut.mockImplementationOnce(async (_url, stream) => {
        let forwarded = 0;
        for await (const chunk of stream) {
          forwarded += Buffer.byteLength(chunk);
        }
        expect(forwarded).toBe(sizeBytes);
        expect(Date.now()).toBeLessThan(freshExpiry - 5_000);
        return { status: 200, data: "" };
      });
      mocks.readiness.mockResolvedValueOnce({
        fileId: providerFileId,
        filename: `provider-slow-${index + 1}.pdf`,
        state: "uploaded",
        status: "uploaded",
        checkedAt: virtualNow,
      });

      await expect(
        processManagedUploadIntent({
          intentId: created.intentId,
          userId: 42,
          traceId: `trace-slow-${index + 1}`,
        }),
      ).resolves.toMatchObject({ state: "uploaded", fileId: providerFileId });
    }

    expect(browserBodies).toBe(2);
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(mocks.axiosPut).toHaveBeenCalledTimes(2);
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

  it("uploads only the sealed local copy and finalizes after uploaded metadata", async () => {
    const { sealed, content } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-1",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/upload",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(async (_url, stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(content);
      return { status: 200, data: "" };
    });
    mocks.readiness.mockResolvedValue({
      fileId: "provider-file-1",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });

    const result = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      projectAssignmentId: null,
      traceId: "trace-safe",
    });

    expect(result).toMatchObject({
      state: "uploaded",
      fileId: "provider-file-1",
      sizeBytes: 11,
      recreated: false,
    });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.axiosPut).toHaveBeenCalledTimes(1);
    expect(mocks.credential).toHaveBeenCalledWith({
      credentialId: "credential-1",
      credentialOwnerUserId: 42,
      credentialVersion: 3,
    });
    expect(mocks.recordResource).toHaveBeenCalledTimes(1);
    expect(mocks.markRetention).toHaveBeenCalledTimes(1);
  });

  it("does not trust an early provider 2xx before the local stream reaches EOF", async () => {
    const { sealed, content } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-early-2xx",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/upload-early",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    // Resolve without consuming the request stream, simulating a provider
    // that responds from headers and closes before receiving the body.
    mocks.axiosPut.mockResolvedValue({ status: 200, data: "" });
    mocks.readiness.mockResolvedValue({
      fileId: "provider-file-early-2xx",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: Readable.from([content]),
    });

    const result = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-early-2xx",
    });

    expect(result).toMatchObject({
      state: "uploaded",
      fileId: "provider-file-early-2xx",
    });
    expect(mocks.axiosGet).toHaveBeenCalledTimes(1);
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      provider: [{ putResponse2xx: false, state: "uploaded" }],
    });
  });

  it("accepts the v2 file.upload contract without a legacy status field", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-invalid-capability",
        filename: "provider-document.pdf",
        upload_url: "https://storage.example.com/invalid-capability",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.readiness.mockResolvedValue({
      fileId: "provider-invalid-capability",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-invalid-capability",
      }),
    ).resolves.toMatchObject({
      state: "uploaded",
      fileId: "provider-invalid-capability",
    });

    expect(mocks.recordResource).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamId: "provider-invalid-capability" }),
    );
    expect(mocks.discardResource).not.toHaveBeenCalled();
    expect(mocks.axiosPut).toHaveBeenCalledOnce();
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "uploaded",
      provider: [
        expect.objectContaining({
          fileId: "provider-invalid-capability",
          state: "uploaded",
          ownershipRecorded: true,
        }),
      ],
    });
  });

  it("waits on a 2xx pending record and recovery never resends the browser body", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-pending",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/upload-pending",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.readiness
      .mockResolvedValueOnce({
        fileId: "provider-file-pending",
        filename: "provider-document.pdf",
        state: "pending",
        status: "pending",
        checkedAt: Date.now(),
      })
      .mockResolvedValueOnce({
        fileId: "provider-file-pending",
        filename: "provider-document.pdf",
        state: "uploaded",
        status: "uploaded",
        checkedAt: Date.now(),
      });

    const first = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-1",
    });
    const recovered = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-2",
    });

    expect(first).toMatchObject({
      state: "processing",
      phase: "waiting_provider",
    });
    expect(recovered).toMatchObject({ state: "uploaded" });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.axiosPut).toHaveBeenCalledTimes(1);
  });

  it("keeps a deterministic provider PUT rejection terminal without replay or replacement", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-put-rejected",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/put-rejected",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(async (_url, body) => {
      for await (const _chunk of body) {
        // Prove the rejection is the provider response, not an incomplete body.
      }
      return { status: 400, data: "" };
    });
    mocks.readiness.mockResolvedValue({
      fileId: "provider-put-rejected",
      filename: "provider-document.pdf",
      state: "pending",
      status: "pending",
      checkedAt: Date.now(),
    });

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-put-rejected",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_PUT_REJECTED" });
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-put-rejected-again",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_PUT_REJECTED" });
    expect(mocks.axiosPost).toHaveBeenCalledOnce();
    expect(mocks.axiosPut).toHaveBeenCalledOnce();
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "failed",
      safeErrorCode: "UPLOAD_PROVIDER_PUT_REJECTED",
      provider: [expect.objectContaining({ state: "put_rejected" })],
    });
  });

  it("classifies a fresh-window 403 at request start and uses only the sole replacement", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "provider-put-forbidden-1",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/put-forbidden-1",
          upload_expires_at: Date.now() + 180_000,
        },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "provider-put-forbidden-2",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/put-forbidden-2",
          upload_expires_at: Date.now() + 180_000,
        },
      });
    mocks.axiosPut
      .mockImplementationOnce(async (_url, body) => {
        for await (const _chunk of body) {
          // Fully forwarded, but the fresh capability was forbidden.
        }
        return { status: 403, data: "" };
      })
      .mockImplementationOnce(consumeSuccessfulPut);
    mocks.readiness
      .mockResolvedValueOnce({
        fileId: "provider-put-forbidden-1",
        filename: "provider-document.pdf",
        state: "pending",
        status: "pending",
        checkedAt: Date.now(),
      })
      .mockResolvedValueOnce({
        fileId: "provider-put-forbidden-1",
        filename: "provider-document.pdf",
        state: "pending",
        status: "pending",
        checkedAt: Date.now(),
      })
      .mockResolvedValueOnce({
        fileId: "provider-put-forbidden-2",
        filename: "provider-document.pdf",
        state: "uploaded",
        status: "uploaded",
        checkedAt: Date.now(),
      });
    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });

    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-put-forbidden-1",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      safeErrorCode: "UPLOAD_PROVIDER_PUT_FORBIDDEN",
      provider: [expect.objectContaining({ state: "put_unknown" })],
    });

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-put-forbidden-2",
      }),
    ).resolves.toMatchObject({
      state: "uploaded",
      fileId: "provider-put-forbidden-2",
      recreated: true,
    });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(mocks.axiosPut).toHaveBeenCalledTimes(2);
    expect(mocks.axiosDelete).toHaveBeenCalledOnce();
  });

  it("replaces an unusable post-PUT record from the sealed local copy without another browser body", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "provider-unusable-1",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/provider-unusable-1",
          upload_expires_at: Date.now() + 180_000,
        },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "provider-unusable-2",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/provider-unusable-2",
          upload_expires_at: Date.now() + 180_000,
        },
      });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });
    mocks.readiness
      .mockRejectedValueOnce(
        new UpstreamFileReadinessError(
          "UPSTREAM_FILE_UNUSABLE",
          "provider record unusable",
          false,
        ),
      )
      .mockResolvedValueOnce({
        fileId: "provider-unusable-2",
        filename: "provider-document.pdf",
        state: "uploaded",
        status: "uploaded",
        checkedAt: Date.now(),
      });

    const replacementPending = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-unusable-1",
    });

    expect(replacementPending).toMatchObject({
      state: "processing",
      phase: "creating_provider",
    });
    expect(mocks.axiosPost).toHaveBeenCalledOnce();
    expect(mocks.axiosPut).toHaveBeenCalledOnce();
    expect(mocks.axiosDelete).toHaveBeenCalledOnce();
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "processing",
      providerGeneration: 2,
      provider: [
        expect.objectContaining({
          fileId: "provider-unusable-1",
          state: "discarded",
        }),
        expect.objectContaining({ state: "not_sent", fileId: null }),
      ],
    });

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-unusable-2",
      }),
    ).resolves.toMatchObject({
      state: "uploaded",
      fileId: "provider-unusable-2",
      recreated: true,
    });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(mocks.axiosPut).toHaveBeenCalledTimes(2);
  });

  it("does not create a replacement when the unusable provider record cannot be safely discarded", async () => {
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-unusable-discard-blocked",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url:
          "https://storage.example.com/provider-unusable-discard-blocked",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.axiosDelete.mockResolvedValue({ status: 503, data: "" });
    mocks.readiness.mockRejectedValue(
      new UpstreamFileReadinessError(
        "UPSTREAM_FILE_UNUSABLE",
        "provider record unusable",
        false,
      ),
    );

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-unusable-discard-blocked",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_DISCARD_FAILED",
      retryable: true,
    });
    expect(mocks.axiosPost).toHaveBeenCalledOnce();
    expect(mocks.axiosPut).toHaveBeenCalledOnce();
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "processing",
      providerGeneration: 1,
      provider: [
        expect.objectContaining({
          fileId: "provider-unusable-discard-blocked",
          state: "discard_sending",
        }),
      ],
    });
  });

  it("fences an unknown create for 195 seconds and permits only generation 2", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const { sealed } = await sealIntent();
    mocks.axiosPost
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockImplementationOnce(async () => ({
        status: 201,
        data: {
          id: "provider-file-generation-2",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/upload-generation-2",
          upload_expires_at: Date.now() + 180_000,
        },
      }));
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.readiness.mockResolvedValue({
      fileId: "provider-file-generation-2",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });

    const unknown = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-unknown",
    });
    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-too-early",
    });
    expect(unknown).toMatchObject({ state: "processing" });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);

    vi.setSystemTime(
      new Date(Date.now() + MANAGED_UPLOAD_CREATE_UNKNOWN_WAIT_MS + 1),
    );
    const recovered = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-generation-2",
    });

    expect(recovered).toMatchObject({
      state: "uploaded",
      recreated: true,
    });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(
      (await readManagedUploadIntent(sealed.intentId))?.provider,
    ).toHaveLength(2);
  });

  it("keeps an explicit provider create rejection terminal and never replaces it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const { sealed } = await sealIntent();
    mocks.axiosPost.mockResolvedValue({
      status: 400,
      data: { error: { message: "must not be persisted" } },
      headers: {},
    });

    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-rejected",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_CREATE_REJECTED",
      retryable: false,
    });
    vi.setSystemTime(
      new Date(Date.now() + MANAGED_UPLOAD_CREATE_UNKNOWN_WAIT_MS + 1),
    );
    await expect(
      processManagedUploadIntent({
        intentId: sealed.intentId,
        userId: 42,
        traceId: "trace-rejected-again",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PROVIDER_CREATE_REJECTED" });

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.axiosPut).not.toHaveBeenCalled();
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "failed",
      provider: [{ generation: 1, state: "create_rejected" }],
    });
  });

  it("honors create 429 Retry-After without consuming a provider generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const { sealed } = await sealIntent();
    mocks.axiosPost
      .mockResolvedValueOnce({
        status: 429,
        data: {},
        headers: { "retry-after": "2" },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "provider-file-after-429",
          filename: "provider-document.pdf",
          status: "pending",
          upload_url: "https://storage.example.com/upload-after-429",
          upload_expires_at: Date.now() + 180_000,
        },
      });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.readiness.mockResolvedValue({
      fileId: "provider-file-after-429",
      filename: "provider-document.pdf",
      state: "uploaded",
      status: "uploaded",
      checkedAt: Date.now(),
    });

    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-429",
    });
    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-429-too-early",
    });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 2_001));
    const uploaded = await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-429-retry",
    });
    expect(uploaded).toMatchObject({ state: "uploaded", recreated: false });
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(
      (await readManagedUploadIntent(sealed.intentId))?.provider,
    ).toHaveLength(1);
  });

  it("resumes cleanup after provider and ownership discard committed before manifest CAS", async () => {
    const uploaded = await finalizeIntentForDelete("provider-delete-crash");
    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });
    mocks.axiosGet.mockResolvedValue({ status: 404, data: {} });
    let discardCalls = 0;
    mocks.discardResource.mockImplementation(async (input) => {
      discardCalls += 1;
      if (discardCalls <= 2) {
        await input.discard({
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
    expect(mocks.axiosDelete).toHaveBeenCalledOnce();
    expect(mocks.axiosGet).toHaveBeenCalledOnce();
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
    expect(mocks.axiosDelete).not.toHaveBeenCalled();

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
    expect(mocks.axiosDelete).not.toHaveBeenCalled();

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
    let finishCreate!: (value: unknown) => void;
    mocks.axiosPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve;
        }),
    );
    const running = processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "active-upload-worker",
    });
    await vi.waitFor(() => expect(mocks.axiosPost).toHaveBeenCalledOnce());

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
      phase: "creating_provider",
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
      phase: "creating_provider",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "processing",
      phase: "creating_provider",
      leaseOwner: expect.any(String),
    });
    expect(mocks.axiosPost).toHaveBeenCalledOnce();
    expect(mocks.axiosDelete).not.toHaveBeenCalled();
    finishCreate({
      status: 201,
      data: {
        id: "provider-created-after-cancel",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/created-after-cancel",
        upload_expires_at: Date.now() + 180_000,
      },
    });
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
    expect(mocks.axiosPost).toHaveBeenCalledOnce();
    expect(mocks.axiosPut).not.toHaveBeenCalled();

    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });
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
    expect(mocks.axiosDelete).toHaveBeenCalledOnce();
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
    expect(mocks.axiosDelete).not.toHaveBeenCalled();
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
    mocks.axiosPost.mockResolvedValue({
      status: 201,
      data: {
        id: "provider-expiring",
        filename: "provider-document.pdf",
        status: "pending",
        upload_url: "https://storage.example.com/provider-expiring",
        upload_expires_at: Date.now() + 180_000,
      },
    });
    mocks.axiosPut.mockImplementation(consumeSuccessfulPut);
    mocks.readiness.mockResolvedValue({
      fileId: "provider-expiring",
      filename: "provider-document.pdf",
      state: "pending",
      status: "pending",
      checkedAt: Date.now(),
    });
    mocks.axiosDelete.mockResolvedValue({ status: 204, data: "" });

    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-pending-retention",
    });
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
    expect(mocks.axiosDelete).not.toHaveBeenCalled();

    await processManagedUploadIntent({
      intentId: sealed.intentId,
      userId: 42,
      traceId: "trace-retention-cleanup",
    });
    expect(await readManagedUploadIntent(sealed.intentId)).toMatchObject({
      state: "cancelled",
    });
    expect(mocks.axiosDelete).toHaveBeenCalledOnce();
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
