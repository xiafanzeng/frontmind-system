import { describe, expect, it } from "vitest";

import {
  assertBrandQuestionPortfolioContext,
  brandQuestionPortfolioSchema,
} from "../shared/brand-question-portfolio";

function fixture() {
  return {
    schemaVersion: 1 as const,
    skill: {
      name: "brand-question-portfolio" as const,
      version: "2" as const,
      model: "frontmind-pro" as const,
    },
    knowledgeSnapshot: {
      id: "snapshot-1",
      version: 2,
      archiveHash: "a".repeat(64),
    },
    enterprise: {
      identityHash: "b".repeat(64),
      canonicalName: "精密制造企业",
    },
    planCode: "advanced" as const,
    quotaPeriodId: "period-1",
    candidateTargets: {
      industry: 0,
      competitor_comparison: 0,
      reputation: 0,
      product_scenario: 1,
    },
    categories: {
      industry: [],
      competitor_comparison: [],
      reputation: [],
      product_scenario: [
        {
          candidateId: "laser-cutting-scenario",
          question: "精密制造企业如何选择适合复杂工件的激光切割方案？",
          intent: "评估产品是否适合复杂工件",
          rationale: "知识库记录了企业的设备能力和适用工件",
          evidence: [
            {
              documentPath: "02_产品与解决方案/激光切割.md",
              excerpt: "支持多种复杂工件加工。",
              relevance: "直接支持该应用场景",
            },
          ],
          risks: [],
        },
      ],
    },
    shortfalls: [],
    risks: [],
  };
}

describe("brand question portfolio contract", () => {
  it("accepts a strict Pro result bound to the current snapshot", () => {
    const value = brandQuestionPortfolioSchema.parse(fixture());
    expect(
      assertBrandQuestionPortfolioContext(value, {
        snapshotId: "snapshot-1",
        snapshotVersion: 2,
        archiveHash: "a".repeat(64),
        planCode: "advanced",
        quotaPeriodId: "period-1",
        enterprise: {
          identityHash: "b".repeat(64),
          canonicalName: "精密制造企业",
        },
        candidateTargets: {
          industry: 0,
          competitor_comparison: 0,
          reputation: 0,
          product_scenario: 1,
        },
        documents: [
          {
            path: "02_产品与解决方案/激光切割.md",
            content: "支持多种复杂工件加工。",
          },
        ],
      }),
    ).toBe(value);
  });

  it("rejects evidence paths outside the published snapshot", () => {
    const value = brandQuestionPortfolioSchema.parse(fixture());
    expect(() =>
      assertBrandQuestionPortfolioContext(value, {
        snapshotId: "snapshot-1",
        snapshotVersion: 2,
        archiveHash: "a".repeat(64),
        planCode: "advanced",
        quotaPeriodId: "period-1",
        enterprise: {
          identityHash: "b".repeat(64),
          canonicalName: "精密制造企业",
        },
        candidateTargets: {
          industry: 0,
          competitor_comparison: 0,
          reputation: 0,
          product_scenario: 1,
        },
        documents: [{ path: "README.md", content: "其他内容" }],
      }),
    ).toThrow("不存在的路径");
  });
});
