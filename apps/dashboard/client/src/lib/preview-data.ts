import type { DashboardPayload } from "@shared/dashboard";
import type {
  KnowledgeBaseProgressBranchDto,
  KnowledgeBaseProgressDto,
  KnowledgeBaseProgressLeafDto,
} from "@shared/knowledge-base-progress";
import type { KnowledgeSnapshotView } from "@/components/KnowledgeBaseViewer";
import type {
  PurchasedServiceQuestion,
  ServiceAction,
  ServiceCapability,
  ServiceCapabilityKey,
  ServicePortalView,
  ServiceWorkflowStep,
} from "@/dashboard/service-portal";

export const previewContentAssetCatalog = [
  {
    id: "A1",
    group: "A 类：GEO 优化文章",
    name: "品牌聚合榜单",
    description: "多品牌介绍与选型指南",
  },
  {
    id: "A2",
    group: "A 类：GEO 优化文章",
    name: "行业测评解析",
    description: "深度行业分析与品牌定位",
  },
  {
    id: "A3",
    group: "A 类：GEO 优化文章",
    name: "场景解决方案",
    description: "按场景拆解与方案说明",
  },
  {
    id: "A4",
    group: "A 类：GEO 优化文章",
    name: "技术科普",
    description: "行业知识与品牌关联",
  },
  {
    id: "A5",
    group: "A 类：GEO 优化文章",
    name: "品宣与品牌故事",
    description: "品牌历程、里程碑、案例和愿景",
  },
  {
    id: "A6",
    group: "A 类：GEO 优化文章",
    name: "选型指南",
    description: "多维度选型标准、风险点和 FAQ",
  },
  {
    id: "A7",
    group: "A 类：GEO 优化文章",
    name: "避坑指南",
    description: "常见陷阱、识别方法和正确做法",
  },
  {
    id: "A9",
    group: "A 类：GEO 优化文章",
    name: "行业趋势与洞察",
    description: "数据密集型行业分析和趋势预测",
  },
  {
    id: "A10",
    group: "A 类：GEO 优化文章",
    name: "FAQ 常见问题",
    description: "高频问答、导言和总结",
  },
  {
    id: "B1",
    group: "B 类：权威长内容",
    name: "行业白皮书",
    description: "深度研究报告",
  },
  {
    id: "B2",
    group: "B 类：权威长内容",
    name: "技术文档",
    description: "产品或方案技术详解",
  },
  {
    id: "B3",
    group: "B 类：权威长内容",
    name: "用户案例与成功故事",
    description: "客户成功案例",
  },
  {
    id: "C1a",
    group: "C 类：媒体与公关",
    name: "事件型新闻稿",
    description: "纯事件报道、5W1H、高管引语和品牌简介",
  },
  {
    id: "C1b",
    group: "C 类：媒体与公关",
    name: "品牌深度新闻稿",
    description: "机构全景介绍、技术实力和发展历程",
  },
  {
    id: "C3",
    group: "C 类：媒体与公关",
    name: "行业评论稿",
    description: "行业趋势与品牌观点",
  },
  {
    id: "D1",
    group: "D 类：问答内容",
    name: "知乎问答",
    description: "围绕真实用户问题组织专业、可核验的问答内容",
  },
] as const;

