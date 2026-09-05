/**
 * FilePreview Component - Preview and download files
 * Features: File type icon, file info, download button, inline PDF viewer,
 *           HTML file rendering, text file preview.
 */
import { lazy, Suspense, useCallback, useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  FileText,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Download,
  X,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deliveryProjectHeaders, sanitizeBrandText } from "@/lib/frontmind-api";
import type { Attachment } from "@/contexts/ConversationContext";
import { isAttachmentExpired } from "@/lib/attachment-expiry";
import {
  filePreviewSource,
  type FilePreviewSource,
} from "@/lib/file-preview-source";

const PdfDocumentViewer = lazy(() => import("./PdfDocumentViewer"));

export const FILE_CONTENT_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const;

interface FilePreviewProps {
  file: Attachment;
  className?: string;
  showDownload?: boolean;
}

// Get file icon based on MIME type
function getFileIcon(mimeType: string | undefined, fileName: string) {
  if (mimeType?.startsWith("image/")) return FileImage;
  if (mimeType?.startsWith("video/")) return File;
  if (mimeType?.startsWith("audio/")) return File;
  if (mimeType?.includes("pdf")) return FileText;
  if (
    mimeType?.includes("zip") ||
    mimeType?.includes("tar") ||
    mimeType?.includes("rar")
  )
    return FileArchive;
  if (
    mimeType?.includes("json") ||
    mimeType?.includes("xml") ||
    mimeType?.includes("html") ||
    mimeType?.includes("css") ||
    mimeType?.includes("javascript")
  )
    return FileCode;
  if (
    mimeType?.includes("sheet") ||
    mimeType?.includes("excel") ||
    mimeType?.includes("csv")
  )
    return FileSpreadsheet;
  if (mimeType?.includes("word") || mimeType?.includes("document"))
    return FileText;

  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return FileText;
    case "zip":
    case "tar":
    case "gz":
    case "rar":
    case "7z":
      return FileArchive;
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
    case "py":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "css":
    case "html":
    case "json":
    case "xml":
      return FileCode;
    case "xls":
    case "xlsx":
    case "csv":
      return FileSpreadsheet;
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return FileImage;
    default:
      return File;
  }
}

// Format file size
function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isPdfFile(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType?.includes("pdf")) return true;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "pdf";
}

function isHtmlFile(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType?.includes("html")) return true;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "html" || ext === "htm";
}

function isPreviewableFile(
  mimeType: string | undefined,
  fileName: string,
): boolean {
  return isPdfFile(mimeType, fileName) || isHtmlFile(mimeType, fileName);
}

function buildProxyDownloadUrl(
  fileUrl: string,
  fileName?: string,
  asDownload = false,
): string | null {
  try {
    const parsed = new URL(fileUrl, window.location.origin);
    if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
      if (fileName)
        parsed.searchParams.set("filename", sanitizeBrandText(fileName));
      if (asDownload) parsed.searchParams.set("download", "1");
      return `${parsed.pathname}${parsed.search}`;
    }
    if (/^https?:\/\//i.test(fileUrl)) {
      const params = new URLSearchParams({ url: fileUrl });
      if (fileName) params.set("filename", sanitizeBrandText(fileName));
      if (asDownload) params.set("download", "1");
      return `/api/frontmind/proxy-download?${params.toString()}`;
    }
  } catch {
    // Ignore malformed URLs.
  }
  return null;
}

function nativeDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

type FileRecoveryAction = "retry" | "reupload" | "contact_admin" | null;

export class FileContentRequestError extends Error {
  code?: string;
  retryable: boolean;
  recoveryAction: FileRecoveryAction;
  expiresAt?: number;

  constructor(
    message: string,
    failure: {
      code?: string;
      retryable?: boolean;
      recoveryAction?: FileRecoveryAction;
      expiresAt?: number;
    } = {},
  ) {
    super(message);
    this.name = "FileContentRequestError";
    this.code = failure.code;
    const terminal = terminalFileFailure(failure.code);
    this.retryable = terminal ? false : (failure.retryable ?? false);
    this.recoveryAction =
      terminal?.recoveryAction ?? failure.recoveryAction ?? null;
    this.expiresAt = failure.expiresAt;
  }
}

