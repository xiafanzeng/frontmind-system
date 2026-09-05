// @ts-nocheck
import {
  acceptanceGeoAnswerBooks,
  acceptanceGeoIntents,
  acceptanceRepresentativeAnswers,
} from "@/dev-assets/acceptance-monitoring-fixture";
import {
  getPreviewServicePortal,
  previewContentAssetCatalog,
  previewKnowledgeProgress,
  previewKnowledgeSnapshot,
} from "@/lib/preview-data";
import { buildPreviewHistoricalResults } from "@/lib/preview-historical-results";
import type { AdminDeliveryTicketPreviewFixtures } from "@/components/AdminDeliveryTicketWorkspace";

const overview = {
  brand: "验收企业",
  shortName: "验收企业",
  englishName: "Acceptance Company",
  dateRange: "2026-01-15",
  headline: "以匿名合成回答持续校准品牌呈现",
  summary:
    "本验收租户使用同一批次的 50 条匿名合成问答样本，验证按问题、平台和日期区间的正确聚合。",
  kpis: [],
};

const brandBuilding = {
  updatedAt: "2026-01-15",
  knowledgeBase: {
    facts: [
      ["品牌名称", "验收企业"],
      ["监控主题", "方案适配与公开口碑核验"],
      ["数据批次", "2026-01-15"],
      ["问答样本", "2 个问题、5 个平台、50 条具体回答"],
      ["信源样本", "匿名合成引用记录"],
    ],
    evidence: [
      "问答正文来自仓库内匿名合成验收数据。",
      "渠道与内容引用仅用于验证界面聚合结构。",
      "未带答案 ID 的信源只进入问题级汇总，不伪装为单条回答信源。",
    ],
  },
  knowledgeManuals: [
    {
      module: "品牌事实边界",
      title: "同名主体与产品事实核验",
      content:
        "先确认验收企业主体、方案边界和公开凭证，再形成可被模型引用的统一口径。",
      deliverables: [
        {
          name: "主体识别清单",
          detail: "企业全称、所属行业、官网与可核验公开来源。",
        },
        {
          name: "产品证据卡",
          detail: "方案能力、适用业务场景、服务边界与授权资料。",
        },
      ],
    },
    {
      module: "问答与舆情治理",
      title: "推荐场景和风险问题应答",
      content:
        "按平台留存真实回答，识别品牌遗漏、同名误判与缺少权威依据的问题。",
      deliverables: [
        {
          name: "标准回答口径",
          detail: "推荐问题与舆情问题分别维护事实、边界和引用依据。",
        },
      ],
    },
  ],
  positioning: {
    statement: "以可核验的方案事实和业务场景证据建立清晰品牌认知。",
    audience: "关注方案适配、服务边界与品牌可信度的企业用户。",
    differentiator: "用结构化企业事实避免同名主体误判，并持续核验模型回答。",
  },
  qaArchitecture: {
    path: "场景提问 → 主体确认 → 产品事实 → 安全边界 → 可核验来源",
    principle:
      "推荐类问题先说明适用场景与服务边界；舆情类问题先确认主体，避免把其他同名企业的问题归因到当前品牌。",
    metrics: [
      ["2", "核心问题", "本批次真实监控问题"],
      ["5", "AI 平台", "同日回答采样平台"],
      ["50", "具体回答", "逐条可查看的真实回答"],
    ],
    priorityAssets: [
      ["P0", "企业主体与品牌身份页"],
      ["P0", "方案边界与适用场景"],
      ["P1", "常见问题与同名主体澄清"],
    ],
    sampleAnswers: [
      {
        category: "产品场景",
        question: "验收企业的方案适合哪些业务场景？",
        answer: "先按业务场景和服务边界筛选，再比较具体方案与服务证据。",
        evidence: ["方案资料", "服务边界", "匿名用户场景"],
      },
      {
        category: "美誉舆情",
        question: "如何核验验收企业的公开口碑？",
        answer: "先确认企业全称和所属行业，再只引用与该主体直接相关的记录。",
        evidence: ["企业主体信息", "官方公开资料", "可追溯第三方来源"],
      },
    ],
  },
  visualSystem: {
    concept: "方案适配与证据路径",
    principle: "视觉资料必须来自企业授权资产，并与产品事实逐项对应。",
    motifs: [
      ["主视觉", "匿名方案、业务场景与服务流程"],
      ["信息卡", "方案事实、边界信息和来源日期"],
    ],
  },
  verbalVisual: {
    vocabulary: ["方案适配", "服务边界", "事实可核验", "主体清晰"],
    banned: ["绝对保证", "行业第一", "无条件推荐", "同名主体混用"],
  },
  semanticAudit: {
    issueMatrix: [
      ["品牌指代", "待补强", "存在同名主体混淆", "回答前先确认企业全称"],
      ["推荐场景", "待补强", "合成回答中品牌露出不足", "补齐方案与场景证据"],
    ],
  },
};

