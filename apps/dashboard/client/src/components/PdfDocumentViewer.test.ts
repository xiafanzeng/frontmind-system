import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PDF_DOWNLOAD_TOKEN_RETRY_DELAYS_MS,
  PDF_PREPARATION_RETRY_DELAYS_MS,
  PDF_READY_CONTENT_RETRY_DELAYS_MS,
  prepareRemotePdf,
  preferredPreparedPdfFailure,
  preparedPdfDocumentFailure,
  preparedPdfRequestFailure,
  requestPreparedPdfDownloadUrl,
} from "./PdfDocumentViewer";

describe("prepareRemotePdf", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the bounded 2s, 10s and 60s automatic retry schedule", () => {
    expect(PDF_PREPARATION_RETRY_DELAYS_MS).toEqual([2_000, 10_000, 60_000]);
    expect(PDF_READY_CONTENT_RETRY_DELAYS_MS).toEqual([2_000, 10_000, 60_000]);
    expect(PDF_DOWNLOAD_TOKEN_RETRY_DELAYS_MS).toEqual([2_000, 10_000, 60_000]);
  });

  it.each([
    ["SOURCE_EXPIRED", "reupload"],
    ["SOURCE_UNAVAILABLE", "reupload"],
    ["SOURCE_FORBIDDEN", "contact_admin"],
    ["INVALID_PDF", "reupload"],
  ] as const)(
    "never retries terminal PDF code %s even when the server asks to retry",
    (errorCode, recoveryAction) => {
      expect(
        preferredPreparedPdfFailure(
          { errorCode, retryable: true, recoveryAction: "retry" },
          null,
        ),
      ).toMatchObject({
        errorCode,
        retryable: false,
        recoveryAction,
      });
    },
  );

  it("retries a ready PDF download-token request after 2s, 10s and 60s", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (fetchMock.mock.calls.length < 4) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ downloadUrl: "/download/file" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestPreparedPdfDownloadUrl("/download-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [index, delay] of PDF_DOWNLOAD_TOKEN_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    }
    await expect(pending).resolves.toBe("/download/file");
  });

  it("gives the current request failure priority over a stale processing snapshot", () => {
    expect(
      preferredPreparedPdfFailure(
        { retryable: false, recoveryAction: null },
        {
          failureScope: "prepare",
          retryable: true,
          recoveryAction: "retry",
        },
      ),
    ).toMatchObject({
      failureScope: "prepare",
      retryable: true,
      recoveryAction: "retry",
    });
  });

  it("retries ready-content network failures but not invalid PDFs or aborts", () => {
    expect(preparedPdfDocumentFailure(new TypeError("offline"))).toMatchObject({
      retryable: true,
      recoveryAction: "retry",
    });
    expect(
      preparedPdfDocumentFailure({
        name: "InvalidPDFException",
        message: "bad pdf",
      }),
    ).toMatchObject({
      errorCode: "INVALID_PDF",
      retryable: false,
      recoveryAction: "reupload",
    });
    expect(preparedPdfDocumentFailure({ name: "AbortError" })).toBeNull();
  });

  it("sends an explicit fileId without rebuilding a path URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          assetId: "asset-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
          status: "queued",
          phase: "queued",
          contentUrl: "/content",
          downloadTokenUrl: "/download",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await prepareRemotePdf({ fileId: "folder/中文 file" }, "report.pdf");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/assets/prepare",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fileId: "folder/中文 file",
          fileName: "report.pdf",
        }),
      }),
    );
  });

  it("preserves retry and re-upload recovery metadata from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "文件内容保留期已结束",
              retryable: false,
              recoveryAction: "reupload",
              expiresAt: 123,
            },
          }),
          { status: 410, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      prepareRemotePdf({ fileId: "expired" }, "expired.pdf"),
    ).rejects.toMatchObject({
      message: "文件已超过 30 天，请重新上传",
      errorCode: "SOURCE_EXPIRED",
      retryable: false,
      recoveryAction: "reupload",
      expiresAt: 123,
    });
  });

  it("classifies non-abort network failures as retryable", async () => {
    expect(
      preparedPdfRequestFailure(new TypeError("Failed to fetch")),
    ).toMatchObject({
      retryable: true,
      recoveryAction: "retry",
    });
    expect(preparedPdfRequestFailure({ name: "AbortError" })).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(
      prepareRemotePdf({ fileId: "network-file" }, "network.pdf"),
    ).rejects.toMatchObject({
      retryable: true,
      recoveryAction: "retry",
    });
  });

  it("defaults 429 and 5xx API responses to retry recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      prepareRemotePdf({ fileId: "busy-file" }, "busy.pdf"),
    ).rejects.toMatchObject({
      retryable: true,
      recoveryAction: "retry",
    });
  });
});