function terminalFileFailure(
  code: string | undefined,
): { recoveryAction: Exclude<FileRecoveryAction, "retry" | null> } | undefined {
  if (
    code === "SOURCE_EXPIRED" ||
    code === "SOURCE_UNAVAILABLE" ||
    code === "SOURCE_NOT_FOUND" ||
    code === "FILE_NOT_FOUND" ||
    code === "NO_DOWNLOAD_URL" ||
    code === "INVALID_PDF"
  ) {
    return { recoveryAction: "reupload" };
  }
  if (code === "SOURCE_FORBIDDEN") {
    return { recoveryAction: "contact_admin" };
  }
  return undefined;
}

function fileFailureMessage(code: string | undefined, fallback: string) {
  if (code === "SOURCE_EXPIRED") {
    return "文件已超过 30 天，请重新上传";
  }
  if (
    code === "SOURCE_UNAVAILABLE" ||
    code === "SOURCE_NOT_FOUND" ||
    code === "FILE_NOT_FOUND" ||
    code === "NO_DOWNLOAD_URL"
  ) {
    return "文件内容已不可用，请重新上传";
  }
  if (code === "SOURCE_FORBIDDEN") {
    return "当前账号或客户项目无权读取此文件，请联系管理员";
  }
  if (code === "INVALID_PDF") {
    return "文件不是有效的 PDF，请重新上传";
  }
  return fallback;
}

export async function readFileContentError(response: Response) {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    // The HTTP status still gives us a safe recovery policy.
  }
  const code =
    typeof payload?.error?.code === "string"
      ? payload.error.code
      : response.status === 410
        ? "SOURCE_EXPIRED"
        : response.status === 404
          ? "SOURCE_UNAVAILABLE"
          : response.status === 401 || response.status === 403
            ? "SOURCE_FORBIDDEN"
            : undefined;
  const transient =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  const suppliedRecovery = payload?.error?.recoveryAction;
  const recoveryAction: FileRecoveryAction =
    suppliedRecovery === "retry" ||
    suppliedRecovery === "reupload" ||
    suppliedRecovery === "contact_admin"
      ? suppliedRecovery
      : code === "SOURCE_EXPIRED" || code === "SOURCE_UNAVAILABLE"
        ? "reupload"
        : code === "SOURCE_FORBIDDEN"
          ? "contact_admin"
          : transient
            ? "retry"
            : null;
  const fallback =
    typeof payload?.error?.message === "string"
      ? payload.error.message
      : `文件读取失败（HTTP ${response.status}）`;
  return new FileContentRequestError(fileFailureMessage(code, fallback), {
    code,
    retryable:
      typeof payload?.error?.retryable === "boolean"
        ? payload.error.retryable
        : transient,
    recoveryAction,
    expiresAt:
      typeof payload?.error?.expiresAt === "number"
        ? payload.error.expiresAt
        : undefined,
  });
}

function isAbortRequestError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function normalizeFileContentError(
  error: unknown,
  fallback: string,
): FileContentRequestError | null {
  if (isAbortRequestError(error)) return null;
  if (error instanceof FileContentRequestError) return error;
  return new FileContentRequestError(
    error instanceof Error && error.message
      ? `${fallback}（${error.message}）`
      : fallback,
    { retryable: true, recoveryAction: "retry" },
  );
}

/**
 * Fetch a file from the API with proper auth headers and return a blob URL.
 * This is needed because iframe src can't send custom headers.
 *
 * The server proxy at /api/frontmind/v1/files/:id returns the authorized file
 * bytes. An upload capability is never a valid browser download fallback.
 */
