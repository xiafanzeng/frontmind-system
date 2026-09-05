import { describe, expect, it } from "vitest";

import {
  getPreviewServicePortal,
  previewKnowledgeProgress,
  previewKnowledgeSnapshot,
} from "./preview-data";

describe("preview service portal fixtures", () => {
  it.each(["advanced", "luxury"] as const)(
    "uses the canonical four keyword labels in the %s API preview",
    (plan) => {
      expect(
        getPreviewServicePortal(plan).quotas.map(({ label }) => label),
      ).toEqual(["行业排名词", "竞品对比词", "美誉舆情词", "产品场景词"]);
    },
  );

  it("uses the expected purchase and advisor actions for each plan", () => {
    expect(getPreviewServicePortal("basic").purchaseActions).toEqual([
      {
        kind: "purchase_basic",
        label: "继续购买普通版",
        href: "https://www.frontmind.net",
        targetPlan: "basic",
      },
      {
        kind: "upgrade",
        label: "升级进阶版",
        targetPlan: "advanced",
      },
      {
        kind: "upgrade",
        label: "升级豪华版",
        targetPlan: "luxury",
      },
    ]);

    expect(getPreviewServicePortal("advanced").purchaseActions).toEqual([
      {
        kind: "renew",
        label: "续费进阶版",
        targetPlan: "advanced",
      },
      {
        kind: "upgrade",
        label: "升级豪华版",
        targetPlan: "luxury",
      },
    ]);

    expect(getPreviewServicePortal("luxury").purchaseActions).toEqual([
      {
        kind: "renew",
        label: "续费豪华版",
        targetPlan: "luxury",
      },
    ]);
  });

  it("previews luxury in its first quarterly unlock without hiding the annual entitlement", () => {
    const luxury = getPreviewServicePortal("luxury");

    expect(luxury.quotas.map(({ limit }) => limit)).toEqual([1, 1, 1, 5]);
    expect(
      luxury.quotas.map(({ entitlementLimit }) => entitlementLimit),
    ).toEqual([4, 4, 4, 20]);
    expect(luxury.quotaUnlock).toEqual({
      current: 1,
      total: 4,
      nextUnlockAt: "2026-10-18",
      capacityState: "available",
    });
  });

  it("moves selected questions directly into response logic", () => {
    const basic = getPreviewServicePortal("basic");

    expect(basic.knowledgeBase.sourceLabel).toBe("Website 流程同步知识库");
    expect(basic.capabilities.knowledgeBuild.reason).toBe(
      "普通版不包含知识库智能体；知识库由 Website 流程自动同步至本账号，服务团队可补录。升级进阶版或豪华版后可解锁知识库智能体。",
    );
    expect(basic.workflowSteps.map((step) => step.id)).toEqual([
      "knowledge",
      "question",
      "response_logic",
      "monitoring",
      "channel_distribution",
      "progress_report",
    ]);
    expect(
      basic.workflowSteps.find((step) => step.id === "response_logic"),
    ).toMatchObject({
      status: "ready",
      nextAction: {
        kind: "build_response_logic",
        label: "进入应答逻辑智能体",
        href: "/response-logic",
      },
    });
    expect(basic.primaryNextAction).toEqual({
      kind: "build_response_logic",
      label: "进入应答逻辑智能体",
      href: "/response-logic",
    });
  });

  it("keeps Advanced content assets locked until the knowledge agent publishes", () => {
    expect(
      getPreviewServicePortal("advanced").capabilities.contentAssets,
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        effectiveStatus: "pending",
        reason:
          "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
      }),
    );
  });

  it("keeps the acceptance knowledge snapshot anonymous", () => {
    expect(previewKnowledgeSnapshot.sourceFileName).toContain("验收企业");
    expect(previewKnowledgeProgress.build.companyName).toBe("验收企业");
    expect(JSON.stringify(previewKnowledgeSnapshot)).toContain("匿名合成内容");
  });
});
