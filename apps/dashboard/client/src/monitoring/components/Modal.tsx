import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  inline?: boolean;
  title: string;
  description?: string;
  size?: "medium" | "large" | "wide";
  onClose: () => void;
  children: ReactNode;
};

export default function Modal({
  open,
  inline = false,
  title,
  description,
  size = "medium",
  onClose,
  children,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  if (inline)
    return open ? (
      <section
        className={`monitoring-inline-step modal-${size}`}
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h3>{title}</h3>
            {description && <p>{description}</p>}
          </div>
          <button
            type="button"
            className="top-icon"
            aria-label="收起当前步骤"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    ) : null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          ref={contentRef}
          className={`modal-card modal-${size}`}
          {...(!description ? { "aria-describedby": undefined } : {})}
          onOpenAutoFocus={(event) => {
            const firstEditableControl =
              contentRef.current?.querySelector<HTMLElement>(
                '[data-modal-initial-focus], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([data-modal-close])',
              );
            if (!firstEditableControl) return;
            event.preventDefault();
            firstEditableControl.focus({ preventScroll: true });
          }}
        >
          <header className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="top-icon"
                aria-label="关闭"
                data-modal-close
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
