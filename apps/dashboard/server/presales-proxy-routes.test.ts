import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { siblingWebsiteRepositoryRoot } from "./cross-repo-test-path";

vi.mock("./presales-service", async () => {
  const actual =
    await vi.importActual<typeof import("./presales-service")>(
      "./presales-service",
    );
  return {
    ...actual,
    acquirePresalesTaskReservation: vi.fn(),
    completePresalesProjectTaskPurge: vi.fn(),
    completePresalesTaskReservation: vi.fn(),
    countPresalesProjectPendingFileUploads: vi.fn(),
    deletePresalesFileEvidence: vi.fn(),
    deletePresalesTaskEvidence: vi.fn(),
    finalizePresalesFileUploadRetention: vi.fn(),
    getActivePresalesCredential: vi.fn(),
    getPresalesCredentialById: vi.fn(),
    getPresalesCredentialForResource: vi.fn(),
    hasPresalesOutputUrlGrant: vi.fn(),
    markPresalesFileContentDeleted: vi.fn(),
    recordPresalesUpstreamResource: vi.fn(),
    releasePresalesTaskReservation: vi.fn(),
    readPresalesProjectFileTargets: vi.fn(),
    readPresalesProjectTaskPurgeSnapshot: vi.fn(),
    readPresalesTaskEvidenceFileIds: vi.fn(),
    retainPresalesProjectFilePurgeTarget: vi.fn(),
    retainPresalesTaskPurgeTarget: vi.fn(),
    reservePresalesFileUploadRetention: vi.fn(),
    resolvePresalesTaskCredentialForFiles: vi.fn(),
    syncPresalesOutputUrlGrants: vi.fn(),
    withPresalesProjectFileCreateGuard: vi.fn(),
  };
});

vi.mock("./presales-monitor", async () => {
  const actual =
    await vi.importActual<typeof import("./presales-monitor")>(
      "./presales-monitor",
    );
  return {
    ...actual,
    getDedicatedMonitorCredentialReadiness: vi.fn(),
    purgePresalesProjectMonitorRuns: vi.fn(),
  };
});

import presalesProxy from "./presales-proxy";
import { AuthServiceError } from "./auth-service";
import {
  readPresalesFileLifecycle,
  readStoredPresalesFile,
  removeStoredPresalesFileContent,
  stagePresalesFileContent,
} from "./presales-file-store";
import {
  acquirePresalesTaskReservation,
  completePresalesProjectTaskPurge,
  completePresalesTaskReservation,
  countPresalesProjectPendingFileUploads,
  deletePresalesFileEvidence,
  deletePresalesTaskEvidence,
  finalizePresalesFileUploadRetention,
  getActivePresalesCredential,
  getPresalesCredentialById,
  getPresalesCredentialForResource,
  hasPresalesOutputUrlGrant,
  markPresalesFileContentDeleted,
  recordPresalesUpstreamResource,
  releasePresalesTaskReservation,
  readPresalesProjectFileTargets,
  readPresalesProjectTaskPurgeSnapshot,
  readPresalesTaskEvidenceFileIds,
  retainPresalesProjectFilePurgeTarget,
  retainPresalesTaskPurgeTarget,
  reservePresalesFileUploadRetention,
  resolvePresalesTaskCredentialForFiles,
  syncPresalesOutputUrlGrants,
  withPresalesProjectFileCreateGuard,
} from "./presales-service";
import {
  getDedicatedMonitorCredentialReadiness,
  purgePresalesProjectMonitorRuns,
} from "./presales-monitor";

const token = "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
const originalServiceToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
const originalMonitorKey = process.env.FRONTMIND_MONITOR_API_KEY;
const originalPublicUrl = process.env.FRONTMIND_PUBLIC_URL;
const originalDashboardAssetDir = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
let dashboardAssetDir = "";
let presalesContentState: {
  contentSource: "user_upload" | "assistant_output" | null;
  uploadReservedAt: Date | null;
  uploadedAt: Date | null;
  contentExpiresAt: Date | null;
  contentDeletedAt: Date | null;
};
const websiteBrokerPath = path.resolve(
  siblingWebsiteRepositoryRoot(),
  "server/geo/broker.ts",
);
const websiteBrokerAvailable = existsSync(websiteBrokerPath);
const websiteBrokerIt = websiteBrokerAvailable ? it : it.skip;
const websiteBrokerRoundTripTestName =
  "round-trips Website Broker bytes through durable local storage without calling an upstream download endpoint";
const websiteBrokerRejectedUploadTestName =
  "does not publish a local file when the upstream upload was rejected";

beforeEach(() => {
  vi.mocked(deletePresalesFileEvidence).mockResolvedValue(undefined);
  vi.mocked(countPresalesProjectPendingFileUploads).mockResolvedValue(0);
  vi.mocked(purgePresalesProjectMonitorRuns).mockResolvedValue({
    deletedRuns: 0,
    pendingRuns: 0,
  });
  vi.mocked(deletePresalesTaskEvidence).mockResolvedValue({
    deleted: true,
    fileIds: [],
  });
  vi.mocked(readPresalesProjectFileTargets).mockResolvedValue([]);
  vi.mocked(readPresalesTaskEvidenceFileIds).mockResolvedValue([]);
  vi.mocked(retainPresalesProjectFilePurgeTarget).mockResolvedValue(undefined);
  vi.mocked(retainPresalesTaskPurgeTarget).mockResolvedValue(undefined);
  vi.mocked(withPresalesProjectFileCreateGuard).mockImplementation(
    async (_projectId, _credentialId, operation) => operation(),
  );
});

