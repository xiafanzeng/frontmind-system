/**
 * ImagePreview Component - Full-screen image viewer with zoom and pan
 * Features: Click to open fullscreen modal, zoom controls, download
 *
 * FIX: Now properly handles API URLs with auth headers for download/preview.
 * Supports both /api/frontmind/v1/files/ URLs and /api/frontmind/proxy-download URLs.
 */
import { useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCw, Download, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { deliveryProjectHeaders } from "@/lib/frontmind-api";

interface ImagePreviewProps {
  src?: string;
  /** Opaque ID for an authenticated Dashboard-owned upload. */
  fileId?: string;
  alt?: string;
  className?: string;
  showDownload?: boolean;
  /** Server-authoritative hard content deadline for uploaded files. */
  expiresAt?: number;
  /** Server-authoritative deletion/expiry state. */
  expired?: boolean;
}

export const IMAGE_OWNED_FILE_RETRY_DELAYS_MS = [
  2_000, 10_000, 60_000,
] as const;

type ImageLoadFailure = {
  message: string;
  code?: string;
  retryable: boolean;
  recoveryAction?: "retry" | "reupload" | "contact_admin";
  expiresAt?: number;
};

export class ImageContentRequestError
  extends Error
  implements ImageLoadFailure
{
  code?: string;
  retryable: boolean;
  recoveryAction?: "retry" | "reupload" | "contact_admin";
  expiresAt?: number;

  constructor(message: string, failure: Omit<ImageLoadFailure, "message">) {
    super(message);
    this.name = "ImageContentRequestError";
    this.code = failure.code;
    const terminal = terminalImageFailure(failure.code);
    this.retryable = terminal ? false : failure.retryable;
    this.recoveryAction = terminal?.recoveryAction ?? failure.recoveryAction;
    this.expiresAt = failure.expiresAt;
  }
}

function terminalImageFailure(
  code: string | undefined,
): { recoveryAction: "reupload" | "contact_admin" } | undefined {
  if (
    code === "SOURCE_EXPIRED" ||
    code === "SOURCE_UNAVAILABLE" ||
    code === "INVALID_PDF"
  ) {
    return { recoveryAction: "reupload" };
  }
  if (code === "SOURCE_FORBIDDEN") {
    return { recoveryAction: "contact_admin" };
  }
  return undefined;
}

function isAbortRequestError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * Check if a URL needs auth headers (our proxy URLs)
 */
const KNOWLEDGE_BASE_RESOURCE_PREFIX =
  "/api/knowledge-base/artifacts/resources/";

function isKnowledgeBaseResource(url: string): boolean {
  return url.startsWith(KNOWLEDGE_BASE_RESOURCE_PREFIX);
}

function needsAuthHeaders(url: string): boolean {
  return url.startsWith("/api/frontmind/") || isKnowledgeBaseResource(url);
}

async function readImageContentError(response: Response) {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    // Fall through to status-derived behavior.
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
  const message =
    code === "SOURCE_EXPIRED"
      ? "文件已超过 30 天，请重新上传"
      : code === "SOURCE_UNAVAILABLE"
        ? "图片内容已不可用，请重新上传"
        : typeof payload?.error?.message === "string"
          ? payload.error.message
          : `图片读取失败（HTTP ${response.status}）`;
  return new ImageContentRequestError(message, {
    code,
    retryable:
      typeof payload?.error?.retryable === "boolean"
        ? payload.error.retryable
        : transient,
    recoveryAction:
      payload?.error?.recoveryAction === "retry" ||
      payload?.error?.recoveryAction === "reupload" ||
      payload?.error?.recoveryAction === "contact_admin"
        ? payload.error.recoveryAction
        : code === "SOURCE_EXPIRED" || code === "SOURCE_UNAVAILABLE"
          ? "reupload"
          : transient
            ? "retry"
            : undefined,
    expiresAt:
      typeof payload?.error?.expiresAt === "number"
        ? payload.error.expiresAt
        : undefined,
  });
}

function normalizeImageContentError(
  error: unknown,
): ImageContentRequestError | null {
  if (isAbortRequestError(error)) return null;
  if (error instanceof ImageContentRequestError) return error;
  return new ImageContentRequestError(
    error instanceof Error && error.message
      ? `图片读取网络异常（${error.message}）`
      : "图片读取网络异常",
    { retryable: true, recoveryAction: "retry" },
  );
}

/**
 * Fetch image with auth headers and return blob URL
 */
export async function fetchImageWithAuth(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const knowledgeBaseResource = isKnowledgeBaseResource(url);
  const response = await fetch(url, {
    credentials: "include",
    headers: knowledgeBaseResource ? undefined : deliveryProjectHeaders(),
    signal,
  });

  if (!response.ok) {
    throw await readImageContentError(response);
  }

  const contentType = response.headers.get("content-type") || "";

  // upload_url is a PUT-only capability. Metadata is never a valid image
  // download fallback; the authenticated content route must return bytes.
  if (
    contentType.includes("application/json") ||
    (knowledgeBaseResource && !contentType.toLowerCase().startsWith("image/"))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageContentRequestError("服务返回的不是有效图片", {
      retryable: false,
      recoveryAction: "contact_admin",
    });
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function waitForImageRetry(delayMs: number, signal?: AbortSignal) {
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

/** Initial request plus three bounded retries for authenticated file bytes. */
export async function fetchImageWithRetry(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  let retryIndex = 0;
  while (true) {
    try {
      return await fetchImageWithAuth(url, signal);
    } catch (error) {
      const failure = normalizeImageContentError(error);
      if (!failure) throw error;
      const retryDelay = IMAGE_OWNED_FILE_RETRY_DELAYS_MS[retryIndex];
      if (!failure.retryable || retryDelay === undefined) throw failure;
      retryIndex += 1;
      await waitForImageRetry(retryDelay, signal);
    }
  }
}

export default function ImagePreview({
  src,
  fileId,
  alt = "预览图片",
  className,
  showDownload = true,
  expiresAt,
  expired = false,
}: ImagePreviewProps) {
  const sourceUrl = fileId
    ? fileId.startsWith("asset_")
      ? `/api/frontmind/v2/assets/${encodeURIComponent(fileId)}/content`
      : `/api/frontmind/v1/files/${encodeURIComponent(fileId)}`
    : src || "";
  const [isOpen, setIsOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ImageLoadFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [expiryNow, setExpiryNow] = useState(() => Date.now());
  const declaredExpired =
    expired ||
    (typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt <= expiryNow);
  const contentExpired =
    declaredExpired || loadError?.code === "SOURCE_EXPIRED";

  useEffect(() => {
    if (expired || expiresAt === undefined) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setExpiryNow(Date.now());
      return;
    }
    const timer = window.setTimeout(
      () => setExpiryNow(Date.now()),
      Math.min(remaining, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [expired, expiresAt, expiryNow]);

  useEffect(() => {
    if (contentExpired) setIsOpen(false);
  }, [contentExpired]);

  // Fetch blob URL when component mounts or src changes (for API/proxy URLs)
  // Data URLs and blob URLs are used directly without fetching
  useEffect(() => {
    let cancelled = false;
    let ownedBlobUrl: string | null = null;
    const controller = new AbortController();

    if (declaredExpired) {
      setBlobUrl(null);
      setLoading(false);
      setLoadError({
        message: "文件已超过 30 天，请重新上传",
        code: "SOURCE_EXPIRED",
        retryable: false,
        recoveryAction: "reupload",
        expiresAt,
      });
      return () => controller.abort();
    }

    if (sourceUrl && needsAuthHeaders(sourceUrl)) {
      setBlobUrl(null);
      setLoading(true);
      setLoadError(null);
      const load = async () => {
        try {
          const url = await fetchImageWithRetry(sourceUrl, controller.signal);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          ownedBlobUrl = url;
          setBlobUrl(url);
          setLoading(false);
        } catch (error) {
          const failure = normalizeImageContentError(error);
          if (!failure) return;
          console.error("Failed to load image:", error);
          if (!cancelled) {
            setLoadError(failure);
            setLoading(false);
          }
        }
      };
      void load();
    } else {
      // For data: URLs, blob: URLs, and regular URLs - use directly
      setBlobUrl(null);
      setLoadError(null);
      setLoading(false);
    }

    // Cleanup blob URL on unmount
    return () => {
      cancelled = true;
      controller.abort();
      if (ownedBlobUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(ownedBlobUrl);
      }
    };
  }, [declaredExpired, expiresAt, loadAttempt, sourceUrl]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 4));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);

  const handleDownload = useCallback(async () => {
    if (contentExpired) {
      setLoadError({
        message: "文件已超过 30 天，请重新上传",
        code: "SOURCE_EXPIRED",
        retryable: false,
        recoveryAction: "reupload",
        expiresAt,
      });
      return;
    }
    if (isKnowledgeBaseResource(sourceUrl) && (!blobUrl || loadError)) {
      return;
    }
    try {
      let downloadUrl: string;

      if (blobUrl) {
        // Use existing blob URL
        downloadUrl = blobUrl;
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = alt || "image";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }

      if (needsAuthHeaders(sourceUrl)) {
        // Fetch with auth for download
        const fetchedUrl = await fetchImageWithRetry(sourceUrl);
        const a = document.createElement("a");
        a.href = fetchedUrl;
        a.download = alt || "image";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(fetchedUrl);
        return;
      }

      // Direct download for data URLs or regular URLs
      const response = await fetch(sourceUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = alt || "image";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
      const failure = normalizeImageContentError(err);
      if (failure) setLoadError(failure);
    }
  }, [alt, blobUrl, contentExpired, expiresAt, loadError, sourceUrl]);

  const handleNativeImageError = useCallback(() => {
    setLoadError({
      message: "图片加载失败，请检查网络后重试",
      retryable: false,
      recoveryAction: "retry",
    });
  }, []);

  // Image source for the img tag: blob URL if available, otherwise original src
  const imgSrc = blobUrl || sourceUrl;
  const canDownload =
    showDownload &&
    (!isKnowledgeBaseResource(sourceUrl) || Boolean(blobUrl && !loadError));

  return (
    <>
      <div
        className={cn(
          "cursor-pointer overflow-hidden rounded-xl border border-border/30 shadow-sm",
          "hover:border-primary/30 transition-all duration-200 hover:shadow-md",
          className,
        )}
        onClick={() => {
          if (!contentExpired) setIsOpen(true);
        }}
        role="button"
        aria-disabled={contentExpired}
        tabIndex={contentExpired ? -1 : 0}
        onKeyDown={(e) =>
          e.key === "Enter" && !contentExpired && setIsOpen(true)
        }
      >
        {loading ? (
          <div className="w-full h-full flex items-center justify-center bg-muted/30 min-h-[100px]">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/50" />
          </div>
        ) : loadError ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-muted/30 min-h-[100px] p-4">
            <p className="text-xs text-muted-foreground/70 text-center">
              {loadError.message}
            </p>
            {loadError.retryable ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLoadAttempt((value) => value + 1);
                }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                重试
              </button>
            ) : canDownload && loadError.recoveryAction !== "reupload" ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                点击下载
              </button>
            ) : null}
          </div>
        ) : (
          <img
            src={imgSrc}
            alt={alt}
            className="w-full h-auto object-cover transition-transform duration-200 hover:scale-[1.02]"
            loading="lazy"
            onError={handleNativeImageError}
          />
        )}
      </div>

      <Dialog
        open={isOpen && !contentExpired}
        onOpenChange={(open) => setIsOpen(contentExpired ? false : open)}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-[90vw] max-h-[90vh] p-0 bg-black/95 border-none"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>

          {/* Controls bar */}
          <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomOut}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <ZoomOut className="w-4 h-4" />
              </Button>
              <span className="text-white/70 text-sm min-w-[3rem] text-center">
                {Math.round(scale * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomIn}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <ZoomIn className="w-4 h-4" />
              </Button>
              <div className="w-px h-6 bg-white/20 mx-1" />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRotate}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <RotateCw className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleReset}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20 text-xs"
              >
                重置
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {canDownload && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleDownload}
                  className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
                >
                  <Download className="w-4 h-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsOpen(false)}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Image container */}
          <div
            className="flex items-center justify-center overflow-auto h-full w-full"
            style={{ cursor: "grab" }}
          >
            {loading ? (
              <Loader2 className="w-8 h-8 animate-spin text-white/50" />
            ) : loadError ? (
              <div className="text-white/60 text-center">
                <p>图片加载失败</p>
                {canDownload ? (
                  <button
                    onClick={handleDownload}
                    className="mt-2 text-sm text-blue-400 hover:underline"
                  >
                    点击下载
                  </button>
                ) : null}
              </div>
            ) : (
              <img
                src={imgSrc}
                alt={alt}
                className="max-w-full max-h-[85vh] object-contain transition-transform duration-200"
                style={{
                  transform: `scale(${scale}) rotate(${rotation}deg)`,
                }}
                draggable={false}
                onError={handleNativeImageError}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
