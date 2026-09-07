import type { Response } from "express";
import { AiBillingError } from "./ai-billing-service";

export function aiBillingHttpFailure(error: unknown) {
  if (!(error instanceof AiBillingError)) return null;
  const insufficient =
    error.code === "AI_BALANCE_INSUFFICIENT" ||
    error.code === "AI_BALANCE_PAUSED";
  const forbidden = [
    "AI_BILLING_TASK_OWNERSHIP",
    "AI_BILLING_PROJECT_OWNERSHIP",
  ].includes(error.code);
  return {
    status: insufficient
      ? 402
      : forbidden
        ? 403
        : ["AI_RESUME_PENDING", "AI_RESUME_REJECTED"].includes(error.code)
          ? 409
          : 503,
    error: {
      code: error.code,
      message:
        error.code === "AI_BALANCE_PAUSED"
          ? "账户余额不足，任务已中断，已保存内容保留。充值后可继续。"
          : insufficient
            ? "账户余额不足，本次操作尚未执行。请充值后继续。"
            : error.code === "AI_RESUME_REJECTED"
              ? "上次继续请求已被明确拒绝，可再次点击继续。"
              : forbidden
                ? "当前账号无权操作此任务。"
                : "费用或恢复状态暂时无法确认，请稍后查看任务状态。",
      retryable: false,
      resetRequired: false,
      recoveryAction: insufficient ? "top_up" : "check_status",
      ...(insufficient ? { accountUrl: "/account" } : {}),
      ...(error.code === "AI_BALANCE_INSUFFICIENT"
        ? { dispatchSettled: true }
        : {}),
    },
  };
}

export function sendAiBillingError(res: Response, error: unknown): boolean {
  const failure = aiBillingHttpFailure(error);
  if (!failure) return false;
  res.status(failure.status).json({ error: failure.error });
  return true;
}
