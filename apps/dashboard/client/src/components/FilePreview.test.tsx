import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachmentExpiresAt } from "@/lib/attachment-expiry";
import FilePreview, {
  FileContentRequestError,
  readFileContentError,
} from "./FilePreview";

const mocks = vi.hoisted(() => ({
  pdfProps: vi.fn(),
}));

vi.mock("./PdfDocumentViewer", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.pdfProps(props);
    return <div data-testid="pdf-document-viewer" />;
  },
}));

describe("FilePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("maps expired and unavailable owned-file responses to re-upload guidance", async () => {
    await expect(
      readFileContentError(
        new Response(
          JSON.stringify({
            error: {
              code: "SOURCE_EXPIRED",
              message: "gone",
              retryable: false,
              recoveryAction: "reupload",
            },
          }),
          { status: 410, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ).resolves.toMatchObject({
      message: "文件已超过 30 天，请重新上传",
      retryable: false,
      recoveryAction: "reupload",
    });
    await expect(
      readFileContentError(
        new Response(
          JSON.stringify({ error: { code: "SOURCE_UNAVAILABLE" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ).resolves.toMatchObject({
      message: "文件内容已不可用，请重新上传",
      recoveryAction: "reupload",
    });
  });

  it.each([
    ["SOURCE_EXPIRED", "reupload"],
    ["SOURCE_UNAVAILABLE", "reupload"],
    ["SOURCE_FORBIDDEN", "contact_admin"],
    ["INVALID_PDF", "reupload"],
  ] as const)(
    "never retries terminal file code %s even when the server asks to retry",
    (code, recoveryAction) => {
      expect(
        new FileContentRequestError("unsafe server response", {
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

  it("passes a live PDF through the local source without remote preparation", async () => {
    const sourceFile = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
    });
    render(
      <FilePreview
        file={{
          id: "attachment-1",
          type: "file",
          name: "report.pdf",
          fileId: "remote-file-1",
          file: sourceFile,
          expiresAt: attachmentExpiresAt(),
        }}
      />,
    );

    fireEvent.click(screen.getByText("report.pdf").closest('[role="button"]')!);

    await screen.findByTestId("pdf-document-viewer");
    expect(mocks.pdfProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "local",
          file: sourceFile,
        }),
      }),
    );
  });

  it("uses an explicit raw fileId for a hydrated PDF", async () => {
    render(
      <FilePreview
        file={{
          id: "attachment-2",
          type: "file",
          name: "hydrated.pdf",
          fileId: "/folder/中文 # file",
          expiresAt: attachmentExpiresAt(),
        }}
      />,
    );

    fireEvent.click(
      screen.getByText("hydrated.pdf").closest('[role="button"]')!,
    );

    await screen.findByTestId("pdf-document-viewer");
    expect(mocks.pdfProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "owned_file",
          fileId: "/folder/中文 # file",
        }),
      }),
    );
  });

  it("renders an expired attachment as a disabled re-upload card", async () => {
    render(
      <FilePreview
        file={{
          id: "attachment-expired",
          type: "file",
          name: "expired.pdf",
          fileId: "expired-file",
          expiresAt: Date.now() - 1,
          expired: true,
        }}
      />,
    );

    const card = screen.getByRole("button", { name: /expired\.pdf/i });
    expect(card).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("文件已超过 30 天，请重新上传"),
    ).toBeInTheDocument();
    fireEvent.click(card);

    await waitFor(() => expect(mocks.pdfProps).not.toHaveBeenCalled());
    expect(screen.queryByTestId("pdf-document-viewer")).not.toBeInTheDocument();
  });

  it("shows a retry action when a non-PDF owned download has a transient failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "SOURCE_DOWNLOAD_FAILED",
                message: "文件服务繁忙",
                retryable: true,
                recoveryAction: "retry",
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    render(
      <FilePreview
        file={{
          id: "attachment-zip",
          type: "file",
          name: "资料.zip",
          fileId: "folder/资料 #1",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
        }}
      />,
    );

    fireEvent.click(screen.getByText("资料.zip").closest('[role="button"]')!);
    fireEvent.click(screen.getByRole("button", { name: "下载文件" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(72_000);
    });

    expect(screen.getByText("文件服务繁忙")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重试下载" }),
    ).toBeInTheDocument();
  });
});
