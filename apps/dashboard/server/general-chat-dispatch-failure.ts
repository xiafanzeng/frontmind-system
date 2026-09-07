import { AiBillingError, AiBillingPausedError } from "./ai-billing-service";
import { ManusV2ApiError } from "./manus-v2-client";

/** These failures are raised by the admission transaction before a user POST.
 * An interrupted task, a transport failure, or a lost database acknowledgement
 * is not proof that the command was never accepted. */
export function generalChatDispatchIsDefinitelyRejected(error: unknown) {
  if (error instanceof ManusV2ApiError) return !error.outcomeUnknown;
  return (
    error instanceof AiBillingError &&
    !(error instanceof AiBillingPausedError) &&
    [
      "AI_BALANCE_INSUFFICIENT",
      "AI_COST_PENDING",
      "AI_BILLING_NOT_ACTIVE",
      "AI_MODEL_PRICE_UNAVAILABLE",
      "AI_BILLING_TASK_OWNERSHIP",
      "AI_BILLING_PROJECT_OWNERSHIP",
      "AI_BILLING_COMMAND_CONFLICT",
      "AI_BILLING_COMMAND_CLOSED",
      "AI_BILLING_WALLET_MISSING",
    ].includes(error.code)
  );
}

/** Older create handlers called a pre-send balance refusal an unknown create.
 * This durable pause is written only after admission rolled back. A missing
 * message mutation proves that the provider POST fence was never entered. */
export function generalChatHasPersistedPreSendBalanceRefusal(value: unknown) {
  const record = (input: unknown): Record<string, any> =>
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, any>)
      : {};
  const root = record(value);
  const pause = record(root.billingPause);
  const runtime = record(root.dashboardManaged);
  const commands = Array.isArray(runtime.commands) ? runtime.commands : [];
  const initial = record(commands[0]);
  return (
    pause.reason === "balance" &&
    pause.stage === "before_send" &&
    pause.commandKey === "initial" &&
    typeof pause.sessionId === "string" &&
    pause.sessionId === runtime.sessionId &&
    runtime.revision === 1 &&
    commands.length === 1 &&
    initial.key === "initial" &&
    !initial.eventId &&
    initial.intentId === runtime.intentId &&
    record(runtime.mutations)["message:initial"] === undefined
  );
}

/** Translate public state precisely without leaking upstream response bodies. */
export function generalChatHttpErrorMessage(code: string, status: number) {
  if (status === 429)
    return "智能体服务请求频率受限，本次未执行，请稍后手动重试。";
  if (["CREATE_OUTCOME_UNRESOLVED", "SEND_OUTCOME_UNRESOLVED"].includes(code))
    return "提交结果仍在核对，请稍后查看任务状态；请勿重复发送。";
  if (
    ["CREATE_PREPARATION_IN_PROGRESS", "SEND_PREPARATION_IN_PROGRESS"].includes(
      code,
    )
  )
    return "本次请求正在准备，请稍后查看任务状态。";
  if (code === "TASK_STILL_RUNNING" || code === "TASK_NOT_READY")
    return "当前任务尚未结束，请等待本轮完成后再发送。";
  if (
    [
      "GENERAL_AGENT_ACCOUNT_SCOPE_REQUIRED",
      "ENTERPRISE_PROJECT_REQUIRED",
    ].includes(code)
  )
    return code === "GENERAL_AGENT_ACCOUNT_SCOPE_REQUIRED"
      ? "通用智能体属于当前账户，请从通用智能体入口重新打开。"
      : "请先选择企业项目，再使用此功能。";
  if (code === "CONVERSATION_NOT_SYNCED" || code === "USER_MESSAGE_NOT_SYNCED")
    return "会话内容尚未保存完成，请稍后重试本次请求。";
  return code;
}
