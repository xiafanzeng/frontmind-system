import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import axios from "axios";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  discardUnboundUpstreamFile: vi.fn(),
  getDecryptedCredentialForKnowledgeBaseUploadReservation: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  recordUpstreamResource: vi.fn(),
}));
const retentionMocks = vi.hoisted(() => ({
  markUploadedFileRetention: vi.fn(async () => ({
    uploadedAt: new Date("2026-08-04T00:00:00Z"),
    contentExpiresAt: new Date("2026-09-03T00:00:00Z"),
    contentDeletedAt: null,
  })),
}));

vi.mock("./auth-service", async () => {
  const actual =
    await vi.importActual<typeof import("./auth-service")>("./auth-service");
  return {
    ...actual,
    discardUnboundUpstreamFile: authMocks.discardUnboundUpstreamFile,
    getDecryptedCredentialForKnowledgeBaseUploadReservation:
      authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation,
    getCredentialForUpstreamResource:
      authMocks.getCredentialForUpstreamResource,
    recordUpstreamResource: authMocks.recordUpstreamResource,
  };
});

vi.mock("./file-content-retention", async () => {
  const actual = await vi.importActual<
    typeof import("./file-content-retention")
  >("./file-content-retention");
  return {
    ...actual,
    markUploadedFileRetention: retentionMocks.markUploadedFileRetention,
  };
});

import manusProxy, {
  CAPTURED_UPLOAD_MAX_ATTEMPTS,
  CAPTURED_UPLOAD_METADATA_TIMEOUT_MS,
  CAPTURED_UPLOAD_PROVIDER_PUT_TIMEOUT_MS,
  MAX_EXTERNAL_DOWNLOAD_BYTES,
  assertManagedUploadRequestComplete,
  boundedFileDownloadTokenExpiry,
  isPrivateUpstreamCollectionRequest,
  isRetainedUpstreamTaskDeleteRequest,
  isPublicFilePayloadRequest,
  isPublicTaskPayloadRequest,
  publicUpstreamFilePayload,
  publicUpstreamPayload,
  publicUpstreamTaskPayload,
  readBoundedExternalDownload,
  runManagedUploadOperation,
  sanitizeFileBuffer,
  uploadCapturedStage,
} from "./manus-proxy";
import {
  readStoredPresalesFile,
  stagePresalesFileContent,
} from "./presales-file-store";
import { AuthServiceError } from "./auth-service";
import { preparedFileService } from "./prepared-file-service";
import {
  createManagedUploadTicket,
  openManagedUploadTicket,
} from "./managed-upload-ticket";
import { MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS } from "./managed-upload-provider";

beforeEach(() => {
  vi.spyOn(axios, "create").mockImplementation(((
    defaults: { headers?: Record<string, string> } = {},
  ) => ({
    get: async (
      url: string,
      options: { params?: Record<string, unknown>; headers?: object } = {},
    ) => {
      if (url.endsWith("/v2/file.detail")) {
        const fileId = String(options.params?.file_id ?? "");
        const response = await axios.get(
          `${url.slice(0, -"/v2/file.detail".length)}/v1/files/${encodeURIComponent(fileId)}`,
          {
            ...options,
            headers: { ...defaults.headers, ...options.headers },
          },
        );
        if (response.status < 200 || response.status >= 300) {
          return {
            ...response,
            data: {
              ok: false,
              error: { code: `HTTP_${response.status}` },
            },
          };
        }
        const data =
          response.data &&
          typeof response.data === "object" &&
          !Array.isArray(response.data)
            ? (response.data as Record<string, unknown>)
            : {};
        return {
          ...response,
          data: {
            ok: true,
            file: {
              id: data.id ?? fileId,
              filename: data.filename ?? "provider-document.pdf",
              status: data.status ?? "uploaded",
              bytes:
                data.bytes ??
                data.size ??
                data.size_bytes ??
                data.sizeBytes ??
                null,
              expires_at: 2_000_000_000,
              content_type:
                data.mime_type ?? data.content_type ?? "application/pdf",
            },
          },
        };
      }
      return axios.get(url, {
        ...options,
        headers: { ...defaults.headers, ...options.headers },
      });
    },
    post: async (
      url: string,
      body: Record<string, unknown>,
      options: { headers?: object } = {},
    ) => {
      if (url.endsWith("/v2/file.delete")) {
        const fileId = String(body.file_id ?? "");
        const response = await axios.delete(
          `${url.slice(0, -"/v2/file.delete".length)}/v1/files/${encodeURIComponent(fileId)}`,
          {
            ...options,
            headers: { ...defaults.headers, ...options.headers },
          },
        );
        return response.status === 404
          ? {
              ...response,
              data: { ok: false, error: { code: "NOT_FOUND" } },
            }
          : {
              ...response,
              data: { ok: true, file: { id: fileId } },
            };
      }
      return axios.post(url, body, {
        ...options,
        headers: { ...defaults.headers, ...options.headers },
      });
    },
  })) as typeof axios.create);
});

async function withManusProxyServer(
  run: (baseUrl: string) => Promise<void>,
  options: {
    authenticated?: boolean;
    userId?: number;
    projectAssignmentId?: string | null;
    activeCredentialId?: string;
    activeCredentialVersion?: number;
    activeCredential?: boolean;
  } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (options.authenticated) {
      const userId = options.userId ?? 42;
      req.frontmindUser = {
        id: userId,
        username: "capture-test-user",
        role: "user",
        isActive: true,
      };
      if (options.activeCredential !== false) {
        req.frontmindCredential = {
          id: options.activeCredentialId ?? "credential-capture-test",
          userId,
          version: options.activeCredentialVersion ?? 1,
          apiKey: "test-only-credential",
        };
      }
      if (options.projectAssignmentId) {
        req.frontmindDeliveryProjectContext = {
          projectAssignmentId: options.projectAssignmentId,
          customerUserId: userId,
          roleType: "ai_operations_engineer",
          customerName: "Capture Test Customer",
        };
      }
    }
    next();
  });
  app.use("/api/frontmind", manusProxy);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/frontmind`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(() => {
  authMocks.discardUnboundUpstreamFile.mockReset();
  authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockReset();
  authMocks.getCredentialForUpstreamResource.mockReset();
  authMocks.recordUpstreamResource.mockReset();
  retentionMocks.markUploadedFileRetention.mockClear();
  vi.restoreAllMocks();
});

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function rawProxyUpload(input: {
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      input.url,
      { method: "PUT", headers: input.headers },
      async (response) => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: (await readAll(response)).toString("utf8"),
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.once("error", reject);
    if (input.body) request.write(input.body);
    request.end();
  });
}

async function withCaptureAssetDirectory(
  run: (assetDirectory: string) => Promise<void>,
) {
  const previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  const assetDirectory = await mkdtemp(
    path.join(tmpdir(), "frontmind-proxy-capture-test-"),
  );
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
  try {
    await run(assetDirectory);
  } finally {
    if (previousAssetDirectory === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
    }
    await rm(assetDirectory, { recursive: true, force: true });
  }
}

const managedUploadMasterKey = `base64:${Buffer.alloc(32, 23).toString("base64")}`;

async function withManagedUploadKey(run: () => Promise<void>) {
  const previous = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = managedUploadMasterKey;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = previous;
    }
  }
}

function managedUploadTarget(label: string) {
  return `https://uploads.example.test/${encodeURIComponent(label)}?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180&X-Amz-Signature=test-only`;
}

function managedUploadTicket(input: {
  fileId: string;
  filename: string;
  target?: string;
  credentialId?: string;
}) {
  return createManagedUploadTicket({
    fileId: input.fileId,
    ownerUserId: 42,
    credentialId: input.credentialId ?? "credential-record-owner",
    projectAssignmentId: null,
    providerFilename: input.filename,
    target: input.target ?? managedUploadTarget(input.fileId),
    upstreamExpiresAt: Date.now() + 5 * 60_000,
  });
}

function boundUploadCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "credential-record-owner",
    apiKey: "bound-record-credential",
    resource: {
      projectAssignmentId: null,
      createdAt: new Date("2026-08-11T00:00:00Z"),
    },
    ...overrides,
  };
}

describe("isPrivateUpstreamCollectionRequest", () => {
  it.each([
    ["GET", "/v1/tasks"],
    ["HEAD", "/v1/tasks"],
    ["GET", "/v1/responses"],
    ["HEAD", "/v1/responses/"],
    ["GET", "/v1/files?limit=20"],
    ["HEAD", "/v1/files?after=file-1"],
  ])("blocks %s access to private collection %s", (method, targetPath) => {
    expect(isPrivateUpstreamCollectionRequest(method, targetPath)).toBe(true);
  });

  it.each([
    ["GET", "/v1/tasks/task-1"],
    ["HEAD", "/v1/responses/response-1"],
    ["GET", "/v1/files/file-1"],
    ["GET", "/v1/files/file-1/content"],
    ["POST", "/v1/tasks"],
    ["POST", "/v1/responses"],
    ["POST", "/v1/files"],
  ])("allows %s access to scoped endpoint %s", (method, targetPath) => {
    expect(isPrivateUpstreamCollectionRequest(method, targetPath)).toBe(false);
  });
});

describe("owned file download token expiry", () => {
  it("never outlives either five minutes or the source retention deadline", () => {
    const now = 10_000;
    expect(boundedFileDownloadTokenExpiry(now)).toBe(now + 5 * 60 * 1_000);
    expect(boundedFileDownloadTokenExpiry(now, now + 1_000)).toBe(now + 1_000);
  });
});