export const previewUserDashboard: DashboardPayload = {
  brandName: "验收企业 · 企业知识中枢",
  headline: "让企业事实、产品能力与全网品牌信息持续成为 AI 可引用的答案",
  summary:
    "以官网、全网公开信息和企业内部资料为统一知识底座，持续沉淀可核验文本、图片资产与 GEO 内容证据。",
  metrics: [
    { label: "知识文档", value: 186, unit: "篇", note: "12 个标准化知识域" },
    { label: "图片资产", value: 428, unit: "张", note: "产品、工厂与案例图片" },
    { label: "内容字数", value: "32.8", unit: "万字", note: "已完成来源核验" },
  ],
  keywordTables: [],
  questions: [],
  monitoringAnswers: [],
  citations: [],
  contentAssets: [],
  optimizationReport: null,
  progressReports: [],
  sections: [
    {
      id: "overview",
      title: "企业身份与核心定位",
      subtitle: "统一对外事实口径与品牌表达",
      body: "验收企业知识库围绕企业主体、匿名方案、适用场景、服务边界与品牌舆情组织合成事实。关键事实均保留来源、更新时间和核验状态。",
      items: [
        {
          title: "核心定位",
          description: "匿名企业方案与品牌事实",
          meta: "官方资料 · 已核验",
        },
        {
          title: "知识维护状态",
          description: "企业身份与工商信息已完成本月复核",
          meta: "2026-07-22",
        },
      ],
      tables: [],
    },
    {
      id: "products",
      title: "产品与解决方案",
      subtitle: "面向 AI 答案组织的产品事实与场景证据",
      body: "已形成龙门加工中心、卧式加工中心、立式加工中心等产品族知识结构，并关联技术参数、应用行业、交付案例和原始图片。",
      items: [
        {
          title: "产品知识图谱",
          description: "8 个产品族、47 个标准型号与 126 项核心参数",
          meta: "结构化数据",
        },
        {
          title: "应用案例",
          description: "覆盖航空航天、汽车、模具、能源装备等场景",
          meta: "38 个案例",
        },
      ],
      tables: [],
    },
    {
      id: "evidence",
      title: "技术研发与制造证据",
      subtitle: "专利、研发平台、工厂与质量控制资料",
      body: "研发与制造节点已关联专利台账、检测设备、生产流程、质量认证及工厂实景图片，便于后续内容直接引用。",
      items: [],
      tables: [],
    },
    {
      id: "knowledge",
      title: "知识库智能体",
      subtitle: "继续对话即可补充或修订知识库",
      body: "完成全部节点后点击“更新知识库”同步最终 ZIP；后续对话产生的新版本也由用户确认后更新展示内容。",
      items: [],
      tables: [],
    },
  ],
};

const previewProgressBranches = [
  {
    id: "identity",
    title: "企业身份",
    leaves: [
      "一句话定位",
      "企业简介",
      "发展历程",
      "使命愿景价值观",
      "工商与注册地址",
      "资质与荣誉",
    ],
  },
  {
    id: "team",
    title: "团队",
    leaves: [
      "创始人与核心领导",
      "核心团队",
      "研发团队",
      "组织结构",
      "人才培养",
      "团队文化",
    ],
  },
  {
    id: "products",
    title: "产品与服务",
    leaves: [
      "产品线全景",
      "核心产品定位",
      "关键规格参数",
      "差异化优势",
      "应用场景",
      "产品案例与问答",
    ],
  },
  {
    id: "capabilities",
    title: "核心能力",
    leaves: [
      "研发平台",
      "核心技术",
      "生产制造",
      "质量控制",
      "供应链能力",
      "定制与交付",
    ],
  },
  {
    id: "customers",
    title: "客户与行业",
    leaves: [
      "目标客户",
      "重点行业",
      "行业痛点",
      "解决方案",
      "客户案例",
      "客户评价与授权",
    ],
  },
  {
    id: "advantages",
    title: "为什么选我们",
    leaves: [
      "核心竞争优势",
      "竞品对比",
      "数据与成果",
      "专利与认证证据",
      "品牌口碑",
      "全网权威来源",
    ],
  },
  {
    id: "cooperation",
    title: "合作方式",
    leaves: [
      "售前咨询",
      "需求确认",
      "方案与报价",
      "实施交付",
      "培训验收",
      "售后与联系方式",
    ],
  },
] as const;

const previewProgressLeaves: KnowledgeBaseProgressLeafDto[] =
  previewProgressBranches
    .flatMap((branch) =>
      branch.leaves.map((title) => ({
        id: `${branch.id}.${title}`,
        title,
        branchId: branch.id,
        branchTitle: branch.title,
        ordinal: 0,
        status: "pending" as const,
      })),
    )
    .map((leaf, ordinal) => ({
      ...leaf,
      ordinal,
      status:
        ordinal < 14
          ? ("confirmed" as const)
          : ordinal < 17
            ? ("direct_prefilled" as const)
            : ordinal === 17
              ? ("needs_verification" as const)
              : ("pending" as const),
    }));

function previewBranchDto(
  branch: (typeof previewProgressBranches)[number],
): KnowledgeBaseProgressBranchDto {
  const leaves = previewProgressLeaves.filter(
    (leaf) => leaf.branchId === branch.id,
  );
  const confirmed = leaves.filter((leaf) => leaf.status === "confirmed").length;
  const directPrefilled = leaves.filter(
    (leaf) => leaf.status === "direct_prefilled",
  ).length;
  return {
    id: branch.id,
    title: branch.title,
    total: leaves.length,
    handled: confirmed + directPrefilled,
    confirmed,
    directPrefilled,
    pending: leaves.filter((leaf) => leaf.status === "pending").length,
    current: leaves.filter((leaf) => leaf.status === "current").length,
    needsVerification: leaves.filter(
      (leaf) => leaf.status === "needs_verification",
    ).length,
    leaves,
  };
}