async function fetchFileAsBlob(
  source: Extract<FilePreviewSource, { kind: "owned_file" | "external" }>,
  fileName?: string,
  signal?: AbortSignal,
): Promise<string> {
  const url =
    source.kind === "owned_file"
      ? `/api/frontmind/v1/files/${encodeURIComponent(source.fileId)}`
      : buildProxyDownloadUrl(source.url, fileName, false) || source.url;

  const response = await fetch(url, {
    credentials: "include",
    headers: deliveryProjectHeaders(),
    signal,
  });

  if (!response.ok) {
    throw await readFileContentError(response);
  }

  // Do not interpret metadata (especially upload_url) as file bytes.
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new FileContentRequestError("服务返回了文件信息，但未返回文件内容", {
      retryable: false,
      recoveryAction: "contact_admin",
    });
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function waitForFileRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Initial request plus three retries; aborts never consume the retry budget. */
export async function fetchFileAsBlobWithRetry(
  source: Extract<FilePreviewSource, { kind: "owned_file" | "external" }>,
  fileName?: string,
  signal?: AbortSignal,
): Promise<string> {
  let retryIndex = 0;
  while (true) {
    try {
      return await fetchFileAsBlob(source, fileName, signal);
    } catch (error) {
      const failure = normalizeFileContentError(
        error,
        "文件读取网络异常，请稍后重试",
      );
      if (!failure) throw error;
      const retryDelay = FILE_CONTENT_RETRY_DELAYS_MS[retryIndex];
      if (!failure.retryable || retryDelay === undefined) throw failure;
      retryIndex += 1;
      await waitForFileRetry(retryDelay, signal);
    }
  }
}

async function createDirectDownloadUrl(fileId: string): Promise<string> {
  const response = await fetch("/api/frontmind/download-token", {
    method: "POST",
    headers: deliveryProjectHeaders({
      "Content-Type": "application/json",
    }),
    credentials: "include",
    body: JSON.stringify({ fileId }),
  });

  if (!response.ok) {
    throw await readFileContentError(response);
  }

  const data = await response.json();
  if (!data.downloadUrl) {
    throw new Error("下载链接响应缺少有效地址");
  }
  return data.downloadUrl;
}

export default function FilePreview({
  file,
  className,
  showDownload = true,
}: FilePreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] =
    useState<FileContentRequestError | null>(null);
  const [downloadError, setDownloadError] =
    useState<FileContentRequestError | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [expiryNow, setExpiryNow] = useState(() => Date.now());
  const [readerExpired, setReaderExpired] = useState(false);

  const displayFileName = sanitizeBrandText(file.name || "file");
  const Icon = getFileIcon(file.file?.type, displayFileName);
  const fileSize = file.file?.size ? formatFileSize(file.file.size) : "";
  const isPdf = isPdfFile(file.file?.type, displayFileName);
  const isPreviewable = isPreviewableFile(file.file?.type, displayFileName);
  const expired = isAttachmentExpired(file, expiryNow);
  const serverExpired =
    previewError?.code === "SOURCE_EXPIRED" ||
    downloadError?.code === "SOURCE_EXPIRED";
  const contentExpired = expired || serverExpired || readerExpired;
  const previewSource = filePreviewSource(file);

  useEffect(() => {
    if (file.expired === true || file.expiresAt === undefined) return;
    const remaining = file.expiresAt - Date.now();
    if (remaining <= 0) {
      setExpiryNow(Date.now());
      return;
    }
    // Browser timers are signed 32-bit; 30 days needs one intermediate wake.
    const timer = window.setTimeout(
      () => setExpiryNow(Date.now()),
      Math.min(remaining, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [expiryNow, file.expired, file.expiresAt]);

  useEffect(() => {
    if (contentExpired) setIsOpen(false);
  }, [contentExpired]);

  useEffect(() => {
    setReaderExpired(false);
  }, [file.expiresAt, file.fileId]);

  // Load a blob URL only for non-PDF iframe previews.
  // Priority: blobUrl (in-memory) > File object > base64 (convert to blob) > API fileId
  useEffect(() => {
    let cancelled = false;
    let ownedBlobUrl: string | null = null;
    const controller = new AbortController();
    setBlobUrl(null);
    if (!isOpen || !isPreviewable || isPdf || contentExpired) return;

    setLoadingPreview(true);
    setPreviewError(null);

    const useOwnedBlobUrl = (url: string) => {
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      ownedBlobUrl = url;
      setBlobUrl(url);
      setLoadingPreview(false);
    };

    if (file.blobUrl) {
      // The ConversationProvider owns this URL and revokes it at expiry/removal.
      setBlobUrl(file.blobUrl);
      setLoadingPreview(false);
    } else if (file.file) {
      useOwnedBlobUrl(URL.createObjectURL(file.file));
    } else if (file.base64) {
      try {
        const parts = file.base64.split(",");
        const mimeMatch = parts[0]?.match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
        const binaryStr = atob(parts[1]);
        const bytes = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) {
          bytes[j] = binaryStr.charCodeAt(j);
        }
        useOwnedBlobUrl(URL.createObjectURL(new Blob([bytes], { type: mime })));
      } catch (error) {
        console.error("Failed to convert base64 to blob:", error);
        setPreviewError(
          new FileContentRequestError("文件格式转换失败，请重新上传", {
            recoveryAction: "reupload",
          }),
        );
        setLoadingPreview(false);
      }
    } else if (
      previewSource?.kind === "owned_file" ||
      previewSource?.kind === "external"
    ) {
      void fetchFileAsBlobWithRetry(
        previewSource,
        displayFileName,
        controller.signal,
      )
        .then(useOwnedBlobUrl)
        .catch((error) => {
          if (cancelled) return;
          const failure = normalizeFileContentError(
            error,
            "文件读取网络异常，请稍后重试",
          );
          if (!failure) return;
          console.error("Failed to load file preview:", error);
          setPreviewError(failure);
          setLoadingPreview(false);
        });
    } else {
      setPreviewError(
        new FileContentRequestError("没有可用的文件来源，请重新上传", {
          recoveryAction: "reupload",
        }),
      );
      setLoadingPreview(false);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
    };
  }, [
    displayFileName,
    contentExpired,
    isOpen,
    isPdf,
    isPreviewable,
    file.fileId,
    file.file,
    file.base64,
    file.blobUrl,
    previewSource?.kind,
    previewSource?.kind === "owned_file" ? previewSource.fileId : undefined,
    previewSource?.kind === "external" ? previewSource.url : undefined,
    previewAttempt,
  ]);

  const handleDownload = useCallback(async () => {
    if (contentExpired) return;
    if (isPdf) {
      // Remote PDFs must finish server-side brand replacement before download.
      // Opening the shared viewer starts/previews that preparation and exposes
      // the download action only when the sanitized asset is ready.
      setIsOpen(true);
      return;
    }
    setDownloadError(null);
    setIsDownloading(true);
    try {
      let downloadName = displayFileName;

      // Priority: blobUrl > File object > base64 > API fileId
      if (file.blobUrl) {
        // In-memory blob URL (for large files)
        nativeDownload(file.blobUrl, downloadName);
        return;
      }

      if (file.file) {
        // Local File object (available in current session)
        const objectUrl = URL.createObjectURL(file.file);
        nativeDownload(objectUrl, downloadName);
        URL.revokeObjectURL(objectUrl);
        return;
      }

      if (file.base64) {
        // Direct base64/data-URL download
        nativeDownload(file.base64, downloadName);
        return;
      }

      if (previewSource?.kind === "external") {
        const blobUrl = await fetchFileAsBlobWithRetry(
          previewSource,
          downloadName,
        );
        nativeDownload(blobUrl, downloadName);
        URL.revokeObjectURL(blobUrl);
        return;
      }

      if (previewSource?.kind === "owned_file") {
        // Fast path for uploaded files with real file IDs: create a short-lived
        // same-origin URL and let the browser download natively. A file ID is
        // opaque and is never interpreted as a URL.
        try {
          const directUrl = await createDirectDownloadUrl(previewSource.fileId);
          nativeDownload(directUrl, downloadName);
          return;
        } catch (err) {
          console.error("Direct download failed; falling back to fetch:", err);
          const blobUrl = await fetchFileAsBlobWithRetry(
            previewSource,
            downloadName,
          );
          nativeDownload(blobUrl, downloadName);
          URL.revokeObjectURL(blobUrl);
          return;
        }
      }

      throw new FileContentRequestError("没有可用的文件来源，请重新上传", {
        recoveryAction: "reupload",
      });
    } catch (err) {
      console.error("Download failed:", err);
      const failure = normalizeFileContentError(
        err,
        "文件下载网络异常，请稍后重试",
      );
      if (failure) setDownloadError(failure);
      setIsOpen(true);
    } finally {
      setIsDownloading(false);
    }
  }, [contentExpired, displayFileName, file, isPdf, previewSource]);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-card/80 border border-border/70 shadow-sm",
          contentExpired
            ? "cursor-not-allowed opacity-65"
            : "hover:bg-secondary/70 hover:border-primary/25 transition-all cursor-pointer group",
          className,
        )}
        onClick={() => {
          if (!contentExpired) setIsOpen(true);
        }}
        role="button"
        aria-disabled={contentExpired}
        tabIndex={contentExpired ? -1 : 0}
        onKeyDown={(event) => {
          if (!contentExpired && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
      >
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-4 h-4 text-primary/60" />
        </div>
        <div className="flex-1 overflow-hidden">
          <p className="text-xs font-medium text-foreground/70 truncate">
            {displayFileName}
          </p>
          {contentExpired ? (
            <p className="text-xs text-amber-700">
              文件已超过 30 天，请重新上传
            </p>
          ) : fileSize ? (
            <p className="text-xs text-muted-foreground/50">{fileSize}</p>
          ) : null}
        </div>
        {showDownload && !contentExpired && (
          <Button
            variant="ghost"
            size="icon"
            className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
            aria-label={`下载 ${displayFileName}`}
          >
            {isDownloading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </Button>
        )}
      </div>

      <Dialog
        open={isOpen && !contentExpired}
        onOpenChange={(open) => setIsOpen(contentExpired ? false : open)}
      >
        <DialogContent
          showCloseButton={false}
          className={cn(
            "p-0 flex flex-col overflow-hidden",
            isPreviewable ? "sm:max-w-[800px]" : "max-w-md",
          )}
          style={
            isPreviewable
              ? { width: 800, height: 640, maxWidth: "95vw", maxHeight: "95vh" }
              : undefined
          }
        >
          <DialogTitle className="sr-only">{displayFileName}</DialogTitle>

          {isPdf && previewSource ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  正在启动 PDF 阅读器…
                </div>
              }
            >
              <PdfDocumentViewer
                fileName={displayFileName}
                source={previewSource}
                onClose={() => setIsOpen(false)}
                onExpired={() => {
                  setReaderExpired(true);
                  setIsOpen(false);
                }}
              />
            </Suspense>
          ) : isPdf ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              没有可用的 PDF 文件来源
            </div>
          ) : isPreviewable ? (
            <>
              {/* Previewable file header */}
              <div className="flex items-center justify-between px-6 py-3 border-b border-border/30 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground/80 truncate max-w-[400px]">
                    {displayFileName}
                  </span>
                  {fileSize && (
                    <span className="text-xs text-muted-foreground/50 ml-1">
                      {fileSize}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownload}
                    disabled={isDownloading}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {isDownloading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    下载
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsOpen(false)}
                    className="w-8 h-8"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              {/* File preview area */}
              <div className="flex-1 overflow-hidden bg-muted/20">
                {loadingPreview ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
                    <span className="ml-2 text-sm text-muted-foreground">
                      加载文件中...
                    </span>
                  </div>
                ) : previewError ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <FileText className="w-12 h-12 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">
                      文件加载失败
                    </p>
                    <p className="text-xs text-muted-foreground/60">
                      {previewError.message}
                    </p>
                    {previewError.retryable && (
                      <Button
                        onClick={() => setPreviewAttempt((value) => value + 1)}
                        variant="outline"
                        size="sm"
                      >
                        重试
                      </Button>
                    )}
                  </div>
                ) : blobUrl ? (
                  <iframe
                    src={blobUrl}
                    title={displayFileName}
                    className="w-full h-full border-0"
                    style={{ minHeight: "100%" }}
                    sandbox=""
                  />
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center py-6">
              {/* Large icon */}
              <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Icon className="w-10 h-10 text-primary/60" />
              </div>

              {/* File info */}
              <h3 className="text-lg font-semibold text-foreground text-center mb-1">
                {displayFileName}
              </h3>
              {fileSize && (
                <p className="text-sm text-muted-foreground mb-4">{fileSize}</p>
              )}

              {downloadError && (
                <div className="mb-3 max-w-sm text-center">
                  <p className="text-sm text-destructive">
                    {downloadError.message}
                  </p>
                  {downloadError.recoveryAction === "contact_admin" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      请联系管理员检查账号和客户项目权限。
                    </p>
                  )}
                </div>
              )}

              {/* Actions - only download */}
              <div className="flex items-center gap-3 mt-2">
                {showDownload && (
                  <Button onClick={handleDownload} disabled={isDownloading}>
                    {isDownloading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        下载中...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        {downloadError?.retryable ? "重试下载" : "下载文件"}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
