import * as Dialog from "@radix-ui/react-dialog";
import { Download, Expand, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

export default function PanelFrame({
  id,
  labelledBy,
  icon,
  title,
  meta,
  exportHref,
  exportFileName,
  children,
  className = "",
  fullscreenEnabled = true,
}: {
  id: string;
  labelledBy: string;
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  exportHref?: string;
  exportFileName?: string;
  children: ReactNode;
  className?: string;
  fullscreenEnabled?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const tools = (insideDialog = false) => (
    <div className="fm-panel-tools">
      {exportHref ? (
        <a
          className="fm-tool-button"
          href={exportHref}
          download={
            exportHref.startsWith("data:text/csv")
              ? exportFileName?.replace(/\.xlsx$/u, ".csv")
              : exportFileName
          }
          aria-label={`导出${title}`}
        >
          <Download size={14} /> 导出
        </a>
      ) : (
        <button
          type="button"
          className="fm-tool-button"
          disabled
          aria-label={`导出${title}`}
        >
          <Download size={14} /> 导出
        </button>
      )}
      {insideDialog ? (
        <Dialog.Close asChild>
          <button
            type="button"
            className="fm-tool-button"
            aria-label={`退出${title}全屏`}
          >
            <Minimize2 size={14} /> 退出全屏
          </button>
        </Dialog.Close>
      ) : fullscreenEnabled ? (
        <button
          ref={triggerRef}
          type="button"
          className="fm-tool-button"
          aria-label={`全屏查看${title}`}
          onClick={() => setFullscreen(true)}
        >
          <Expand size={14} /> 全屏
        </button>
      ) : null}
    </div>
  );

  const heading = (insideDialog = false) => (
    <header className="fm-card-heading fm-panel-heading">
      <div>
        {icon}
        {insideDialog ? <Dialog.Title>{title}</Dialog.Title> : <h3>{title}</h3>}
      </div>
      <div className="fm-panel-heading-side">
        {meta && <span>{meta}</span>}
        {tools(insideDialog)}
      </div>
    </header>
  );

  return (
    <Dialog.Root
      open={fullscreen}
      onOpenChange={(open) => {
        setFullscreen(open);
        if (!open) {
          window.requestAnimationFrame(() => triggerRef.current?.focus());
        }
      }}
    >
      {!fullscreen && (
        <section
          id={id}
          className={`fm-tab-panel fm-card fm-panel-frame ${className}`.trim()}
          role="tabpanel"
          aria-labelledby={labelledBy}
        >
          {heading()}
          <div className="fm-panel-body">{children}</div>
        </section>
      )}
      {fullscreenEnabled && (
        <Dialog.Portal
          container={document.getElementById("monitoring-module-portals")}
        >
          <Dialog.Overlay className="fm-dialog-overlay fm-panel-overlay" />
          <Dialog.Content
            className="fm-panel-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          >
            <Dialog.Description className="fm-visually-hidden">
              全屏查看{title}，按 Esc 可退出。
            </Dialog.Description>
            {heading(true)}
            <div className="fm-panel-body fm-panel-fullscreen-body">
              {children}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
