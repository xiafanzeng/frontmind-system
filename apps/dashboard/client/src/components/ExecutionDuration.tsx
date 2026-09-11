import { useEffect, useState } from "react";
import type { ExecutionTiming } from "@/lib/execution-duration";
import "./GeneralExecutionActivity.css";

export function formatElapsedDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}小时 ` : ""}${hours || minutes ? `${minutes}分钟 ` : ""}${seconds % 60}秒`;
}

export function ExecutionDuration({
  startedAt,
  completedAt,
  active,
}: ExecutionTiming) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [startedAt, active]);
  const end = active ? now : completedAt;
  if (end === undefined) return null;
  return (
    <span className="execution-duration" data-active={active || undefined}>
      用时 {formatElapsedDuration(end - startedAt)}
    </span>
  );
}

export function ExecutionDivider({ timing }: { timing?: ExecutionTiming }) {
  return (
    <div className="execution-divider">
      {timing && <ExecutionDuration {...timing} />}
      <hr className="general-chat-user-divider" aria-hidden="true" />
    </div>
  );
}
