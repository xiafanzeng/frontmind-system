import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import preparedFileRouter, {
  boundedPreparedDownloadExpiry,
  parseByteRange,
  resolvePreparedSourceInput,
} from "./prepared-file-router";
import {
  createPreparedAssetId,
  migratePreparedManifestResolver,
  preparedExternalRequestFailure,
  preparedExternalUpstreamFailure,
  preparedManifestMatchesFileSource,
  preparedManifestMatchesOwnedFileSource,
  preparedFileService,
  preparedFilePublicStatus,
  PreparedFileError,
  type PreparedFileManifest,
} from "./prepared-file-service";
import { OWNED_FILE_CONTENT_RESOLVER_VERSION } from "./owned-file-content-resolver";
import { ExternalUrlRejectedError } from "./_core/safe-external-url";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepared PDF byte ranges", () => {
  it("returns the complete response when Range is absent", () => {
    expect(parseByteRange(undefined, 1_000)).toBeNull();
  });

  it("parses bounded and open-ended ranges", () => {
    expect(parseByteRange("bytes=0-65535", 100_000)).toEqual({
      start: 0,
      end: 65_535,
    });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it("parses suffix ranges and clamps them to the file", () => {
    expect(parseByteRange("bytes=-100", 1_000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseByteRange("bytes=-2000", 1_000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it.each(["bytes=", "items=0-2", "bytes=5-2", "bytes=1000-", "bytes=0-1,5-6"])(
    "rejects invalid or unsupported range %s",
    (range) => {
      expect(parseByteRange(range, 1_000)).toBe("invalid");
    },
  );

  it("serves a byte range with explicit no-store cache semantics", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-prepared-range-"),
    );
    const assetId = "a".repeat(40);
    const pdfPath = path.join(directory, `${assetId}.pdf`);
    const bytes = Buffer.from("%PDF-1.7\nrange-payload");
    await fs.writeFile(pdfPath, bytes);
    const manifest: PreparedFileManifest = {
      version: 1,
      id: assetId,
      ownerUserId: 7,
      credentialId: "credential-1",
      projectAssignmentId: null,
      source: { kind: "external", url: "https://objects.example/report.pdf" },
      filename: "范围测试.pdf",
      mimeType: "application/pdf",
      status: "ready",
      phase: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
      size: bytes.length,
      etag: "range-etag",
      expiresAt: Date.now() + 60_000,
    };
    vi.spyOn(preparedFileService, "getReadyManifest").mockResolvedValue(
      manifest,
    );
    vi.spyOn(preparedFileService, "contentPath").mockReturnValue(pdfPath);
    vi.spyOn(preparedFileService, "beginUse").mockImplementation(() => {});
    vi.spyOn(preparedFileService, "endUse").mockImplementation(() => {});

    const app = express();
    app.use((req, _res, next) => {
      req.frontmindUser = { id: 7 } as typeof req.frontmindUser;
      next();
    });
    app.use(preparedFileRouter);
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("NO_ADDRESS");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/${assetId}/content`,
        { headers: { Range: "bytes=0-7" } },
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      expect(response.headers.get("content-range")).toBe(
        `bytes 0-7/${bytes.length}`,
      );
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        bytes.subarray(0, 8),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("prepared PDF asset identity", () => {
  it("is stable for the same owned upstream file", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "file",
      fileId: "file-123",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "file",
      fileId: "file-123",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{40}$/);
  });

  it("isolates assets by owner and credential", () => {
    const source = { kind: "file" as const, fileId: "file-123" };
    expect(createPreparedAssetId(7, "credential-1", source)).not.toBe(
      createPreparedAssetId(8, "credential-1", source),
    );
    expect(createPreparedAssetId(7, "credential-1", source)).not.toBe(
      createPreparedAssetId(7, "credential-2", source),
    );
  });

  it("keeps a stable external asset id when only an AWS signing envelope changes", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=one&X-Amz-Signature=old",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=two&X-Amz-Signature=new",
    });
    expect(first).toBe(second);
  });

  it("never removes a generic business token from external content identity", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?token=document-a",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?token=document-b",
    });
    expect(first).not.toBe(second);
  });

  it("keeps content-selecting query parameters in the asset identity", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?file=report-a.pdf&signature=old",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?file=report-b.pdf&signature=new",
    });
    expect(first).not.toBe(second);
  });
});

describe("prepared PDF source contract", () => {
  it("accepts explicit fileId or legacy fileUrl, but never both", () => {
    expect(resolvePreparedSourceInput({ fileId: "file-123" })).toEqual({
      kind: "file",
      fileId: "file-123",
    });
    expect(
      resolvePreparedSourceInput({
        fileUrl: "/api/frontmind/v1/files/file%20legacy/content",
      }),
    ).toEqual({ kind: "file", fileId: "file legacy" });
    expect(() =>
      resolvePreparedSourceInput({
        fileId: "file-123",
        fileUrl: "/api/frontmind/v1/files/file-123",
      }),
    ).toThrowError(expect.objectContaining({ code: "AMBIGUOUS_FILE_SOURCE" }));
    expect(() => resolvePreparedSourceInput({})).toThrowError(
      expect.objectContaining({ code: "MISSING_FILE_SOURCE" }),
    );
  });

  it("bounds a token by both five minutes and source retention", () => {
    const now = 1_000_000;
    expect(boundedPreparedDownloadExpiry(now)).toBe(now + 5 * 60 * 1_000);
    expect(boundedPreparedDownloadExpiry(now, now + 2_000)).toBe(now + 2_000);
  });
});

describe("prepared PDF resolver migration and recovery policy", () => {
  function failedLegacyManifest(): PreparedFileManifest {
    return {
      version: 1,
      id: "a".repeat(40),
      ownerUserId: 7,
      credentialId: "credential-1",
      projectAssignmentId: null,
      source: { kind: "file", fileId: "file-123" },
      filename: "report.pdf",
      mimeType: "application/pdf",
      status: "failed",
      phase: "failed",
      createdAt: 1,
      updatedAt: 2,
      lastAccessedAt: 2,
      expiresAt: 50_000,
      errorCode: "SOURCE_EXPIRED",
      errorMessage: "old upload_url reader failed",
    };
  }

  it("requeues an old failed file resolver exactly once", () => {
    const manifest = failedLegacyManifest();
    expect(migratePreparedManifestResolver(manifest, 10)).toEqual({
      changed: true,
      requeued: true,
    });
    expect(manifest).toMatchObject({
      sourceResolverVersion: OWNED_FILE_CONTENT_RESOLVER_VERSION,
      status: "queued",
      phase: "queued",
      updatedAt: 10,
    });
    expect(manifest).not.toHaveProperty("errorCode");
    expect(migratePreparedManifestResolver(manifest, 20)).toEqual({
      changed: false,
      requeued: false,
    });
  });

  it("publishes retry, recovery and millisecond expiry fields", () => {
    const manifest = failedLegacyManifest();
    manifest.errorCode = "SOURCE_EXPIRED";
    manifest.retryable = false;
    manifest.recoveryAction = "reupload";
    manifest.expiresAt = 1_800_000_000_000;

    expect(preparedFilePublicStatus(manifest)).toMatchObject({
      status: "failed",
      retryable: false,
      recoveryAction: "reupload",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("matches account assets by owner and project assets by project", () => {
    const accountManifest = failedLegacyManifest();
    expect(
      preparedManifestMatchesOwnedFileSource(accountManifest, {
        ownerUserId: 7,
        fileId: "file-123",
      }),
    ).toBe(true);
    expect(
      preparedManifestMatchesOwnedFileSource(accountManifest, {
        ownerUserId: 8,
        fileId: "file-123",
      }),
    ).toBe(false);

    const projectManifest = failedLegacyManifest();
    projectManifest.ownerUserId = 99;
    projectManifest.projectAssignmentId = "project-a";
    expect(
      preparedManifestMatchesOwnedFileSource(projectManifest, {
        ownerUserId: 7,
        fileId: "file-123",
        projectAssignmentId: "project-a",
      }),
    ).toBe(true);
    expect(preparedManifestMatchesFileSource(projectManifest, "file-123")).toBe(
      true,
    );
    expect(
      preparedManifestMatchesFileSource(projectManifest, "file-other"),
    ).toBe(false);
  });

  it("keeps PreparedFileError recovery metadata available to routers", () => {
    const error = new PreparedFileError("SOURCE_FORBIDDEN", "forbidden");
    expect(error.retryable).toBe(false);
    expect(error.recoveryAction).toBe("contact_admin");
  });

  it.each([401, 403, 404, 410])(
    "treats external upstream HTTP %s as terminal source unavailability",
    (status) => {
      expect(preparedExternalUpstreamFailure(status)).toMatchObject({
        code: "SOURCE_UNAVAILABLE",
        retryable: false,
        recoveryAction: "reupload",
      });
    },
  );

  it.each([408, 429, 500, 503])(
    "retries only transient external upstream HTTP %s",
    (status) => {
      expect(preparedExternalUpstreamFailure(status)).toMatchObject({
        code: "SOURCE_DOWNLOAD_FAILED",
        retryable: true,
        recoveryAction: "retry",
      });
    },
  );

  it("does not retry deterministic external upstream client errors", () => {
    expect(preparedExternalUpstreamFailure(422)).toMatchObject({
      code: "SOURCE_DOWNLOAD_FAILED",
      retryable: false,
      recoveryAction: "contact_admin",
    });
  });

  it("does not retry external redirects rejected by the SSRF policy", () => {
    expect(
      preparedExternalRequestFailure(
        new ExternalUrlRejectedError("blocked private address"),
      ),
    ).toMatchObject({
      code: "SOURCE_REDIRECT_REJECTED",
      retryable: false,
      recoveryAction: "contact_admin",
    });
    expect(
      preparedExternalRequestFailure({
        cause: new ExternalUrlRejectedError("blocked redirect address"),
      }),
    ).toMatchObject({
      code: "SOURCE_REDIRECT_REJECTED",
      retryable: false,
    });
  });
});
