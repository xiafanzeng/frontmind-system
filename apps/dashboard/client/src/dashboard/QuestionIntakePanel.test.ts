import { describe, expect, it } from "vitest";

import { normalizeServicePortal } from "./service-portal";
import {
  directQuestionQuotaHasCapacity,
  pendingQuestionQuotaReservations,
  questionHistoryItemMatchesTarget,
  questionQuotaUnavailableMessage,
  questionRequestCategoryLabel,
} from "./QuestionIntakePanel";

function withRuntimeTimeZone<T>(timeZone: string, run: () => T) {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }
}

describe("question demand history identity", () => {
  const target = {
    questionId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
    question: "硅基流动有什么核心产品？",
  };

  it("uses the authoritative source question id whenever it exists", () => {
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: target.questionId,
          topic: "旧问题文本",
        },
        target,
      ),
    ).toBe(true);
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: "5a67e445-37bb-45ed-9268-4ca9437e4d72",
          topic: target.question,
        },
        target,
      ),
    ).toBe(false);
  });

  it("falls back only to exact normalized legacy text, never a substring", () => {
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: null,
          topic: "  硅基流动有什么核心产品？ \n",
        },
        target,
      ),
    ).toBe(true);
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: null,
          topic: "请说明硅基流动有什么核心产品？并给出价格",
        },
        target,
      ),
    ).toBe(false);
  });
});

describe("question demand history labels", () => {
  it.each([
    ["question_review", "问题审核 · 自主填写"],
    ["question_modify", "问题修改 · 服务问题"],
    ["question_delete", "问题删除 · 服务问题"],
  ])("maps %s without inspecting a source question id", (category, label) => {
    expect(questionRequestCategoryLabel(category, "旧标签")).toBe(label);
  });

  it("keeps the server label for unrelated categories", () => {
    expect(questionRequestCategoryLabel("content_asset", "内容需求")).toBe(
      "内容需求",
    );
  });
});

describe("quarterly question quota messaging", () => {
  function luxuryPortal(capacityState: string, nextUnlockAt: unknown = null) {
    return normalizeServicePortal({
      service: { planCode: "luxury", status: "active" },
      quotas: {
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
          totalQuestionLimit: 8,
        },
        entitlementLimits: {
          industryLimit: 4,
          competitorComparisonLimit: 4,
          reputationLimit: 4,
          productScenarioLimit: 20,
          totalQuestionLimit: 32,
        },
        unlockStage: { current: 1, total: 4 },
        nextUnlockAt,
        capacityState,
      },
    });
  }

  it("points a first-quarter customer to the Shanghai unlock date from a US runtime", () => {
    const portal = luxuryPortal("awaiting_unlock", "2026-10-01T00:00:00+08:00");
    const directEntryMessage = withRuntimeTimeZone("America/Los_Angeles", () =>
      questionQuotaUnavailableMessage(portal, false),
    );
    const libraryMessage = withRuntimeTimeZone("America/Los_Angeles", () =>
      questionQuotaUnavailableMessage(portal, true),
    );

    expect(directEntryMessage).toBe(
      "本季度已解锁的问题额度已用完，下一季度额度将于 2026/10/01 开放。",
    );
    expect(libraryMessage).toBe(
      "该类问题本季度已解锁额度已用完，下一季度额度将于 2026/10/01 开放。",
    );
  });

  it("distinguishes a full-year exhaustion from a future unlock", () => {
    const portal = luxuryPortal("exhausted");
    portal.quotaUnlock = {
      current: 4,
      total: 4,
      nextUnlockAt: null,
      capacityState: "exhausted",
    };

    expect(questionQuotaUnavailableMessage(portal, false)).toBe(
      "豪华版全年问题额度已用完，不能继续新增。",
    );
  });

  it("does not call a single-category Q4 constraint full annual exhaustion", () => {
    const portal = luxuryPortal("available");
    portal.quotaUnlock = {
      current: 4,
      total: 4,
      nextUnlockAt: null,
      capacityState: "available",
    };
    expect(questionQuotaUnavailableMessage(portal, false)).toContain(
      "至少一个问题分类的全年额度已用完",
    );
  });

  it("keeps the legacy generic copy for an unknown server state", () => {
    const portal = normalizeServicePortal({
      service: { planCode: "luxury", status: "active" },
      quotas: {
        limits: {
          industryLimit: 4,
          competitorComparisonLimit: 4,
          reputationLimit: 4,
          productScenarioLimit: 20,
          totalQuestionLimit: 32,
        },
        usage: {},
        capacityState: "provider_paused",
      },
    });

    expect(portal.quotaUnlock).toBeUndefined();
    expect(questionQuotaUnavailableMessage(portal, false)).toBe(
      "当前服务的问题额度已用满，请联系服务管理员调整当前服务问题。",
    );
  });

  it("does not infer a blocking state from an unknown capacity enum", () => {
    const portal = luxuryPortal("provider_paused", "2026-10-01T00:00:00+08:00");

    expect(portal.quotaUnlock).toMatchObject({
      current: 1,
      total: 4,
      capacityState: null,
    });
    expect(questionQuotaUnavailableMessage(portal, false)).toBe(
      "当前服务的问题额度已用满，请联系服务管理员调整当前服务问题。",
    );
  });

  it("does not apply luxury annual copy to a completed advanced period", () => {
    const portal = normalizeServicePortal({
      service: { planCode: "advanced", status: "active" },
      quotas: {
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
          totalQuestionLimit: 8,
        },
        usage: {
          industry: 1,
          competitorComparison: 1,
          reputation: 1,
          productScenario: 5,
          total: 8,
        },
        unlockStage: { current: 1, total: 1 },
        nextUnlockAt: null,
        capacityState: "exhausted",
      },
    });

    expect(questionQuotaUnavailableMessage(portal, false)).toBe(
      "当前服务的问题额度已用满，请联系服务管理员调整当前服务问题。",
    );
  });

  it("reserves every progressive category for an unclassified pending question", () => {
    expect(
      Object.fromEntries(
        pendingQuestionQuotaReservations([{ category: null }], true),
      ),
    ).toEqual({
      industry: 1,
      competitor_comparison: 1,
      reputation: 1,
      product_scenario: 1,
    });
    expect(
      directQuestionQuotaHasCapacity([true, true, false, true], true),
    ).toBe(false);
    expect(
      directQuestionQuotaHasCapacity([true, true, false, true], false),
    ).toBe(true);
  });
});