describe("stage-first intent capability cache policy", () => {
  it("marks create and recovery responses no-store without reflecting the mi1 ticket", async () => {
    await withCaptureAssetDirectory(async () => {
      await withManagedUploadKey(async () => {
        await withManusProxyServer(
          async (baseUrl) => {
            const created = await fetch(`${baseUrl}/v1/managed-uploads`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                operationId: "cache-policy-operation",
                batchId: "cache-policy-batch",
                ordinal: 1,
                total: 1,
                filename: "cache-policy.pdf",
                mimeType: "application/pdf",
                sizeBytes: 1,
              }),
            });
            expect(created.status).toBe(201);
            expect(created.headers.get("cache-control")).toBe(
              "private, no-store",
            );
            expect(created.headers.get("pragma")).toBe("no-cache");
            const payload = (await created.json()) as {
              intentId: string;
              intentTicket: string;
            };
            expect(payload.intentTicket).toMatch(/^mi1\./u);
            expect(
              JSON.stringify(Array.from(created.headers.entries())),
            ).not.toContain(payload.intentTicket);

            const recovery = await fetch(
              `${baseUrl}/v1/managed-uploads/recovery`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-FrontMind-Upload-Intent-Id": payload.intentId,
                },
                body: "{}",
              },
            );
            expect(recovery.status).toBe(403);
            expect(recovery.headers.get("cache-control")).toBe(
              "private, no-store",
            );
          },
          { authenticated: true },
        );
      });
    });
  });

  it("rediscovers the complete frozen reservation with fresh tickets on the pinned retired credential", async () => {
    const conversationId = "conversation-discovery";
    const turnId = "00000000-0000-4000-8000-000000000042";
    const clientRequestId = "client-discovery";
    const projectAssignmentId = "project-discovery";
    const attachmentManifest = [
      {
        itemId: "discovery-item-1",
        ordinal: 1,
        total: 2,
        filename: "discovery-one.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        lastModified: 1_700_000_000_001,
        sha256: "a".repeat(64),
      },
      {
        itemId: "discovery-item-2",
        ordinal: 2,
        total: 2,
        filename: "discovery-two.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2,
        lastModified: 1_700_000_000_002,
        sha256: "b".repeat(64),
      },
    ];
    const pinnedRetiredCredential = {
      id: "credential-frozen-retired",
      userId: 42,
      version: 7,
      apiKey: "test-only-retired-credential",
      fingerprint: "retired-fingerprint",
      status: "retired" as const,
      verifiedAt: null,
      reservation: {
        clientRequestId,
        sourceResetRevision: 9,
        attachmentManifest,
        stagedAttachmentCount: 1,
      },
    };
    authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
      pinnedRetiredCredential,
    );
    const now = Date.parse("2026-08-12T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    await withCaptureAssetDirectory(async () => {
      await withManagedUploadKey(async () => {
        const createdTickets: Array<{
          intentTicket: string;
          expiresAt: number;
        }> = [];
        await withManusProxyServer(
          async (baseUrl) => {
            const resumeScope = {
              kind: "knowledge_base",
              conversationId,
              turnId,
              clientRequestId,
              expectedResetRevision: 9,
            };
            for (const item of attachmentManifest) {
              const created = await fetch(`${baseUrl}/v1/managed-uploads`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  operationId: item.itemId,
                  batchId: clientRequestId,
                  ordinal: item.ordinal,
                  total: item.total,
                  filename: item.filename,
                  mimeType: item.mimeType,
                  sizeBytes: item.sizeBytes,
                  resumeScope,
                }),
              });
              expect(created.status).toBe(201);
              createdTickets.push(
                (await created.json()) as {
                  intentTicket: string;
                  expiresAt: number;
                },
              );
            }

            clock.mockReturnValue(now + 5_000);
            const discovered = await fetch(
              `${baseUrl}/v1/managed-uploads?conversationId=${conversationId}&turnId=${turnId}`,
            );
            expect(discovered.status).toBe(200);
            expect(discovered.headers.get("cache-control")).toBe(
              "private, no-store",
            );
            const payload = (await discovered.json()) as {
              uploads: any[];
              reservation: unknown;
            };
            expect(payload.reservation).toEqual({
              clientRequestId,
              sourceResetRevision: 9,
              attachmentManifest,
              stagedAttachmentCount: 1,
            });
            expect(payload.uploads).toHaveLength(2);
            expect(payload.uploads.map((upload) => upload.ordinal)).toEqual([
              1, 2,
            ]);
            for (const [index, upload] of payload.uploads.entries()) {
              expect(upload).toMatchObject({
                batchId: clientRequestId,
                ordinal: index + 1,
                total: 2,
                filename: attachmentManifest[index].filename,
                mimeType: "application/pdf",
                sizeBytes: attachmentManifest[index].sizeBytes,
                state: "awaiting_browser",
                clientRequestId,
                intentTicket: expect.stringMatching(/^mi1\./u),
                ticketExpiresAt: expect.any(Number),
              });
              expect(upload.intentTicket).not.toBe(
                createdTickets[index].intentTicket,
              );
              expect(upload.ticketExpiresAt).toBeGreaterThan(
                createdTickets[index].expiresAt,
              );
            }
            expect(
              authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation,
            ).toHaveBeenLastCalledWith({
              userId: 42,
              projectAssignmentId,
              conversationId,
              turnId,
            });
          },
          {
            authenticated: true,
            projectAssignmentId,
            // The account has no current credential. Creation is authorized
            // solely by the exact KB reservation's frozen retired credential.
            activeCredential: false,
          },
        );

        authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
          null,
        );
        await withManusProxyServer(
          async (baseUrl) => {
            const response = await fetch(
              `${baseUrl}/v1/managed-uploads?conversationId=${conversationId}&turnId=${turnId}`,
            );
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({
              error: { code: "UPLOAD_INTENT_FORBIDDEN" },
            });
          },
          { authenticated: true, userId: 99, projectAssignmentId },
        );
        expect(
          authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation,
        ).toHaveBeenLastCalledWith({
          userId: 99,
          projectAssignmentId,
          conversationId,
          turnId,
        });

        await withManusProxyServer(
          async (baseUrl) => {
            const response = await fetch(
              `${baseUrl}/v1/managed-uploads?conversationId=${conversationId}&turnId=${turnId}`,
            );
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({
              error: { code: "UPLOAD_INTENT_FORBIDDEN" },
            });
          },
          {
            authenticated: true,
            userId: 42,
            projectAssignmentId: "project-other",
          },
        );
        expect(
          authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation,
        ).toHaveBeenLastCalledWith({
          userId: 42,
          projectAssignmentId: "project-other",
          conversationId,
          turnId,
        });

        authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
          {
            ...pinnedRetiredCredential,
            id: "credential-drifted",
            version: 8,
            status: "active",
          },
        );
        await withManusProxyServer(
          async (baseUrl) => {
            const response = await fetch(
              `${baseUrl}/v1/managed-uploads?conversationId=${conversationId}&turnId=${turnId}`,
            );
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({
              error: { code: "UPLOAD_INTENT_FORBIDDEN" },
            });
          },
          { authenticated: true, userId: 42, projectAssignmentId },
        );
      });
    });
  });

  it("rejects every scoped upload tuple injection before allocating an intent or resume index", async () => {
    const conversationId = "conversation-frozen-post";
    const turnId = "00000000-0000-4000-8000-000000000043";
    const clientRequestId = "client-frozen-post";
    const projectAssignmentId = "project-frozen-post";
    const attachmentManifest = [
      {
        itemId: "frozen-batch:1",
        ordinal: 1,
        total: 2,
        filename: "frozen-one.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11,
        lastModified: 1_700_000_000_011,
        sha256: "c".repeat(64),
      },
      {
        itemId: "frozen-batch:2",
        ordinal: 2,
        total: 2,
        filename: "frozen-two.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        lastModified: 1_700_000_000_012,
        sha256: "d".repeat(64),
      },
    ];
    authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
      {
        id: "credential-frozen-post",
        userId: 42,
        version: 4,
        apiKey: "test-only-frozen-post",
        fingerprint: "frozen-post-fingerprint",
        status: "active" as const,
        verifiedAt: null,
        reservation: {
          clientRequestId,
          sourceResetRevision: 9,
          attachmentManifest,
          stagedAttachmentCount: 0,
        },
      },
    );
    const validRequest = {
      operationId: attachmentManifest[0].itemId,
      batchId: "frozen-batch",
      ordinal: 1,
      total: 2,
      filename: attachmentManifest[0].filename,
      mimeType: attachmentManifest[0].mimeType,
      sizeBytes: attachmentManifest[0].sizeBytes,
      resumeScope: {
        kind: "knowledge_base",
        conversationId,
        turnId,
        clientRequestId,
        expectedResetRevision: 9,
      },
    };
    const attacks: Array<[string, Record<string, unknown>]> = [
      ["extra ordinal", { operationId: "frozen-batch:3", ordinal: 3 }],
      ["wrong item", { operationId: attachmentManifest[1].itemId }],
      [
        "wrong client request",
        {
          resumeScope: {
            ...validRequest.resumeScope,
            clientRequestId: "client-attacker",
          },
        },
      ],
      ["wrong batch", { batchId: "batch-attacker" }],
      ["wrong ordinal", { ordinal: 2 }],
      ["wrong total", { total: 3 }],
      ["wrong filename", { filename: "attacker.pdf" }],
      ["wrong MIME", { mimeType: "application/zip" }],
      ["wrong size", { sizeBytes: 10 }],
    ];

    await withCaptureAssetDirectory(async (assetDirectory) => {
      await withManagedUploadKey(async () => {
        await withManusProxyServer(
          async (baseUrl) => {
            for (const [label, mutation] of attacks) {
              const response = await fetch(`${baseUrl}/v1/managed-uploads`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...validRequest, ...mutation }),
              });
              expect(response.status, label).toBe(409);
              expect(await response.json(), label).toMatchObject({
                error: { code: "UPLOAD_RESERVATION_MISMATCH" },
              });
            }

            const intentRoot = path.join(
              assetDirectory,
              "managed-upload-intents",
            );
            const entries = await readdir(intentRoot).catch(() => []);
            expect(entries).toEqual([]);
            expect(
              authMocks.getDecryptedCredentialForKnowledgeBaseUploadReservation,
            ).toHaveBeenCalledTimes(attacks.length);
          },
          { authenticated: true, projectAssignmentId },
        );
      });
    });
  });
});

