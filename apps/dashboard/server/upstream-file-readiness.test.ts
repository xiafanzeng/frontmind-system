import { afterEach, describe, expect, it, vi } from "vitest";

import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";
import {
  checkUpstreamFileReadiness,
  UpstreamFileReadinessError,
  waitForUpstreamFilesReady,
} from "./upstream-file-readiness";

const base = {
  baseUrl: "https://api.example.test/",
  apiKey: "secret-test-key",
  file: { fileId: "file-1", filename: "provider-name.pdf" },
};

function detail(
  status: "pending" | "uploaded" | "deleted" | "error",
  overrides: Partial<Awaited<ReturnType<ManusV2Client["fileDetail"]>>> = {},
) {
  return {
    fileId: base.file.fileId,
    filename: base.file.filename,
    status,
    bytes: status === "uploaded" ? 12 : null,
    expiresAt: 2_000_000_000,
    contentType: "application/pdf",
    requestId: "request-1",
    ...overrides,
  };
}

describe("upstream file readiness v2", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the unified Manus v2 file.detail client", async () => {
    const fileDetail = vi
      .spyOn(ManusV2Client.prototype, "fileDetail")
      .mockResolvedValue(detail("uploaded"));

    await expect(checkUpstreamFileReadiness(base)).resolves.toMatchObject({
      ...base.file,
      state: "uploaded",
    });
    expect(fileDetail).toHaveBeenCalledWith(base.file.fileId, {
      signal: undefined,
    });
  });

  it("waits pending metadata with bounded backoff before succeeding", async () => {
    vi.spyOn(ManusV2Client.prototype, "fileDetail")
      .mockResolvedValueOnce(detail("pending"))
      .mockResolvedValueOnce(detail("pending"))
      .mockResolvedValueOnce(detail("uploaded"));
    const delays: number[] = [];

    const result = await waitForUpstreamFilesReady({
      ...base,
      files: [base.file],
      deadlineMs: 10_000,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays).toEqual([500, 1_000]);
    expect(result.pending).toEqual([]);
    expect(result.ready).toHaveLength(1);
  });

  it("returns pending when the readiness deadline is reached", async () => {
    vi.spyOn(ManusV2Client.prototype, "fileDetail").mockResolvedValue(
      detail("pending"),
    );
    const result = await waitForUpstreamFilesReady({
      ...base,
      files: [base.file],
      deadlineMs: 0,
    });
    expect(result.pending).toHaveLength(1);
    expect(result.ready).toEqual([]);
  });

  it("supports a provider-authoritative normalized filename", async () => {
    vi.spyOn(ManusV2Client.prototype, "fileDetail").mockResolvedValue(
      detail("uploaded", { filename: "provider-normalized.pdf" }),
    );
    await expect(
      checkUpstreamFileReadiness({
        ...base,
        filenamePolicy: "provider_authoritative",
      }),
    ).resolves.toMatchObject({ filename: "provider-normalized.pdf" });
    await expect(checkUpstreamFileReadiness(base)).rejects.toMatchObject({
      code: "UPSTREAM_FILE_IDENTITY_MISMATCH",
    });
  });

  it("fails closed for deleted and error leases", async () => {
    const fileDetail = vi.spyOn(ManusV2Client.prototype, "fileDetail");
    for (const status of ["deleted", "error"] as const) {
      fileDetail.mockResolvedValueOnce(detail(status));
      await expect(checkUpstreamFileReadiness(base)).rejects.toBeInstanceOf(
        UpstreamFileReadinessError,
      );
    }
  });

  it("classifies a transient v2 metadata failure safely", async () => {
    vi.spyOn(ManusV2Client.prototype, "fileDetail").mockRejectedValue(
      new ManusV2ApiError(
        "file.detail",
        503,
        "UPSTREAM_BUSY",
        true,
        false,
        "request-safe",
      ),
    );
    await expect(checkUpstreamFileReadiness(base)).rejects.toMatchObject({
      code: "UPSTREAM_FILE_METADATA_UNAVAILABLE",
      retryable: true,
      httpStatus: 503,
      message: "Upstream file metadata is temporarily unavailable",
    });
  });
});
