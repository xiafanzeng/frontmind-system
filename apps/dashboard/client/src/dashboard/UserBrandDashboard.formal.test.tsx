import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const projectMocks = vi.hoisted(() => ({ id: "11111111-1111-4111-8111-111111111111", list: vi.fn(), create: vi.fn(), delete: vi.fn(), select: vi.fn() }));
vi.mock("./HistoricalResultsReadOnly", () => ({ default: ({ questionId, onBack }: { questionId: string; onBack: () => void }) => <section data-testid="historical-question-result">{questionId}<button onClick={onBack}>返回优化问题</button></section> }));
vi.mock("@/components/EmbeddedKnowledgeBasePanel", () => ({ default: () => <div data-testid="knowledge-agent">知识库节点工作区</div> }));
vi.mock("@/lib/enterprise-project", async original => ({ ...await original<typeof import("@/lib/enterprise-project")>(), switchEnterpriseProject: projectMocks.select }));

const {
  dashboardUseQuery,
  portalUseQuery,
  responseLogicUseQuery,
  questionPortfolioUseQuery,
  requestQuestionSelectionUseMutation,
  requestQuestionSelectionMutateAsync,
  questionMaintenanceExecuteUseMutation,
  purchaseIntentMutateAsync,
  purchaseIntentUseMutation,
  changePasswordUseMutation,
  monitoringFiltersUseQuery,
  monitoringSamplesUseQuery,
  monitoringSampleCitationsUseQuery,
  monitoringCitationSummaryUseQuery,
  brandQuestionUniverseObserveUseQuery,
  brandQuestionUniverseStartUseMutation,
  trpcUtils,
  authState,
} = vi.hoisted(() => ({
  dashboardUseQuery: vi.fn(),
  portalUseQuery: vi.fn(),
  responseLogicUseQuery: vi.fn(),
  questionPortfolioUseQuery: vi.fn(),
  requestQuestionSelectionUseMutation: vi.fn(),
  requestQuestionSelectionMutateAsync: vi.fn(),
  questionMaintenanceExecuteUseMutation: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  purchaseIntentMutateAsync: vi.fn(),
  purchaseIntentUseMutation: vi.fn(),
  changePasswordUseMutation: vi.fn(),
  monitoringFiltersUseQuery: vi.fn(),
  monitoringSamplesUseQuery: vi.fn(),
  monitoringSampleCitationsUseQuery: vi.fn(),
  monitoringCitationSummaryUseQuery: vi.fn(),
  brandQuestionUniverseObserveUseQuery: vi.fn(),
  brandQuestionUniverseStartUseMutation: vi.fn(),
  trpcUtils: {
    enterpriseProjects: { list: { setData: vi.fn(), invalidate: vi.fn() } },
    workspace: {
      brandQuestionUniverse: { observe: { invalidate: vi.fn() } },
      dashboard: { invalidate: vi.fn() },
      questionPortfolio: { invalidate: vi.fn() },
      portal: { invalidate: vi.fn() },
      responseLogic: { invalidate: vi.fn() },
    },
  },
  authState: {
    marketEdition: "domestic" as "domestic" | "overseas",
  },
}));

vi.mock("@/monitoring/Workspace", () => ({
  default: () => (
    <div data-testid="embedded-monitoring-business">真实监控模块</div>
  ),
}));

vi.mock("./siteops/ConnectedSiteOpsConversationPanel", () => ({
  default: () => (
    <div data-testid="connected-siteops-panel">OAuth-only SiteOps 已连接</div>
  ),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 7, role: "user", marketEdition: authState.marketEdition },
    logout: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  ConversationPurposeProvider: ({
    children,
    purpose,
  }: {
    children: React.ReactNode;
    purpose: string;
  }) => (
    <div data-testid="purpose-scope" data-purpose={purpose}>
      {children}
    </div>
  ),
}));
vi.mock("./EnterpriseQaWorkspace", () => ({
  default: () => <div data-testid="enterprise-qa-workspace" />,
}));

