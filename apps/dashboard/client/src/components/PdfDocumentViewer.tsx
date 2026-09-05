import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deliveryProjectHeaders, sanitizeBrandText } from "@/lib/frontmind-api";
import type { FilePreviewSource } from "@/lib/file-preview-source";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PreparedStatus = "queued" | "processing" | "ready" | "failed";
type PreparedPhase =
  | "queued"
  | "downloading"
  | "sanitizing"
  | "optimizing"
  | "ready"
  | "failed";
type PreparedRecoveryAction = "retry" | "reupload" | "contact_admin" | null;
export const PDF_PREPARATION_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const;
export const PDF_READY_CONTENT_RETRY_DELAYS_MS = [
  2_000, 10_000, 60_000,
] as const;
export const PDF_DOWNLOAD_TOKEN_RETRY_DELAYS_MS = [
  2_000, 10_000, 60_000,
] as const;

interface PreparedPdfAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  status: PreparedStatus;
  phase: PreparedPhase;
  size?: number;
  sourceBytes?: number;
  pageCount?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  retryable?: boolean;
  recoveryAction?: PreparedRecoveryAction;
  expiresAt?: number;
  contentUrl: string;
  downloadTokenUrl: string;
}

interface PdfDocumentViewerProps {
  fileName: string;
  source: FilePreviewSource;
  onClose?: () => void;
  onExpired?: (expiresAt?: number) => void;
}

export interface PreparedFailure {
  errorCode?: string;
  failureScope?: "prepare" | "content" | "download";
  retryable?: boolean;
  recoveryAction?: PreparedRecoveryAction;
  expiresAt?: number;
}

function terminalPreparedFailure(
  errorCode: string | undefined,
):
  | { retryable: false; recoveryAction: "reupload" | "contact_admin" }
  | undefined {
  if (
    errorCode === "SOURCE_EXPIRED" ||
    errorCode === "SOURCE_UNAVAILABLE" ||
    errorCode === "INVALID_PDF"
  ) {
    return { retryable: false, recoveryAction: "reupload" };
  }
  if (errorCode === "SOURCE_FORBIDDEN") {
    return { retryable: false, recoveryAction: "contact_admin" };
  }
  return undefined;
}

export function preferredPreparedPdfFailure(
  asset: PreparedFailure | null,
  requestFailure: PreparedFailure | null,
): PreparedFailure {
  const merged: PreparedFailure = {
    errorCode: requestFailure?.errorCode ?? asset?.errorCode,
    failureScope: requestFailure?.failureScope ?? asset?.failureScope,
    retryable: requestFailure?.retryable ?? asset?.retryable,
    recoveryAction:
      requestFailure?.recoveryAction ?? asset?.recoveryAction ?? null,
    expiresAt: requestFailure?.expiresAt ?? asset?.expiresAt,
  };
  return { ...merged, ...terminalPreparedFailure(merged.errorCode) };
}

function isAbortRequestError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

class PreparedPdfRequestError extends Error implements PreparedFailure {
  errorCode?: string;
  retryable?: boolean;
  recoveryAction?: PreparedRecoveryAction;
  expiresAt?: number;

  constructor(message: string, failure: PreparedFailure = {}) {
    super(message);
    this.name = "PreparedPdfRequestError";
    this.errorCode = failure.errorCode;
    const terminal = terminalPreparedFailure(failure.errorCode);
    this.retryable = terminal?.retryable ?? failure.retryable;
    this.recoveryAction = terminal?.recoveryAction ?? failure.recoveryAction;
    this.expiresAt = failure.expiresAt;
  }
}

const phaseLabels: Record<PreparedPhase, string> = {
  queued: "正在加载 PDF…",
  downloading: "正在加载 PDF…",
  sanitizing: "正在加载 PDF…",
  optimizing: "正在加载 PDF…",
  ready: "文件已准备完成",
  failed: "文件准备失败",
};

