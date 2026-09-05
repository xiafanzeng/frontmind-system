import { describe, expect, it } from "vitest";

import {
  isTerminalBrandQuestionTaskFailure,
  parseStoredBrandQuestionTask,
  serializeStoredBrandQuestionTask,
} from "./brand-question-task";

describe("brand question task browser state", () => {
  it("persists only snapshot-bound task state and drops legacy ids", () => {
    const value = {
      taskId: "task-1",
      contextToken: "payload.signature",
      startedAt: 1_721_984_400_000,
    };
    expect(
      parseStoredBrandQuestionTask(serializeStoredBrandQuestionTask(value)),
    ).toEqual(value);
    expect(parseStoredBrandQuestionTask("legacy-task-id")).toBeNull();
    expect(
      parseStoredBrandQuestionTask(
        JSON.stringify({ taskId: "task-1", startedAt: Date.now() }),
      ),
    ).toBeNull();
  });

  it("clears failed and stale tasks but keeps transient reads retryable", () => {
    expect(
      isTerminalBrandQuestionTaskFailure({
        status: 422,
        code: "BRAND_QUESTION_TASK_FAILED",
      }),
    ).toBe(true);
    expect(
      isTerminalBrandQuestionTaskFailure({
        status: 409,
        code: "BRAND_QUESTION_TASK_STALE",
      }),
    ).toBe(true);
    expect(
      isTerminalBrandQuestionTaskFailure({
        status: 404,
        code: "BRAND_QUESTION_TASK_READ_FAILED",
      }),
    ).toBe(true);
    expect(
      isTerminalBrandQuestionTaskFailure({
        status: 503,
        code: "BRAND_QUESTION_TASK_READ_FAILED",
      }),
    ).toBe(false);
  });
});