export const previewKnowledgeProgress: KnowledgeBaseProgressDto = {
  build: {
    id: "preview-build",
    conversationId: "preview-conversation",
    companyName: "验收企业",
    status: "confirming",
    revision: 18,
    currentLeafId: previewProgressLeaves[17]!.id,
    protocolError: null,
    updatedAt: Date.parse("2026-07-23T15:30:00+08:00"),
  },
  summary: {
    total: previewProgressLeaves.length,
    handled: 17,
    confirmed: 14,
    directPrefilled: 3,
    pending: 24,
    current: 0,
    needsVerification: 1,
    overallPercent: 40,
  },
  branches: previewProgressBranches.map(previewBranchDto),
  packageAllowed: false,
};

export const previewKnowledgeSnapshot = {
  id: "preview-acceptance-v1",
  version: 1,
  sourceFileName: "验收企业知识库_V1.zip",
  documentCount: 12,
  imageCount: 3,
  characterCount: 1_007,
  totalBytes: 1_534_400,
  createdAt: "2026-07-18T10:24:00+08:00",
  documents: [
    {
      path: "01-企业身份与定位/企业概览.md",
      title: "企业身份与定位",
      content:
        "# 企业身份与定位\n\n验收企业知识库使用匿名合成内容保存企业全称、所属行业、方案事实与公开来源，验证同名主体隔离能力。\n\n## GEO 标准口径\n\n- 所有核心事实保留来源链接与核验日期\n- 企业主体、官网口径与内部资料交叉核验\n- 未获得凭证的信息明确标记为待核验",
    },
    {
      path: "02-产品与解决方案/产品矩阵.md",
      title: "产品与解决方案",
      content:
        "# 产品与解决方案\n\n知识库覆盖龙门、卧式、立式加工中心等产品族，并关联标准型号、核心参数、适用材料、加工场景与选型依据。\n\n| 产品族 | 标准型号 | 典型场景 |\n| --- | ---: | --- |\n| 龙门加工中心 | 16 | 大型复杂零部件 |\n| 卧式加工中心 | 13 | 箱体类零件批量加工 |\n| 立式加工中心 | 18 | 通用精密加工 |",
    },
    {
      path: "03-技术研发/研发能力.md",
      title: "技术研发与创新能力",
      content:
        "# 技术研发与创新能力\n\n已建立研发平台、专利与软件著作权、核心部件能力、关键技术指标和研发成果之间的证据关联。每项能力均可追溯到官方材料或企业凭证。",
    },
    {
      path: "04-制造质量/制造与质量控制.md",
      title: "制造体系与质量控制",
      content:
        "# 制造体系与质量控制\n\n从原材料、核心部件、装配、精度检测到出厂验收形成完整质量链路，并将工厂实景、检测设备与质量体系认证作为可引用图片证据。",
    },
    {
      path: "05-客户行业与案例/行业案例.md",
      title: "客户行业与应用案例",
      content:
        "# 客户行业与应用案例\n\n案例按航空航天、汽车、模具、能源装备等行业组织，记录客户需求、选型逻辑、实施过程和可量化结果。客户名称与 Logo 仅在获得授权时展示。",
    },
    {
      path: "06-合作流程与售后/服务体系.md",
      title: "合作流程与售后服务",
      content:
        "# 合作流程与售后服务\n\n覆盖需求澄清、方案设计、商务确认、生产交付、安装调试、培训验收与售后支持。SLA 等承诺以已批准的企业制度为准。",
    },
    {
      path: "07-团队组织与文化/组织与人才.md",
      title: "团队组织与企业文化",
      content:
        "# 团队组织与企业文化\n\n沉淀管理团队、研发人才、人才培养、价值观与雇主品牌资料。人物履历和照片必须经过授权与事实核验。",
    },
    {
      path: "08-发展成果与品牌/里程碑.md",
      title: "发展成果与品牌里程碑",
      content:
        "# 发展成果与品牌里程碑\n\n按时间线组织重要发展节点、荣誉资质、行业活动与品牌成果，避免将营销性表述作为未经证实的客观结论。",
    },
    {
      path: "09-全球渠道与市场/市场网络.md",
      title: "全球渠道与市场网络",
      content:
        "# 全球渠道与市场网络\n\n整理销售区域、服务网点、合作伙伴类型和主要市场语言版本，为区域化 GEO 内容提供统一底座。",
    },
    {
      path: "10-合规资质与标准/合规清单.md",
      title: "合规、资质与行业标准",
      content:
        "# 合规、资质与行业标准\n\n集中管理证书名称、编号、有效期、适用主体与凭证文件。过期或待核验材料不会作为当前有效资质对外引用。",
    },
    {
      path: "11-媒体与公共信息/全网信息索引.md",
      title: "全网信息与媒体索引",
      content:
        "# 全网信息与媒体索引\n\n除官网外，持续采集权威媒体、行业协会、展会、招投标与公开数据库信息，并记录来源等级、发布时间和事实冲突。",
    },
    {
      path: "12-GEO问答与证据/标准问答.md",
      title: "GEO 标准问答与证据映射",
      content:
        "# GEO 标准问答与证据映射\n\n将常见采购、技术、行业与品牌问题映射到经过核验的事实、文档段落和图片资产，便于模型生成可追溯的企业答案。",
    },
  ],
  assets: [
    {
      key: "preview-factory",
      path: "assets/brand/企业与制造视觉样例.webp",
      mimeType: "image/webp",
      size: 1_420_000,
      url: "/assets/frontmind-login-background.webp",
    },
  ],
} satisfies KnowledgeSnapshotView;

