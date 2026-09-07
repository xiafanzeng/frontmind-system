import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { X } from "lucide-react";
import type { RunAttempt } from "../../domain";
import { useMonitoringDemo } from "../../MonitoringDemoContext";

export default function AnswerCorrectionDialog({
  attempt,
  open,
  onOpenChange,
}: {
  attempt: RunAttempt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const demo = useMonitoringDemo();
  const [mentioned, setMentioned] = useState(attempt.brandMentioned === true);
  const [position, setPosition] = useState(
    String(attempt.mentionPosition ?? 1),
  );
  if (!demo) return null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="fm-dialog-overlay" />
        <Dialog.Content className="fm-correction-dialog">
          <header>
            <div>
              <Dialog.Title>纠正提及结果 · 演示</Dialog.Title>
              <Dialog.Description>
                仅修改当前页面的合成统计，保留回答原文。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="fm-icon-button" aria-label="关闭纠正窗口">
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              demo.correctAnswer(attempt.id, {
                brandMentioned: mentioned,
                mentionPosition: mentioned ? Number(position) : null,
              });
              onOpenChange(false);
            }}
          >
            <fieldset>
              <legend>回答是否提及品牌</legend>
              <label>
                <input
                  type="radio"
                  name="mentioned"
                  checked={mentioned}
                  onChange={() => setMentioned(true)}
                />{" "}
                已提及
              </label>
              <label>
                <input
                  type="radio"
                  name="mentioned"
                  checked={!mentioned}
                  onChange={() => setMentioned(false)}
                />{" "}
                未提及
              </label>
            </fieldset>
            {mentioned && (
              <label className="fm-correction-position">
                提及位置
                <input
                  aria-label="纠正后的提及位置"
                  required
                  type="number"
                  min={1}
                  max={1000}
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                />
              </label>
            )}
            <footer>
              <button
                type="button"
                className="fm-secondary-button"
                onClick={() => onOpenChange(false)}
              >
                取消
              </button>
              <button className="fm-primary-button" type="submit">
                保存演示纠正
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
