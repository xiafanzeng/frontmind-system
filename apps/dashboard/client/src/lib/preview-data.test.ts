import { describe, expect, it } from "vitest";

import {
  getPreviewServicePortal,
  previewKnowledgeProgress,
  previewKnowledgeSnapshot,
} from "./preview-data";

describe("preview service portal fixtures", () => {
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

  it("moves selected questions directly into response logic", () => {
    const basic = getPreviewServicePortal("basic");

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

  it("keeps the acceptance knowledge snapshot anonymous", () => {
    expect(previewKnowledgeSnapshot.sourceFileName).toContain("验收企业");
    expect(previewKnowledgeProgress.build.companyName).toBe("验收企业");
    expect(JSON.stringify(previewKnowledgeSnapshot)).toContain("匿名合成内容");
  });
});
