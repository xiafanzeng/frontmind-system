import { describe, expect, it } from "vitest";

import {
  BrandQuestionTaskContextError,
  classifyBrandQuestionTaskStatus,
  createBrandQuestionTaskContextToken,
  verifyBrandQuestionTaskContextToken,
} from "./brand-question-task-context";

const NOW = new Date("2026-07-26T08:00:00.000Z");
const SECRET = "tenant-api-key-used-only-for-test-signing";
const expected = {
  userId: 7,
  taskId: "task-1",
  snapshotId: "snapshot-1",
  snapshotHash: "archive-sha256",
  quotaPeriodId: "period-1",
  planCode: "advanced" as const,
};

describe("brand question task context", () => {
  it("binds a task to its tenant, snapshot and quota period", () => {
    const token = createBrandQuestionTaskContextToken({
      ...expected,
      secret: SECRET,
      now: NOW,
    });

    expect(
      verifyBrandQuestionTaskContextToken({
        token,
        secret: SECRET,
        now: new Date(NOW.getTime() + 1_000),
        expected,
      }),
    ).toMatchObject(expected);

    expect(() =>
      verifyBrandQuestionTaskContextToken({
        token,
        secret: SECRET,
        now: new Date(NOW.getTime() + 1_000),
        expected: { ...expected, snapshotId: "snapshot-2" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BRAND_QUESTION_TASK_STALE" }),
    );
  });

  it("rejects tampered and expired context instead of reusing a stale task", () => {
    const token = createBrandQuestionTaskContextToken({
      ...expected,
      secret: SECRET,
      now: NOW,
      ttlMs: 500,
    });
    const tampered = `${token.slice(0, -1)}x`;

    expect(() =>
      verifyBrandQuestionTaskContextToken({
        token: tampered,
        secret: SECRET,
        now: NOW,
        expected,
      }),
    ).toThrow(BrandQuestionTaskContextError);
    expect(() =>
      verifyBrandQuestionTaskContextToken({
        token,
        secret: SECRET,
        now: new Date(NOW.getTime() + 501),
        expected,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "BRAND_QUESTION_TASK_CONTEXT_EXPIRED",
      }),
    );
  });

  it("separates running and terminal upstream states", () => {
    expect(classifyBrandQuestionTaskStatus("running")).toBe("running");
    expect(classifyBrandQuestionTaskStatus("pending")).toBe("running");
    expect(classifyBrandQuestionTaskStatus("completed")).toBe("completed");
    expect(classifyBrandQuestionTaskStatus("failed")).toBe("failed");
    expect(classifyBrandQuestionTaskStatus("cancelled")).toBe("failed");
  });
});