const globalKeywordBank = {
  categories: [{ 核心词分类: "场景痛点词" }, { 核心词分类: "品牌核心词" }],
  questions: [
    {
      序号: 1,
      问题: "验收企业的方案适合哪些业务场景？",
      核心词: "验收企业",
      核心词分类: "场景痛点词",
      热度: 1,
      优先级: "重点覆盖",
      GEO场景: "场景推荐",
    },
    {
      序号: 2,
      问题: "如何核验验收企业的公开口碑？",
      核心词: "验收企业",
      核心词分类: "品牌核心词",
      热度: 1,
      优先级: "口径治理",
      GEO场景: "美誉舆情",
    },
  ],
};

const reportQuestion = (
  id: keyof typeof acceptanceRepresentativeAnswers,
  category: string,
  expectedLogic: string,
  gaps: string[],
  improvements: string[],
) => {
  const sample = acceptanceRepresentativeAnswers[id];
  return {
    id,
    category,
    question: sample.question,
    summary: "",
    metrics: [],
    before: {
      platform: "",
      capturedAt: "",
      content: sample.before?.content || "",
      screenshots: sample.before?.screenshotUrl
        ? [
            {
              id: `${id}-before`,
              url: sample.before.screenshotUrl,
              alt: `${sample.question}优化前真实回答截图`,
            },
          ]
        : [],
    },
    expectedLogic,
    gaps,
    after: {
      platform: "",
      capturedAt: "",
      content: sample.after?.content || "",
      screenshots: sample.after?.screenshotUrl
        ? [
            {
              id: `${id}-after`,
              url: sample.after.screenshotUrl,
              alt: `${sample.question}优化后真实回答截图`,
            },
          ]
        : [],
    },
    improvements,
    analysis: "",
    evidence: [],
    afterEffect: {
      released: true,
      totalScore: 72,
      grade: "B",
      summary: "管理员已开放本题优化后效果验收样例。",
      dimensions: [
        {
          id: "identity",
          label: "主体识别",
          score: 15,
          maxScore: 20,
          summary: "已将同名主体确认设为回答前置步骤。",
        },
        {
          id: "evidence",
          label: "事实与信源",
          score: 14,
          maxScore: 20,
          summary: "问题级信源与具体回答保持独立、可追溯。",
        },
      ],
      platforms: [
        {
          platform: "DeepSeek",
          responseCount: 5,
          mentionRate: null,
          averageRank: null,
          factAccuracy: "复测已记录",
          propositionHitRate: "复测已记录",
          citationCount: id === "acceptance-product-scenario" ? 12 : 10,
          referenceCount: id === "acceptance-product-scenario" ? 12 : 10,
          verdict: "此处只用于核验字段渲染；正式复测结果由管理员发布。",
        },
      ],
      gapFillSummary:
        "已建立主体确认、场景边界和来源核验三项结构化检查；正式数值以管理员发布的复测数据为准。",
      gapClosures: [
        {
          topic: "同名主体混淆",
          beforeGap: "部分回答把其他同名企业信息混入当前品牌判断。",
          result: "标准应答逻辑要求先确认企业主体。",
          status: "partial",
        },
      ],
    },
  };
};

