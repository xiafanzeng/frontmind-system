import { describe, expect, it, vi } from "vitest";

import type { ResponseLogicRecordDto } from "../shared/response-logic";
import { selectEditableServiceQuestion } from "./dashboard-service";
import { deriveServicePortalState } from "./service-entitlement";
import {
  getHistoricalQuestionResults,
  type HistoricalResultsDependencies,
} from "./historical-results-service";

const draft = {
  concern: "采购方关心长期稳定性。",
  conclusion: "以交付记录和售后体系作为判断依据。",
  facts: "历史项目按期验收。",
  pending: "",
  boundaries: "不承诺未经核验的市场排名。",
  references: "历史项目验收记录",
  images: [],
  attachments: [],
};

function portal() {
  return deriveServicePortalState({
    userId: 7,
    now: new Date("2026-07-26T08:00:00.000Z"),
    contract: {
      id: "contract-current",
      userId: 7,
      planCode: "advanced",
      status: "active",
      source: "admin",
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-10-01T00:00:00.000Z"),
      revision: 2,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    historicalQuestions: [
      {
        id: "history-question",
        contractId: "contract-old",
        quotaPeriodId: "period-old",
        externalQuestionId: "website-question",
        sourceQuestionId: null,
        category: "reputation",
        question: "品牌是否值得长期合作？",
        source: "website",
        status: "selected",
        locked: true,
        revision: 1,
      },
    ],
  });
}

function record(): ResponseLogicRecordDto {
  return {
    id: "logic-record",
    questionId: "history-question",
    groupId: "reputation",
    groupTitle: "美誉舆情",
    question: "品牌是否值得长期合作？",
    intent: "核验品牌可信度",
    summary: "形成可追溯回答",
    conversationId: "must-not-leak",
    lastTaskId: "must-not-leak",
    draft,
    confirmed: {
      ...draft,
      version: 3,
      updatedAt: "2026-06-30T08:00:00.000Z",
    },
    version: 3,
    createdAt: Date.parse("2026-06-01T08:00:00.000Z"),
    updatedAt: Date.parse("2026-06-30T08:00:00.000Z"),
  };
}

function dependencies(): HistoricalResultsDependencies {
  return {
    loadPortal: vi.fn().mockResolvedValue(portal()),
    resolveLineage: vi
      .fn()
      .mockResolvedValue(["history-question", "carried-question"]),
    loadResponseLogic: vi.fn().mockResolvedValue([record()]),
    loadMonitoringSamples: vi.fn().mockResolvedValue({
      items: [
        {
          id: "sample-1",
          sourceRecordId: "sample-external-1",
          questionId: "carried-question",
          question: "品牌是否值得长期合作？",
          platform: "DeepSeek",
          answerNo: 1,
          content: "历史监控回答",
          citationCount: 1,
          monitorRank: null,
          screenshotUrl: null,
          collectedAt: Date.parse("2026-06-30T08:00:00.000Z"),
          batchKey: "batch-june",
          sourceName: "六月复测.xlsx",
          batchRevision: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    }),
    loadMonitoringCitations: vi.fn().mockResolvedValue({
      items: [
        {
          id: "citation-1",
          sourceRecordId: "citation-external-1",
          sampleId: "sample-1",
          questionId: "history-question",
          question: "品牌是否值得长期合作？",
          model: "deepseek",
          title: "企业官网",
          url: "https://example.com/evidence",
          media: "官方",
          domain: "example.com",
          publishedAt: null,
          collectedAt: Date.parse("2026-06-30T08:00:00.000Z"),
          batchKey: "batch-june",
          sourceName: "六月复测.xlsx",
          batchRevision: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    }),
  };
}

describe("historical question results", () => {
  it("authorizes a historical identity and loads read-only results across its server lineage", async () => {
    const deps = dependencies();
    const result = await getHistoricalQuestionResults(
      { userId: 7, questionId: "website-question" },
      deps,
    );

    expect(deps.resolveLineage).toHaveBeenCalledWith(7, "history-question");
    expect(deps.loadResponseLogic).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([
        "history-question",
        "website-question",
        "carried-question",
      ]),
    );
    expect(deps.loadMonitoringSamples).toHaveBeenCalledWith(
      7,
      "history-question",
    );
    expect(deps.loadMonitoringCitations).toHaveBeenCalledWith(
      7,
      "history-question",
    );
    expect(result).toMatchObject({
      readOnly: true,
      question: { id: "history-question" },
      responseLogic: [
        {
          recordId: "logic-record",
          status: "confirmed",
          version: 3,
          content: { conclusion: "以交付记录和售后体系作为判断依据。" },
        },
      ],
      monitoring: {
        sampleTotal: 1,
        citationTotal: 1,
      },
    });
    expect(result.question).not.toHaveProperty("contractId");
    expect(result.question).not.toHaveProperty("quotaPeriodId");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("contract-old");
    expect(JSON.stringify(result)).not.toContain("period-old");
  });

  it("rejects non-historical IDs before loading any artifact", async () => {
    const deps = dependencies();

    await expect(
      getHistoricalQuestionResults(
        { userId: 7, questionId: "not-a-history-question" },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "QUESTION_NOT_FOUND",
      statusCode: 404,
    });
    expect(deps.resolveLineage).not.toHaveBeenCalled();
    expect(deps.loadResponseLogic).not.toHaveBeenCalled();
    expect(deps.loadMonitoringSamples).not.toHaveBeenCalled();
  });

  it("never resolves a historical identity into the active response-logic editor", () => {
    const base = portal();
    const activeQuestion = {
      ...base.historicalQuestions[0]!,
      id: "carried-question",
      contractId: "contract-current",
      quotaPeriodId: "period-current",
      sourceQuestionId: "history-question",
    };
    const withCarriedQuestion = {
      ...base,
      purchasedQuestions: [activeQuestion],
    };

    expect(
      selectEditableServiceQuestion(withCarriedQuestion, "history-question"),
    ).toBeNull();
    expect(
      selectEditableServiceQuestion(withCarriedQuestion, "website-question"),
    ).toBeNull();
    expect(
      selectEditableServiceQuestion(withCarriedQuestion, "carried-question"),
    ).toMatchObject({ id: "carried-question" });
  });
});