type WebsiteBrokerClient = {
  createFile(value: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ id: string; proxy_upload_ticket?: string }>;
  uploadFile(
    fileId: string,
    content: Buffer,
    mimeType: string,
    uploadTicket?: string,
  ): Promise<void>;
  downloadFile(fileId: string): Promise<Response>;
};

async function createWebsiteBroker(options: {
  baseUrl: string;
  serviceToken: string;
  fetchImpl: typeof fetch;
}) {
  const { HttpGeoPresalesBroker } = await vi.importActual<{
    HttpGeoPresalesBroker: new (value: typeof options) => WebsiteBrokerClient;
  }>(websiteBrokerPath);
  return new HttpGeoPresalesBroker(options);
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use("/api/internal/presales", presalesProxy);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/internal/presales`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function storePresalesTestFile(input: {
  fileId: string;
  body: Buffer;
  filename?: string;
  mimeType?: string;
  uploadedAt: Date;
  contentExpiresAt: Date;
}) {
  const staged = await stagePresalesFileContent({
    fileId: input.fileId,
    stream: Readable.from([input.body]),
    maxBytes: 100 * 1024 * 1024,
  });
  await staged.commit({
    filename: input.filename,
    mimeType: input.mimeType,
    uploadedAt: input.uploadedAt,
    contentExpiresAt: input.contentExpiresAt,
  });
}

function presalesContentPath(fileId: string) {
  const storageKey = createHash("sha256").update(fileId).digest("hex");
  return path.join(
    dashboardAssetDir,
    "presales-files",
    `${storageKey}.content`,
  );
}

function presalesManifestPath(fileId: string) {
  return presalesContentPath(fileId).replace(/\.content$/u, ".json");
}

describe("presales readiness status", () => {
  afterEach(() => {
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
    if (originalMonitorKey === undefined) {
      delete process.env.FRONTMIND_MONITOR_API_KEY;
    } else {
      process.env.FRONTMIND_MONITOR_API_KEY = originalMonitorKey;
    }
    if (originalPublicUrl === undefined) {
      delete process.env.FRONTMIND_PUBLIC_URL;
    } else {
      process.env.FRONTMIND_PUBLIC_URL = originalPublicUrl;
    }
    vi.mocked(getActivePresalesCredential).mockReset();
    vi.mocked(getDedicatedMonitorCredentialReadiness).mockReset();
  });

  it("returns only non-secret readiness booleans for paid monitoring", async () => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_MONITOR_API_KEY =
      "dedicated-monitor-credential-for-tests";
    process.env.FRONTMIND_PUBLIC_URL = "https://agent.frontmind.test";
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "ordinary-presales-test-key",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(getDedicatedMonitorCredentialReadiness).mockResolvedValue({
      configured: true,
      authenticated: true,
      ready: true,
      status: "authenticated",
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/status`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        ok: true,
        credentialConfigured: true,
        monitorCredentialConfigured: true,
        monitorCredentialAuthenticated: true,
        publicUrlConfigured: true,
      });
      expect(getDedicatedMonitorCredentialReadiness).toHaveBeenCalledWith(
        process.env,
        { forceRefresh: false },
      );
      expect(JSON.stringify(body)).not.toContain(
        process.env.FRONTMIND_MONITOR_API_KEY,
      );
    });
  });

  it("forces a fresh provider probe and distinguishes configured from authenticated", async () => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_MONITOR_API_KEY =
      "configured-but-rejected-monitor-credential";
    process.env.FRONTMIND_PUBLIC_URL = "https://agent.frontmind.test";
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "ordinary-presales-test-key",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(getDedicatedMonitorCredentialReadiness).mockResolvedValue({
      configured: true,
      authenticated: false,
      ready: false,
      status: "rejected",
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/status?monitorCredentialProbe=fresh`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        credentialConfigured: true,
        monitorCredentialConfigured: true,
        monitorCredentialAuthenticated: false,
        publicUrlConfigured: true,
      });
      expect(getDedicatedMonitorCredentialReadiness).toHaveBeenCalledWith(
        process.env,
        { forceRefresh: true },
      );
    });
  });
});

describe("presales create-time upload capability", () => {
  beforeEach(async () => {
    dashboardAssetDir = await mkdtemp(
      path.join(tmpdir(), "frontmind-presales-files-test-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = dashboardAssetDir;
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-upload-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    presalesContentState = {
      contentSource: "assistant_output",
      uploadReservedAt: null,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
    };
    vi.mocked(getPresalesCredentialForResource).mockImplementation(
      async (kind, upstreamId) => ({
        id: "credential-1",
        version: 1,
        apiKey: "sk-upload-file",
        fingerprint: "fingerprint",
        status: "active",
        verifiedAt: new Date(),
        resource: {
          id: "resource-1",
          apiCredentialId: "credential-1",
          kind,
          upstreamId,
          parentTaskId: null,
          createdAt: new Date(),
          ...presalesContentState,
        },
      }),
    );
    vi.mocked(recordPresalesUpstreamResource).mockImplementation(
      async (input) => {
        if (input.kind === "file" && input.contentSource) {
          presalesContentState.contentSource = input.contentSource;
        }
        return undefined as never;
      },
    );
    vi.mocked(reservePresalesFileUploadRetention).mockImplementation(
      async ({ now }) => {
        if (presalesContentState.contentDeletedAt) {
          throw new AuthServiceError("CONFLICT", "文件已删除，不能重新上传");
        }
        if (!presalesContentState.uploadReservedAt) {
          presalesContentState.contentSource = "user_upload";
          presalesContentState.uploadReservedAt = now;
        }
        return {
          ...presalesContentState,
          uploadReservedAt: presalesContentState.uploadReservedAt,
        } as never;
      },
    );
    vi.mocked(finalizePresalesFileUploadRetention).mockImplementation(
      async () => {
        if (!presalesContentState.uploadReservedAt) {
          throw new AuthServiceError("CONFLICT", "文件上传时钟尚未预留");
        }
        if (!presalesContentState.uploadedAt) {
          presalesContentState.uploadedAt =
            presalesContentState.uploadReservedAt;
          presalesContentState.contentExpiresAt = new Date(
            presalesContentState.uploadReservedAt.getTime() +
              30 * 24 * 60 * 60 * 1_000,
          );
        }
        return {
          ...presalesContentState,
          uploadedAt: presalesContentState.uploadedAt,
          contentExpiresAt: presalesContentState.contentExpiresAt,
        } as never;
      },
    );
    vi.mocked(markPresalesFileContentDeleted).mockImplementation(
      async ({ now }) => {
        presalesContentState.contentDeletedAt = now;
        return undefined as never;
      },
    );
    vi.mocked(hasPresalesOutputUrlGrant).mockResolvedValue(true);
    vi.mocked(syncPresalesOutputUrlGrants).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(getActivePresalesCredential).mockReset();
    vi.mocked(getPresalesCredentialForResource).mockReset();
    vi.mocked(hasPresalesOutputUrlGrant).mockReset();
    vi.mocked(recordPresalesUpstreamResource).mockReset();
    vi.mocked(reservePresalesFileUploadRetention).mockReset();
    vi.mocked(finalizePresalesFileUploadRetention).mockReset();
    vi.mocked(markPresalesFileContentDeleted).mockReset();
    vi.mocked(syncPresalesOutputUrlGrants).mockReset();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
    if (originalDashboardAssetDir === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = originalDashboardAssetDir;
    }
    await rm(dashboardAssetDir, { recursive: true, force: true });
  });

  it("authenticates file reads before ownership lookup or upstream access", async () => {
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      for (const headers of [
        {},
        { "x-frontmind-service-token": "wrong-service-token" },
      ]) {
        const response = await fetch(`${baseUrl}/files/file-1/content`, {
          headers,
        });
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "INVALID_SERVICE_TOKEN" },
        });
      }
    });

    expect(getPresalesCredentialForResource).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not distinguish an unknown file from a file outside the service credential binding", async () => {
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue(null);
    const get = vi.spyOn(axios, "get");
    const responses: Array<{ status: number; body: unknown }> = [];

    await withServer(async (baseUrl) => {
      for (const fileId of ["unknown-file", "other-credential-file"]) {
        const response = await fetch(
          `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
          { headers: { "x-frontmind-service-token": token } },
        );
        responses.push({
          status: response.status,
          body: await response.json(),
        });
      }
    });

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toMatchObject({
      status: 403,
      body: {
        error: {
          code: "SOURCE_FORBIDDEN",
          retryable: false,
          recoveryAction: "contact_admin",
        },
      },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed when a task-bound assistant output was not localized", async () => {
    const fileId = "assessment-json-output";
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-upload-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
      resource: {
        id: "resource-assessment-output",
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: fileId,
        parentTaskId: "task-assessment",
        contentSource: "assistant_output",
        uploadReservedAt: null,
        uploadedAt: null,
        contentExpiresAt: null,
        contentDeletedAt: null,
        createdAt: new Date(),
      },
    });
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
    expect(await readStoredPresalesFile(fileId)).toBeNull();
  });

  it("uploads with the create-time signed URL and never renews the original 30-day clock on retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const signedUrl =
      "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef0123456789";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "catalog.pdf",
        upload_url: signedUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    const metadataLookup = vi.spyOn(axios, "get");
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 204,
      data: "",
    });

    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/files`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          filename: "catalog.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        }),
      });
      expect(created.status).toBe(201);
      const file = (await created.json()) as Record<string, string>;
      expect(file.proxy_upload_ticket).toMatch(/^v1\./);

      const uploaded = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "3",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
          "x-frontmind-upload-ticket": file.proxy_upload_ticket,
        },
        body: Buffer.from("pdf"),
      });
      expect(uploaded.status).toBe(200);

      const initialLifecycle = await readPresalesFileLifecycle("file-1");
      expect(initialLifecycle).toMatchObject({
        state: "stored",
        uploadedAt: new Date("2026-08-04T00:00:00.000Z"),
        contentExpiresAt: new Date("2026-09-03T00:00:00.000Z"),
        contentDeletedAt: null,
      });

      vi.setSystemTime(new Date("2026-08-04T00:01:00.000Z"));
      const retried = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "3",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
          "x-frontmind-upload-ticket": file.proxy_upload_ticket,
        },
        body: Buffer.from("pdf"),
      });
      expect(retried.status).toBe(200);
      expect(await readPresalesFileLifecycle("file-1")).toMatchObject({
        uploadedAt: initialLifecycle?.uploadedAt,
        contentExpiresAt: initialLifecycle?.contentExpiresAt,
      });
    });

    expect(metadataLookup).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  it("keeps the DB-reserved clock when the upstream PUT succeeds but local commit fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T02:00:00.000Z"));
    const fileId = "commit-failure-file";
    const signedUrl =
      "https://uploads.example.test/commit-failure.pdf?sig=fixed";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: fileId,
        filename: "commit-failure.pdf",
        upload_url: signedUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    const put = vi.spyOn(axios, "put").mockImplementationOnce(async () => {
      await mkdir(presalesContentPath(fileId));
      return { status: 204, data: "" };
    });

    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/files`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          filename: "commit-failure.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        }),
      });
      expect(created.status).toBe(201);
      const ticket = String((await created.json()).proxy_upload_ticket);

      const first = await fetch(`${baseUrl}/files/${fileId}/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "x-frontmind-service-token": token,
          "x-frontmind-upload-ticket": ticket,
        },
        body: Buffer.from("pdf"),
      });
      expect(first.status).toBe(503);
      await expect(first.json()).resolves.toMatchObject({
        error: {
          code: "SOURCE_CAPTURE_FAILED",
          retryable: true,
          recoveryAction: "retry",
        },
      });
      const reservedUploadedAt = presalesContentState.uploadedAt;
      const reservedExpiresAt = presalesContentState.contentExpiresAt;
      expect(reservedUploadedAt).toEqual(new Date("2026-08-04T02:00:00.000Z"));

      await rm(presalesContentPath(fileId), { recursive: true, force: true });
      // The signed upload ticket is intentionally short lived. Retry before
      // that capability expires so this assertion isolates retention-clock
      // reuse from ticket-expiry behavior.
      vi.setSystemTime(new Date("2026-08-04T02:02:00.000Z"));
      put.mockResolvedValueOnce({ status: 204, data: "" });
      const retried = await fetch(`${baseUrl}/files/${fileId}/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "x-frontmind-service-token": token,
          "x-frontmind-upload-ticket": ticket,
        },
        body: Buffer.from("pdf"),
      });
      expect(retried.status).toBe(200);
      expect(presalesContentState).toMatchObject({
        uploadedAt: reservedUploadedAt,
        contentExpiresAt: reservedExpiresAt,
      });
      expect(await readPresalesFileLifecycle(fileId)).toMatchObject({
        uploadedAt: reservedUploadedAt,
        contentExpiresAt: reservedExpiresAt,
      });
    });
  });

  it("rejects reads and upload retries at the immutable deadline without contacting upstream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const fileId = "expired-file";
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    await storePresalesTestFile({
      fileId,
      body: Buffer.from("expired bytes"),
      filename: "expired.pdf",
      mimeType: "application/pdf",
      uploadedAt,
      contentExpiresAt,
    });
    presalesContentState = {
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
      contentDeletedAt: null,
    };
    const get = vi.spyOn(axios, "get");
    const put = vi.spyOn(axios, "put");

    await withServer(async (baseUrl) => {
      const downloaded = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(downloaded.status).toBe(410);
      await expect(downloaded.json()).resolves.toMatchObject({
        error: {
          code: "SOURCE_EXPIRED",
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: contentExpiresAt.getTime(),
        },
      });

      const retried = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/pdf",
            "x-frontmind-service-token": token,
          },
          body: Buffer.from("replacement bytes"),
        },
      );
      expect(retried.status).toBe(410);
      await expect(retried.json()).resolves.toMatchObject({
        error: { code: "SOURCE_EXPIRED" },
      });
    });

    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await readPresalesFileLifecycle(fileId)).toMatchObject({
      uploadedAt,
      contentExpiresAt,
    });
  });

  it("uses the DB user-upload deadline but never recovers missing bytes from Provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const fileId = "manifest-missing-user-upload";
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    presalesContentState = {
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
      contentDeletedAt: null,
    };
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: contentExpiresAt.getTime(),
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
    expect(await readPresalesFileLifecycle(fileId)).toBeNull();
  });

  it("fails closed for a historical resource with no provenance and no manifest", async () => {
    presalesContentState = {
      contentSource: null,
      uploadReservedAt: null,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
    };
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/files/historical-unknown/content`,
        {
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "SOURCE_UNAVAILABLE",
          retryable: false,
          recoveryAction: "contact_admin",
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
  });

  it("isolates a partial local ledger without falling back to Provider bytes", async () => {
    const fileId = "partial-retention-ledger";
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    await storePresalesTestFile({
      fileId,
      body: Buffer.from("locally valid bytes"),
      uploadedAt,
      contentExpiresAt,
    });
    presalesContentState = {
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
      contentDeletedAt: null,
    };
    const manifestPath = presalesManifestPath(fileId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manifest.contentExpiresAt;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: contentExpiresAt.getTime(),
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
    expect(await readPresalesFileLifecycle(fileId)).toBeNull();
  });

  it("rejects a SHA-damaged local copy without calling a Provider content endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const fileId = "file # 中文 📄";
    const original = Buffer.from("original durable bytes");
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    await storePresalesTestFile({
      fileId,
      body: original,
      filename: "原始 文件.pdf",
      mimeType: "application/pdf",
      uploadedAt,
      contentExpiresAt,
    });
    // Preserve the recorded size but alter every byte, forcing SHA-256
    // validation (rather than the cheaper size check) to trigger recovery.
    await writeFile(
      presalesContentPath(fileId),
      Buffer.alloc(original.length, 0x78),
    );
    vi.mocked(getPresalesCredentialForResource).mockImplementation(
      async (kind, requestedFileId) => {
        expect(kind).toBe("file");
        expect(requestedFileId).toBe(fileId);
        return {
          id: "credential-1",
          version: 1,
          apiKey: "sk-upload-file",
          fingerprint: "fingerprint",
          status: "active",
          verifiedAt: new Date(),
          resource: {
            id: "resource-special",
            apiCredentialId: "credential-1",
            kind: "file",
            upstreamId: fileId,
            parentTaskId: null,
            createdAt: uploadedAt,
            contentSource: "user_upload",
            uploadReservedAt: uploadedAt,
            uploadedAt,
            contentExpiresAt,
            contentDeletedAt: null,
          },
        };
      },
    );
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: contentExpiresAt.getTime(),
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
    expect(await readStoredPresalesFile(fileId)).toBeNull();
  });

  it("retains a user upload and its local content when cleanup is requested", async () => {
    const fileId = "deleted-user-upload";
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    await storePresalesTestFile({
      fileId,
      body: Buffer.from("delete me"),
      uploadedAt,
      contentExpiresAt,
    });
    presalesContentState = {
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
      contentDeletedAt: null,
    };
    const deleteMock = vi
      .spyOn(axios, "delete")
      .mockResolvedValue({ status: 204, data: "" });
    const get = vi.spyOn(axios, "get");

    await withServer(async (baseUrl) => {
      const deleted = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(deleted.status).toBe(204);

      const downloaded = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe("delete me");
    });

    expect(markPresalesFileContentDeleted).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await readPresalesFileLifecycle(fileId)).not.toBeNull();
  });

  it("does not create a DB tombstone or contact Provider during cleanup", async () => {
    const fileId = "delete-upstream-failure";
    const uploadedAt = new Date("2026-08-04T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-09-03T00:00:00.000Z");
    presalesContentState = {
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
      contentDeletedAt: null,
    };
    const deleteMock = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 503,
      data: { message: "storage unavailable" },
    });

    await withServer(async (baseUrl) => {
      const deleted = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(deleted.status).toBe(204);
      expect(presalesContentState.contentDeletedAt).toBeNull();
    });

    expect(deleteMock).not.toHaveBeenCalled();
    expect(markPresalesFileContentDeleted).not.toHaveBeenCalled();
  });

  it("replays one durable file id after the create response is lost and cleanup is retained", async () => {
    const idempotencyKey =
      "geo-custom-question-file:operation-hash:archive:0:v1";
    const signedUrl =
      "https://uploads.example.test/custom.zip?X-Amz-Signature=response-lost";
    const create = vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-response-lost",
        filename: "custom.zip",
        status: "pending",
        upload_url: signedUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-service-token": token,
      },
      body: JSON.stringify({
        filename: "custom.zip",
        mimeType: "application/zip",
        sizeBytes: 3,
        idempotencyKey,
      }),
    } as const;

    // The first server fully commits the response, but the Website caller can
    // lose it before reading the file id.
    await withServer(async (baseUrl) => {
      const lost = await fetch(`${baseUrl}/files`, request);
      expect(lost.status).toBe(201);
    });

    // Starting a fresh HTTP server exercises disk replay rather than a module
    // cache. Rotate the active credential before retrying: the immutable
    // completed operation must still return its original file id and must not
    // invoke the upstream create endpoint in the new account.
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-2",
      version: 2,
      apiKey: "sk-upload-file-rotated",
      fingerprint: "fingerprint-rotated",
      status: "active",
      verifiedAt: new Date(),
    });
    await withServer(async (baseUrl) => {
      const replay = await fetch(`${baseUrl}/files`, request);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      await expect(replay.json()).resolves.toMatchObject({
        id: "file-response-lost",
        filename: "custom.zip",
        proxy_upload_ticket: expect.stringMatching(/^v1\./),
      });

      vi.spyOn(axios, "delete").mockResolvedValue({ status: 204, data: "" });
      const cleaned = await fetch(`${baseUrl}/files/file-response-lost`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(cleaned.status).toBe(204);

      const lateReplay = await fetch(`${baseUrl}/files`, request);
      expect(lateReplay.status).toBe(200);
      await expect(lateReplay.json()).resolves.toMatchObject({
        id: "file-response-lost",
        filename: "custom.zip",
      });
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toEqual({ filename: "custom.zip" });
    expect(JSON.stringify(create.mock.calls[0]?.[1])).not.toContain(
      idempotencyKey,
    );
    expect(create.mock.calls[0]?.[2]).toMatchObject({
      headers: {
        "Idempotency-Key": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("keeps an ambiguous file-create lease without logging its key or body", async () => {
    const idempotencyKey =
      "geo-custom-question-file:secret-operation:skill:0:v1";
    const filename = "secret-customer-contract.skill.zip";
    const create = vi
      .spyOn(axios, "post")
      .mockRejectedValue(new Error(`timeout ${idempotencyKey} ${filename}`));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-service-token": token,
      },
      body: JSON.stringify({
        filename,
        mimeType: "application/zip",
        sizeBytes: 3,
        idempotencyKey,
      }),
    } as const;

    await withServer(async (baseUrl) => {
      const unknown = await fetch(`${baseUrl}/files`, request);
      expect(unknown.status).toBe(502);

      const immediateRetry = await fetch(`${baseUrl}/files`, request);
      expect(immediateRetry.status).toBe(425);
      expect(immediateRetry.headers.get("retry-after")).toBeTruthy();
    });

    expect(create).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(idempotencyKey);
    expect(logged).not.toContain(filename);
  });

  websiteBrokerIt(websiteBrokerRoundTripTestName, async () => {
    const bytes = Buffer.from("zip");
    let storedBytes = Buffer.alloc(0);
    const signedUploadUrl =
      "https://uploads.example.test/final.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=put-only";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "final.zip",
        upload_url: signedUploadUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    vi.spyOn(axios, "put").mockImplementation(async (_url, body) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      storedBytes = Buffer.concat(chunks);
      return { status: 204, data: "" };
    });
    const get = vi.spyOn(axios, "get").mockImplementation(async () => ({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(storedBytes.length),
        "content-disposition": "attachment; filename*=UTF-8''website-final.zip",
      },
      data: Readable.from([storedBytes]),
    }));

    await withServer(async (baseUrl) => {
      const broker = await createWebsiteBroker({
        baseUrl,
        serviceToken: token,
        fetchImpl: (input, init) =>
          fetch(input, { ...init, signal: undefined }),
      });
      const file = await broker.createFile({
        filename: "final.zip",
        mimeType: "application/zip",
        sizeBytes: bytes.length,
      });
      await broker.uploadFile(
        file.id,
        bytes,
        "application/zip",
        file.proxy_upload_ticket,
      );
      const downloaded = await broker.downloadFile(file.id);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      expect(downloaded.headers.get("content-disposition")).toContain(
        "final.zip",
      );
    });

    expect(storedBytes).toEqual(bytes);
    expect(get).not.toHaveBeenCalled();
  });

  websiteBrokerIt(websiteBrokerRejectedUploadTestName, async () => {
    const signedUploadUrl =
      "https://uploads.example.test/rejected.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=rejected";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "rejected.zip",
        upload_url: signedUploadUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({
      status: 403,
      data: { message: "rejected" },
    });
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 404,
      headers: {},
      data: Readable.from([]),
    });

    await withServer(async (baseUrl) => {
      const broker = await createWebsiteBroker({
        baseUrl,
        serviceToken: token,
        fetchImpl: (input, init) =>
          fetch(input, { ...init, signal: undefined }),
      });
      const file = await broker.createFile({
        filename: "rejected.zip",
        mimeType: "application/zip",
        sizeBytes: 3,
      });
      await expect(
        broker.uploadFile(
          file.id,
          Buffer.from("zip"),
          "application/zip",
          file.proxy_upload_ticket,
        ),
      ).rejects.toThrow("rejected");

      const downloaded = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(downloaded.status).toBe(410);
      await expect(downloaded.json()).resolves.toMatchObject({
        error: {
          code: "SOURCE_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
        },
      });
    });

    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    {
      upstreamStatus: 403,
    },
    {
      upstreamStatus: 404,
    },
    {
      upstreamStatus: 503,
    },
  ])(
    "ignores a mocked legacy Provider status $upstreamStatus when local bytes are absent",
    async ({ upstreamStatus }) => {
      const get = vi.spyOn(axios, "get").mockResolvedValue({
        status: upstreamStatus,
        headers: {},
        data: { secret: "must-not-leak" },
      });

      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/files/file-1/content`, {
          headers: { "x-frontmind-service-token": token },
        });
        expect(response.status).toBe(410);
        const body = await response.json();
        expect(body).toMatchObject({
          error: {
            code: "CONTENT_UNAVAILABLE",
            retryable: false,
            recoveryAction: "reupload",
          },
        });
        expect(JSON.stringify(body)).not.toContain("must-not-leak");
      });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("does not inspect an empty mocked Provider body when local bytes are absent", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/zip" },
      data: Readable.from([]),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
        },
      });
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not inspect mocked oversized Provider bytes when local bytes are absent", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(100 * 1024 * 1024 + 1),
      },
      data: Readable.from([Buffer.from("must-not-stream")]),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "CONTENT_UNAVAILABLE",
          retryable: false,
          recoveryAction: "reupload",
        },
      });
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the trusted URL-only task-output fallback for historical tasks", async () => {
    const target = "https://downloads.example.test/historical.zip?sig=trusted";
    const bytes = Buffer.from("historical-zip");
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: "task-legacy",
          status: "completed",
          output: [
            {
              role: "assistant",
              content: [
                {
                  type: "output_file",
                  filename: "historical.zip",
                  file_url: target,
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
        },
        data: Readable.from([bytes]),
      });

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/tasks/task-legacy/output?${new URLSearchParams({
          url: target,
          filename: "historical.zip",
        }).toString()}`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]![0]).toContain("/v1/tasks/task-legacy");
    expect(get.mock.calls[1]![0]).toBe(target);
    expect(hasPresalesOutputUrlGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task-legacy",
        url: target,
      }),
    );
  });
});

describe("presales deletion routes", () => {
  beforeEach(() => {
    let uploadReservedAt: Date | null = null;
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-delete-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
      resource: {
        id: "resource-1",
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        parentTaskId: null,
        contentSource: "user_upload",
        uploadReservedAt: null,
        uploadedAt: null,
        contentExpiresAt: null,
        contentDeletedAt: null,
        createdAt: new Date(),
      },
    });
    vi.mocked(reservePresalesFileUploadRetention).mockImplementation(
      async ({ now }) => {
        uploadReservedAt ??= now;
        return {
          uploadReservedAt,
          uploadedAt: null,
          contentExpiresAt: null,
        } as never;
      },
    );
    vi.mocked(finalizePresalesFileUploadRetention).mockImplementation(
      async () => {
        if (!uploadReservedAt) throw new Error("reservation missing");
        return {
          uploadReservedAt,
          uploadedAt: uploadReservedAt,
          contentExpiresAt: new Date(
            uploadReservedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        } as never;
      },
    );
    vi.mocked(markPresalesFileContentDeleted).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(deletePresalesTaskEvidence).mockResolvedValue({
      deleted: true,
      fileIds: [],
    });
    vi.mocked(completePresalesProjectTaskPurge).mockResolvedValue({
      completed: true,
      pendingReservations: 0,
      remainingTasks: 0,
    });
    vi.mocked(resolvePresalesTaskCredentialForFiles).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-create-task",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(completePresalesTaskReservation).mockResolvedValue(undefined);
    vi.mocked(releasePresalesTaskReservation).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
  });

  it("retains a legacy Provider file when Website requests cleanup", async () => {
    const deleteMock = vi
      .spyOn(axios, "delete")
      .mockResolvedValue({ status: 404, data: { message: "not found" } });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    expect(deleteMock).not.toHaveBeenCalled();
    expect(deletePresalesFileEvidence).not.toHaveBeenCalled();
  });

  it("does not contact Provider when its delete endpoint would fail", async () => {
    const deleteMock = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 503,
      data: { message: "storage unavailable" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(204);
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("uploads website attachments to the exact SigV4 URL without redirects", async () => {
    const signedUrl =
      "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { id: "file-1", filename: "catalog.pdf", upload_url: signedUrl },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 204,
      data: "",
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
        },
        body: Buffer.from("pdf"),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "uploaded",
      });
    });

    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({
        maxRedirects: 0,
        headers: expect.objectContaining({
          "Content-Type": "application/pdf",
        }),
      }),
    );
  });

  it("rejects a new project upload reservation after the deletion fence closes", async () => {
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-upload-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
      resource: {
        id: "resource-1",
        projectId: "project-20260728-0001",
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        parentTaskId: null,
        contentSource: "user_upload",
        uploadReservedAt: null,
        uploadedAt: null,
        contentExpiresAt: null,
        contentDeletedAt: null,
        createdAt: new Date(),
      },
    });
    vi.mocked(withPresalesProjectFileCreateGuard).mockRejectedValueOnce(
      new AuthServiceError("PROJECT_DELETED", "project deleted"),
    );
    const put = vi.spyOn(axios, "put");

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
        },
        body: Buffer.from("pdf"),
      });
      expect(response.status).toBe(410);
    });
    expect(put).not.toHaveBeenCalled();
  });

  it(
    "keeps the legacy generic task cleanup as a retained acknowledgement",
    async () => {
      const deleteMock = vi.spyOn(axios, "delete");

      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/tasks/task-1`, {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("x-frontmind-task-retention")).toBeNull();
      });

      expect(deleteMock).not.toHaveBeenCalled();
      expect(deletePresalesTaskEvidence).not.toHaveBeenCalled();
    },
  );

  it(
    "acknowledges project deletion routes without invoking purge providers",
    async () => {
      await withServer(async (baseUrl) => {
        for (const endpoint of [
          "/projects/project-20260728-0001/monitor-runs/00000000-0000-4000-8000-000000000001",
          "/projects/project-20260728-0001/tasks",
        ]) {
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: "DELETE",
            headers: { "x-frontmind-service-token": token },
          });
          if (endpoint.includes("monitor-runs")) {
            expect(response.status).toBe(204);
          } else {
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
              schemaVersion: 1,
              projectId: "project-20260728-0001",
              status: "deleted",
              deletedTasks: 0,
              deletedFiles: 0,
              pendingReservations: 0,
            });
          }
        }
      });
      expect(purgePresalesProjectMonitorRuns).not.toHaveBeenCalled();
      expect(readPresalesProjectTaskPurgeSnapshot).not.toHaveBeenCalled();
    },
  );
});