const optimizationReport = {
  period: "",
  title: "验收企业问题优化进度报告",
  subtitle: "",
  executiveSummary: [],
  kpis: [],
  platforms: [],
  journeys: [],
  competitorTiers: [],
  sourceMix: [],
  risks: [],
  roadmap: [],
  reportRecords: [],
  questionBaselines: [
    {
      id: "acceptance-product-scenario-baseline",
      questionId: "acceptance-product-scenario",
      question: "验收企业的方案适合哪些业务场景？",
      category: "产品场景词",
      generatedAt: "",
      period: "",
      title: "方案适配问题优化前基准",
      subtitle: "",
      scopeLabel: "",
      totalScore: 46,
      grade: "C",
      summary: "合成回答覆盖方案选择，但企业身份和方案事实露出不足。",
      dimensions: [],
      platforms: [],
      findings: [],
      priorityActions: [],
      limitations: [],
    },
    {
      id: "acceptance-reputation-review-baseline",
      questionId: "acceptance-reputation-review",
      question: "如何核验验收企业的公开口碑？",
      category: "美誉舆情词",
      generatedAt: "",
      period: "",
      title: "公开口碑问题优化前基准",
      subtitle: "",
      scopeLabel: "",
      totalScore: 38,
      grade: "D",
      summary: "真实回答存在显著同名主体混淆，需要先确认企业身份。",
      dimensions: [],
      platforms: [],
      findings: [],
      priorityActions: [],
      limitations: [],
    },
  ],
  questionReports: [
    reportQuestion(
      "acceptance-product-scenario",
      "产品场景词",
      "先明确业务目标、使用环境与服务边界，再按适配性和证据组织方案建议；只使用已核验的企业与方案事实。",
      [
        "回答普遍直接罗列方案，缺少可核验的企业事实。",
        "服务边界与适用场景的解释口径不一致。",
      ],
      [
        "建立场景、服务边界与方案证据的固定回答顺序。",
        "将企业主体和方案资料与推荐结论逐项绑定。",
      ],
    ),
    reportQuestion(
      "acceptance-reputation-review",
      "美誉舆情词",
      "先确认用户所指企业全称、所属行业和地域，再区分当前品牌事实与其他同名主体；负面判断必须给出直接相关、可追溯且有日期的来源。",
      [
        "多条回答将不同地区、不同行业的同名企业混为一谈。",
        "部分结论缺少与当前主体直接相关的证据。",
      ],
      ["把企业主体确认设为第一步。", "未能归属当前主体的材料不进入品牌结论。"],
    ),
  ],
};

const publishedContentAssets = [
  {
    id: "acceptance-solution-facts",
    group: "品牌事实内容",
    name: "方案选型与服务边界事实",
    description: "管理员发布的 AI 友好内容资产验收样例。",
    wordRange: "",
    imageCount: 0,
    scene: "企业采购、业务落地与方案选型",
    articles: [
      {
        id: "acceptance-solution-guide",
        title: "方案选型时应优先核验哪些事实",
        intro:
          "内容按使用场景、安全认证、适配性和证据来源组织；具体企业与产品结论以管理员确认发布的事实为准。",
        sections: [
          [
            "核验顺序",
            "先确认业务场景，再核验服务边界、方案适配、产品资料及可追溯来源。",
          ],
        ],
      },
    ],
  },
];

export const userPreviewFixtures = {
  getServicePortal: getPreviewServicePortal,
  contentAssetCatalog: previewContentAssetCatalog,
  overview,
  brandBuilding,
  globalKeywordBank,
  geoIntents: acceptanceGeoIntents,
  geoAnswerBooks: acceptanceGeoAnswerBooks,
  optimizationReport,
  publishedContentAssets,
  knowledgeProgress: previewKnowledgeProgress,
  knowledgeSnapshot: previewKnowledgeSnapshot,
  buildHistoricalResults: buildPreviewHistoricalResults,
};

