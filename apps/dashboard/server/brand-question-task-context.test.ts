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
  quotaRevision: 4,
  candidateTargets: {
    industry: 3,
    competitor_comparison: 3,
    reputation: 3,
    product_scenario: 15,
  },
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

  it("rejects a task after its quota revision or candidate targets change", () => {
    const token = createBrandQuestionTaskContextToken({
      ...expected,
      secret: SECRET,
      now: NOW,
    });

    for (const changed of [
      { ...expected, quotaRevision: expected.quotaRevision + 1 },
      {
        ...expected,
        candidateTargets: {
          ...expected.candidateTargets,
          product_scenario: expected.candidateTargets.product_scenario + 3,
        },
      },
    ]) {
      expect(() =>
        verifyBrandQuestionTaskContextToken({
          token,
          secret: SECRET,
          now: new Date(NOW.getTime() + 1_000),
          expected: changed,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "BRAND_QUESTION_TASK_STALE",
          message: expect.stringContaining("问题额度"),
        }),
      );
    }
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
