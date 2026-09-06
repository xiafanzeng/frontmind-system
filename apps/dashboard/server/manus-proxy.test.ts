import * as credentialAgentClient from "./credential-agent-client";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import axios from "axios";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

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
} from "./manus-proxy";
import {
  readStoredPresalesFile,
  stagePresalesFileContent,
} from "./presales-file-store";
import { AuthServiceError } from "./auth-service";
import { preparedFileService } from "./prepared-file-service";

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
          provider: "zhipu",
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

  it("fails closed when the HTTP parser did not complete the managed request", () => {
    expect(() =>
      assertManagedUploadRequestComplete({ complete: false } as any),
    ).toThrow();
    expect(() =>
      assertManagedUploadRequestComplete({ complete: true } as any),
    ).not.toThrow();
  });

  it.each([
    ["PUT", "/proxy-upload"],
    ["POST", "/v1/files/old-file/upload-recovery"],
  ])(
    "directs %s %s to the current uploader without provider work",
    async (method, route) => {
      const provider = vi.spyOn(
        credentialAgentClient,
        "createCredentialAgentClient",
      );
      const upstream = vi.spyOn(axios, "request");
      await withManusProxyServer(
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}${route}`, { method });
          expect(response.status).toBe(410);
          expect(await response.json()).toMatchObject({
            error: {
              code: "UPLOAD_RECREATE_REQUIRED",
              recreateRequired: true,
              message: expect.stringContaining("重新选择文件"),
            },
          });
        },
        { authenticated: true },
      );
      expect(provider).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
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
            credential: {
              id: "credential-before-rotation",
              userId: 42,
              version: 1,
              provider: "zhipu",
              apiKey: "bound-key-before-rotation",
            },
          });
          return { discarded: true };
        },
      );
      const removeProvider = vi.fn().mockResolvedValue(undefined);
      const factory = vi
        .spyOn(credentialAgentClient, "createCredentialAgentClient")
        .mockReturnValue({ deleteFile: removeProvider } as any);
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

      expect(removeProvider).toHaveBeenCalledWith(fileId);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "zhipu",
          id: "credential-before-rotation",
          apiKey: "bound-key-before-rotation",
        }),
        expect.objectContaining({ accountUserId: 42 }),
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
    const removeProvider = vi.spyOn(
      credentialAgentClient,
      "createCredentialAgentClient",
    );

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
            credential: {
              id: "credential-record-owner",
              userId: 42,
              version: 1,
              provider: "zhipu",
              apiKey: "bound-record-credential",
            },
          });
          return { discarded: true };
        },
      );
      vi.spyOn(
        credentialAgentClient,
        "createCredentialAgentClient",
      ).mockReturnValue({
        deleteFile: vi
          .fn()
          .mockRejectedValue(new Error("provider unavailable")),
      } as any);
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