export const adminDashboardPreviewFixtures = {
  managedAdminId: "101",
  managedUserIds: [1, 2],
  ticketOverview: {
    counts: {
      pending: 2,
      completed: 18,
    },
    tickets: [
      {
        id: "preview-admin-ticket-1",
        userId: 1,
        enterpriseName: "验收企业 A",
        assignedAdminId: 101,
        assignedAdminName: "FrontMind Admin",
        type: "content_asset",
        title: "用户案例与成功故事",
        topic: "骑行装备产品应用案例",
        status: "submitted",
        publicStatus: "pending",
        revision: 2,
        createdAt: "2026-07-26T09:30:00+08:00",
        updatedAt: "2026-07-27T10:10:00+08:00",
      },
      {
        id: "preview-admin-ticket-2",
        userId: 2,
        enterpriseName: "验收企业 B",
        assignedAdminId: 103,
        assignedAdminName: "陈悦",
        type: "website_operation",
        category: "product_case_docs",
        title: "产品案例与文档",
        topic: "骑行装备产品资料更新",
        status: "submitted",
        publicStatus: "pending",
        revision: 4,
        createdAt: "2026-07-26T10:05:00+08:00",
        updatedAt: "2026-07-27T09:05:00+08:00",
      },
      {
        id: "preview-admin-ticket-3",
        userId: 1,
        enterpriseName: "验收企业 A",
        assignedAdminId: 101,
        assignedAdminName: "FrontMind Admin",
        type: "website_operation",
        title: "企业新闻与动态",
        status: "completed",
        publicStatus: "completed",
        revision: 3,
        createdAt: "2026-07-25T17:40:00+08:00",
        updatedAt: "2026-07-26T17:40:00+08:00",
      },
    ],
  },
  usageAlerts: [
    {
      id: "preview-website-key",
      scope: "website_frontend",
      used: 188_400,
      accountUsed: 188_400,
      limit: 230_000,
      warningRatio: 0.8,
      windowDays: 30,
      fetchedAt: "2026-07-28T08:00:00+08:00",
      syncStatus: "ok",
    },
    {
      id: "preview-user-key",
      scope: "managed_user",
      userId: 1,
      enterpriseName: "验收企业 A",
      used: 84_200,
      accountUsed: 31_600,
      credentialFingerprint: "9f17b2d4a631c809",
      limit: 230_000,
      warningRatio: 0.8,
      windowDays: 30,
      fetchedAt: "2026-07-28T08:00:00+08:00",
      syncStatus: "ok",
    },
  ],
};

export const adminDeliveryTicketPreviewFixtures: AdminDeliveryTicketPreviewFixtures =
  {
    tickets: [
      {
        id: "preview-ticket-knowledge-reset",
        userId: 1,
        enterpriseName: "验收企业 A",
        type: "knowledge_base",
        category: "knowledge_reset",
        title: "知识库重置申请",
        status: "completed",
        publicStatus: "completed",
        publicSummary: "知识库已清空，可以重新开始首次构建。",
        revision: 2,
        createdAt: "2026-07-30T22:43:00+08:00",
        updatedAt: "2026-07-30T22:43:00+08:00",
      },
      {
        id: "preview-ticket-1",
        userId: 1,
        enterpriseName: "验收企业 A",
        type: "content_asset",
        category: "case_study",
        title: "用户案例与成功故事",
        topic: "骑行装备在城市通勤场景中的产品应用案例",
        description:
          "希望基于已确认客户素材，整理一篇可供行业媒体核验的案例稿。",
        status: "submitted",
        quotaPool: "content_asset_publish",
        quotaState: "reserved",
        revision: 3,
        createdAt: "2026-07-26T09:30:00+08:00",
        updatedAt: "2026-07-27T10:10:00+08:00",
      },
      {
        id: "preview-ticket-2",
        userId: 1,
        enterpriseName: "验收企业 A",
        type: "website_operation",
        category: "product_case_docs",
        title: "产品案例与文档",
        topic: "补充骑行装备产品资料与适用场景",
        status: "submitted",
        quotaPool: "website_content_publish",
        quotaState: "reserved",
        revision: 5,
        createdAt: "2026-07-23T15:10:00+08:00",
        updatedAt: "2026-07-27T08:45:00+08:00",
      },
    ],
    events: [
      {
        id: "event-1",
        visibility: "customer",
        eventType: "status_change",
        actorLabel: "用户",
        statusTo: "submitted",
        message: "客户提交知识库重置申请，知识库已进入只读锁定。",
        createdAt: "2026-07-30T22:43:00+08:00",
      },
      {
        id: "event-2",
        visibility: "customer",
        eventType: "status_change",
        actorLabel: "交付成员",
        statusTo: "completed",
        message: "知识库重置已批准并完成清理，可以重新开始首次构建。",
        createdAt: "2026-07-30T22:43:00+08:00",
      },
    ],
    periodId: "preview-luxury-period",
    revision: 1,
    contentAssetQuota: {
      used: 7,
      reserved: 1,
      consumed: 6,
      limit: 20,
    },
    websiteContentQuota: {
      used: 31,
      reserved: 2,
      consumed: 29,
      limit: 100,
    },
  };