function available(reason = ""): ServiceCapability {
  return {
    allowed: true,
    effectiveStatus: "available",
    reason,
  };
}

function locked(reason: string, label = "查看升级方案"): ServiceCapability {
  return {
    allowed: false,
    effectiveStatus: "locked",
    reason,
    nextAction: {
      kind: "upgrade",
      label,
      targetPlan: "advanced",
    },
  };
}

function capabilitySet(
  values: Partial<Record<ServiceCapabilityKey, ServiceCapability>>,
): Record<ServiceCapabilityKey, ServiceCapability> {
  const unavailable: ServiceCapability = {
    allowed: false,
    effectiveStatus: "unavailable",
    reason: "当前服务尚未配置此能力。",
  };
  return {
    knowledgeBuild: values.knowledgeBuild || unavailable,
    knowledgeDisplay: values.knowledgeDisplay || unavailable,
    globalKeywords: values.globalKeywords || unavailable,
    questionSelection: values.questionSelection || unavailable,
    intentOptimization: values.intentOptimization || unavailable,
    responseLogic: values.responseLogic || unavailable,
    monitoring: values.monitoring || unavailable,
    channelDistribution: values.channelDistribution || unavailable,
    progressReport: values.progressReport || unavailable,
    contentAssets: values.contentAssets || unavailable,
  };
}

function previewQuestion(
  input: Pick<
    PurchasedServiceQuestion,
    "id" | "question" | "kind" | "statusLabel"
  > &
    Partial<PurchasedServiceQuestion>,
  confirmed = true,
): PurchasedServiceQuestion {
  const intent =
    input.intent ||
    `围绕“${input.question}”核验企业事实、服务能力与可追溯证据。`;
  return {
    ...input,
    intent,
    rationale:
      input.rationale ||
      "建议稿来自当前知识库证据，仍需用户逐题阅读并明确确认。",
    revision: input.revision ?? (confirmed ? 2 : 1),
    intentRevision: input.intentRevision ?? 1,
    intentConfirmedRevision:
      input.intentConfirmedRevision ?? (confirmed ? 1 : null),
    intentConfirmedAt:
      input.intentConfirmedAt ??
      (confirmed ? Date.parse("2026-07-22T09:30:00+08:00") : null),
    intentConfirmed: input.intentConfirmed ?? confirmed,
  };
}

const previewBasicQuestions: PurchasedServiceQuestion[] = [
  previewQuestion(
    {
      id: "acceptance-reputation-review",
      question: "如何核验验收企业的公开口碑？",
      kind: "basic",
      statusLabel: "官网购买时已选择",
    },
    false,
  ),
];

const previewLuxuryQuestions: PurchasedServiceQuestion[] = [
  previewQuestion({
    id: "acceptance-product-scenario",
    question: "验收企业的方案适合哪些业务场景？",
    kind: "scenario",
    statusLabel: "已纳入本月服务",
  }),
  previewQuestion({
    id: "acceptance-reputation-review",
    question: "如何核验验收企业的公开口碑？",
    kind: "reputation",
    statusLabel: "已纳入本月服务",
  }),
];

