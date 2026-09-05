import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImagePreview, {
  fetchImageWithAuth,
  ImageContentRequestError,
  IMAGE_OWNED_FILE_RETRY_DELAYS_MS,
} from "./ImagePreview";

describe("fetchImageWithAuth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never treats a metadata upload_url as a GET download capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          upload_url: "https://uploads.example/put-only?signature=secret",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithAuth("/api/frontmind/v1/files/file-image"),
    ).rejects.toThrow("服务返回的不是有效图片");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a knowledge-base JSON response and does not attach project headers", async () => {
    const sourceUrl =
      "/api/knowledge-base/artifacts/resources/opaque-resource-handle";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "知识库资源不存在",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchImageWithAuth(sourceUrl)).rejects.toThrow(
      "知识库资源不存在",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({
        credentials: "include",
        headers: undefined,
      }),
    );
  });

  it("never offers a failed knowledge-base resource JSON for download", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "知识库资源不存在",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(ImagePreview, {
        src: "/api/knowledge-base/artifacts/resources/opaque-resource-handle",
        alt: "企业官方主 Logo",
        showDownload: true,
      }),
    );

    expect(await screen.findByText("知识库资源不存在")).toBeInTheDocument();
    expect(screen.queryByText("点击下载")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("rejects a successful non-image knowledge-base response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not an image", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithAuth(
        "/api/knowledge-base/artifacts/resources/opaque-resource-handle",
      ),
    ).rejects.toThrow("服务返回的不是有效图片");
  });

  it.each([
    ["SOURCE_EXPIRED", "reupload"],
    ["SOURCE_UNAVAILABLE", "reupload"],
    ["SOURCE_FORBIDDEN", "contact_admin"],
    ["INVALID_PDF", "reupload"],
  ] as const)(
    "never retries terminal image code %s even when the server asks to retry",
    (code, recoveryAction) => {
      expect(
        new ImageContentRequestError("unsafe server response", {
          code,
          retryable: true,
          recoveryAction: "retry",
        }),
      ).toMatchObject({
        code,
        retryable: false,
        recoveryAction,
      });
    },
  );

  it("retries an owned image after 2s, 10s and 60s, then stops", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(ImagePreview, {
        src: "/api/frontmind/v1/files/file-owned-image",
        alt: "客户图片",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (const [index, delay] of IMAGE_OWNED_FILE_RETRY_DELAYS_MS.entries()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
      expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/图片读取网络异常/)).toBeInTheDocument();
  });

  it("shows a 30-day expiry without retrying the owned image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "SOURCE_EXPIRED",
            retryable: false,
            recoveryAction: "reupload",
          },
        }),
        { status: 410, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(ImagePreview, {
        src: "/api/frontmind/v1/files/file-expired-image",
        alt: "过期图片",
      }),
    );

    expect(
      await screen.findByText("文件已超过 30 天，请重新上传"),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
  });
});
