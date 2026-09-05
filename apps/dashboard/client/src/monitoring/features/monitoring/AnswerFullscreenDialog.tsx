import * as Dialog from "@radix-ui/react-dialog";
import { Minimize2 } from "lucide-react";
import type { RefObject } from "react";

import type { RunAttempt } from "../../domain";
import CitationRail from "./CitationRail";
import { AnswerReader } from "./AnswerWorkspace";
import type { SourceScope } from "./types";

export default function AnswerFullscreenDialog({
  open,
  attempt,
  returnFocusRef,
  onOpenChange,
  sourceScope,
  onSourceScopeChange,
}: {
  open: boolean;
  attempt: RunAttempt;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  sourceScope: SourceScope;
  onSourceScopeChange: (scope: SourceScope) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="fm-dialog-overlay fm-fullscreen-overlay" />
        <Dialog.Content
          className="fm-fullscreen-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <Dialog.Title className="fm-visually-hidden">
            全屏问答明细
          </Dialog.Title>
          <Dialog.Description className="fm-visually-hidden">
            全屏查看回答正文和引用信源。
          </Dialog.Description>
          <header className="fm-fullscreen-heading">
            <div>
              <strong>{attempt.platformName}</strong>
              <span>第 {attempt.repetition} 次回答</span>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="fm-secondary-button"
                aria-label="退出全屏"
              >
                <Minimize2 size={15} /> 退出全屏
              </button>
            </Dialog.Close>
          </header>
          <div className="fm-fullscreen-layout">
            <AnswerReader attempt={attempt} />
            <CitationRail
              attempt={attempt}
              scope={sourceScope}
              onScopeChange={onSourceScopeChange}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