const purchaseUrl = "https://www.frontmind.net";

type PreviewWorkflowStepId = Exclude<
  ServiceWorkflowStep["id"],
  "intent_optimization"
>;

const previewWorkflowMeta: Record<
  PreviewWorkflowStepId,
  { label: string; href: string }
> = {
  knowledge: { label: "知识库智能体", href: "/knowledge-base" },
  question: {
    label: "品牌全域词库与选题",
    href: "/brand-question-portfolio",
  },
  response_logic: { label: "应答逻辑", href: "/response-logic" },
  monitoring: { label: "问题监控", href: "/question-monitoring" },
  channel_distribution: {
    label: "渠道分发",
    href: "/channel-distribution",
  },
  progress_report: { label: "进度报告", href: "/progress-report" },
};

const previewWorkflowOrder = Object.keys(
  previewWorkflowMeta,
) as PreviewWorkflowStepId[];

function previewWorkflow(
  plan: "basic" | "advanced" | "luxury",
  currentStep: PreviewWorkflowStepId | null,
  nextAction: ServiceAction,
): ServiceWorkflowStep[] {
  const currentIndex =
    currentStep === null
      ? previewWorkflowOrder.length
      : previewWorkflowOrder.indexOf(currentStep);
  return previewWorkflowOrder.map((id, index) => {
    const meta = previewWorkflowMeta[id];
    const status: ServiceWorkflowStep["status"] =
      index < currentIndex
        ? "complete"
        : index === currentIndex
          ? "ready"
          : "locked";
    const label =
      id === "knowledge"
        ? plan === "basic"
          ? "知识库展示"
          : "知识库智能体"
        : id === "question"
          ? plan === "basic"
            ? "已购问题"
            : "品牌全域词库与选题"
          : meta.label;
    return {
      id,
      label,
      status,
      lockedReason:
        status === "locked"
          ? currentStep === "knowledge"
            ? "请先通过知识库智能体完成全部节点，并联系管理员开启品牌全域词库。"
            : currentStep === "response_logic"
              ? "请先在应答逻辑智能体逐题发布确认。"
              : "请先完成上一项服务。"
          : "",
      href: meta.href,
      ...(status === "complete" ? {} : { nextAction }),
    };
  });
}

