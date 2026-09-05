import { describe, expect, it } from "vitest";

import {
  getCapability,
  getRouteCapability,
  isCapabilityIncludedInPlan,
  normalizeServicePortal,
  type ServiceCapabilityKey,
} from "./service-portal";

const capabilityKeys: ServiceCapabilityKey[] = [
  "knowledgeBuild",
  "knowledgeDisplay",
  "globalKeywords",
  "questionSelection",
  "intentOptimization",
  "responseLogic",
  "monitoring",
  "channelDistribution",
  "progressReport",
  "contentAssets",
  "brandTracking",
];

function availableCapabilities() {
  return Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      { allowed: true, effectiveStatus: "available", reason: null },
    ]),
  );
}

describe("service portal adapter", () => {
  it("maps the enterprise dashboard to an entitled formal capability", () => {
    expect(getRouteCapability("brand", "enterprise-dashboard")).toBe(
      "contentAssets",
    );
    expect(getRouteCapability("brand", "global-keywords")).toBe(
      "globalKeywords",
    );
    expect(getRouteCapability("progress", "monitor")).toBe("monitoring");
    expect(getRouteCapability("public-opinion", "brand-tracking")).toBe(
      "brandTracking",
    );
  });

  it("normalizes the authoritative direct workspace.portal DTO", () => {
    const validFrom = Date.parse("2026-07-01T00:00:00+08:00");
    const validUntil = Date.parse("2026-09-30T23:59:59+08:00");
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      revision: 7,
      account: {
        userId: 12,
        username: "enterprise",
        displayName: "测试企业",
      },
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "active",
        validFrom,
        validUntil,
        billingLabel: "季度服务",
      },
      quotas: {
        periodId: "period-1",
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
          productScenario: 3,
          total: 6,
        },
      },
      knowledge: {
        version: 2,
        status: "display_ready",
        latestImportStatus: "completed",
      },
      purchasedQuestions: [
        {
          id: "question-1",
          sourceQuestionId: "question-old",
          category: "reputation",
          question: "品牌口碑有哪些可核验证据？",
          status: "selected",
          responseLogicConfirmed: true,
        },
      ],
      historicalQuestions: [
        {
          id: "question-old",
          category: "reputation",
          question: "升级前购买的品牌口碑问题",
          status: "selected",
        },
      ],
      capabilities: availableCapabilities(),
      workflowSteps: [
        {
          id: "knowledge",
          label: "品牌知识库",
          status: "complete",
          lockedReason: null,
          href: "/knowledge-base",
        },
        {
          id: "intent_optimization",
          label: "问题优化",
          status: "locked",
          lockedReason: "请先完成已购问题同步或选题。",
          href: null,
          nextAction: {
            kind: "select_service_questions",
            label: "先确认本周期服务问题",
            href: "/brand-question-portfolio",
          },
        },
      ],
      nextAction: {
        kind: "view_knowledge",
        label: "查看品牌知识库",
        href: "/knowledge-base",
      },
    });

    expect(portal.known).toBe(true);
    expect(portal.plan).toMatchObject({
      code: "advanced",
      name: "进阶版",
      statusLabel: "已生效",
      validFrom: String(validFrom),
      validUntil: String(validUntil),
    });
    expect(portal.quotas).toEqual([
      {
        key: "industry",
        label: "行业排名词",
        limit: 1,
        used: 1,
        unit: "个词",
      },
      {
        key: "competitor",
        label: "竞品对比词",
        limit: 1,
        used: 1,
        unit: "个词",
      },
      {
        key: "reputation",
        label: "美誉舆情词",
        limit: 1,
        used: 1,
        unit: "个词",
      },
      {
        key: "scenario",
        label: "产品场景词",
        limit: 5,
        used: 3,
        unit: "个词",
      },
    ]);
    expect(portal.knowledgeBase).toMatchObject({
      status: "ready",
      statusLabel: "可查看",
      version: "V2",
    });
    expect(portal.purchasedQuestions[0]).toMatchObject({
      id: "question-1",
      kind: "reputation",
      sourceQuestionId: "question-old",
      responseLogicConfirmed: true,
    });
    expect(portal.historicalQuestions[0]).toMatchObject({
      id: "question-old",
      kind: "reputation",
      statusLabel: "只读历史",
    });
    expect(getCapability(portal, "intentOptimization")).toMatchObject({
      allowed: false,
      effectiveStatus: "pending",
      reason: "请先完成已购问题同步或选题。",
      nextAction: {
        kind: "select_service_questions",
        label: "先确认本周期服务问题",
      },
    });
  });

  it("does not expose legacy keyword labels from an array-shaped API response", () => {
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "active",
      },
      quotas: [
        { key: "industry", label: "行业词", limit: 1, used: 0 },
        { key: "competitor", label: "竞品", limit: 1, used: 0 },
        { key: "reputation", label: "舆情", limit: 1, used: 0 },
        { key: "scenario", label: "场景", limit: 5, used: 0 },
      ],
    });

    expect(portal.quotas.map(({ label }) => label)).toEqual([
      "行业排名词",
      "竞品对比词",
      "美誉舆情词",
      "产品场景词",
    ]);
  });

  it("keeps the authoritative luxury unlock schedule separate from the unlocked cap", () => {
    const nextUnlockAt = Date.parse("2026-10-01T00:00:00+08:00");
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "luxury",
        planName: "豪华版",
        status: "active",
      },
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
        usage: {
          industry: 1,
          competitorComparison: 1,
          reputation: 1,
          productScenario: 5,
          total: 8,
        },
        unlockStage: { current: 1, total: 4 },
        nextUnlockAt,
        capacityState: "awaiting_unlock",
      },
    });

    expect(portal.quotaUnlock).toEqual({
      current: 1,
      total: 4,
      nextUnlockAt: String(nextUnlockAt),
      capacityState: "awaiting_unlock",
    });
    expect(
      portal.quotas.map(({ limit, entitlementLimit }) => ({
        limit,
        entitlementLimit,
      })),
    ).toEqual([
      { limit: 1, entitlementLimit: 4 },
      { limit: 1, entitlementLimit: 4 },
      { limit: 1, entitlementLimit: 4 },
      { limit: 5, entitlementLimit: 20 },
    ]);
  });

  it("keeps an already-normalized quota unlock view idempotent", () => {
    const portal = normalizeServicePortal({
      plan: { code: "luxury", name: "豪华版" },
      quotas: [
        {
          key: "scenario",
          label: "产品场景词",
          limit: 5,
          entitlementLimit: 20,
          used: 1,
          unit: "个词",
        },
      ],
      quotaUnlock: {
        current: 1,
        total: 4,
        nextUnlockAt: "2026-10-18",
        capacityState: "available",
      },
    });

    expect(portal.quotaUnlock).toEqual({
      current: 1,
      total: 4,
      nextUnlockAt: "2026-10-18",
      capacityState: "available",
    });
    expect(portal.quotas[0]).toMatchObject({
      limit: 5,
      entitlementLimit: 20,
      used: 1,
    });
  });

  it("ignores an unknown capacity state and preserves legacy quota behavior", () => {
    const portal = normalizeServicePortal({
      service: { planCode: "luxury", status: "active" },
      quotas: {
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
          totalQuestionLimit: 8,
        },
        usage: {},
        capacityState: "provider_paused",
      },
    });

    expect(portal.quotaUnlock).toBeUndefined();
    expect(portal.quotas[0]).not.toHaveProperty("entitlementLimit");
  });

  it("defensively locks knowledge building for a basic plan", () => {
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "basic",
        planName: "普通版",
        status: "active",
        source: "website",
      },
      capabilities: availableCapabilities(),
      knowledge: {
        version: 1,
        status: "display_ready",
      },
    });

    expect(getCapability(portal, "knowledgeBuild")).toMatchObject({
      allowed: false,
      effectiveStatus: "locked",
    });
    expect(getCapability(portal, "knowledgeBuild").reason).toBe(
      "普通版不包含知识库智能体；知识库由 Website 流程自动同步至本账号，服务团队可补录。升级进阶版或豪华版后可解锁知识库智能体。",
    );
    expect(portal.knowledgeBase.sourceLabel).toBe("Website 流程同步知识库");
    expect(isCapabilityIncludedInPlan("basic", "knowledgeBuild")).toBe(false);
    expect(isCapabilityIncludedInPlan("basic", "globalKeywords")).toBe(false);
    expect(isCapabilityIncludedInPlan("basic", "knowledgeDisplay")).toBe(true);
    expect(isCapabilityIncludedInPlan("basic", "contentAssets")).toBe(false);
    expect(isCapabilityIncludedInPlan("basic", "brandTracking")).toBe(false);
    expect(isCapabilityIncludedInPlan("advanced", "contentAssets")).toBe(true);
    expect(isCapabilityIncludedInPlan("advanced", "brandTracking")).toBe(true);
    expect(isCapabilityIncludedInPlan("unknown", "knowledgeBuild")).toBe(true);
  });

  it("defensively locks content assets while the knowledge workflow is unfinished", () => {
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "active",
      },
      capabilities: availableCapabilities(),
      knowledge: { status: "missing" },
      workflowSteps: [
        {
          id: "knowledge",
          label: "知识库智能体",
          status: "ready",
          lockedReason: null,
          href: "/knowledge-base",
        },
      ],
    });

    expect(getCapability(portal, "contentAssets")).toMatchObject({
      allowed: false,
      effectiveStatus: "pending",
      reason: expect.stringContaining("当前服务的认证知识库"),
    });
    expect(isCapabilityIncludedInPlan("advanced", "contentAssets")).toBe(true);
  });

  it("never promotes an unavailable capability because a question exists", () => {
    const capabilities = availableCapabilities();
    capabilities.intentOptimization = {
      allowed: false,
      effectiveStatus: "not_in_plan",
      reason: "服务端未开放问题优化",
    };
    capabilities.responseLogic = {
      allowed: false,
      effectiveStatus: "not_in_plan",
      reason: "服务端未开放应答逻辑",
    };
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "active",
      },
      capabilities,
      purchasedQuestions: [
        {
          id: "question-1",
          category: "reputation",
          question: "品牌口碑如何？",
          status: "selected",
        },
      ],
      workflowSteps: [
        {
          id: "question",
          label: "服务问题",
          status: "locked",
          lockedReason: "请先完成当前高级套餐的认证知识库发布。",
          href: "/brand-question-portfolio",
        },
      ],
    });

    expect(getCapability(portal, "globalKeywords")).toMatchObject({
      allowed: false,
      effectiveStatus: "pending",
      reason:
        "请先通过知识库智能体完成全部节点，并联系管理员开启品牌全域词库。",
    });
    expect(getCapability(portal, "intentOptimization")).toMatchObject({
      allowed: false,
      reason: "服务端未开放问题优化",
    });
    expect(getCapability(portal, "responseLogic")).toMatchObject({
      allowed: false,
      reason: "服务端未开放应答逻辑",
    });
  });

  it("keeps knowledge display locked until the in-system agent publishes the current version", () => {
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "active",
      },
      capabilities: availableCapabilities(),
      workflowSteps: [
        {
          id: "knowledge",
          label: "知识库智能体",
          status: "ready",
          lockedReason: null,
          href: "/knowledge-base",
          nextAction: {
            kind: "start_knowledge_build",
            label: "开始知识库智能体",
          },
        },
      ],
    });

    expect(getCapability(portal, "knowledgeBuild")).toMatchObject({
      allowed: true,
    });
    expect(getCapability(portal, "knowledgeDisplay")).toMatchObject({
      allowed: false,
      effectiveStatus: "pending",
      reason: "请先在知识库智能体中完成全部节点并发布知识库。",
      nextAction: expect.objectContaining({
        kind: "start_knowledge_build",
      }),
    });
  });

  it("keeps historical questions separate from active service questions", () => {
    const portal = normalizeServicePortal({
      schemaVersion: 1,
      service: {
        planCode: "advanced",
        planName: "进阶版",
        status: "expired",
      },
      capabilities: {},
      purchasedQuestions: [],
      historicalQuestions: [
        {
          id: "question-history-1",
          category: "product_scenario",
          question: "已结束周期的问题",
          status: "selected",
          sourceQuestionId: "question-origin",
        },
      ],
    });

    expect(portal.purchasedQuestions).toEqual([]);
    expect(portal.historicalQuestions).toEqual([
      expect.objectContaining({
        id: "question-history-1",
        kind: "scenario",
        statusLabel: "只读历史",
        sourceQuestionId: "question-origin",
      }),
    ]);
  });
});