vi.mock("@/pages/Home", () => ({
  default: (props: {
    embedded: boolean;
    showKnowledgeBaseStarter: boolean;
    showAccountMenu: boolean;
  }) => (
    <div
      data-testid="customer-general-agent"
      data-embedded={String(props.embedded)}
      data-knowledge-starter={String(props.showKnowledgeBaseStarter)}
      data-account-menu={String(props.showAccountMenu)}
    />
  ),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => trpcUtils,
    auth: {
      changePassword: {
        useMutation: changePasswordUseMutation,
      },
    },
    enterpriseProjects: {
      list: { useQuery: projectMocks.list },
      create: { useMutation: () => ({ mutateAsync: projectMocks.create }) },
      rename: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      delete: { useMutation: () => ({ mutateAsync: projectMocks.delete }) },
      monitoringProgress: { useQuery: () => ({ data: { projects: [], runs: [], summary: { projectCount: 0, runCount: 0, expectedAttempts: 0, completedAttempts: 0, failedAttempts: 0 } }, isLoading: false }) },
      createMonitoringProject: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    workspace: {
      portal: {
        useQuery: portalUseQuery,
      },
      dashboard: {
        useQuery: dashboardUseQuery,
      },
      brandQuestionUniverse: {
        observe: { useQuery: brandQuestionUniverseObserveUseQuery },
        start: { useMutation: brandQuestionUniverseStartUseMutation },
      },
      responseLogic: {
        useQuery: responseLogicUseQuery,
      },
      questionPortfolio: {
        useQuery: questionPortfolioUseQuery,
      },
      requestQuestionSelection: {
        useMutation: requestQuestionSelectionUseMutation,
      },
      questionMaintenance: {
        execute: {
          useMutation: questionMaintenanceExecuteUseMutation,
        },
      },
      purchaseIntent: {
        useMutation: purchaseIntentUseMutation,
      },
      monitoring: {
        filters: {
          useQuery: monitoringFiltersUseQuery,
        },
        samples: {
          useQuery: monitoringSamplesUseQuery,
        },
        sampleCitations: {
          useQuery: monitoringSampleCitationsUseQuery,
        },
        citationSummary: {
          useQuery: monitoringCitationSummaryUseQuery,
        },
      },
    },
  },
}));

import UserBrandDashboard from "./UserBrandDashboard";

const managedPayload = {
  brandName: "新企业",
  headline: "新企业内容体系",
  summary: "由管理员发布的正式数据",
  metrics: [
    {
      label: "事实条目",
      value: 12,
      unit: "项",
      note: "管理员维护",
    },
  ],
  sections: [
    {
      id: "company-facts",
      title: "企业事实",
      subtitle: "正式资料",
      body: "由管理员发布的板块正文",
      items: [
        {
          title: "核验动作",
          description: "核验证书、本部关系与学校性质",
          meta: "已发布",
        },
      ],
      tables: [
        {
          id: "phase-roadmap",
          title: "分阶段路线",
          description: "管理员上传的执行表格",
          columns: ["阶段", "动作"],
          rows: [["第1周", "形成该说与不要说清单"]],
        },
      ],
    },
  ],
  keywordTables: [
    {
      id: "enterprise-keywords",
      title: "企业问题词库",
      description: "管理员上传",
      columns: ["序号", "问题", "核心词", "核心词分类", "问题细分"],
      rows: [["1", "如何选择新企业？", "新企业", "场景痛点词", "场景方案"]],
    },
  ],
  questions: [],
  monitoringAnswers: [],
  citations: [],
  optimizationReport: {
    period: "2026 年 7 月",
    title: "新企业 GEO 优化进度报告",
    subtitle: "管理员发布的正式报告",
    executiveSummary: [],
    kpis: [],
    platforms: [],
    journeys: [],
    competitorTiers: [],
    sourceMix: [],
    risks: [],
    roadmap: [
      ["短期 1–4 周", "核验证书、本部关系与学校性质", "形成该说与不要说清单"],
    ],
    reportRecords: [],
  },
  progressReports: [
    {
      id: "progress-report-r1",
      revision: 1,
      publishedAt: Date.parse("2026-06-30T08:00:00.000Z"),
      report: {
        period: "2026 年 6 月",
        title: "新企业 GEO 六月进度报告",
        subtitle: "上一服务周期的正式报告",
        executiveSummary: [],
        kpis: [],
        platforms: [],
        journeys: [],
        competitorTiers: [],
        sourceMix: [],
        risks: [],
        roadmap: [],
        reportRecords: [],
      },
    },
  ],
  contentAssets: [
    {
      id: "enterprise-first",
      group: "行业内容",
      name: "首个企业资产",
      description: "正式账号首项",
      wordRange: "",
      imageCount: 0,
      scene: "",
      impact: 0,
      articles: [
        {
          id: "published-article-1",
          title: "管理员发布的文章",
          intro: "这是正式发布的内容摘要。",
          sections: [["事实说明", "内容来自管理员上传并确认发布的当前版本。"]],
        },
      ],
    },
    {
      id: "enterprise-second",
      group: "行业内容",
      name: "第二个企业资产",
      description: "正式账号第二项",
      wordRange: "",
      imageCount: 0,
      scene: "",
      impact: 0,
      articles: [],
    },
  ],
};