describe("isRetainedUpstreamTaskDeleteRequest", () => {
  it.each([
    ["DELETE", "/v1/tasks/task-1"],
    ["delete", "/v1/responses/response-1?force=true"],
  ])("blocks %s %s", (method, targetPath) => {
    expect(isRetainedUpstreamTaskDeleteRequest(method, targetPath)).toBe(true);
  });

  it.each([
    ["GET", "/v1/tasks/task-1"],
    ["DELETE", "/v1/files/file-1"],
    ["DELETE", "/v1/tasks/task-1/content"],
  ])("does not block unrelated request %s %s", (method, targetPath) => {
    expect(isRetainedUpstreamTaskDeleteRequest(method, targetPath)).toBe(false);
  });
});

describe("publicUpstreamPayload", () => {
  it("rebrands alternate provider names in every visible payload string", () => {
    const sourceBrand = ["Jeno", "va"].join("");
    const result = publicUpstreamPayload(
      {
        title: `${sourceBrand} Brand Tracker`,
        output: [
          {
            type: "message",
            content: `正在验证独立 ${sourceBrand} 凭证`,
          },
        ],
      },
      "current-api-key",
    );

    expect(result).toMatchObject({
      title: "FrontMind Brand Tracker",
      output: [
        {
          type: "message",
          content: "正在验证独立 FrontMind 凭证",
        },
      ],
    });
    expect(JSON.stringify(result).toLowerCase()).not.toContain(
      sourceBrand.toLowerCase(),
    );
  });

  it("strips nested auth fields and exact current credentials", () => {
    const credential = "sentinel-proxy-credential-do-not-expose";
    const result = publicUpstreamPayload(
      {
        id: "task-safe",
        API_KEY: credential,
        output: [
          {
            type: "message",
            content: `safe prefix ${credential} suffix`,
            nested: {
              Authorization: `Bearer ${credential}`,
              Cookie: `session=${credential}`,
              accessToken: "another-token",
            },
          },
        ],
      },
      credential,
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      id: "task-safe",
      output: [
        {
          type: "message",
          content: "safe prefix [REDACTED] suffix",
          nested: {},
        },
      ],
    });
    expect(serialized).not.toContain(credential);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("sanitizes underscored codes and long text without a fail-open bypass", () => {
    const sourceBrand = ["MA", "NUS"].join("");
    const result = publicUpstreamPayload(
      {
        code: `${sourceBrand}_V2_TASK_ERROR`,
        message: `${"x".repeat(100_001)} ${sourceBrand}-v2 rejected`,
      },
      "current-api-key",
    );
    expect(JSON.stringify(result)).not.toMatch(new RegExp(sourceBrand, "iu"));
  });

  it("drops public URL capabilities and provider-branded keys recursively", () => {
    const sourceBrand = ["ma", "nus"].join("");
    const result = publicUpstreamPayload(
      {
        src: `https://open.${sourceBrand}.ai/task/1`,
        href: `https://${sourceBrand}.im/task/1`,
        download_url: `https://${sourceBrand}.im/download/1`,
        upload_url: `https://${sourceBrand}.im/upload/1`,
        [`${sourceBrand}_request_id`]: "private-request-id",
        [`${sourceBrand}.request`]: "private-dotted-key",
        [`prefix ${sourceBrand} label`]: "private-spaced-key",
        nested: {
          imageUrl: "https://provider.example/image/1",
          [`${sourceBrand}Status`]: "private-camel-key",
        },
      },
      "current-api-key",
    );
    expect(result).toEqual({ nested: {} });
    expect(JSON.stringify(result)).not.toMatch(new RegExp(sourceBrand, "iu"));
  });

  it("preserves every SigV4 query parameter only for a scoped file payload", () => {
    const signedUrl =
      "https://uploads.example.test/object.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Date=20260730T010203Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef0123456789";
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        filename: "Logo.png",
        upload_url: signedUrl,
        Authorization: "Bearer must-not-leak",
      },
      "current-api-key",
    ) as Record<string, unknown>;

    expect(result.upload_url).toBe(signedUrl);
    expect(result).not.toHaveProperty("Authorization");
    expect(isPublicFilePayloadRequest("POST", "/v1/files")).toBe(true);
    expect(isPublicFilePayloadRequest("GET", "/v1/files/file-safe")).toBe(true);
    expect(isPublicFilePayloadRequest("GET", "/v1/files")).toBe(false);
  });

  it("never restores a provider-branded upload capability", () => {
    const sourceBrand = ["ma", "nus"].join("");
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        filename: "Logo.png",
        upload_url: `https://uploads.${sourceBrand}.ai/private`,
      },
      "current-api-key",
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("upload_url");
    expect(JSON.stringify(result)).not.toMatch(new RegExp(sourceBrand, "iu"));
  });

  it("checks the canonical upload host before restoring an encoded capability", () => {
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        upload_url: "https://uploads.ma%6Eus.ai/private",
      },
      "current-api-key",
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("upload_url");
  });

  it("never restores an upload capability containing the active credential", () => {
    const credential = "api-secret-do-not-expose";
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        upload_url: `https://uploads.example.test/private?token=${encodeURIComponent(credential)}`,
      },
      credential,
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("upload_url");
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("never restores a non-TLS upload capability", () => {
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        filename: "Logo.png",
        upload_url: "http://uploads.example.test/private",
      },
      "current-api-key",
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("upload_url");
  });

  it("fails closed for arbitrary ZIP archives with uninspected text entries", async () => {
    const sourceBrand = ["Ma", "nus"].join("");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("SKILL.md", `# ${sourceBrand} internal package`);
    const archive = await zip.generateAsync({ type: "nodebuffer" });

    await expect(
      sanitizeFileBuffer(archive, "package.zip", "application/zip"),
    ).rejects.toMatchObject({ code: "PUBLIC_FILE_UNAVAILABLE" });
  });

  it("fails closed for an explicit ZIP with a self-extracting preamble", async () => {
    const sourceBrand = ["Ma", "nus"].join("");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("SKILL.md", `# ${sourceBrand} internal payload`);
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const selfExtractingArchive = Buffer.concat([
      Buffer.from("MZstub", "ascii"),
      archive,
    ]);

    await expect(
      sanitizeFileBuffer(
        selfExtractingArchive,
        "package.zip",
        "application/zip",
      ),
    ).rejects.toMatchObject({ code: "PUBLIC_FILE_UNAVAILABLE" });
  });

  it.each(["utf16le", "utf16be"] as const)(
    "sanitizes provider branding in %s Office XML without changing its encoding",
    async (encoding) => {
      const sourceBrand = ["Ma", "nus"].join("");
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const xml = `<?xml version="1.0" encoding="UTF-16"?><Types>${sourceBrand} internal</Types>`;
      const littleEndian = Buffer.from(xml, "utf16le");
      const encoded =
        encoding === "utf16le"
          ? Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian])
          : Buffer.concat([
              Buffer.from([0xfe, 0xff]),
              Buffer.from(littleEndian).swap16(),
            ]);
      zip.file("[Content_Types].xml", encoded);
      const archive = await zip.generateAsync({ type: "nodebuffer" });

      const result = await sanitizeFileBuffer(
        archive,
        "report.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(result.wasSanitized).toBe(true);

      const output = await JSZip.loadAsync(result.buffer);
      const outputBytes = await output
        .file("[Content_Types].xml")!
        .async("nodebuffer");
      expect(Array.from(outputBytes.subarray(0, 2))).toEqual(
        encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff],
      );
      const payload = outputBytes.subarray(2);
      const outputText =
        encoding === "utf16le"
          ? payload.toString("utf16le")
          : Buffer.from(payload).swap16().toString("utf16le");
      expect(outputText).toContain("FrontMind internal");
      expect(outputText).not.toMatch(new RegExp(sourceBrand, "iu"));
    },
  );
});

