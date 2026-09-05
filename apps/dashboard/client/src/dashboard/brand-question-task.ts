export type StoredBrandQuestionTask = {
  taskId: string;
  contextToken: string;
  startedAt: number;
};

export function parseStoredBrandQuestionTask(
  value: string | null,
): StoredBrandQuestionTask | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredBrandQuestionTask>;
    if (
      typeof parsed.taskId !== "string" ||
      !parsed.taskId.trim() ||
      typeof parsed.contextToken !== "string" ||
      !parsed.contextToken.trim() ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null;
    }
    return {
      taskId: parsed.taskId.trim(),
      contextToken: parsed.contextToken.trim(),
      startedAt: parsed.startedAt,
    };
  } catch {
    // Legacy storage held only a task id. It did not bind the task to a
    // knowledge snapshot and quota period, so it must not be resumed.
    return null;
  }
}

export function serializeStoredBrandQuestionTask(
  value: StoredBrandQuestionTask,
) {
  return JSON.stringify(value);
}

export function isTerminalBrandQuestionTaskFailure(input: {
  status: number;
  code: string;
}) {
  return (
    [403, 404, 409, 410, 422].includes(input.status) ||
    [
      "BRAND_QUESTION_TASK_FAILED",
      "BRAND_QUESTION_TASK_FORBIDDEN",
      "BRAND_QUESTION_TASK_MISMATCH",
      "BRAND_QUESTION_TASK_STALE",
      "BRAND_QUESTION_TASK_CONTEXT_INVALID",
      "BRAND_QUESTION_TASK_CONTEXT_EXPIRED",
    ].includes(input.code)
  );
}