const portalPayload = {
  mode: "operator",
  enterpriseProjectId: "11111111-1111-4111-8111-111111111111",
  schemaVersion: 1,
  account: {
    displayName: "旧账号显示名",
    username: "new-enterprise",
  },
  service: {
    contractId: "formal-contract",
    planCode: "luxury",
    planName: "豪华版",
    billingLabel: "季度服务",
    status: "active",
    validFrom: Date.parse("2026-07-01T00:00:00+08:00"),
    validUntil: Date.parse("2026-07-31T23:59:59+08:00"),
    source: "admin",
  },
  capabilities: {
    knowledgeBuild: { allowed: true, status: "available" },
    knowledgeDisplay: { allowed: true, status: "available" },
    globalKeywords: { allowed: true, status: "available" },
    questionSelection: { allowed: true, status: "available" },
    intentOptimization: { allowed: true, status: "available" },
    responseLogic: { allowed: true, status: "available" },
    monitoring: { allowed: true, status: "available" },
    channelDistribution: { allowed: true, status: "available" },
    progressReport: { allowed: true, status: "available" },
    contentAssets: { allowed: true, status: "available" },
  },
  knowledge: {
    status: "display_ready",
    latestImportStatus: "completed",
    version: 2,
  },
  quotas: {
    limits: {
      industryLimit: 4,
      competitorComparisonLimit: 4,
      reputationLimit: 4,
      productScenarioLimit: 20,
      totalQuestionLimit: 32,
    },
    usage: {
      industry: 1,
      competitorComparison: 2,
      reputation: 1,
      productScenario: 5,
      total: 9,
    },
  },
  purchasedQuestions: [],
  purchases: [],
  purchaseActions: [],
};

function progressiveLuxuryQuotas(
  capacityState: "available" | "awaiting_unlock" | "exhausted",
) {
  return {
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
    nextUnlockAt: "2026-10-01T00:00:00+08:00",
    capacityState,
  };
}