describe("proxy upload", () => {
  it("stops awaiting a hanging local operation when the shared deadline aborts", async () => {
    const controller = new AbortController();
    let finishOperation!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOperation = resolve;
        }),
    );
    const awaited = runManagedUploadOperation(controller.signal, operation);
    expect(operation).toHaveBeenCalledOnce();
    controller.abort(
      Object.assign(new Error("post-ingress deadline"), {
        code: "UPLOAD_POST_INGRESS_DEADLINE_EXCEEDED",
      }),
    );

    await expect(awaited).rejects.toMatchObject({
      code: "UPLOAD_POST_INGRESS_DEADLINE_EXCEEDED",
    });
    finishOperation();
    await Promise.resolve();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("already aborted"));
    const neverStarted = vi.fn(async () => undefined);
    await expect(
      runManagedUploadOperation(alreadyAborted.signal, neverStarted),
    ).rejects.toThrow("already aborted");
    expect(neverStarted).not.toHaveBeenCalled();
  });

  it("keeps the bounded provider recovery budget below the client completion watchdog", () => {
    const clientCompletionWatchdogMs = 6 * 60_000;
    const maximumProviderRecoveryMs =
      CAPTURED_UPLOAD_MAX_ATTEMPTS *
      (CAPTURED_UPLOAD_METADATA_TIMEOUT_MS +
        CAPTURED_UPLOAD_PROVIDER_PUT_TIMEOUT_MS);

    expect(CAPTURED_UPLOAD_MAX_ATTEMPTS).toBe(2);
    expect(CAPTURED_UPLOAD_PROVIDER_PUT_TIMEOUT_MS).toBe(120_000);
    expect(maximumProviderRecoveryMs).toBeLessThan(clientCompletionWatchdogMs);
    expect(MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS).toBeLessThanOrEqual(330_000);
    expect(MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS).toBeLessThan(
      clientCompletionWatchdogMs,
    );
  });

  it("forwards the complete signed URL and never exposes upstream XML errors", async () => {
    const signedUrl =
      "https://uploads.example.test/object.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 400,
      data: '<?xml version="1.0"?><Error><Code>AuthorizationQueryParametersError</Code></Error>',
    });

    await withManusProxyServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/proxy-upload?target=${encodeURIComponent(signedUrl)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Original-Content-Type": "image/png",
          },
          body: new Uint8Array([1, 2, 3]),
        },
      );
      const responseText = await response.text();

      expect(response.status).toBe(400);
      expect(responseText).toContain("上传地址无效或已失效");
      expect(responseText).not.toContain("AuthorizationQueryParametersError");
    });

    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({
        maxRedirects: 0,
        headers: expect.objectContaining({ "Content-Type": "image/png" }),
      }),
    );
  });

  describe("managed upload ticket and official provider schema", () => {
    it("uses a fixed allowlist for managed storage failures with hostile paths and identifiers", async () => {
      const fileId = "file-managed-storage-private";
      const filename = "private-storage-name.pdf";
      const apiKey = "test-only-credential";
      const filesystemPath =
        "/private/customer/file-managed-storage-private/private-storage-name.pdf";
      const error = Object.assign(
        new Error(`EACCES ${filesystemPath} ${fileId} ${filename} ${apiKey}`),
        { code: "EACCES", path: filesystemPath },
      );
      authMocks.getCredentialForUpstreamResource.mockRejectedValueOnce(error);
      const logs: unknown[][] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });

      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
            {
              method: "PUT",
              headers: {
                "X-Original-Content-Type": "application/pdf",
                "X-FrontMind-Capture-Filename-UTF8": filename,
                "X-FrontMind-Provider-Filename-UTF8": filename,
              },
              body: Buffer.from("unread managed body"),
            },
          );
          expect(response.status).toBe(507);
        },
        { authenticated: true },
      );

      const serialized = JSON.stringify(logs);
      expect(serialized).toContain("MANAGED_UPLOAD_RUNTIME_ERROR");
      for (const secret of [fileId, filename, apiKey, filesystemPath]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain("EACCES");
    });

    it("rejects missing, empty, and oversized managed lengths before metadata or upload", async () => {
      const fileId = "file-managed-length-preflight";
      const filename = "length.pdf";
      authMocks.getCredentialForUpstreamResource.mockResolvedValue(
        boundUploadCredential(),
      );
      const get = vi.spyOn(axios, "get");
      const put = vi.spyOn(axios, "put");

      await withManusProxyServer(
        async (baseUrl) => {
          const commonHeaders = {
            "Content-Type": "application/octet-stream",
            "X-Original-Content-Type": "application/pdf",
            "X-FrontMind-Capture-Filename-UTF8": filename,
            "X-FrontMind-Provider-Filename-UTF8": filename,
          };
          const cases = [
            {
              headers: {
                ...commonHeaders,
                "Transfer-Encoding": "chunked",
              },
              body: Buffer.from("chunked"),
              status: 411,
              code: "UPLOAD_LENGTH_REQUIRED",
            },
            {
              headers: { ...commonHeaders, "Content-Length": "0" },
              status: 400,
              code: "FILE_EMPTY",
            },
            {
              headers: {
                ...commonHeaders,
                "Content-Length": String(100 * 1024 * 1024 + 1),
              },
              status: 413,
              code: "FILE_TOO_LARGE",
            },
          ] as const;

          for (const testCase of cases) {
            const response = await rawProxyUpload({
              url: `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
              headers: testCase.headers,
              body: testCase.body,
            });
            expect(response.status).toBe(testCase.status);
            expect(JSON.parse(response.body)).toMatchObject({
              error: {
                code: testCase.code,
                fileId,
                traceId: expect.any(String),
              },
            });
          }
        },
        { authenticated: true },
      );

      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    it("returns the same safe busy contract for managed PUT and upload recovery without starting new work", async () => {
      await withCaptureAssetDirectory(async (assetDirectory) => {
        await withManagedUploadKey(async () => {
          const fileId = "file-managed-busy-contract";
          const filename = "busy-private-name.pdf";
          const source = Buffer.from("browser body held at provider preflight");
          const target = managedUploadTarget(fileId);
          const handle = managedUploadTicket({ fileId, filename, target });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          let resolvePreflight!: (value: {
            status: number;
            data: Record<string, unknown>;
          }) => void;
          const get = vi
            .spyOn(axios, "get")
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  resolvePreflight = resolve;
                }),
            )
            .mockResolvedValue({
              status: 200,
              data: { id: fileId, filename, status: "uploaded" },
            });
          const put = vi
            .spyOn(axios, "put")
            .mockImplementation(async (_target, body) => {
              await readAll(body as NodeJS.ReadableStream);
              return { status: 200, data: "" };
            });

          await withManusProxyServer(
            async (baseUrl) => {
              const activeUpload = fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              await vi.waitFor(() => {
                expect(resolvePreflight).toBeTypeOf("function");
              });

              const filesBeforeBusy = await readdir(
                path.join(assetDirectory, "presales-files"),
              ).catch(() => []);
              expect(filesBeforeBusy).toEqual([]);
              expect(get).toHaveBeenCalledOnce();
              expect(put).not.toHaveBeenCalled();
              expect(
                retentionMocks.markUploadedFileRetention,
              ).not.toHaveBeenCalled();

              // Deliberately omit a body, length, and ticket. The busy guard
              // must answer before request-body validation or upload work.
              const busyUpload = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                { method: "PUT" },
              );
              expect(busyUpload.status).toBe(409);
              expect(busyUpload.headers.get("retry-after")).toBe("3");
              const busyUploadBody = await busyUpload.json();
              expect(busyUploadBody).toEqual({
                error: {
                  message: "该文件仍在上传处理中，请稍后重试",
                  code: "UPLOAD_IN_PROGRESS",
                  retryable: true,
                  recoveryAction: "check_status",
                  fileId,
                  traceId: expect.any(String),
                  recreateRequired: false,
                  retryAfterMs: 3_000,
                },
              });

              const busyRecovery = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(busyRecovery.status).toBe(409);
              expect(busyRecovery.headers.get("retry-after")).toBe("3");
              const busyRecoveryBody = await busyRecovery.json();
              expect(busyRecoveryBody).toEqual({
                error: {
                  message: "该文件仍在上传处理中，请稍后重试",
                  code: "UPLOAD_IN_PROGRESS",
                  retryable: true,
                  recoveryAction: "check_status",
                  fileId,
                  traceId: expect.any(String),
                  recreateRequired: false,
                  retryAfterMs: 3_000,
                },
              });

              for (const responseBody of [busyUploadBody, busyRecoveryBody]) {
                const serialized = JSON.stringify(responseBody);
                expect(serialized).not.toContain(filename);
                expect(serialized).not.toContain(handle.ticket);
                expect(serialized).not.toContain(target);
                expect(serialized).not.toContain("test-only-credential");
                expect(serialized).not.toContain("bound-record-credential");
              }
              expect(get).toHaveBeenCalledOnce();
              expect(put).not.toHaveBeenCalled();
              expect(
                retentionMocks.markUploadedFileRetention,
              ).not.toHaveBeenCalled();
              expect(
                await readdir(
                  path.join(assetDirectory, "presales-files"),
                ).catch(() => []),
              ).toEqual([]);

              resolvePreflight({
                status: 200,
                data: { id: fileId, filename, status: "uploaded" },
              });
              expect((await activeUpload).status).toBe(409);
            },
            { authenticated: true },
          );
        });
      });
    });

    it("fails closed when the HTTP parser did not complete the managed request", () => {
      expect(() =>
        assertManagedUploadRequestComplete({ complete: false }),
      ).toThrowError(
        expect.objectContaining({ code: "UPLOAD_CONTENT_LENGTH_MISMATCH" }),
      );
      expect(() =>
        assertManagedUploadRequestComplete({ complete: true }),
      ).not.toThrow();
    });

    it("cancels and cleans a truncated browser body before allowing the same fileId again", async () => {
      await withCaptureAssetDirectory(async (assetDirectory) => {
        await withManagedUploadKey(async () => {
          const fileId = "file-truncated-browser-body";
          const filename = "truncated.pdf";
          const source = Buffer.from("complete body after reconnect");
          const handle = managedUploadTicket({ fileId, filename });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          const get = vi
            .spyOn(axios, "get")
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValue({
              status: 200,
              data: { id: fileId, filename, status: "uploaded" },
            });
          vi.spyOn(axios, "put").mockImplementation(async (_target, body) => {
            await readAll(body as NodeJS.ReadableStream);
            return { status: 200, data: "" };
          });

          await withManusProxyServer(
            async (baseUrl) => {
              await new Promise<void>((resolve) => {
                const request = httpRequest(
                  `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/octet-stream",
                      "Content-Length": String(source.length + 10),
                      "X-Original-Content-Type": "application/pdf",
                      "X-FrontMind-Capture-Filename-UTF8": filename,
                      "X-FrontMind-Provider-Filename-UTF8": filename,
                      "X-FrontMind-Upload-Ticket": handle.ticket,
                    },
                  },
                );
                request.once("error", () => resolve());
                request.write(source.subarray(0, 8));
                setTimeout(() => request.destroy(), 30).unref?.();
              });

              await vi.waitFor(async () => {
                const entries = await readdir(
                  path.join(assetDirectory, "presales-files"),
                ).catch(() => []);
                expect(
                  entries.some((name) => name.endsWith(".upload.tmp")),
                ).toBe(false);
              });
              expect(await readStoredPresalesFile(fileId)).toBeNull();

              const retry = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              expect(retry.status).toBe(200);
            },
            { authenticated: true },
          );
          expect(get).toHaveBeenCalled();
        });
      });
    });

    it("rejects legacy blind file creation without contacting the Provider", async () => {
      await withManagedUploadKey(async () => {
        const fileId = "file-create-managed-handle";
        const providerFilename = "Manus 品牌资料.pdf";
        const target = managedUploadTarget(fileId);
        authMocks.recordUpstreamResource.mockResolvedValue(undefined);
        vi.spyOn(axios, "request").mockResolvedValue({
          status: 200,
          data: {
            id: fileId,
            filename: providerFilename,
            status: "pending",
            upload_url: target,
            upload_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
          headers: { "content-type": "application/json" },
        });

        await withManusProxyServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/v1/files`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename: providerFilename }),
            });
            expect(response.status).toBe(410);
            const payload = await response.json();
            expect(payload).toMatchObject({
              error: {
                code: "LEGACY_MANUS_V1_REMOVED",
                resetRequired: true,
              },
            });
            expect(axios.request).not.toHaveBeenCalled();
          },
          { authenticated: true },
        );
      });
    });

    it("accepts provider-authoritative filename changes after official pending metadata", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-opaque-managed";
          const filename = "Manus 企业原始资料.pdf";
          const providerCanonicalFilename = "provider-canonical-name.pdf";
          const publicFilename = "FrontMind 企业原始资料.pdf";
          const source = Buffer.from("one browser body, staged and replayed");
          const target = managedUploadTarget("opaque-managed");
          const handle = managedUploadTicket({ fileId, filename, target });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          const get = vi
            .spyOn(axios, "get")
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValueOnce({
              status: 200,
              data: {
                id: fileId,
                filename: providerCanonicalFilename,
                status: "pending",
              },
            })
            .mockResolvedValue({
              status: 200,
              data: {
                id: fileId,
                filename: providerCanonicalFilename,
                status: "uploaded",
              },
            });
          let replayed = Buffer.alloc(0);
          const put = vi
            .spyOn(axios, "put")
            .mockImplementation(async (_target, body) => {
              replayed = await readAll(body as NodeJS.ReadableStream);
              return { status: 200, data: "" };
            });

          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${encodeURIComponent(fileId)}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8":
                      encodeURIComponent(filename),
                    "X-FrontMind-Provider-Filename-UTF8":
                      encodeURIComponent(publicFilename),
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              expect(response.status).toBe(200);
              expect(await response.json()).toMatchObject({
                state: "uploaded",
                fileId,
                sizeBytes: source.length,
                providerReadyAt: expect.any(Number),
                replayed: true,
                recovered: false,
              });
            },
            { authenticated: true },
          );

          expect(get).toHaveBeenCalledTimes(3);
          expect(
            get.mock.calls.every(
              ([, config]) =>
                (
                  config as {
                    headers?: { "x-manus-api-key"?: string };
                  }
                ).headers?.["x-manus-api-key"] === "bound-record-credential",
            ),
          ).toBe(true);
          expect(
            get.mock.calls.every(
              ([, config]) =>
                !(config as { headers?: Record<string, string> }).headers
                  ?.Authorization,
            ),
          ).toBe(true);
          expect(put).toHaveBeenCalledOnce();
          expect(replayed).toEqual(source);
          expect((await readStoredPresalesFile(fileId))?.sizeBytes).toBe(
            source.length,
          );
        });
      });
    });

    it("recovers without another PUT when processing canonicalizes the provider filename", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-provider-processing";
          const filename = "processing.pdf";
          const source = Buffer.from("browser body is sent exactly once");
          const handle = managedUploadTicket({ fileId, filename });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          let providerStatus: "pending" | "uploaded" | "deleted" = "pending";
          let providerMetadataId = fileId;
          let providerMetadataFilename = filename;
          let metadataHttpStatus = 200;
          const get = vi.spyOn(axios, "get").mockImplementation(async () => ({
            status: metadataHttpStatus,
            data: {
              id: providerMetadataId,
              filename: providerMetadataFilename,
              status: providerStatus,
            },
          }));
          const put = vi
            .spyOn(axios, "put")
            .mockImplementation(async (_target, body) => {
              expect(await readAll(body as NodeJS.ReadableStream)).toEqual(
                source,
              );
              return { status: 200, data: "" };
            });

          await withManusProxyServer(
            async (baseUrl) => {
              const uploaded = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              expect(uploaded.status).toBe(202);
              expect(await uploaded.json()).toMatchObject({
                state: "processing",
                fileId,
                sizeBytes: source.length,
                uploadedAt: expect.any(Number),
                expiresAt: expect.any(Number),
                retryAfterMs: 3_000,
                traceId: expect.any(String),
              });
              expect(put).toHaveBeenCalledOnce();

              metadataHttpStatus = 503;
              const temporarilyUnavailable = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(temporarilyUnavailable.status).toBe(202);
              expect(await temporarilyUnavailable.json()).toMatchObject({
                state: "processing",
                fileId,
              });
              metadataHttpStatus = 200;

              const stillPending = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(stillPending.status).toBe(202);
              expect(await stillPending.json()).toMatchObject({
                state: "processing",
                fileId,
                retryAfterMs: 3_000,
              });
              expect(put).toHaveBeenCalledOnce();

              providerStatus = "uploaded";
              providerMetadataFilename = "provider-canonical-processing.pdf";
              vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
              expect(handle.expiresAt).toBeLessThan(Date.now());
              const ready = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(ready.status).toBe(200);
              expect(await ready.json()).toMatchObject({
                state: "uploaded",
                fileId,
                providerReadyAt: expect.any(Number),
                recovered: true,
              });
              expect(put).toHaveBeenCalledOnce();
              expect(
                authMocks.discardUnboundUpstreamFile,
              ).not.toHaveBeenCalled();
              expect(authMocks.recordUpstreamResource).not.toHaveBeenCalled();

              providerStatus = "deleted";
              const unusable = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(unusable.status).toBe(409);
              expect(await unusable.json()).toMatchObject({
                error: {
                  code: "UPLOAD_PROVIDER_RECORD_UNUSABLE",
                  recoveryAction: "discard_and_recreate",
                },
              });

              providerStatus = "uploaded";
              providerMetadataId = "different-provider-file";
              const mismatchedIdentity = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(mismatchedIdentity.status).toBe(409);
              expect(await mismatchedIdentity.json()).toMatchObject({
                error: {
                  code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
                  recoveryAction: "contact_admin",
                },
              });
            },
            { authenticated: true },
          );
          expect(get.mock.calls.length).toBeGreaterThanOrEqual(5);
        });
      });
    });

    it("never starts a provider PUT when official preflight already says uploaded", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-provider-already-uploaded";
          const filename = "already.pdf";
          const handle = managedUploadTicket({ fileId, filename });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          vi.spyOn(axios, "get").mockResolvedValue({
            status: 200,
            data: { id: fileId, filename, status: "uploaded" },
          });
          const stagedReplay = vi.spyOn(axios, "put");
          const nativePut = vi.spyOn(https, "request");

          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: Buffer.from("must not reach provider"),
                },
              );
              expect(response.status).toBe(409);
              expect(await response.json()).toMatchObject({
                error: {
                  code: "UPLOAD_RECOVERY_REQUIRED",
                  recoveryAction: "check_status",
                  fileId,
                  recreateRequired: false,
                },
              });
            },
            { authenticated: true },
          );
          expect(nativePut).not.toHaveBeenCalled();
          expect(stagedReplay).not.toHaveBeenCalled();
        });
      });
    });

    it("fails closed when v2 metadata cannot prove the uploaded byte count", async () => {
      await withCaptureAssetDirectory(async () => {
        const fileId = "file-content-proof";
        const filename = "proof.pdf";
        const source = Buffer.from("provider content proof bytes");
        const staged = await stagePresalesFileContent({
          fileId,
          stream: Readable.from([source]),
          maxBytes: 1_024,
        });
        const get = vi
          .spyOn(axios, "get")
          .mockResolvedValueOnce({
            status: 200,
            data: { id: fileId, filename, status: "uploaded" },
          })
          .mockResolvedValueOnce({
            status: 200,
            data: Readable.from([source]),
          });

        await expect(
          uploadCapturedStage({
            baseUrl: "https://api.example.test",
            apiKey: "bound-key",
            fileId,
            providerFilename: filename,
            mimeType: "application/pdf",
            target: managedUploadTarget(fileId),
            ticketExpiresAt: Date.now() + 120_000,
            staged,
            initialProvider: {
              status: 200,
              errorCode: null,
              providerPutMs: 1,
              bytesForwarded: 0,
              requestBodyComplete: false,
              requestCreatedAtOffsetMs: 0,
              providerStartedAtOffsetMs: 1,
            },
            requestStartedAt: Date.now(),
            signal: new AbortController().signal,
            traceId: "trace-content-proof",
            ingressMs: 1,
          }),
        ).rejects.toMatchObject({
          code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
          recoveryAction: "discard_and_recreate",
        });
        expect(get).toHaveBeenCalledTimes(2);
        await staged.discard();
      });
    });

    it("fails closed when streamed provider content does not match the staged body", async () => {
      await withCaptureAssetDirectory(async () => {
        const fileId = "file-content-proof-mismatch";
        const filename = "proof.pdf";
        const staged = await stagePresalesFileContent({
          fileId,
          stream: Readable.from(["expected bytes"]),
          maxBytes: 1_024,
        });
        vi.spyOn(axios, "get")
          .mockResolvedValueOnce({
            status: 200,
            data: { id: fileId, filename, status: "uploaded" },
          })
          .mockResolvedValueOnce({
            status: 200,
            data: Readable.from(["different bytes"]),
          });

        await expect(
          uploadCapturedStage({
            baseUrl: "https://api.example.test",
            apiKey: "bound-key",
            fileId,
            providerFilename: filename,
            mimeType: "application/pdf",
            target: managedUploadTarget(fileId),
            ticketExpiresAt: Date.now() + 120_000,
            staged,
            initialProvider: {
              status: 200,
              errorCode: null,
              providerPutMs: 1,
              bytesForwarded: 0,
              requestBodyComplete: false,
              requestCreatedAtOffsetMs: 0,
              providerStartedAtOffsetMs: 1,
            },
            requestStartedAt: Date.now(),
            signal: new AbortController().signal,
            traceId: "trace-content-mismatch",
            ingressMs: 1,
          }),
        ).rejects.toMatchObject({
          code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
          recoveryAction: "discard_and_recreate",
        });
        await staged.discard();
      });
    });

    it("maps no-body recovery to discard/recreate for pending or unverified uploaded state", async () => {
      await withManagedUploadKey(async () => {
        for (const [status, code] of [
          ["pending", "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED"],
          ["uploaded", "UPLOAD_RECOVERY_UNVERIFIED"],
        ] as const) {
          const fileId = `file-recovery-${status}`;
          const filename = `${status}.pdf`;
          authMocks.getCredentialForUpstreamResource.mockResolvedValueOnce(
            boundUploadCredential(),
          );
          const get = vi.spyOn(axios, "get").mockResolvedValueOnce({
            status: 200,
            data: { id: fileId, filename, status },
          });
          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: 12,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(response.status).toBe(409);
              expect(await response.json()).toMatchObject({
                error: {
                  code,
                  recoveryAction: "discard_and_recreate",
                  fileId,
                  recreateRequired: true,
                },
              });
            },
            { authenticated: true },
          );
          get.mockRestore();
        }
      });
    });

    it("recovers a first retention-registration failure from the immutable local receipt", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-retention-recovery";
          const filename = "retention raw.pdf";
          const captureFilename = "kb-normalized-retention.pdf";
          const source = Buffer.from("retained browser body");
          const handle = managedUploadTicket({ fileId, filename });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          vi.spyOn(axios, "get")
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValueOnce({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            })
            .mockResolvedValue({
              status: 200,
              data: { id: fileId, filename, status: "uploaded" },
            });
          vi.spyOn(axios, "put").mockImplementation(async (_target, body) => {
            await readAll(body as NodeJS.ReadableStream);
            return { status: 200, data: "" };
          });
          retentionMocks.markUploadedFileRetention
            .mockRejectedValueOnce(new Error("db temporarily unavailable"))
            .mockResolvedValue({
              uploadedAt: new Date("2026-08-11T01:00:00Z"),
              contentExpiresAt: new Date("2026-09-10T01:00:00Z"),
              contentDeletedAt: null,
            });

          await withManusProxyServer(
            async (baseUrl) => {
              const uploaded = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": captureFilename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              expect(uploaded.status).toBe(503);
              expect(await uploaded.json()).toMatchObject({
                error: { code: "FILE_RETENTION_MARK_FAILED" },
              });

              const recovered = await fetch(
                `${baseUrl}/v1/files/${fileId}/upload-recovery`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    filename,
                    sizeBytes: source.length,
                    mimeType: "application/pdf",
                  }),
                },
              );
              expect(recovered.status).toBe(200);
              expect(await recovered.json()).toMatchObject({
                fileId,
                state: "uploaded",
                sizeBytes: source.length,
                uploadedAt: Date.parse("2026-08-11T01:00:00Z"),
                providerReadyAt: expect.any(Number),
                expiresAt: Date.parse("2026-09-10T01:00:00Z"),
                recovered: true,
              });
            },
            { authenticated: true },
          );
          expect(
            retentionMocks.markUploadedFileRetention,
          ).toHaveBeenCalledTimes(2);
          expect((await readStoredPresalesFile(fileId))?.filename).toBe(
            captureFilename,
          );
        });
      });
    });

    it("drops hostile Drizzle params from managed retention failure logs", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-managed-drizzle-private";
          const filename = "private-drizzle-name.pdf";
          const apiKey = "private-bound-api-key";
          const filesystemPath =
            "/private/customer/file-managed-drizzle-private/private-drizzle-name.pdf";
          const source = Buffer.from("browser body retained before DB failure");
          const handle = managedUploadTicket({ fileId, filename });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential({ apiKey }),
          );
          vi.spyOn(axios, "get").mockResolvedValue({
            status: 200,
            data: { id: fileId, filename, status: "pending" },
          });
          vi.spyOn(axios, "put").mockImplementation(async (_target, body) => {
            await readAll(body as NodeJS.ReadableStream);
            return { status: 200, data: "" };
          });
          retentionMocks.markUploadedFileRetention.mockRejectedValueOnce(
            new DrizzleQueryError(
              "UPDATE upstream_resources SET uploaded_at = ? WHERE upstream_id = ?",
              [filesystemPath, fileId, filename, apiKey],
              Object.assign(
                new Error(
                  `database failure ${filesystemPath} ${fileId} ${filename} ${apiKey}`,
                ),
                { code: "ER_QUERY_INTERRUPTED", path: filesystemPath },
              ),
            ),
          );
          const logs: unknown[][] = [];
          vi.spyOn(console, "error").mockImplementation(
            (...args: unknown[]) => {
              logs.push(args);
            },
          );

          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );
              expect(response.status).toBe(503);
              expect(await response.json()).toMatchObject({
                error: { code: "FILE_RETENTION_MARK_FAILED", fileId },
              });
            },
            { authenticated: true },
          );

          const serialized = JSON.stringify(logs);
          expect(serialized).toContain("MANAGED_UPLOAD_RUNTIME_ERROR");
          for (const secret of [
            fileId,
            filename,
            apiKey,
            filesystemPath,
            "ER_QUERY_INTERRUPTED",
          ]) {
            expect(serialized).not.toContain(secret);
          }
          expect(serialized).not.toContain("UPDATE upstream_resources");
        });
      });
    });

    it("returns a structured storage recovery error when local commit fails after provider success", async () => {
      await withCaptureAssetDirectory(async (assetDirectory) => {
        await withManagedUploadKey(async () => {
          const fileId = "file-local-commit-failure";
          const filename = "commit.pdf";
          const source = Buffer.from("provider accepted, local commit fails");
          const handle = managedUploadTicket({ fileId, filename });
          const conflictingContentPath = path.join(
            assetDirectory,
            "presales-files",
            `${createHash("sha256").update(fileId).digest("hex")}.content`,
          );
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential(),
          );
          vi.spyOn(axios, "get").mockResolvedValue({
            status: 200,
            data: { id: fileId, filename, status: "pending" },
          });
          vi.spyOn(axios, "put").mockImplementation(async (_target, body) => {
            await readAll(body as NodeJS.ReadableStream);
            await mkdir(conflictingContentPath, { recursive: true });
            return { status: 200, data: "" };
          });

          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: source,
                },
              );

              expect(response.status).toBe(507);
              expect(await response.json()).toMatchObject({
                error: {
                  code: "UPLOAD_STORAGE_UNAVAILABLE",
                  retryable: true,
                  recoveryAction: "check_status",
                  fileId,
                  traceId: expect.any(String),
                  recreateRequired: false,
                },
              });
            },
            { authenticated: true },
          );
          expect(retentionMocks.markUploadedFileRetention).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 42, fileId }),
          );
          expect(
            (await readdir(path.dirname(conflictingContentPath))).some((name) =>
              name.endsWith(".upload.tmp"),
            ),
          ).toBe(false);
          await rm(conflictingContentPath, { recursive: true, force: true });
          expect(await readStoredPresalesFile(fileId)).toBeNull();
        });
      });
    });

    it("never logs or returns managed tickets, signed targets, credentials, provider XML, or filenames", async () => {
      await withCaptureAssetDirectory(async () => {
        await withManagedUploadKey(async () => {
          const fileId = "file-managed-redaction";
          const filename = "sentinel-private-filename.pdf";
          const apiKey = "sentinel-bound-api-key";
          const signature = "sentinel-private-signature";
          const providerXml =
            "<Error><Message>sentinel-provider-private-xml</Message></Error>";
          const target = `https://uploads.example.test/redaction?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180&X-Amz-Signature=${signature}`;
          const handle = managedUploadTicket({ fileId, filename, target });
          authMocks.getCredentialForUpstreamResource.mockResolvedValue(
            boundUploadCredential({ apiKey }),
          );
          vi.spyOn(axios, "get").mockResolvedValue({
            status: 200,
            data: { id: fileId, filename, status: "pending" },
          });
          vi.spyOn(axios, "put").mockResolvedValue({
            status: 403,
            data: providerXml,
          });
          const logs: unknown[][] = [];
          for (const method of ["log", "info", "warn", "error"] as const) {
            vi.spyOn(console, method).mockImplementation(
              (...args: unknown[]) => {
                logs.push(args);
              },
            );
          }

          let responseBody = "";
          await withManusProxyServer(
            async (baseUrl) => {
              const response = await fetch(
                `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
                {
                  method: "PUT",
                  headers: {
                    "X-Original-Content-Type": "application/pdf",
                    "X-FrontMind-Capture-Filename-UTF8": filename,
                    "X-FrontMind-Provider-Filename-UTF8": filename,
                    "X-FrontMind-Upload-Ticket": handle.ticket,
                  },
                  body: Buffer.from("redaction body"),
                },
              );
              expect(response.status).toBe(502);
              responseBody = await response.text();
              expect(JSON.parse(responseBody)).toMatchObject({
                error: {
                  code: "UPSTREAM_UPLOAD_REJECTED",
                  fileId,
                  traceId: expect.any(String),
                },
              });
            },
            { authenticated: true },
          );

          const observable = `${JSON.stringify(logs)}\n${responseBody}`;
          for (const secret of [
            handle.ticket,
            target,
            signature,
            apiKey,
            providerXml,
            "sentinel-provider-private-xml",
            filename,
          ]) {
            expect(observable).not.toContain(secret);
          }
        });
      });
    });
  });
});

describe("discard unbound upload", () => {
  it("drops hostile Drizzle params from discard failure logs", async () => {
    const fileId = "file-discard-private";
    const apiKey = "test-only-credential";
    const filesystemPath = "/private/customer/file-discard-private.pdf";
    authMocks.discardUnboundUpstreamFile.mockRejectedValueOnce(
      new DrizzleQueryError(
        "SELECT * FROM upstream_resources WHERE upstream_id = ?",
        [fileId, apiKey, filesystemPath],
        Object.assign(
          new Error(`discard failure ${fileId} ${apiKey} ${filesystemPath}`),
          { code: "ER_QUERY_INTERRUPTED", path: filesystemPath },
        ),
      ),
    );
    const logs: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });

    await withManusProxyServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/files/${fileId}/discard`, {
          method: "DELETE",
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "UPLOAD_DISCARD_FAILED", traceId: expect.any(String) },
        });
      },
      { authenticated: true },
    );

    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("MANAGED_UPLOAD_RUNTIME_ERROR");
    for (const secret of [
      fileId,
      apiKey,
      filesystemPath,
      "ER_QUERY_INTERRUPTED",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("SELECT * FROM upstream_resources");
  });

  it("uses the bound credential and removes provider, local, prepared, and ownership state", async () => {
    await withCaptureAssetDirectory(async () => {
      const fileId = "file-unbound-discard";
      const bytes = Buffer.from("unbound local copy");
      const staged = await stagePresalesFileContent({
        fileId,
        stream: Readable.from([bytes]),
        maxBytes: 1_024,
      });
      await staged.commit({
        filename: "unused.pdf",
        mimeType: "application/pdf",
        uploadedAt: new Date("2026-08-11T00:00:00Z"),
        contentExpiresAt: new Date("2026-09-10T00:00:00Z"),
      });
      authMocks.discardUnboundUpstreamFile.mockImplementation(
        async (input: {
          discard: (context: Record<string, unknown>) => Promise<void>;
        }) => {
          await input.discard({
            fileId,
            userId: 42,
            projectAssignmentId: null,
            apiCredentialId: "credential-before-rotation",
            apiKey: "bound-key-before-rotation",
          });
          return { discarded: true };
        },
      );
      const removeProvider = vi.spyOn(axios, "delete").mockResolvedValue({
        status: 204,
        data: "",
      });
      const removePrepared = vi
        .spyOn(preparedFileService, "deleteByOwnedFileSource")
        .mockResolvedValue(1);

      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/discard`,
            { method: "DELETE" },
          );
          expect(response.status).toBe(204);
          expect(await response.text()).toBe("");
        },
        { authenticated: true },
      );

      expect(removeProvider).toHaveBeenCalledWith(
        expect.stringMatching(`/v1/files/${fileId}$`),
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            "x-manus-api-key": "bound-key-before-rotation",
          },
        }),
      );
      expect(removePrepared).toHaveBeenCalledWith({
        ownerUserId: 42,
        fileId,
        projectAssignmentId: null,
      });
      expect(await readStoredPresalesFile(fileId)).toBeNull();
    });
  });

  it("returns 409 without cleanup when the transactional reference check finds a binding", async () => {
    const fileId = "file-already-bound";
    authMocks.discardUnboundUpstreamFile.mockRejectedValue(
      new AuthServiceError(
        "CONFLICT",
        "UPLOAD_ALREADY_BOUND: live turn reference",
      ),
    );
    const removeProvider = vi.spyOn(axios, "delete");

    await withManusProxyServer(
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/discard`,
          { method: "DELETE" },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: {
            code: "UPLOAD_ALREADY_BOUND",
            retryable: false,
            traceId: expect.any(String),
          },
        });
      },
      { authenticated: true },
    );

    expect(removeProvider).not.toHaveBeenCalled();
  });

  it("keeps local and ownership state recoverable when provider deletion fails", async () => {
    await withCaptureAssetDirectory(async () => {
      const fileId = "file-discard-provider-failure";
      const staged = await stagePresalesFileContent({
        fileId,
        stream: Readable.from(["keep me"]),
        maxBytes: 1_024,
      });
      await staged.commit({
        filename: "keep.pdf",
        mimeType: "application/pdf",
        uploadedAt: new Date("2026-08-11T00:00:00Z"),
        contentExpiresAt: new Date("2026-09-10T00:00:00Z"),
      });
      authMocks.discardUnboundUpstreamFile.mockImplementation(
        async (input: {
          discard: (context: Record<string, unknown>) => Promise<void>;
        }) => {
          await input.discard({
            fileId,
            userId: 42,
            projectAssignmentId: null,
            apiCredentialId: "credential-record-owner",
            apiKey: "bound-record-credential",
          });
          return { discarded: true };
        },
      );
      vi.spyOn(axios, "delete").mockResolvedValue({
        status: 503,
        data: "unavailable",
      });
      const removePrepared = vi.spyOn(
        preparedFileService,
        "deleteByOwnedFileSource",
      );

      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/discard`,
            { method: "DELETE" },
          );
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({
            error: { code: "UPLOAD_DISCARD_FAILED", retryable: true },
          });
        },
        { authenticated: true },
      );

      expect(removePrepared).not.toHaveBeenCalled();
      expect(await readStoredPresalesFile(fileId)).not.toBeNull();
    });
  });

  it("refuses discard while the same managed fileId is active", async () => {
    await withCaptureAssetDirectory(async () => {
      await withManagedUploadKey(async () => {
        const fileId = "file-active-upload-discard-race";
        const filename = "active.pdf";
        const bytes = Buffer.from("active captured bytes");
        const handle = managedUploadTicket({ fileId, filename });
        authMocks.getCredentialForUpstreamResource.mockResolvedValue(
          boundUploadCredential(),
        );
        let resolvePreflight!: (value: {
          status: number;
          data: Record<string, unknown>;
        }) => void;
        vi.spyOn(axios, "get")
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePreflight = resolve;
              }),
          )
          .mockResolvedValueOnce({
            status: 200,
            data: { id: fileId, filename, status: "pending" },
          })
          .mockResolvedValue({
            status: 200,
            data: { id: fileId, filename, status: "uploaded" },
          });
        vi.spyOn(axios, "put").mockImplementation(async (_target, body) => {
          await readAll(body as NodeJS.ReadableStream);
          return { status: 200, data: "" };
        });

        await withManusProxyServer(
          async (baseUrl) => {
            const uploadPromise = fetch(
              `${baseUrl}/proxy-upload?capture_file_id=${fileId}`,
              {
                method: "PUT",
                headers: {
                  "X-Original-Content-Type": "application/pdf",
                  "X-FrontMind-Capture-Filename-UTF8": filename,
                  "X-FrontMind-Provider-Filename-UTF8": filename,
                  "X-FrontMind-Upload-Ticket": handle.ticket,
                },
                body: bytes,
              },
            );
            await vi.waitFor(() => {
              expect(resolvePreflight).toBeTypeOf("function");
            });

            const discardResponse = await fetch(
              `${baseUrl}/v1/files/${fileId}/discard`,
              { method: "DELETE" },
            );
            expect(discardResponse.status).toBe(409);
            expect(await discardResponse.json()).toMatchObject({
              error: {
                code: "UPLOAD_IN_PROGRESS",
                traceId: expect.any(String),
              },
            });
            expect(authMocks.discardUnboundUpstreamFile).not.toHaveBeenCalled();

            resolvePreflight({
              status: 200,
              data: { id: fileId, filename, status: "pending" },
            });
            expect((await uploadPromise).status).toBe(200);
          },
          { authenticated: true },
        );
      });
    });
  });
});

describe("owned file content download", () => {
  function ownedCredential() {
    return {
      id: "credential-capture-test",
      apiKey: "test-only-credential",
      resource: {
        createdAt: new Date(),
        contentExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        contentDeletedAt: null,
      },
    };
  }

  it("serves the durable local copy without any upstream GET", async () => {
    await withCaptureAssetDirectory(async () => {
      const fileId = "owned-local-file";
      const bytes = Buffer.from("durable local content");
      const staged = await stagePresalesFileContent({
        fileId,
        stream: Readable.from([bytes]),
        maxBytes: 100 * 1024 * 1024,
      });
      await staged.commit({ filename: "local.txt", mimeType: "text/plain" });
      authMocks.getCredentialForUpstreamResource.mockResolvedValue(
        ownedCredential(),
      );
      const get = vi.spyOn(axios, "get");

      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`,
          );
          expect(response.status).toBe(200);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
        },
        { authenticated: true },
      );

      expect(get).not.toHaveBeenCalled();
    });
  });

  it("returns CONTENT_UNAVAILABLE when a legacy file has no local copy", async () => {
    await withCaptureAssetDirectory(async () => {
      const fileId = "legacy-upstream-file";
      const bytes = Buffer.from("legacy upstream content");
      authMocks.getCredentialForUpstreamResource.mockResolvedValue(
        ownedCredential(),
      );
      const get = vi.spyOn(axios, "get").mockResolvedValue({
        status: 200,
        data: Readable.from([bytes]),
        headers: {
          "content-type": "text/plain",
          "content-length": String(bytes.length),
          "content-disposition": "attachment; filename=legacy.txt",
        },
      });

      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`,
          );
          expect(response.status).toBe(410);
          expect(await response.json()).toMatchObject({
            error: { code: "CONTENT_UNAVAILABLE" },
          });
        },
        { authenticated: true },
      );

      expect(get).not.toHaveBeenCalled();
      expect(await readStoredPresalesFile(fileId)).toBeNull();
    });
  });
});

describe("public task payload boundary", () => {
  it("drops provider navigation URLs from generic proxy objects recursively", () => {
    const firstPrivateCode = ["MAN", "US_V2_TASK_REJECTED"].join("");
    const secondPrivateCode = ["JENO", "VA_UPSTREAM_FAILED"].join("");
    expect(
      publicUpstreamPayload(
        {
          id: "safe",
          url: "https://provider.example/task/1",
          task_url: "https://example.test/task/1",
          metadata: {
            shareUrl: "https://example.test/share/1",
            file_url: "https://provider.example/file/1",
            nested: {
              imageUrl: "https://provider.example/image/1",
              code: firstPrivateCode,
              safeCode: "RATE_LIMITED",
              alternateProviderCode: secondPrivateCode,
            },
            title: "safe title",
          },
        },
        "credential",
      ),
    ).toEqual({
      id: "safe",
      metadata: {
        nested: { safeCode: "RATE_LIMITED" },
        title: "safe title",
      },
    });
  });

  it.each([
    ["GET", "/v1/tasks/task-1"],
    ["HEAD", "/v1/tasks/task-1?include=output"],
    ["GET", "/v1/responses/response-1/"],
    ["POST", "/v1/tasks"],
    ["POST", "/v1/responses/"],
  ])("recognizes %s %s as a task response", (method, targetPath) => {
    expect(isPublicTaskPayloadRequest(method, targetPath)).toBe(true);
  });

  it.each([
    ["GET", "/v1/files/file-1"],
    ["POST", "/v1/files"],
    ["DELETE", "/v1/tasks/task-1"],
    ["GET", "/v1/tasks/task-1/content"],
  ])("does not apply task shaping to %s %s", (method, targetPath) => {
    expect(isPublicTaskPayloadRequest(method, targetPath)).toBe(false);
  });

  it("allows result fields but removes echoed private request context at every nesting level", () => {
    const credential = "sentinel-task-credential-do-not-expose";
    const privateSentinel = "PRIVATE-SKILL-KNOWLEDGE-SENTINEL";
    const result = publicUpstreamTaskPayload(
      {
        id: "task-safe",
        task_id: "task-safe",
        status: "running",
        model: "FrontMind-Pro",
        task_url: "https://example.test/top-level-task-safe",
        share_url: "https://example.test/top-level-share-safe",
        prompt: privateSentinel,
        input: { text: privateSentinel },
        system: privateSentinel,
        instructions: { private: privateSentinel },
        knowledge_base: { content: privateSentinel },
        metadata: {
          credit_usage: "12",
          task_url: "https://example.test/task-safe",
          share_url: "https://example.test/share-safe",
          prompt: privateSentinel,
          nested: { instructions: privateSentinel },
          privateKnowledge: privateSentinel,
        },
        output: [
          {
            id: "message-safe",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "public answer" }],
            prompt: privateSentinel,
            input: privateSentinel,
            system: privateSentinel,
            instructions: privateSentinel,
            knowledge: privateSentinel,
          },
          {
            id: "reasoning-safe",
            type: "reasoning",
            summary: [
              {
                type: "summary_text",
                text: "public progress",
                instructions: privateSentinel,
              },
            ],
          },
          {
            id: "call-safe",
            type: "function_call",
            name: "public_tool",
            arguments: JSON.stringify({ prompt: privateSentinel }),
            input: privateSentinel,
            action: {
              type: "navigate",
              url: "https://example.test/",
              instructions: privateSentinel,
            },
          },
          {
            id: "file-safe",
            type: "output_file",
            file_id: "file-safe",
            filename: "safe.pdf",
            file_url: "https://provider.example/files/file-safe",
            image_url: "https://provider.example/images/file-safe",
          },
          {
            id: "input-secret",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: privateSentinel }],
          },
          {
            id: "system-secret",
            type: "instructions",
            content: [{ type: "output_text", text: privateSentinel }],
          },
        ],
        usage: {
          input_tokens: 123,
          output_tokens: 45,
          prompt: privateSentinel,
        },
        progress: {
          stage: "collecting",
          visited_links: 7,
          instructions: privateSentinel,
        },
        API_KEY: credential,
      },
      credential,
    );
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      id: "task-safe",
      task_id: "task-safe",
      status: "running",
      model: "FrontMind-Pro",
      metadata: {
        credit_usage: "12",
      },
      output: [
        {
          id: "message-safe",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "public answer" }],
        },
        {
          id: "reasoning-safe",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "public progress" }],
        },
        {
          id: "call-safe",
          type: "function_call",
          name: "public_tool",
          action: { type: "navigate" },
        },
        {
          id: "file-safe",
          type: "output_file",
          file_id: "file-safe",
          filename: "safe.pdf",
        },
      ],
      usage: {
        input_tokens: 123,
        output_tokens: 45,
      },
      progress: {
        stage: "collecting",
        visited_links: 7,
      },
    });
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"system"');
    expect(serialized).not.toContain("task_url");
    expect(serialized).not.toContain("share_url");
    expect(serialized).not.toContain('"instructions"');
    expect(serialized).not.toContain('"knowledge_base"');
  });

  it("preserves top-level assistant text without exposing request-shaped output", () => {
    const credential = "sentinel-task-credential-do-not-expose";
    const privateSentinel = "PRIVATE-REQUEST-CONTEXT-SENTINEL";
    const result = publicUpstreamTaskPayload(
      {
        id: "task-safe",
        status: "completed",
        output: [
          ...["message", "output_message", "output_text", "text"].map(
            (type, index) => ({
              id: `assistant-${index}`,
              type,
              role: "assistant",
              output_text: `public output_text ${index}`,
              content: `public content ${index}`,
              prompt: privateSentinel,
              input: privateSentinel,
              system: privateSentinel,
              instructions: privateSentinel,
            }),
          ),
          {
            id: "user-secret",
            type: "message",
            role: "user",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "system-secret",
            type: "output_message",
            role: "system",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "instruction-secret",
            type: "instructions",
            role: "assistant",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "reasoning-safe",
            type: "reasoning",
            role: "assistant",
            output_text: privateSentinel,
            content: privateSentinel,
            summary: [{ type: "summary_text", text: "public progress" }],
          },
          {
            id: "assistant-value-shape",
            type: "output_text",
            role: "assistant",
            output_text: { value: "public value-shaped output_text" },
          },
          {
            id: "assistant-untyped-string-content",
            role: "assistant",
            content: "public untyped assistant content",
          },
          {
            id: "assistant-nested-value-shape",
            type: "output_message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                output_text: { value: "public nested value-shaped text" },
              },
            ],
          },
        ],
        prompt: privateSentinel,
        input: privateSentinel,
        system: privateSentinel,
        instructions: privateSentinel,
        API_KEY: credential,
      },
      credential,
    );

    expect(result).toEqual({
      id: "task-safe",
      status: "completed",
      output: [
        ...["message", "output_message", "output_text", "text"].map(
          (type, index) => ({
            id: `assistant-${index}`,
            type,
            role: "assistant",
            output_text: `public output_text ${index}`,
            content: `public content ${index}`,
          }),
        ),
        {
          id: "reasoning-safe",
          type: "reasoning",
          role: "assistant",
          summary: [{ type: "summary_text", text: "public progress" }],
        },
        {
          id: "assistant-value-shape",
          type: "output_text",
          role: "assistant",
          output_text: { value: "public value-shaped output_text" },
        },
        {
          id: "assistant-untyped-string-content",
          role: "assistant",
          content: "public untyped assistant content",
        },
        {
          id: "assistant-nested-value-shape",
          type: "output_message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "public nested value-shaped text",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"system"');
    expect(serialized).not.toContain('"instructions"');
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("system-secret");
    expect(serialized).not.toContain("instruction-secret");
  });
});

describe("external download size boundary", () => {
  it("returns a neutral 409 instead of serving an arbitrary ZIP package", async () => {
    const sourceBrand = ["Ma", "nus"].join("");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("SKILL.md", `# ${sourceBrand} internal package`);
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      },
      data: Readable.from([archive]),
    } as any);

    await withManusProxyServer(async (baseUrl) => {
      const target = "https://files.example.test/package.zip";
      const response = await fetch(
        `${baseUrl}/proxy-download?url=${encodeURIComponent(target)}`,
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        error: {
          message: "该文件暂时无法提供安全下载，请联系支持处理",
          code: "PUBLIC_FILE_UNAVAILABLE",
        },
      });
      expect(JSON.stringify(body)).not.toMatch(new RegExp(sourceBrand, "iu"));
    });
  });

  it("rejects an oversized declared Content-Length with 413 before reading", async () => {
    const credentialSentinel = "SIGNED-CREDENTIAL-MUST-NOT-LEAK";
    const source = Readable.from([Buffer.from("must not be consumed")]);
    const destroySpy = vi.spyOn(source, "destroy");
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(MAX_EXTERNAL_DOWNLOAD_BYTES + 1),
      },
      data: source,
    } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withManusProxyServer(async (baseUrl) => {
      const target = `https://files.example.test/archive.bin?signature=${credentialSentinel}`;
      const response = await fetch(
        `${baseUrl}/proxy-download?url=${encodeURIComponent(target)}`,
      );
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body).toEqual({
        error: {
          message: "文件超过允许的下载大小",
          code: "EXTERNAL_DOWNLOAD_TOO_LARGE",
        },
      });
      expect(JSON.stringify(body)).not.toContain(credentialSentinel);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
        credentialSentinel,
      );
      expect(destroySpy).toHaveBeenCalled();
    });
  });

  it("rejects a chunked response that crosses the actual byte cap with 413", async () => {
    const credentialSentinel = "CHUNKED-CREDENTIAL-MUST-NOT-LEAK";
    const chunk = Buffer.alloc(1024 * 1024);
    async function* chunks() {
      const count = Math.floor(MAX_EXTERNAL_DOWNLOAD_BYTES / chunk.length) + 1;
      for (let index = 0; index < count; index += 1) {
        yield chunk;
      }
    }
    const source = Readable.from(chunks());
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      data: source,
    } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withManusProxyServer(async (baseUrl) => {
      const target = `https://files.example.test/chunked.bin?signature=${credentialSentinel}`;
      const response = await fetch(
        `${baseUrl}/proxy-download?url=${encodeURIComponent(target)}`,
      );
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error?.code).toBe("EXTERNAL_DOWNLOAD_TOO_LARGE");
      expect(JSON.stringify(body)).not.toContain(credentialSentinel);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
        credentialSentinel,
      );
    });
  });

  it("accepts a chunked response exactly at a smaller test cap", async () => {
    await expect(
      readBoundedExternalDownload(
        Readable.from([Buffer.from("1234"), Buffer.from("5678")]),
        {},
        8,
      ),
    ).resolves.toEqual(Buffer.from("12345678"));
  });
});
