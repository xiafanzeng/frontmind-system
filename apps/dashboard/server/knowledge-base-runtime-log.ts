import { runtimeErrorForLog } from "./_core/runtime-error-log";

export function knowledgeBaseRuntimeErrorMetadata(
  error: unknown,
  additionalSecrets: Iterable<unknown> = [],
) {
  const safe = runtimeErrorForLog(error, { additionalSecrets });
  return {
    // Error.message/detail and provider-controlled code strings are omitted.
    // The event name and this stable family code carry the operational signal.
    errorCode: "KNOWLEDGE_BASE_RUNTIME_ERROR",
    ...(typeof safe.status === "number" ? { status: safe.status } : {}),
  };
}

export function logKnowledgeBaseRuntimeFailure(input: {
  level: "warn" | "error";
  event: string;
  error: unknown;
  additionalSecrets?: Iterable<unknown>;
  userId?: number;
  buildId?: string;
  turnId?: string;
  taskId?: string;
}) {
  const identifier = (value: string | undefined) =>
    typeof value === "string" &&
    value.length <= 255 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
      ? value
      : undefined;
  const metadata = {
    ...(Number.isSafeInteger(input.userId) ? { userId: input.userId } : {}),
    ...(identifier(input.buildId)
      ? { buildId: identifier(input.buildId) }
      : {}),
    ...(identifier(input.turnId) ? { turnId: identifier(input.turnId) } : {}),
    ...(identifier(input.taskId) ? { taskId: identifier(input.taskId) } : {}),
    ...knowledgeBaseRuntimeErrorMetadata(input.error, input.additionalSecrets),
  };
  console[input.level](input.event, JSON.stringify(metadata));
}