export const previewServicePortals = {
  basic: {
    schemaVersion: 1,
    known: true,
    account: {
      displayName: "验收企业",
      username: "acceptance.demo",
    },
    plan: {
      code: "basic",
      name: "普通版",
      billingLabel: "30 天单题服务",
      statusLabel: "已生效",
      validFrom: "2026-07-18",
      validUntil: "2026-08-16",
    },
    quotas: [
      {
        key: "basicQuestion",
        label: "已购问题",
        limit: 1,
        used: 1,
        unit: "个问题",
      },
    ],
    purchasedQuestions: previewBasicQuestions,
    historicalQuestions: [],
    workflowSteps: previewWorkflow("basic", "response_logic", {
      kind: "build_response_logic",
      label: "进入应答逻辑智能体",
      href: "/response-logic",
    }),
    knowledgeBase: {
      status: "ready",
      statusLabel: "可查看",
      version: "V1",
      sourceLabel: "官网初步知识库",
      updatedAt: "2026-07-18",
    },
    capabilities: capabilitySet({
      knowledgeBuild: locked(
        "普通版已包含官网生成的初步知识库展示，不包含对话式知识库构建。升级进阶版或豪华版后可解锁。",
      ),
      knowledgeDisplay: available(),
      globalKeywords: locked(
        "品牌全域词库属于进阶版与豪华版服务范围，普通版只围绕已购的单个问题开展优化。",
      ),
      questionSelection: locked(
        "普通版问题已在官网购买时完成选择，无需再次选择。继续购买普通版可新增一个问题。",
        "继续购买普通版",
      ),
      intentOptimization: available(),
      responseLogic: available(),
      monitoring: available(),
      channelDistribution: available(),
      progressReport: available(),
      contentAssets: available(),
    }),
    primaryNextAction: {
      kind: "build_response_logic",
      label: "进入应答逻辑智能体",
      href: "/response-logic",
    },
    purchaseActions: [
      {
        kind: "purchase_basic",
        label: "继续购买普通版",
        href: purchaseUrl,
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
    ],
  },
  advanced: {
    schemaVersion: 1,
    known: true,
    account: {
      displayName: "验收企业",
      username: "acceptance.advanced",
    },
    plan: {
      code: "advanced",
      name: "进阶版",
      billingLabel: "按季度",
      statusLabel: "已生效",
      validFrom: "2026-07-18",
      validUntil: "2026-10-17",
    },
    quotas: [
      { key: "industry", label: "行业词", limit: 1, used: 0, unit: "个词" },
      {
        key: "competitor",
        label: "竞品对比词",
        limit: 1,
        used: 0,
        unit: "个词",
      },
      {
        key: "reputation",
        label: "美誉舆情词",
        limit: 1,
        used: 0,
        unit: "个词",
      },
      {
        key: "scenario",
        label: "产品场景词",
        limit: 5,
        used: 0,
        unit: "个词",
      },
    ],
    purchasedQuestions: [],
    historicalQuestions: [
      previewQuestion({
        id: "preview-history-basic-question",
        question: "如何核验验收企业的公开口碑？",
        kind: "reputation",
        statusLabel: "只读历史",
      }),
    ],
    workflowSteps: previewWorkflow("advanced", "knowledge", {
      kind: "resume_knowledge_build",
      label: "继续知识库智能体",
      href: "/knowledge-base",
    }),
    knowledgeBase: {
      status: "missing",
      statusLabel: "构建中",
      version: "",
      sourceLabel: "",
      updatedAt: "",
    },
    capabilities: capabilitySet({
      knowledgeBuild: available(),
      knowledgeDisplay: available(),
      globalKeywords: available(),
      questionSelection: available(),
      intentOptimization: available(),
      responseLogic: available(),
      monitoring: available(),
      channelDistribution: available(),
      progressReport: available(),
      contentAssets: available(),
    }),
    primaryNextAction: {
      kind: "resume_knowledge_build",
      label: "继续知识库智能体",
      href: "/knowledge-base",
    },
    purchaseActions: [
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
    ],
  },
  luxury: {
    schemaVersion: 1,
    known: true,
    account: {
      displayName: "验收企业",
      username: "acceptance.luxury",
    },
    plan: {
      code: "luxury",
      name: "豪华版",
      billingLabel: "",
      statusLabel: "已生效",
      validFrom: "2026-07-18",
      validUntil: "2026-10-17",
    },
    quotas: [
      { key: "industry", label: "行业词", limit: 4, used: 4, unit: "个词" },
      {
        key: "competitor",
        label: "竞品对比词",
        limit: 4,
        used: 4,
        unit: "个词",
      },
      {
        key: "reputation",
        label: "美誉舆情词",
        limit: 4,
        used: 4,
        unit: "个词",
      },
      {
        key: "scenario",
        label: "产品场景词",
        limit: 20,
        used: 20,
        unit: "个词",
      },
    ],
    purchasedQuestions: previewLuxuryQuestions,
    historicalQuestions: [
      previewQuestion({
        id: "preview-history-advanced-question",
        question: "验收企业的方案适合哪些业务场景？",
        kind: "industry",
        statusLabel: "只读历史",
        sourceQuestionId: "preview-history-basic-question",
      }),
    ],
    workflowSteps: previewWorkflow("luxury", null, {
      kind: "view_progress_report",
      label: "查看最新进度报告",
      href: "/progress-report",
    }),
    knowledgeBase: {
      status: "ready",
      statusLabel: "可查看",
      version: "V1",
      sourceLabel: "知识库智能体发布",
      updatedAt: "2026-07-24",
    },
    capabilities: capabilitySet({
      knowledgeBuild: available(),
      knowledgeDisplay: available(),
      globalKeywords: available(),
      questionSelection: available(),
      intentOptimization: available(),
      responseLogic: available(),
      monitoring: available(),
      channelDistribution: available(),
      progressReport: available(),
      contentAssets: available(),
    }),
    primaryNextAction: {
      kind: "view_progress_report",
      label: "查看最新进度报告",
      href: "/progress-report",
    },
    purchaseActions: [
      {
        kind: "renew",
        label: "续费豪华版",
        targetPlan: "luxury",
      },
    ],
  },
} satisfies Record<"basic" | "advanced" | "luxury", ServicePortalView>;

export function getPreviewServicePortal(
  plan: keyof typeof previewServicePortals,
) {
  return previewServicePortals[plan];
}
