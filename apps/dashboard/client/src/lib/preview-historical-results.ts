import type { HistoricalQuestionResults } from "@shared/historical-results";
import type { PurchasedServiceQuestion } from "@/dashboard/service-portal";

function previewCategory(
  kind: PurchasedServiceQuestion["kind"],
): HistoricalQuestionResults["question"]["category"] {
  if (kind === "industry") return "industry";
  if (kind === "competitor") return "competitor_comparison";
  if (kind === "reputation") return "reputation";
  return "product_scenario";
}

export function buildPreviewHistoricalResults(
  question: PurchasedServiceQuestion,
): HistoricalQuestionResults {
  const collectedAt = Date.parse("2026-06-28T09:30:00+08:00");
  return {
    readOnly: true,
    question: {
      id: question.id,
      externalQuestionId: question.externalQuestionId ?? null,
      sourceQuestionId: question.sourceQuestionId ?? null,
      category: previewCategory(question.kind),
      question: question.question,
      intent: question.intent || "核验企业能力、事实依据与长期合作可信度",
      intentRevision: question.intentRevision,
      intentConfirmedRevision: question.intentConfirmedRevision,
      intentConfirmedAt: question.intentConfirmedAt,
      intentConfirmed: question.intentConfirmed,
      rationale: "该问题来自上一服务周期，成果继续保留。",
      evidence: [],
      risks: [],
      source: "admin",
      status: "selected",
      selectionApprovalStatus: "approved",
      selectionRequestedAt: collectedAt,
      selectionApprovedAt: collectedAt,
      locked: true,
      revision: 1,
    },
    lineageQuestionIds: [
      question.id,
      ...(question.sourceQuestionId ? [question.sourceQuestionId] : []),
    ],
    responseLogic: [
      {
        recordId: "preview-historical-response",
        questionId: question.id,
        status: "confirmed",
        version: 2,
        updatedAt: collectedAt,
        content: {
          concern: "采购方关心长期稳定性、交付能力与售后响应是否有证据。",
          conclusion:
            "历史口径以公开产品能力、已核验交付记录和服务体系为依据，不使用未经核验的市场排名。",
          facts: "已沉淀产品能力边界、交付流程、质量控制节点与售后响应机制。",
          pending: "后续周期如有新增案例，可由服务团队在当前问题中继续补充。",
          boundaries: "不承诺未公开客户信息，不使用无法追溯来源的销量或排名。",
          references: "企业官网产品页、服务流程说明、历史验收资料。",
          images: [],
          attachments: [],
        },
      },
    ],
    monitoring: {
      samples: [
        {
          id: "preview-historical-sample",
          sourceRecordId: "preview-historical-sample-source",
          questionId: question.id,
          platform: "DeepSeek",
          answerNo: 1,
          content:
            "模型回答已能引用企业公开能力与服务体系，但对历史案例的证据表达仍需保持审慎。",
          citationCount: 1,
          monitorRank: null,
          screenshotUrl: null,
          collectedAt,
          batchKey: "preview-history-june",
          sourceName: "历史周期复测",
          batchRevision: 1,
        },
      ],
      sampleTotal: 1,
      citations: [
        {
          id: "preview-historical-citation",
          sourceRecordId: "preview-historical-citation-source",
          sampleId: "preview-historical-sample",
          questionId: question.id,
          question: question.question,
          model: "deepseek",
          title: "企业官网产品与服务说明",
          url: "https://www.frontmind.net",
          media: "企业官网",
          domain: "frontmind.net",
          publishedAt: null,
          collectedAt,
          batchKey: "preview-history-june",
          sourceName: "历史周期复测",
          batchRevision: 1,
        },
      ],
      citationTotal: 1,
    },
  };
}