function nativeDownload(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

async function readApiError(response: Response) {
  const transientStatus =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  const defaultRecoveryAction: PreparedRecoveryAction =
    response.status === 404 || response.status === 410
      ? "reupload"
      : response.status === 401 || response.status === 403
        ? "contact_admin"
        : transientStatus
          ? "retry"
          : null;
  try {
    const value = await response.json();
    const errorCode =
      typeof value?.error?.code === "string"
        ? value.error.code
        : response.status === 410
          ? "SOURCE_EXPIRED"
          : response.status === 404
            ? "SOURCE_UNAVAILABLE"
            : response.status === 401 || response.status === 403
              ? "SOURCE_FORBIDDEN"
              : undefined;
    const recoveryAction = value?.error?.recoveryAction;
    const suppliedMessage =
      value?.error?.message ||
      value?.message ||
      `请求失败 (HTTP ${response.status})`;
    return new PreparedPdfRequestError(
      errorCode === "SOURCE_EXPIRED"
        ? "文件已超过 30 天，请重新上传"
        : errorCode === "SOURCE_UNAVAILABLE"
          ? "文件内容已不可用，请重新上传"
          : suppliedMessage,
      {
        errorCode,
        retryable:
          typeof value?.error?.retryable === "boolean"
            ? value.error.retryable
            : transientStatus,
        recoveryAction:
          recoveryAction === "retry" ||
          recoveryAction === "reupload" ||
          recoveryAction === "contact_admin"
            ? recoveryAction
            : defaultRecoveryAction,
        expiresAt:
          typeof value?.error?.expiresAt === "number"
            ? value.error.expiresAt
            : undefined,
      },
    );
  } catch {
    return new PreparedPdfRequestError(`请求失败 (HTTP ${response.status})`, {
      errorCode:
        response.status === 410
          ? "SOURCE_EXPIRED"
          : response.status === 404
            ? "SOURCE_UNAVAILABLE"
            : response.status === 401 || response.status === 403
              ? "SOURCE_FORBIDDEN"
              : undefined,
      retryable: transientStatus,
      recoveryAction: defaultRecoveryAction,
    });
  }
}

export function preparedPdfRequestFailure(
  error: unknown,
  fallbackMessage = "PDF 文件读取网络异常，请稍后重试",
): PreparedPdfRequestError | null {
  if (isAbortRequestError(error)) return null;
  if (error instanceof PreparedPdfRequestError) return error;
  return new PreparedPdfRequestError(
    error instanceof Error && error.message
      ? `${fallbackMessage}（${error.message}）`
      : fallbackMessage,
    { retryable: true, recoveryAction: "retry" },
  );
}

export function preparedPdfDocumentFailure(
  error: unknown,
): PreparedPdfRequestError | null {
  if (isAbortRequestError(error)) return null;
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 0;
  if (name === "InvalidPDFException") {
    return new PreparedPdfRequestError("文件不是有效的 PDF，请重新上传", {
      errorCode: "INVALID_PDF",
      retryable: false,
      recoveryAction: "reupload",
    });
  }
  if (status === 410) {
    return new PreparedPdfRequestError("文件已超过 30 天，请重新上传", {
      errorCode: "SOURCE_EXPIRED",
      retryable: false,
      recoveryAction: "reupload",
    });
  }
  if (status === 404) {
    return new PreparedPdfRequestError("文件内容已不可用，请重新上传", {
      errorCode: "SOURCE_UNAVAILABLE",
      retryable: false,
      recoveryAction: "reupload",
    });
  }
  if (status === 401 || status === 403) {
    return new PreparedPdfRequestError(
      "当前账号或客户项目无权读取此文件，请联系管理员",
      {
        errorCode: "SOURCE_FORBIDDEN",
        retryable: false,
        recoveryAction: "contact_admin",
      },
    );
  }
  return new PreparedPdfRequestError(
    error instanceof Error && error.message
      ? `PDF 内容读取网络异常（${error.message}）`
      : "PDF 内容读取网络异常，请稍后重试",
    { retryable: true, recoveryAction: "retry" },
  );
}

export async function prepareRemotePdf(
  source: { fileUrl?: string; fileId?: string },
  fileName: string,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch("/api/frontmind/assets/prepare", {
      method: "POST",
      credentials: "include",
      headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...source, fileName }),
      signal,
    });
  } catch (error) {
    throw (
      preparedPdfRequestFailure(error, "PDF 文件准备网络异常，请稍后重试") ??
      error
    );
  }
  if (!response.ok) throw await readApiError(response);
  return (await response.json()) as PreparedPdfAsset;
}