describe("UserBrandDashboard formal workspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    projectMocks.delete.mockReset();
    projectMocks.select.mockClear();
    trpcUtils.enterpriseProjects.list.setData.mockReset().mockImplementation((_input, update) => {
      const query = projectMocks.list();
      projectMocks.list.mockReturnValue({ ...query, data: update(query.data) });
    });
    window.history.replaceState(null, "", `/?enterpriseProjectId=${projectMocks.id}`);
    projectMocks.list.mockReturnValue({ data: { projects: [{ id: projectMocks.id, name: "企业项目A", ownerUserId: 7, revision: 1 }] }, isLoading: false, refetch: vi.fn() });
    authState.marketEdition = "domestic";
    purchaseIntentMutateAsync.mockReset();
    purchaseIntentUseMutation.mockReset();
    changePasswordUseMutation.mockReset();
    dashboardUseQuery.mockReset();
    portalUseQuery.mockReset();
    responseLogicUseQuery.mockReset();
    questionPortfolioUseQuery.mockReset();
    monitoringFiltersUseQuery.mockReset();
    monitoringSamplesUseQuery.mockReset();
    monitoringSampleCitationsUseQuery.mockReset();
    monitoringCitationSummaryUseQuery.mockReset();
    brandQuestionUniverseObserveUseQuery.mockReset();
    brandQuestionUniverseStartUseMutation.mockReset();
    requestQuestionSelectionUseMutation.mockReset();
    requestQuestionSelectionMutateAsync.mockReset();
    responseLogicUseQuery.mockReturnValue({
      data: { records: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    questionPortfolioUseQuery.mockReturnValue({
      data: { quotaPeriodId: "formal-period", questions: [] },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    monitoringFiltersUseQuery.mockReturnValue({
      data: { batches: [] },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringSamplesUseQuery.mockReturnValue({
      data: { items: [], total: 0, page: 1, pageSize: 100 },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringSampleCitationsUseQuery.mockReturnValue({
      data: { items: [], total: 0, nextCursor: null },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringCitationSummaryUseQuery.mockReturnValue({
      data: {
        batchKey: "",
        totalCitations: 0,
        channels: [],
        contents: [],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    requestQuestionSelectionUseMutation.mockReturnValue({
      mutateAsync: requestQuestionSelectionMutateAsync,
      isPending: false,
    });
    purchaseIntentUseMutation.mockReturnValue({
      mutateAsync: purchaseIntentMutateAsync,
      isPending: false,
    });
    changePasswordUseMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    brandQuestionUniverseObserveUseQuery.mockReturnValue({
      data: {
        canStart: false,
        reason: "engineer_version",
        knowledgeSnapshotId: null,
        knowledgeVersion: null,
        dashboardRevision: 1,
        credentialReady: true,
        engineerVersionPresent: true,
        operation: null,
      },
      error: null,
    });
    brandQuestionUniverseStartUseMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: null,
    });
    dashboardUseQuery.mockReturnValue({
      data: { payload: managedPayload, revision: 7 },
      isLoading: false,
      isError: false,
    });
    portalUseQuery.mockReturnValue({
      data: { portal: portalPayload },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });


  it("opens the selected enterprise project with six modules and no plan chrome", async () => {
    render(<UserBrandDashboard />);
    expect(await screen.findByTestId("knowledge-agent")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "项目板块" })).getAllByRole("link")).toHaveLength(6);
    expect(screen.getByRole("img", { name: "FrontMind" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "服务首页" })).toBeNull();
    expect(screen.queryByText("豪华版")).toBeNull();
    expect(screen.queryByText("续费套餐")).toBeNull();
    expect(portalUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: true, retry: false }));
  });
  it("restores historical results from a project URL and returns to its optimization questions", async () => {
    window.history.replaceState(null, "", `/?view=historical-results&questionId=archived-question&enterpriseProjectId=${projectMocks.id}`);
    render(<UserBrandDashboard />);
    expect(await screen.findByTestId("historical-question-result")).toHaveTextContent("archived-question");
    expect(screen.queryByTestId("knowledge-agent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回优化问题" }));
    expect(new URLSearchParams(window.location.search).get("view")).toBe("questions");
    expect(new URLSearchParams(window.location.search).get("enterpriseProjectId")).toBe(projectMocks.id);
  });
  it("keeps monitoring and publishing in the same project shell", async () => {
    render(<UserBrandDashboard />);
    const sidebar = screen.getByRole("button", { name: "AI智能品牌优化" }).closest("aside");
    fireEvent.click(screen.getByRole("link", { name: /进度监控/ }));
    expect(await screen.findByTestId("embedded-monitoring-business")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从优化问题新建监控项目" })).toBeEnabled();
    fireEvent.click(screen.getByRole("link", { name: /媒体发布/ }));
    fireEvent.click(screen.getByRole("link", { name: "稿件" }));
    expect(window.location.pathname).toBe("/publishing/articles");
    expect(new URLSearchParams(window.location.search).get("enterpriseProjectId")).toBe(projectMocks.id);
    expect(screen.getByRole("button", { name: "AI智能品牌优化" }).closest("aside")).toBe(sidebar);
  });
  it("opens enterprise QA under project tools while preserving project navigation", async () => {
    render(<UserBrandDashboard />);
    fireEvent.click(screen.getByRole("link", { name: /项目工具/ }));
    expect(await screen.findByTestId("enterprise-qa-workspace")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/enterprise-qa");
    expect(screen.getByRole("button", { name: "账号与余额" })).toBeInTheDocument();
  });
  it("shows actual monitoring report counts instead of invented results", () => {
    render(<UserBrandDashboard />);
    fireEvent.click(screen.getByRole("link", { name: /进度监控/ }));
    fireEvent.click(screen.getByRole("link", { name: "进度报告" }));
    expect(screen.getByText(/尚无监控运行记录/)).toBeInTheDocument();
    expect(screen.getByText("运行次数")).toBeInTheDocument();
  });
  it("keeps project modules unmounted when project access is denied", () => {
    projectMocks.list.mockReturnValue({ error: new Error("无权访问企业项目"), isLoading: false });
    render(<UserBrandDashboard />);
    expect(screen.getByRole("alert")).toHaveTextContent("无权访问企业项目");
    expect(screen.queryByTestId("knowledge-agent")).toBeNull();
    expect(portalUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });
  it("lets a new operator create the first enterprise project even with a collapsed sidebar", async () => {
    window.history.replaceState(null, "", "/");
    projectMocks.list.mockReturnValue({ data: { projects: [] }, isLoading: false });
    projectMocks.create.mockResolvedValue({ id: projectMocks.id });
    render(<UserBrandDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    fireEvent.click(screen.getByRole("button", { name: "新建企业项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "新品牌" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(projectMocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: "新品牌", ownerUserId: 7 })));
    expect(projectMocks.select).toHaveBeenCalledWith(7, projectMocks.id);
  });
  it("removes a confirmed deletion from cache before leaving the last project", async () => {
    projectMocks.delete.mockResolvedValue({ enterpriseProjectId: projectMocks.id, revision: 2 });
    render(<UserBrandDashboard />);
    fireEvent.keyDown(screen.getByRole("button", { name: "项目管理" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除当前项目" }));
    expect(projectMocks.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    await waitFor(() => expect(projectMocks.delete).toHaveBeenCalledWith({ enterpriseProjectId: projectMocks.id, expectedRevision: 1 }));
    await waitFor(() => expect(trpcUtils.enterpriseProjects.list.setData).toHaveBeenCalled());
    const update = trpcUtils.enterpriseProjects.list.setData.mock.calls.at(-1)![1];
    expect(update({ projects: [{ id: projectMocks.id }, { id: "remaining" }] })).toEqual({ projects: [{ id: "remaining" }] });
    expect(new URLSearchParams(window.location.search).has("enterpriseProjectId")).toBe(false);
  });
  it("does not override a new destination after deletion completes", async () => {
    let finish!: (value: unknown) => void;
    projectMocks.delete.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<UserBrandDashboard />);
    fireEvent.keyDown(screen.getByRole("button", { name: "项目管理" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除当前项目" }));
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    window.history.replaceState(null, "", "/agent");
    await act(async () => finish({ enterpriseProjectId: projectMocks.id, revision: 2 }));
    expect(window.location.pathname).toBe("/agent");
    expect(projectMocks.select).not.toHaveBeenCalled();
  });
  it("keeps the customer dashboard chunk free of the private tracker brand", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "client/src/dashboard/UserBrandDashboard.tsx",
      ),
      "utf8",
    );
    const privateTrackerBrand = ["jeno", "va"].join("");

    expect(source).toContain("通过 FrontMind 品牌追踪智能体");
    expect(source).not.toMatch(new RegExp(privateTrackerBrand, "iu"));
  });


  it("routes legacy website metadata through OAuth-only SiteOps", () => {
    authState.marketEdition = "overseas";
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: /项目工具/ }));
    fireEvent.click(screen.getByRole("link", { name: "网站管理" }));

    expect(screen.queryByTestId("connected-siteops-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI友好官网" }));
    fireEvent.click(screen.getByRole("button", { name: "现有工作流" }));
    expect(screen.getByTestId("connected-siteops-panel")).toHaveTextContent(
      "OAuth-only SiteOps 已连接",
    );
    expect(
      screen.queryByRole("heading", { name: "官网开通进度" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("已购买域名")).not.toBeInTheDocument();
  });


  it("retains published website content after removing the content operations page", () => {
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: /项目工具/ }));
    fireEvent.click(screen.getByRole("link", { name: "网站管理" }));

    expect(
      screen.queryByRole("button", { name: "内容资产运营" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑内容资产" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("提交内容需求")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI友好官网" }));
    fireEvent.click(screen.getByRole("button", { name: "文章管理" }));
    expect(screen.getByText("首个企业资产")).toBeInTheDocument();
    expect(screen.getByText("管理员发布的文章")).toBeInTheDocument();
    expect(
      screen.getByText("内容来自管理员上传并确认发布的当前版本。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("影响力")).toBeNull();
    expect(screen.queryByText("3,500-6,000")).toBeNull();
  });


  it("does not expose the retired content-system entry", () => {
    render(<UserBrandDashboard />);

    expect(
      screen.queryByRole("button", { name: "内容制作体系" }),
    ).not.toBeInTheDocument();
  });


  it("does not substitute built-in sample questions when a formal account has no questions", () => {
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: /意图优化/ }));

    expect(
      screen.getByRole("heading", { name: "当前项目尚无优化问题" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("FrontMind 超前智能是一家什么样的公司？"),
    ).toBeNull();
  });


  it("replaces the submitted ticket workspace with the published customer word bank", () => {
    render(<UserBrandDashboard />);

    expect(
      screen.queryByRole("button", { name: "企业资料看板" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "品牌全域词库" }));

    expect(
      screen.getByRole("heading", { name: "品牌全域词库" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "全域词库" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/配置工单|AI 监控与优化工程师|正式词表/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "候选问题目录" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/个候选问题|已确认/)).not.toBeInTheDocument();
    expect(screen.getByText("如何选择新企业？")).toBeInTheDocument();
    const keywordTable = screen.getByRole("table");
    expect(
      within(keywordTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["问题", "主分类", "问题细分", "问题优化"]);
    expect(screen.queryByLabelText("排序")).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "核心词" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "创建日期" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "序号" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).getByRole("columnheader", { name: "问题优化" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/香港中文大学/)).toBeNull();
  });


  it("shows only a neutral word-bank waiting state before an upload exists", () => {
    dashboardUseQuery.mockReturnValue({
      data: {
        payload: {
          ...managedPayload,
          keywordTables: [],
        },
      },
      isLoading: false,
      isError: false,
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: "品牌全域词库" }));

    expect(
      screen.getByRole("heading", { name: "品牌全域词库正在准备中" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("内容发布后会自动显示在这里。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/配置工单|候选问题目录|AI 监控与优化工程师/),
    ).not.toBeInTheDocument();
  });


  it("locks and confirms an authoritative word-bank question before it enters service", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    questionPortfolioUseQuery.mockReturnValue({
      data: { quotaPeriodId: "formal-period", questions: [] },
      isLoading: false,
      isFetching: false,
      refetch,
    });
    requestQuestionSelectionMutateAsync.mockResolvedValue({
      question: {
        id: "selected-question-from-word-bank",
        status: "selected",
        selectionApprovalStatus: "approved",
        locked: true,
      },
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: "品牌全域词库" }));
    fireEvent.click(screen.getByRole("button", { name: "选择并进入问题优化" }));

    const questionInput = screen.getByRole("textbox", { name: "目标问题" });
    expect(questionInput).toHaveValue("如何选择新企业？");
    expect(questionInput).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "问题来源" })).toHaveValue(
      "品牌全域词库",
    );
    expect(
      screen.queryByRole("combobox", { name: "问题类别" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "保存到当前企业项目后即可开展应答优化与监控；后续仍可修改或删除。",
    );
    expect(requestQuestionSelectionMutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));

    await waitFor(() =>
      expect(requestQuestionSelectionMutateAsync).toHaveBeenCalledWith({
        mode: "brand_keyword_library",
        dashboardRevision: 7,
        tableId: "enterprise-keywords",
        rowIndex: 0,
      }),
    );
    await waitFor(() =>
      expect(
        trpcUtils.workspace.questionPortfolio.invalidate,
      ).toHaveBeenCalled(),
    );
  });


  it("keeps the word-bank warning open when confirmation fails", async () => {
    requestQuestionSelectionMutateAsync.mockRejectedValueOnce(
      new Error("额度刚刚发生变化"),
    );
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: "品牌全域词库" }));
    fireEvent.click(screen.getByRole("button", { name: "选择并进入问题优化" }));
    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));

    await waitFor(() =>
      expect(requestQuestionSelectionMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "保存到当前企业项目后即可开展应答优化与监控；后续仍可修改或删除。",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "如何选择新企业？",
    );
  });


  it("immediately selects a directly entered question with its category", async () => {
    requestQuestionSelectionMutateAsync.mockResolvedValue({
      question: {
        id: "direct-question-1",
        selectionApprovalStatus: "approved",
      },
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("link", { name: /意图优化/ }));
    expect(screen.getByRole("textbox", { name: "问题来源" })).toHaveValue(
      "自主填写",
    );
    expect(
      screen.getByRole("combobox", { name: "问题类别" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "目标问题" }), {
      target: { value: "新企业如何验证产品交付能力？" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "问题类别" }), {
      target: { value: "industry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));

    await waitFor(() =>
      expect(requestQuestionSelectionMutateAsync).toHaveBeenCalledWith({
        mode: "direct",
        question: "新企业如何验证产品交付能力？",
        category: "industry",
      }),
    );
  });


  it("projects only the response logic published by the agent into problem optimization", () => {
    const question = {
      id: "formal-question-1",
      contractId: "formal-contract",
      quotaPeriodId: "formal-period",
      category: "product_scenario",
      question: "企业官网怎样成为 AI 可引用的权威信源？",
      intent: "核验官网是否完整呈现可追溯的企业事实与权威证据。",
      intentRevision: 3,
      intentConfirmedRevision: null,
      intentConfirmedAt: null,
      intentConfirmed: false,
      rationale: "建议来自当前知识库的官网证据覆盖情况。",
      evidence: [],
      risks: [],
      source: "model",
      status: "selected",
      locked: true,
      revision: 5,
    };
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          capabilities: {
            ...portalPayload.capabilities,
            questionSelection: {
              allowed: false,
              status: "locked",
              reason: "本期新增问题已锁定。",
            },
          },
          purchasedQuestions: [question],
          workflowSteps: [
            {
              id: "response_logic",
              label: "应答逻辑",
              status: "complete",
              lockedReason: "",
              href: "/response-logic",
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    responseLogicUseQuery.mockReturnValue({
      data: {
        records: [
          {
            id: "response-logic-1",
            questionId: question.id,
            groupId: "basic",
            groupTitle: "产品场景",
            question: question.question,
            intent: question.intent,
            summary: question.rationale,
            draft: {
              concern: "",
              conclusion: "",
              facts: "",
              pending: "",
              boundaries: "",
              references: "",
              images: [],
              attachments: [],
            },
            confirmed: {
              concern: "企业希望确认官网能否成为稳定、可追溯的 AI 信源。",
              conclusion:
                "先核验企业身份与核心能力。\n再用公开证据解释服务边界与适用场景。",
              facts: "企业官网正式资料\n知识库事实节点",
              pending: "客户案例公开授权",
              boundaries: "不使用无法核验的行业第一表述",
              references: "企业官网\n知识库事实确认表",
              images: [
                {
                  id: "evidence-image-1",
                  name: "官网证据截图",
                  url: "/frontmind-contract-logo-white.svg",
                  caption: "官网事实证据",
                  source: "企业官网",
                  section: "事实依据",
                  authorization: "公开可用",
                },
              ],
              attachments: [],
              version: 2,
              updatedAt: "2026-07-26T01:00:00.000Z",
            },
            version: 2,
            createdAt: Date.parse("2026-07-25T01:00:00.000Z"),
            updatedAt: Date.parse("2026-07-26T01:00:00.000Z"),
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<UserBrandDashboard />);
    fireEvent.click(screen.getByRole("link", { name: /意图优化/ }));

    expect(screen.getByText("问题目录")).toBeInTheDocument();
    expect(screen.getAllByText("产品场景词").length).toBeGreaterThan(0);
    expect(
      screen.getByText("企业希望确认官网能否成为稳定、可追溯的 AI 信源。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/先核验企业身份与核心能力。/)).toBeInTheDocument();
    expect(screen.getByText(/企业官网正式资料/)).toBeInTheDocument();
    expect(screen.queryByText("客户案例公开授权")).toBeNull();
    expect(screen.queryByText("引自知识库文档。")).toBeNull();
    expect(
      screen.getByText("不使用无法核验的行业第一表述"),
    ).toBeInTheDocument();
    expect(screen.getByAltText("官网事实证据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改问题" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "删除问题" })).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: `查看“${question.question}”的需求记录`,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "需求记录" }),
    ).not.toBeInTheDocument();

    for (const redundantCopy of [
      "建议的优化方向",
      "为什么这样优化",
      "版本 3",
      "优化方向已确认",
      "此问题优化方向已确认",
      "确认以上优化内容",
      "已发布应答逻辑 V2.0",
      "发布时间：",
    ]) {
      expect(screen.queryByText(redundantCopy)).toBeNull();
    }
  });


});
