import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { RunAttempt } from "../../domain";
import { archivedMediaAttachmentUrl, safeArchivedMediaUrl } from "./selectors";
import { useMonitoringDemo } from "../../MonitoringDemoContext";
import { AnswerReader } from "./AnswerWorkspace";

export default function ScreenshotViewerDialog({
  open,
  attempt,
  onOpenChange,
}: {
  open: boolean;
  attempt: RunAttempt;
  onOpenChange: (open: boolean) => void;
}) {
  const demo = useMonitoringDemo();
  const [index, setIndex] = useState(0);
  const [imageState, setImageState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [downloadState, setDownloadState] = useState<
    "idle" | "pending" | "failed"
  >("idle");
  const screenshots = useMemo(
    () =>
      attempt.assets
        .filter((asset) => asset.type === "screenshot")
        .map((asset) => ({
          ...asset,
          safeUrl: safeArchivedMediaUrl(asset.url),
        })),
    [attempt.assets],
  );
  const visible = screenshots[index];
  const downloadUrl = archivedMediaAttachmentUrl(visible?.safeUrl);

  useEffect(() => setIndex(0), [attempt.id, open]);
  useEffect(() => {
    setImageState("loading");
    setDownloadState("idle");
  }, [open, visible?.id]);

  const downloadScreenshot = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!downloadUrl || downloadState === "pending") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    setDownloadState("pending");
    try {
      const response = await fetch(downloadUrl, {
        credentials: "same-origin",
        headers: { Accept: "image/*,application/octet-stream" },
      });
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `frontmind-answer-screenshot-${index + 1}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setDownloadState("idle");
    } catch {
      setDownloadState("failed");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="fm-dialog-overlay" />
        <Dialog.Content className="fm-screenshot-dialog">
          <header>
            <div>
              <Dialog.Title>回答截图</Dialog.Title>
              <Dialog.Description>
                {demo
                  ? "本地演示截图预览，内容来自当前合成回答。"
                  : "仅展示由服务端归档的回答截图，不会在浏览器请求供应商资源。"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="fm-icon-button"
                aria-label="关闭回答截图"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div
            className="fm-screenshot-stage"
            aria-busy={
              (Boolean(visible?.safeUrl) && imageState === "loading") ||
              undefined
            }
          >
            {demo ? (
              <div className="fm-demo-screenshot">
                <div>回答快照 · 本地演示</div>
                <h3>{attempt.question}</h3>
                <AnswerReader attempt={attempt} />
              </div>
            ) : !screenshots.length ? (
              <div className="fm-dialog-empty">
                <ImageIcon size={30} />
                <strong>没有回答截图</strong>
                <span>当前回答未配置截图，或供应商没有返回截图。</span>
              </div>
            ) : visible?.safeUrl ? (
              <>
                {imageState === "loading" && (
                  <div
                    className="fm-dialog-empty fm-screenshot-status"
                    role="status"
                  >
                    <ImageIcon size={30} />
                    <strong>正在加载回答截图</strong>
                    <span>正在读取受保护的站内归档文件。</span>
                  </div>
                )}
                {imageState === "failed" && (
                  <div
                    className="fm-dialog-empty fm-screenshot-status"
                    role="alert"
                  >
                    <ImageIcon size={30} />
                    <strong>回答截图加载失败</strong>
                    <span>归档文件暂时无法读取，请稍后重试。</span>
                  </div>
                )}
                <img
                  src={visible.safeUrl}
                  alt={visible.title || `回答截图 ${index + 1}`}
                  className={imageState === "ready" ? "is-ready" : ""}
                  onLoad={() => setImageState("ready")}
                  onError={() => setImageState("failed")}
                />
              </>
            ) : (
              <div className="fm-dialog-empty">
                <ImageIcon size={30} />
                <strong>
                  {visible?.archiveStatus === "failed"
                    ? "截图归档失败"
                    : "截图正在归档"}
                </strong>
                <span>归档完成后，可在此查看安全的站内媒体地址。</span>
              </div>
            )}
          </div>
          {screenshots.length > 0 && (
            <footer>
              <button
                type="button"
                className="fm-icon-button"
                disabled={index === 0}
                onClick={() => setIndex((value) => Math.max(0, value - 1))}
                aria-label="上一张回答截图"
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {index + 1} / {screenshots.length}
              </span>
              <button
                type="button"
                className="fm-icon-button"
                disabled={index === screenshots.length - 1}
                onClick={() =>
                  setIndex((value) =>
                    Math.min(screenshots.length - 1, value + 1),
                  )
                }
                aria-label="下一张回答截图"
              >
                <ChevronRight size={18} />
              </button>
              {downloadUrl && (
                <a
                  className="fm-secondary-button"
                  href={downloadUrl}
                  download
                  aria-disabled={downloadState === "pending" || undefined}
                  onClick={(event) => void downloadScreenshot(event)}
                >
                  <Download size={14} />
                  {downloadState === "pending" ? "正在下载…" : "下载截图"}
                </a>
              )}
              {downloadState === "failed" && (
                <span className="fm-download-error" role="alert">
                  下载失败，请稍后重试
                </span>
              )}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