describe("presales idempotent task route", () => {
  beforeEach(() => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(resolvePresalesTaskCredentialForFiles).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-create-task",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(completePresalesTaskReservation).mockResolvedValue(undefined);
    vi.mocked(releasePresalesTaskReservation).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(recordPresalesUpstreamResource).mockReset();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
  });

  it("calls upstream once with the hash and trusted Pro profile", async () => {
    const keyHash = "a".repeat(64);
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-1",
      attemptId: "attempt-1",
      keyHash,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const createMock = vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "task-1", status: "queued" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          attachments: [],
          idempotencyKey: "project-123:knowledge-base:create",
          agentProfile: "frontmind-pro",
        }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ id: "task-1" });
    });

    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][1]).toMatchObject({
      prompt: "build knowledge base",
      agentProfile: "manus-1.6-max",
      taskMode: "agent",
    });
    expect(JSON.stringify(createMock.mock.calls[0][1])).not.toContain(
      "idempotencyKey",
    );
    expect(createMock.mock.calls[0][2]).toMatchObject({
      headers: { "Idempotency-Key": keyHash },
    });
    expect(completePresalesTaskReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation-1",
        attemptId: "attempt-1",
        upstreamTaskId: "task-1",
      }),
    );
  });

  it("adopts a known upstream task when local reservation completion fails", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-delete-race",
      attemptId: "attempt-delete-race",
      keyHash: "b".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(completePresalesTaskReservation).mockRejectedValueOnce(
      new AuthServiceError("NOT_FOUND", "Task reservation not found"),
    );
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "task-delete-race", status: "queued" },
    });
    const cleanup = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: null,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:delete-race:create",
          projectId: "project-20260728-0001",
        }),
      });
      expect(response.status).toBe(502);
    });

    expect(cleanup).not.toHaveBeenCalled();
    expect(releasePresalesTaskReservation).not.toHaveBeenCalled();
    expect(retainPresalesTaskPurgeTarget).toHaveBeenCalledWith({
      reservationId: "reservation-delete-race",
      attemptId: "attempt-delete-race",
      apiCredentialId: "credential-1",
      upstreamTaskId: "task-delete-race",
    });
  });

  it("retains a known task ID without attempting Provider compensation", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-cleanup-retry",
      attemptId: "attempt-cleanup-retry",
      keyHash: "e".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(completePresalesTaskReservation).mockRejectedValueOnce(
      new AuthServiceError("NOT_FOUND", "Task attachment is gone"),
    );
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "task-cleanup-retry", status: "queued" },
    });
    const cleanup = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 503,
      data: { message: "provider unavailable" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:cleanup-retry:create",
          projectId: "project-20260728-0001",
        }),
      });
      expect(response.status).toBe(502);
    });

    expect(retainPresalesTaskPurgeTarget).toHaveBeenCalledWith({
      reservationId: "reservation-cleanup-retry",
      attemptId: "attempt-cleanup-retry",
      apiCredentialId: "credential-1",
      upstreamTaskId: "task-cleanup-retry",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(releasePresalesTaskReservation).not.toHaveBeenCalled();
  });

  it("registers a synchronously completed typed output file before returning the created task", async () => {
    const keyHash = "d".repeat(64);
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-completed-output",
      attemptId: "attempt-completed-output",
      keyHash,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "task-completed-output",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_file",
                file_id: "file-assessment-json",
                filename: "raw-output.json",
                mime_type: "application/json",
              },
            ],
          },
        ],
      },
    });
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "file-assessment-json",
        filename: "raw-output.json",
        mime_type: "application/json",
      },
    });

    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationStarted!: () => void;
    const registrationStartedPromise = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    vi.mocked(recordPresalesUpstreamResource).mockImplementation(
      async (input) => {
        if (input.kind === "file") {
          registrationStarted();
          await registrationGate;
        }
        return undefined as never;
      },
    );

    let responseSettled = false;
    const responsePromise = withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "evaluate current GEO state",
          idempotencyKey: "project-123:assessment:create",
        }),
      });
      responseSettled = true;
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        id: "task-completed-output",
        status: "completed",
      });
    });

    await registrationStartedPromise;
    expect(responseSettled).toBe(false);
    expect(recordPresalesUpstreamResource).toHaveBeenCalledWith({
      apiCredentialId: "credential-1",
      kind: "file",
      upstreamId: "file-assessment-json",
      parentTaskId: "task-completed-output",
      contentSource: "assistant_output",
      verifiedAssistantOutput: true,
    });

    releaseRegistration();
    await responsePromise;
  });

  it("retains a known output file without Provider deletion", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-output-cleanup",
      attemptId: "attempt-output-cleanup",
      keyHash: "f".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "task-output-cleanup",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_file",
                file_id: "file-output-cleanup",
                filename: "output.md",
              },
            ],
          },
        ],
      },
    });
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { id: "file-output-cleanup", filename: "output.md" },
    });
    const cleanup = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 503,
      data: { message: "provider unavailable" },
    });
    vi.mocked(recordPresalesUpstreamResource).mockRejectedValueOnce(
      new AuthServiceError("PROJECT_DELETED", "parent task deleted"),
    );

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "produce output",
          idempotencyKey: "project-123:output-cleanup:create",
          projectId: "project-20260728-0001",
        }),
      });
      expect(response.status).toBe(201);
    });

    expect(retainPresalesProjectFilePurgeTarget).toHaveBeenCalledWith({
      projectId: "project-20260728-0001",
      fileId: "file-output-cleanup",
      apiCredentialId: "credential-1",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(deletePresalesFileEvidence).not.toHaveBeenCalledWith({
      fileId: "file-output-cleanup",
      apiCredentialId: "credential-1",
    });
  });

  it("replays the live completed task and its typed assistant output without creating another task", async () => {
    const fencedTranslation = [
      "```json",
      JSON.stringify({
        schemaVersion: 1,
        sourceQuestionSha256:
          "e7b3f48b10ca7e0feed2605caca8ca4604ffa386561788ddc8c459b9ac88081b",
        questionEnglish: "Is SiliconFlow reliable?",
      }),
      "```",
    ].join("\n");
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "completed",
      upstreamTaskId: "task-original",
    });
    const createMock = vi.spyOn(axios, "post");
    const retrieveMock = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "task-original",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: { value: fencedTranslation },
              },
            ],
          },
        ],
      },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("idempotent-replayed")).toBe("true");
      await expect(response.json()).resolves.toMatchObject({
        id: "task-original",
        status: "completed",
        output: [
          {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: { value: fencedTranslation },
              },
            ],
          },
        ],
      });
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(retrieveMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/tasks/task-original"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-create-task",
        }),
      }),
    );
  });

  it("keeps an unfinished replay unfinished while refreshing its live status", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "completed",
      upstreamTaskId: "task-running",
    });
    const createMock = vi.spyOn(axios, "post");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { id: "task-running", status: "running" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("idempotent-replayed")).toBe("true");
      await expect(response.json()).resolves.toEqual({
        id: "task-running",
        status: "running",
      });
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 425 with Retry-After while another process owns the lease", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockRejectedValue(
      new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "相同任务正在创建中，请稍后重试",
        2_000,
      ),
    );
    const createMock = vi.spyOn(axios, "post");

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(425);
      expect(response.headers.get("retry-after")).toBe("2");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "IDEMPOTENCY_PENDING" },
      });
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("releases the reservation after a known upstream failure", async () => {
    const acquired = {
      state: "acquired" as const,
      reservationId: "reservation-failed",
      attemptId: "attempt-failed",
      keyHash: "b".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue(acquired);
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 503,
      data: { message: "upstream unavailable" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UPSTREAM_TASK_CREATE_FAILED" },
      });
    });
    expect(releasePresalesTaskReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: acquired.reservationId,
        attemptId: acquired.attemptId,
      }),
    );
    expect(completePresalesTaskReservation).not.toHaveBeenCalled();
  });

  it("keeps the lease after an ambiguous transport failure", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-timeout",
      attemptId: "attempt-timeout",
      keyHash: "c".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(axios, "post").mockRejectedValue(new Error("request timed out"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(502);
    });
    expect(releasePresalesTaskReservation).not.toHaveBeenCalled();
    expect(completePresalesTaskReservation).not.toHaveBeenCalled();
  });
});
