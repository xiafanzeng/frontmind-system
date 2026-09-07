import { useState } from "react";
import { deliveryProjectHeaders } from "@/lib/delivery-project";
import { showAiBillingAction } from "@/lib/ai-billing-feedback";

export default function KnowledgeBillingResume({
  buildId,
  turnId,
  reason,
}: {
  buildId: string;
  turnId: string;
  reason: "balance" | "cost";
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const resume = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge-base/billing-resume", {
        method: "POST",
        credentials: "include",
        headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          buildId,
          turnId,
          requestId: crypto.randomUUID(),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        showAiBillingAction(payload.error);
        throw new Error(
          payload.error?.message || "恢复状态暂时无法确认，请稍后查看",
        );
      }
      setMessage("已提交继续请求，正在恢复原任务。");
      window.dispatchEvent(new Event("focus"));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "恢复状态暂时无法确认，请稍后查看",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="my-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
      role="status"
    >
      <strong>
        {reason === "balance"
          ? "余额不足，任务已中断"
          : "费用正在核对，任务已暂停"}
      </strong>
      <p className="mt-1">
        已保存内容、原任务和原推理档位均保留。
        {reason === "balance"
          ? "充值后可从中断处继续。"
          : "核对完成前不会再次发送任务。"}
      </p>
      <div className="mt-3 flex gap-3">
        {reason === "balance" && (
          <a className="underline" href="/account">
            前往账户充值
          </a>
        )}
        <button
          type="button"
          className="rounded-lg bg-amber-900 px-3 py-1 text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void resume()}
        >
          {busy
            ? "正在核对…"
            : reason === "balance"
              ? "已充值，继续原任务"
              : "核对费用并继续"}
        </button>
      </div>
      {message && <p className="mt-2">{message}</p>}
    </div>
  );
}
