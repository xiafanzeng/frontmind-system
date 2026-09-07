import { toast } from "sonner";

/** An explicit user click opens recharge; a failed command is never retried here. */
export function showAiBillingAction(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    !("code" in value) ||
    !["AI_BALANCE_INSUFFICIENT", "AI_BALANCE_PAUSED"].includes(
      String(value.code),
    )
  )
    return false;
  toast.error("账户余额不足，请充值后继续", {
    id: "ai-account-balance",
    description: "当前任务和已保存的内容会保留。",
    action: {
      label: "前往账户充值",
      onClick: () => window.location.assign("/account"),
    },
    duration: 12000,
  });
  return true;
}