async function fetchPreparedStatus(assetId: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(
      `/api/frontmind/assets/${encodeURIComponent(assetId)}/status`,
      {
        credentials: "include",
        cache: "no-store",
        signal,
        headers: deliveryProjectHeaders(),
      },
    );
  } catch (error) {
    throw (
      preparedPdfRequestFailure(error, "PDF 状态查询网络异常，请稍后重试") ??
      error
    );
  }
  if (!response.ok) throw await readApiError(response);
  return (await response.json()) as PreparedPdfAsset;
}

function waitForPdfRetry(delayMs: number, signal?: AbortSignal) {
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

/** Resolve a ready PDF download token with the shared 2s/10s/60s policy. */
export async function requestPreparedPdfDownloadUrl(
  downloadTokenUrl: string,
  signal?: AbortSignal,
) {
  let retryIndex = 0;
  while (true) {
    try {
      const response = await fetch(downloadTokenUrl, {
        method: "POST",
        credentials: "include",
        headers: deliveryProjectHeaders(),
        signal,
      });
      if (!response.ok) throw await readApiError(response);
      const value = await response.json();
      if (typeof value?.downloadUrl !== "string" || !value.downloadUrl) {
        throw new PreparedPdfRequestError("下载链接无效", {
          retryable: false,
          recoveryAction: "contact_admin",
        });
      }
      return value.downloadUrl as string;
    } catch (error) {
      const failure = preparedPdfRequestFailure(
        error,
        "PDF 下载链接请求网络异常，请稍后重试",
      );
      if (!failure) throw error;
      const retryDelay = PDF_DOWNLOAD_TOKEN_RETRY_DELAYS_MS[retryIndex];
      if (failure.retryable !== true || retryDelay === undefined) throw failure;
      retryIndex += 1;
      await waitForPdfRetry(retryDelay, signal);
    }
  }
}

function PageCanvas({
  document,
  pageNumber,
  scale,
  fitWidth,
  scrollRoot,
  onVisible,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  fitWidth: boolean;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  onVisible: (pageNumber: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 2);
  const [containerWidth, setContainerWidth] = useState(720);
  const [aspectRatio, setAspectRatio] = useState(1.414);

  useEffect(() => {
    const container = containerRef.current;
    const root = scrollRoot.current;
    if (!container || !root) return;
    const renderObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsNearViewport(entry.isIntersecting);
      },
      { root, rootMargin: "900px 0px", threshold: 0 },
    );
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && entry.intersectionRatio >= 0.25) {
          onVisible(pageNumber);
        }
      },
      { root, threshold: [0.25, 0.6] },
    );
    renderObserver.observe(container);
    visibleObserver.observe(container);
    return () => {
      renderObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [onVisible, pageNumber, scrollRoot]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setContainerWidth(width);
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!isNearViewport || !canvas || !textContainer) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (textContainer) textContainer.replaceChildren();
      return;
    }

    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    void document
      .getPage(pageNumber)
      .then(async (loadedPage) => {
        if (cancelled) return;
        page = loadedPage;
        const baseViewport = loadedPage.getViewport({ scale: 1 });
        setAspectRatio(baseViewport.height / baseViewport.width);
        const targetScale = fitWidth
          ? Math.max(
              0.25,
              Math.min(
                3,
                (Math.max(containerWidth, 320) - 32) / baseViewport.width,
              ),
            )
          : scale;
        const viewport = loadedPage.getViewport({ scale: targetScale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法创建 PDF Canvas");

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTask = loadedPage.render({
          canvasContext: context,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;

        textContainer.replaceChildren();
        textContainer.style.width = `${Math.floor(viewport.width)}px`;
        textContainer.style.height = `${Math.floor(viewport.height)}px`;
        textLayer = new TextLayer({
          textContentSource: loadedPage.streamTextContent(),
          container: textContainer,
          viewport,
        });
        await textLayer.render();
      })
      .catch((error) => {
        if (
          !cancelled &&
          error?.name !== "RenderingCancelledException" &&
          error?.name !== "AbortException"
        ) {
          console.error(`[PDF] Failed to render page ${pageNumber}`, error);
        }
      });

    return () => {
      cancelled = true;
      textLayer?.cancel();
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [containerWidth, document, fitWidth, isNearViewport, pageNumber, scale]);

  const placeholderHeight = Math.max(
    420,
    Math.round(Math.max(320, containerWidth - 32) * aspectRatio),
  );

  return (
    <div
      ref={containerRef}
      id={`pdf-page-${pageNumber}`}
      className="relative flex min-h-[420px] w-full justify-center px-4 py-3"
      style={{ minHeight: placeholderHeight }}
      aria-label={`第 ${pageNumber} 页`}
    >
      {isNearViewport ? (
        <div className="relative h-fit max-w-full overflow-hidden bg-white shadow-md">
          <canvas ref={canvasRef} className="block max-w-full" />
          <div
            ref={textLayerRef}
            className="textLayer absolute inset-0 overflow-hidden opacity-100"
          />
        </div>
      ) : (
        <div className="flex h-full min-h-[360px] w-[min(90%,720px)] items-center justify-center rounded-sm bg-white shadow-sm">
          <span className="text-xs text-slate-400">第 {pageNumber} 页</span>
        </div>
      )}
    </div>
  );
}

export default function PdfDocumentViewer({
  fileName,
  source,
  onClose,
  onExpired,
}: PdfDocumentViewerProps) {
  const sourceFile = source.kind === "local" ? source.file : undefined;
  const sourceFileId = source.kind === "owned_file" ? source.fileId : undefined;
  const sourceUrl = source.kind === "external" ? source.url : undefined;
  const expiresAt = source.kind === "external" ? undefined : source.expiresAt;
  const displayName = sanitizeBrandText(fileName || "document.pdf");
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [asset, setAsset] = useState<PreparedPdfAsset | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [isDownloading, setIsDownloading] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [documentLoadAttempt, setDocumentLoadAttempt] = useState(0);
  const [expiryNow, setExpiryNow] = useState(() => Date.now());
  const [requestFailure, setRequestFailure] = useState<PreparedFailure | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const automaticRetryCountRef = useRef(0);
  const documentRetryCountRef = useRef(0);
  const documentRetrySourceRef = useRef<string | null>(null);
  const expiredNotificationRef = useRef<string | null>(null);

  const isLocalSource =
    Boolean(sourceFile) ||
    Boolean(sourceUrl?.startsWith("blob:")) ||
    Boolean(sourceUrl?.startsWith("data:"));

  useEffect(() => {
    if (!sourceFile) {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const load = async () => {
      setLoadingError(null);
      setPdfDocument(null);
      setAsset(null);
      setDocumentUrl(null);
      setRequestFailure(null);

      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        setRequestFailure({
          failureScope: "prepare",
          retryable: false,
          recoveryAction: "reupload",
          expiresAt,
        });
        setLoadingError("文件已超过 30 天，请重新上传");
        return;
      }

      if (isLocalSource) {
        setDocumentUrl(localUrl || sourceUrl || null);
        return;
      }
      if (!sourceUrl && !sourceFileId) {
        setLoadingError("没有可用的 PDF 文件地址");
        return;
      }

      try {
        let next = await prepareRemotePdf(
          sourceFileId ? { fileId: sourceFileId } : { fileUrl: sourceUrl },
          displayName,
          controller.signal,
        );
        if (cancelled) return;
        setAsset(next);
        const startedAt = Date.now();

        const poll = async () => {
          if (cancelled) return;
          if (next.status === "ready") {
            setDocumentUrl(next.contentUrl);
            return;
          }
          if (next.status === "failed") {
            setLoadingError(next.errorMessage || "PDF 文件准备失败");
            return;
          }
          const elapsed = Date.now() - startedAt;
          const delay =
            elapsed < 10_000 ? 1_000 : elapsed < 30_000 ? 2_000 : 5_000;
          timer = setTimeout(async () => {
            try {
              next = await fetchPreparedStatus(next.assetId, controller.signal);
              if (cancelled) return;
              setAsset(next);
              await poll();
            } catch (error) {
              if (!cancelled) {
                const failure = preparedPdfRequestFailure(
                  error,
                  "PDF 状态查询网络异常，请稍后重试",
                );
                if (failure) {
                  setRequestFailure({
                    errorCode: failure.errorCode,
                    failureScope: "prepare",
                    retryable: failure.retryable,
                    recoveryAction: failure.recoveryAction,
                    expiresAt: failure.expiresAt,
                  });
                }
                setLoadingError(
                  failure?.message ||
                    (error instanceof Error
                      ? error.message
                      : "查询文件状态失败"),
                );
              }
            }
          }, delay);
        };
        await poll();
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          const failure = preparedPdfRequestFailure(
            error,
            "PDF 文件准备网络异常，请稍后重试",
          );
          if (failure) {
            setRequestFailure({
              errorCode: failure.errorCode,
              failureScope: "prepare",
              retryable: failure.retryable,
              recoveryAction: failure.recoveryAction,
              expiresAt: failure.expiresAt,
            });
          }
          setLoadingError(
            failure?.message ||
              (error instanceof Error ? error.message : "PDF 文件准备失败"),
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    displayName,
    expiresAt,
    isLocalSource,
    localUrl,
    prepareAttempt,
    sourceFileId,
    sourceUrl,
  ]);

  useEffect(() => {
    if (!documentUrl) return;
    if (documentRetrySourceRef.current !== documentUrl) {
      documentRetrySourceRef.current = documentUrl;
      documentRetryCountRef.current = 0;
    }
    setLoadingError(null);
    const loadingTask = getDocument({
      url: documentUrl,
      withCredentials: true,
      httpHeaders: deliveryProjectHeaders(),
      rangeChunkSize: 256 * 1024,
    });
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    void loadingTask.promise
      .then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        setPdfDocument(document);
        setRequestFailure(null);
        setCurrentPage(1);
        setPageInput("1");
      })
      .catch((error) => {
        if (cancelled) return;
        const failure = preparedPdfDocumentFailure(error);
        if (!failure) return;
        setRequestFailure({
          errorCode: failure.errorCode,
          failureScope: "content",
          retryable: failure.retryable,
          recoveryAction: failure.recoveryAction,
          expiresAt: failure.expiresAt,
        });
        const retryIndex = documentRetryCountRef.current;
        const retryDelay = PDF_READY_CONTENT_RETRY_DELAYS_MS[retryIndex];
        if (failure.retryable && retryDelay !== undefined) {
          documentRetryCountRef.current += 1;
          retryTimer = setTimeout(
            () => setDocumentLoadAttempt((value) => value + 1),
            retryDelay,
          );
          return;
        }
        setLoadingError(failure.message);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      setPdfDocument(null);
      void loadingTask.destroy();
    };
  }, [documentLoadAttempt, documentUrl]);

  const visiblePageChanged = useCallback((page: number) => {
    setCurrentPage(page);
    setPageInput(String(page));
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      if (!pdfDocument) return;
      const next = Math.max(1, Math.min(pdfDocument.numPages, page));
      document
        .getElementById(`pdf-page-${next}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setCurrentPage(next);
      setPageInput(String(next));
    },
    [pdfDocument],
  );

  // A network failure while the last successful asset snapshot is still
  // `processing` must control recovery. The stale processing response must not
  // hide the current request failure.
  const preferredFailure = preferredPreparedPdfFailure(asset, requestFailure);
  const recoveryAction = preferredFailure.recoveryAction ?? null;
  const retryable = preferredFailure.retryable;
  const canRetryPreparation =
    requestFailure?.failureScope && requestFailure.failureScope !== "prepare"
      ? false
      : recoveryAction === "retry"
        ? retryable !== false
        : recoveryAction === null && asset?.status === "failed";
  const canRetryContent =
    requestFailure?.failureScope === "content" && retryable !== false;
  const mustReupload = recoveryAction === "reupload";
  const effectiveExpiresAt = preferredFailure.expiresAt ?? expiresAt;
  const effectiveErrorCode = preferredFailure.errorCode ?? undefined;
  const contentExpired =
    effectiveErrorCode === "SOURCE_EXPIRED" ||
    (effectiveExpiresAt !== undefined && effectiveExpiresAt <= expiryNow);

  useEffect(() => {
    if (effectiveExpiresAt === undefined || contentExpired) return;
    const remaining = effectiveExpiresAt - Date.now();
    if (remaining <= 0) {
      setExpiryNow(Date.now());
      return;
    }
    const timer = window.setTimeout(
      () => setExpiryNow(Date.now()),
      Math.min(remaining, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [contentExpired, effectiveExpiresAt, expiryNow]);

  useEffect(() => {
    if (!contentExpired) {
      expiredNotificationRef.current = null;
      return;
    }
    setPdfDocument(null);
    setDocumentUrl(null);
    setLoadingError("文件已超过 30 天，请重新上传");
    const notificationKey = `${sourceFileId || sourceUrl || displayName}:${effectiveExpiresAt || "expired"}`;
    if (expiredNotificationRef.current !== notificationKey) {
      expiredNotificationRef.current = notificationKey;
      onExpired?.(effectiveExpiresAt);
    }
  }, [
    contentExpired,
    displayName,
    effectiveExpiresAt,
    onExpired,
    sourceFileId,
    sourceUrl,
  ]);

  const retryPreparation = useCallback(async () => {
    if (!canRetryPreparation) return;
    setLoadingError(null);
    setRequestFailure(null);
    if (!asset) {
      setPrepareAttempt((value) => value + 1);
      return;
    }
    try {
      const response = await fetch(
        `/api/frontmind/assets/${encodeURIComponent(asset.assetId)}/retry`,
        {
          method: "POST",
          credentials: "include",
          headers: deliveryProjectHeaders(),
        },
      );
      if (!response.ok) {
        throw await readApiError(response);
      }
      const next = (await response.json()) as PreparedPdfAsset;
      setAsset(next);
      setPrepareAttempt((value) => value + 1);
    } catch (error) {
      const failure = preparedPdfRequestFailure(
        error,
        "PDF 重试请求网络异常，请稍后重试",
      );
      if (!failure) return;
      setRequestFailure({
        errorCode: failure.errorCode,
        failureScope: "prepare",
        retryable: failure.retryable,
        recoveryAction: failure.recoveryAction,
        expiresAt: failure.expiresAt,
      });
      setLoadingError(failure.message);
    }
  }, [asset, canRetryPreparation]);

  const retryContent = useCallback(() => {
    if (!canRetryContent || !documentUrl) return;
    documentRetryCountRef.current = 0;
    setLoadingError(null);
    setRequestFailure(null);
    setDocumentLoadAttempt((value) => value + 1);
  }, [canRetryContent, documentUrl]);

  useEffect(() => {
    automaticRetryCountRef.current = 0;
  }, [sourceFile, sourceFileId, sourceUrl]);

  useEffect(() => {
    if (!loadingError || !canRetryPreparation) return;
    const retryIndex = automaticRetryCountRef.current;
    const delay = PDF_PREPARATION_RETRY_DELAYS_MS[retryIndex];
    if (delay === undefined) return;
    automaticRetryCountRef.current += 1;
    const timer = window.setTimeout(() => {
      void retryPreparation();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [canRetryPreparation, loadingError, retryPreparation]);

  const handleDownload = useCallback(async () => {
    if (contentExpired) {
      setLoadingError("文件已超过 30 天，请重新上传");
      return;
    }
    setIsDownloading(true);
    setLoadingError(null);
    setRequestFailure(null);
    try {
      if (isLocalSource) {
        const url = localUrl || sourceUrl;
        if (!url) throw new Error("没有可下载的文件");
        nativeDownload(url, displayName);
        return;
      }
      if (!asset || asset.status !== "ready") {
        throw new Error("文件仍在准备中");
      }
      const downloadUrl = await requestPreparedPdfDownloadUrl(
        asset.downloadTokenUrl,
      );
      setRequestFailure(null);
      nativeDownload(downloadUrl, displayName);
    } catch (error) {
      const failure = preparedPdfRequestFailure(
        error,
        "PDF 下载链接请求网络异常，请稍后重试",
      );
      if (failure) {
        setRequestFailure({
          errorCode: failure.errorCode,
          failureScope: "download",
          retryable: failure.retryable,
          recoveryAction: failure.recoveryAction,
          expiresAt: failure.expiresAt,
        });
      }
      setLoadingError(
        failure?.message ||
          (error instanceof Error ? error.message : "文件下载失败"),
      );
    } finally {
      setIsDownloading(false);
    }
  }, [asset, contentExpired, displayName, isLocalSource, localUrl, sourceUrl]);

  const pageNumbers = useMemo(
    () =>
      pdfDocument
        ? Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1)
        : [],
    [pdfDocument],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          <span className="max-w-[300px] truncate text-sm font-medium">
            {displayName}
          </span>
        </div>

        {pdfDocument && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="上一页"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Input
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") goToPage(Number(pageInput));
                }}
                className="h-7 w-12 px-1 text-center text-xs"
                aria-label="页码"
              />
              <span>/ {pdfDocument.numPages}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= pdfDocument.numPages}
              aria-label="下一页"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setFitWidth(false);
                setScale((value) => Math.max(0.4, value - 0.15));
              }}
              aria-label="缩小"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setFitWidth(false);
                setScale((value) => Math.min(3, value + 0.15));
              }}
              aria-label="放大"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant={fitWidth ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setFitWidth((value) => !value)}
              aria-label="适应宽度"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => void handleDownload()}
          disabled={
            contentExpired ||
            isDownloading ||
            (!isLocalSource && asset?.status !== "ready")
          }
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          下载
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="关闭 PDF"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/35">
        {loadingError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/30" />
            <p className="text-sm font-medium">PDF 加载失败</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {loadingError}
            </p>
            {mustReupload &&
              !contentExpired &&
              loadingError !== "文件已超过 30 天，请重新上传" && (
                <p className="max-w-md text-xs font-medium text-amber-700">
                  请重新上传原文件后再试
                </p>
              )}
            {canRetryPreparation && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryPreparation()}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                重新准备
              </Button>
            )}
            {canRetryContent && (
              <Button variant="outline" size="sm" onClick={retryContent}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重新读取
              </Button>
            )}
          </div>
        ) : !pdfDocument ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            <p className="text-sm text-muted-foreground">
              {asset ? phaseLabels[asset.phase] : "正在打开 PDF…"}
            </p>
            {asset?.sourceBytes ? (
              <p className="text-xs text-muted-foreground/70">
                已接收 {(asset.sourceBytes / 1024 / 1024).toFixed(1)} MB
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1500px]">
            {pageNumbers.map((pageNumber) => (
              <PageCanvas
                key={pageNumber}
                document={pdfDocument}
                pageNumber={pageNumber}
                scale={scale}
                fitWidth={fitWidth}
                scrollRoot={scrollRef}
                onVisible={visiblePageChanged}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
