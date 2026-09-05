import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  dashboardUseQuery,
  portalUseQuery,
  responseLogicUseQuery,
  questionPortfolioUseQuery,
  requestQuestionSelectionUseMutation,
  requestQuestionSelectionMutateAsync,
  questionMaintenanceSubmitUseMutation,
  purchaseIntentMutateAsync,
  purchaseIntentUseMutation,
  changePasswordUseMutation,
  monitoringFiltersUseQuery,
  monitoringSamplesUseQuery,
  monitoringSampleCitationsUseQuery,
  monitoringCitationSummaryUseQuery,
  deliveryWorkspaceUseQuery,
  deliveryIcpChecklistUseQuery,
  deliveryListUseInfiniteQuery,
  deliveryListFetchNextPage,
  deliveryCreateUseMutation,
  deliveryCreateMutateAsync,
  deliverySelectWebsiteStyleUseMutation,
  deliveryRequestWebsiteStyleRevisionUseMutation,
  deliveryDetailUseQuery,
  deliveryAddMessageUseMutation,
  deliveryAddMessageMutateAsync,
  deliveryCancelUseMutation,
  deliveryCancelMutateAsync,
  brandQuestionUniverseObserveUseQuery,
  brandQuestionUniverseStartUseMutation,
  trpcUtils,
  uploadFileMock,
  authState,
} = vi.hoisted(() => ({
  dashboardUseQuery: vi.fn(),
  portalUseQuery: vi.fn(),
  responseLogicUseQuery: vi.fn(),
  questionPortfolioUseQuery: vi.fn(),
  requestQuestionSelectionUseMutation: vi.fn(),
  requestQuestionSelectionMutateAsync: vi.fn(),
  questionMaintenanceSubmitUseMutation: vi.fn(() => ({
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
  deliveryWorkspaceUseQuery: vi.fn(),
  deliveryIcpChecklistUseQuery: vi.fn(),
  deliveryListUseInfiniteQuery: vi.fn(),
  deliveryListFetchNextPage: vi.fn(),
  deliveryCreateUseMutation: vi.fn(),
  deliveryCreateMutateAsync: vi.fn(),
  deliverySelectWebsiteStyleUseMutation: vi.fn(() => ({
    mutateAsync: vi.fn(),
  })),
  deliveryRequestWebsiteStyleRevisionUseMutation: vi.fn(() => ({
    mutateAsync: vi.fn(),
  })),
  deliveryDetailUseQuery: vi.fn(),
  deliveryAddMessageUseMutation: vi.fn(),
  deliveryAddMessageMutateAsync: vi.fn(),
  deliveryCancelUseMutation: vi.fn(),
  deliveryCancelMutateAsync: vi.fn(),
  brandQuestionUniverseObserveUseQuery: vi.fn(),
  brandQuestionUniverseStartUseMutation: vi.fn(),
  trpcUtils: {
    workspace: {
      brandQuestionUniverse: { observe: { invalidate: vi.fn() } },
      dashboard: { invalidate: vi.fn() },
    },
  },
  uploadFileMock: vi.fn(),
  authState: {
    marketEdition: "domestic" as "domestic" | "overseas",
  },
}));

vi.mock("@/lib/frontmind-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmind-api")>();
  return {
    ...actual,
    uploadFile: (...args: unknown[]) => uploadFileMock(...args),
  };
});

vi.mock("./siteops/ConnectedSiteOpsConversationPanel", () => ({
  default: () => (
    <div data-testid="connected-siteops-panel">OAuth-only SiteOps 已连接</div>
  ),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { marketEdition: authState.marketEdition },
    logout: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => trpcUtils,
    auth: {
      changePassword: {
        useMutation: changePasswordUseMutation,
      },
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
        submit: {
          useMutation: questionMaintenanceSubmitUseMutation,
        },
      },
      purchaseIntent: {
        useMutation: purchaseIntentUseMutation,
      },
      deliveryTickets: {
        workspace: {
          useQuery: deliveryWorkspaceUseQuery,
        },
        icpChecklist: {
          useQuery: deliveryIcpChecklistUseQuery,
        },
        list: {
          useInfiniteQuery: deliveryListUseInfiniteQuery,
        },
        create: {
          useMutation: deliveryCreateUseMutation,
        },
        selectWebsiteStyle: {
          useMutation: deliverySelectWebsiteStyleUseMutation,
        },
        requestWebsiteStyleRevision: {
          useMutation: deliveryRequestWebsiteStyleRevisionUseMutation,
        },
        detail: {
          useQuery: deliveryDetailUseQuery,
        },
        addMessage: {
          useMutation: deliveryAddMessageUseMutation,
        },
        cancel: {
          useMutation: deliveryCancelUseMutation,
        },
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
    deliveryWorkspaceUseQuery.mockReset();
    deliveryIcpChecklistUseQuery.mockReset();
    deliveryListUseInfiniteQuery.mockReset();
    deliveryListFetchNextPage.mockReset();
    deliveryCreateUseMutation.mockReset();
    deliveryCreateMutateAsync.mockReset();
    deliveryDetailUseQuery.mockReset();
    deliveryAddMessageUseMutation.mockReset();
    deliveryAddMessageMutateAsync.mockReset();
    deliveryCancelUseMutation.mockReset();
    deliveryCancelMutateAsync.mockReset();
    brandQuestionUniverseObserveUseQuery.mockReset();
    brandQuestionUniverseStartUseMutation.mockReset();
    uploadFileMock.mockReset();
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
    deliveryWorkspaceUseQuery.mockReturnValue({
      data: {
        siteProfile: null,
        siteChecks: [],
        contentAssetCatalog: [
          {
            id: "A1",
            group: "A 类：GEO 优化文章",
            name: "品牌聚合榜单",
            description: "多品牌介绍与选型指南",
          },
          {
            id: "D1",
            group: "D 类：问答内容",
            name: "知乎问答",
            description: "专业问答内容",
          },
        ],
        websiteContentCatalog: [
          { value: "company_facts", label: "企业资料与品牌事实" },
          { value: "product_case_docs", label: "产品案例与文档" },
          { value: "industry_news", label: "行业新闻与观察" },
          { value: "company_news", label: "企业新闻与动态" },
          { value: "faq_content", label: "FAQ 与问答页面" },
        ],
        websiteWorkflow: {
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: true,
        },
        quotas: {
          content_asset_publish: {
            type: "content_asset_publish",
            allowed: true,
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 20,
            remaining: 20,
            periodId: "formal-period",
            validFrom: null,
            validUntil: null,
            reason: null,
          },
          website_content_publish: {
            type: "website_content_publish",
            allowed: true,
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 100,
            remaining: 100,
            periodId: "formal-period",
            validFrom: null,
            validUntil: null,
            reason: null,
          },
        },
        tickets: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    deliveryIcpChecklistUseQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    });
    deliveryListUseInfiniteQuery.mockReturnValue({
      data: {
        pages: [{ tickets: [], nextCursor: null, hasMore: false }],
      },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: deliveryListFetchNextPage,
      refetch: vi.fn(),
    });
    deliveryCreateUseMutation.mockReturnValue({
      mutateAsync: deliveryCreateMutateAsync,
      isPending: false,
    });
    deliveryDetailUseQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    deliveryAddMessageUseMutation.mockReturnValue({
      mutateAsync: deliveryAddMessageMutateAsync,
      isPending: false,
    });
    deliveryCancelUseMutation.mockReturnValue({
      mutateAsync: deliveryCancelMutateAsync,
      isPending: false,
    });
    uploadFileMock.mockResolvedValue({
      fileId: "uploaded-delivery-file",
      filename: "企业资料.pdf",
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

  it("loads the authoritative service portal and opens on the service home", () => {
    render(<UserBrandDashboard />);

    expect(portalUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        refetchOnMount: "always",
        refetchOnWindowFocus: true,
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
      }),
    );
    expect(dashboardUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        refetchOnMount: "always",
        refetchOnWindowFocus: true,
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
      }),
    );
    expect(deliveryListUseInfiniteQuery).toHaveBeenCalledWith(
      { type: "content_asset", limit: 20 },
      expect.objectContaining({
        getNextPageParam: expect.any(Function),
      }),
    );
    expect(deliveryListUseInfiniteQuery).toHaveBeenCalledWith(
      {
        type: "website_operation",
        surface: "website_management",
        limit: 20,
      },
      expect.objectContaining({
        getNextPageParam: expect.any(Function),
      }),
    );
    expect(screen.queryByText("欢迎回来，新企业")).toBeNull();
    expect(
      screen.queryByText(
        "系统会根据真实完成状态，一次只引导您处理当前最重要的一步；未到达的页面会说明前置条件。",
      ),
    ).toBeNull();
    expect(screen.getByLabelText("当前服务版本：豪华版")).toBeInTheDocument();
    expect(screen.queryByText(/¥|89,400/)).not.toBeInTheDocument();
    expect(screen.queryByText(/每月验收本季度/)).not.toBeInTheDocument();
    expect(screen.queryByText("服务中")).toBeNull();
    expect(screen.queryByText(/香港中文大学/)).toBeNull();
    expect(screen.queryByText(/港中大/)).toBeNull();
  });

  it("does not mount semantic assets but keeps delivery history available before knowledge publication", () => {
    const knowledgeReason =
      "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。";
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          service: {
            ...portalPayload.service,
            planCode: "advanced",
            planName: "进阶版",
          },
          knowledge: {
            status: "missing",
            latestImportStatus: null,
            version: null,
          },
          workflowSteps: [
            {
              id: "knowledge",
              label: "知识库智能体",
              status: "ready",
              lockedReason: null,
              href: "/knowledge-base",
            },
          ],
          capabilities: {
            ...portalPayload.capabilities,
            contentAssets: {
              allowed: false,
              effectiveStatus: "workflow_prerequisite",
              reason: knowledgeReason,
            },
          },
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<UserBrandDashboard />);
    const contentAssetsNavigation = screen.getByRole("button", {
      name: "内容资产运营",
    });
    const websiteManagementNavigation = screen.getByRole("button", {
      name: "AI友好官网管理",
    });
    expect(contentAssetsNavigation).not.toHaveAttribute("title");
    expect(
      contentAssetsNavigation.querySelector("svg"),
    ).not.toBeInTheDocument();
    expect(websiteManagementNavigation).not.toHaveAttribute("title");
    expect(
      websiteManagementNavigation.querySelector("svg"),
    ).not.toBeInTheDocument();

    fireEvent.click(contentAssetsNavigation);

    expect(screen.getByText(/服务准备中/)).toBeInTheDocument();
    expect(screen.getByText(knowledgeReason)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "提交内容需求" }),
    ).not.toBeInTheDocument();
    expect(dashboardUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
    expect(deliveryWorkspaceUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: true }),
    );
  });

  it("shows brand tracking navigation only for overseas accounts", () => {
    const domesticView = render(<UserBrandDashboard />);

    const domesticPlanScope = screen.getByTestId("service-plan-scope");
    expect(
      within(domesticPlanScope)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "知识库智能体",
      "品牌全域词库与选题",
      "问题优化",
      "应答逻辑智能体",
      "问题监控",
      "进度报告",
      "AI 友好内容资产",
    ]);
    expect(
      within(domesticPlanScope).queryByText("舆情监控·品牌追踪"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("舆情监控")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "品牌追踪智能体" }),
    ).not.toBeInTheDocument();
    domesticView.unmount();

    authState.marketEdition = "overseas";
    render(<UserBrandDashboard />);

    const overseasPlanScope = screen.getByTestId("service-plan-scope");
    expect(
      within(overseasPlanScope)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "知识库智能体",
      "品牌全域词库与选题",
      "问题优化",
      "应答逻辑智能体",
      "问题监控",
      "进度报告",
      "AI 友好内容资产",
      "舆情监控·品牌追踪",
    ]);
    expect(screen.getAllByText("舆情监控").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("button", { name: "品牌追踪智能体" }),
    ).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "AI友好官网管理" }));

    expect(screen.getByTestId("connected-siteops-panel")).toHaveTextContent(
      "OAuth-only SiteOps 已连接",
    );
    expect(
      screen.queryByRole("heading", { name: "官网开通进度" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("已购买域名")).not.toBeInTheDocument();
  });

  it("does not duplicate the administrator-published customer dashboard on the service home", () => {
    render(<UserBrandDashboard />);

    expect(screen.queryByText("新企业内容体系")).not.toBeInTheDocument();
    expect(
      screen.queryByText("由管理员发布的正式数据"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("事实条目")).not.toBeInTheDocument();
    expect(
      screen.queryByText("由管理员发布的板块正文"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("形成该说与不要说清单")).not.toBeInTheDocument();
    expect(screen.queryByText(/香港中文大学/)).toBeNull();
  });

  it("combines the standardized request taxonomy with administrator-published assets", () => {
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "内容资产运营" }));

    expect(screen.getAllByText("品牌聚合榜单").length).toBeGreaterThan(0);
    expect(screen.getAllByText("知乎问答").length).toBeGreaterThan(0);
    expect(screen.getByText("多品牌介绍与选型指南")).toBeInTheDocument();
    expect(screen.getByText("专业问答内容")).toBeInTheDocument();
    expect(screen.queryByText("媒体稿件与权威信源")).not.toBeInTheDocument();
    expect(screen.getByText("首个企业资产")).toBeInTheDocument();
    expect(screen.getByText("管理员发布的文章")).toBeInTheDocument();
    expect(
      screen.getByText("内容来自管理员上传并确认发布的当前版本。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("影响力")).toBeNull();
    expect(screen.queryByText("3,500-6,000")).toBeNull();
  });

  it("uploads content files before creating a real delivery ticket", async () => {
    const sourceFile = new File(["facts"], "企业资料.pdf", {
      type: "application/pdf",
    });
    deliveryCreateMutateAsync.mockResolvedValue({ id: "ticket-1" });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "内容资产运营" }));
    fireEvent.click(screen.getByRole("button", { name: "选择品牌聚合榜单" }));
    fireEvent.change(screen.getByRole("textbox", { name: /话题方向/ }), {
      target: { value: "高端制造客户成功故事" },
    });
    fireEvent.change(screen.getByLabelText("意向媒体"), {
      target: { value: "新浪" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "参考链接" }), {
      target: { value: "https://example.com/customer-story" },
    });
    const fileInput = document.querySelector(
      "#content-request-files",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [sourceFile] } });
    fireEvent.click(screen.getByRole("button", { name: "提交给管理员" }));

    await waitFor(() =>
      expect(uploadFileMock).toHaveBeenCalledWith(sourceFile),
    );
    await waitFor(() =>
      expect(deliveryCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          clientRequestId: expect.any(String),
          type: "content_asset",
          category: "A1",
          topic: "高端制造客户成功故事",
          title: "品牌聚合榜单",
          preferredMedia: "新浪",
          materialUrls: ["https://example.com/customer-story"],
          attachments: [
            expect.objectContaining({
              fileId: "uploaded-delivery-file",
              filename: "企业资料.pdf",
              mimeType: "application/pdf",
              sizeBytes: sourceFile.size,
            }),
          ],
        }),
      ),
    );
  });

  it("loads formal content-ticket history through the cursor endpoint", async () => {
    const fetchContentNextPage = vi.fn().mockResolvedValue(undefined);
    deliveryListUseInfiniteQuery.mockImplementation(
      (input: { type: "content_asset" | "website_operation" }) => ({
        data: {
          pages:
            input.type === "content_asset"
              ? [
                  {
                    tickets: [
                      {
                        id: "content-ticket-page-1",
                        type: "content_asset",
                        category: "B3",
                        title: "用户案例与成功故事",
                        topic: "第一批真实内容需求",
                        status: "in_progress",
                        revision: 1,
                        submittedAt: "2026-07-27T08:00:00+08:00",
                      },
                    ],
                    nextCursor: "opaque-next-page",
                    hasMore: true,
                  },
                ]
              : [{ tickets: [], nextCursor: null, hasMore: false }],
        },
        isLoading: false,
        isError: false,
        error: null,
        hasNextPage: input.type === "content_asset",
        isFetchingNextPage: false,
        fetchNextPage:
          input.type === "content_asset"
            ? fetchContentNextPage
            : deliveryListFetchNextPage,
        refetch: vi.fn(),
      }),
    );
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "内容资产运营" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^选择/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));
    expect(screen.getByText("第一批真实内容需求")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    expect(fetchContentNextPage).toHaveBeenCalledTimes(1);
  });

  it("does not expose the retired content-system entry", () => {
    render(<UserBrandDashboard />);

    expect(
      screen.queryByRole("button", { name: "内容制作体系" }),
    ).not.toBeInTheDocument();
  });

  it("does not substitute built-in sample questions when a formal account has no questions", () => {
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

    expect(
      screen.getByRole("heading", { name: "当前周期尚无服务问题" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("FrontMind 超前智能是一家什么样的公司？"),
    ).toBeNull();
  });

  it("shares one batch and question across samples, precise sources, and citation summaries", async () => {
    const monitoringQuestion = {
      id: "monitor-question-1",
      contractId: "formal-contract",
      quotaPeriodId: "formal-period",
      category: "product_scenario",
      kind: "scenario",
      question: "新企业的产品适合哪些业务场景？",
      intent: "核验产品适用范围。",
      rationale: "结合正式证据说明适用范围。",
      evidence: [],
      risks: [],
      source: "admin",
      status: "selected",
      locked: true,
      revision: 1,
    };
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          purchasedQuestions: [monitoringQuestion],
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    dashboardUseQuery.mockReturnValue({
      data: {
        payload: {
          ...managedPayload,
          monitoringAnswers: [
            {
              id: "legacy-answer",
              questionId: monitoringQuestion.id,
              platform: "旧看板数据",
              collectedAt: "2025-01-01",
              answerNo: 1,
              content: "不应作为正式空数据的兜底答案。",
              citationCount: 99,
              screenshotUrl: "",
              citations: [],
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
    });
    monitoringFiltersUseQuery.mockReturnValue({
      data: {
        batches: [
          {
            batchKey: "shared-batch",
            collectedAt: Date.parse("2026-07-27T00:00:00+08:00"),
          },
        ],
        modelOptions: [{ key: "deepseek", label: "DeepSeek" }],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringSamplesUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "sample-database-id",
            sourceRecordId: "sample-source-id",
            batchKey: "shared-batch",
            questionId: monitoringQuestion.id,
            platform: "DeepSeek",
            modelKey: "deepseek",
            modelLabel: "DeepSeek",
            collectedAt: Date.parse("2026-07-27T08:00:00.000Z"),
            answerNo: 1,
            content: "当前规范化监控批次的答案。",
            citationCount: 1,
            monitorRank: 2,
            screenshotUrl: "",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringSampleCitationsUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "citation-1",
            sampleId: "sample-database-id",
            questionId: monitoringQuestion.id,
            title: "当前答案的精确信源",
            url: "https://example.com/source",
            media: "企业官网",
            domain: "example.com",
          },
        ],
        total: 1,
        nextCursor: null,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    monitoringCitationSummaryUseQuery.mockReturnValue({
      data: {
        batchKey: "shared-batch",
        questionId: monitoringQuestion.id,
        totalCitations: 1,
        channels: [
          {
            name: "企业官网",
            domain: "example.com",
            citationCount: 1,
            share: 1,
          },
        ],
        contents: [
          {
            title: "当前答案的精确信源",
            url: "https://example.com/source",
            channelName: "企业官网",
            domain: "example.com",
            citationCount: 1,
            share: 1,
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    render(<UserBrandDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "问题监控" }));

    expect(
      await screen.findByText("当前规范化监控批次的答案。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("不应作为正式空数据的兜底答案。"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(monitoringFiltersUseQuery).toHaveBeenCalledWith(
        {
          questionId: monitoringQuestion.id,
        },
        expect.objectContaining({ refetchOnMount: "always" }),
      );
      expect(monitoringSamplesUseQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          questionId: monitoringQuestion.id,
          model: "deepseek",
          from: "2026-07-27",
          to: "2026-07-27",
          page: 1,
          pageSize: 100,
        }),
        expect.objectContaining({ enabled: true }),
      );
      expect(monitoringSampleCitationsUseQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          batchKey: "shared-batch",
          questionId: monitoringQuestion.id,
          sampleId: "sample-database-id",
          cursor: undefined,
          limit: 10,
        }),
        expect.objectContaining({ enabled: true }),
      );
      expect(monitoringCitationSummaryUseQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          questionId: monitoringQuestion.id,
          model: "deepseek",
          from: "2026-07-27",
          to: "2026-07-27",
        }),
        expect.objectContaining({ enabled: true }),
      );
    });
    expect(
      screen.getAllByRole("link", { name: "当前答案的精确信源" }),
    ).toHaveLength(2);
  });

  it("opens the service-advisor WeChat for a formal plan upgrade without creating a purchase redirect", async () => {
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          purchaseActions: [
            {
              kind: "upgrade",
              label: "升级豪华版",
              targetPlan: "luxury",
              href: "https://www.frontmind.net",
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "账号与服务" }));
    fireEvent.click(await screen.findByRole("button", { name: "升级豪华版" }));

    expect(
      await screen.findByRole("heading", { name: "联系服务专员" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "FrontMind 服务专员企业微信二维码",
      }),
    ).toHaveAttribute("src", "/frontmind-sales-wechat.png?v=wecom-20260801");
    expect(purchaseIntentMutateAsync).not.toHaveBeenCalled();
  });

  it("replaces the submitted ticket workspace with the published customer word bank", () => {
    deliveryListUseInfiniteQuery.mockImplementation((input) => ({
      data: {
        pages: [
          {
            tickets:
              input?.type === "website_operation"
                ? [
                    {
                      id: "bd6251d8-991a-4b79-a2d7-7cfd82a12a4e",
                      type: "website_operation",
                      category: "question_catalog",
                      categoryLabel: "品牌词库与问题目录",
                      topic: "配置品牌词库与问题目录",
                      publicStatus: "pending",
                      publicStatusLabel: "待处理",
                      publicSummary: null,
                    },
                  ]
                : [],
            nextCursor: null,
            hasMore: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: deliveryListFetchNextPage,
      refetch: vi.fn(),
    }));
    render(<UserBrandDashboard />);

    expect(
      screen.queryByRole("button", { name: "企业资料看板" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));

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

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));

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

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));
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
      "确认后开启进度将不可修改。",
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
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps the word-bank warning open when confirmation fails", async () => {
    requestQuestionSelectionMutateAsync.mockRejectedValueOnce(
      new Error("额度刚刚发生变化"),
    );
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));
    fireEvent.click(screen.getByRole("button", { name: "选择并进入问题优化" }));
    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));

    await waitFor(() =>
      expect(requestQuestionSelectionMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "确认后开启进度将不可修改。",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "如何选择新企业？",
    );
  });

  it("submits a directly entered target question for administrator confirmation", async () => {
    requestQuestionSelectionMutateAsync.mockResolvedValue({
      question: {
        id: "direct-question-1",
        selectionApprovalStatus: "pending",
      },
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));
    expect(screen.getByRole("textbox", { name: "问题来源" })).toHaveValue(
      "自主填写",
    );
    expect(
      screen.queryByRole("combobox", { name: "问题类别" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "目标问题" }), {
      target: { value: "新企业如何验证产品交付能力？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交专业审核" }));

    await waitFor(() =>
      expect(requestQuestionSelectionMutateAsync).toHaveBeenCalledWith({
        mode: "direct",
        question: "新企业如何验证产品交付能力？",
        classificationVersion: 2,
      }),
    );
  });

  it("keeps the single question history entry available when selection is disabled and no service question exists", () => {
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
          purchasedQuestions: [],
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

    expect(screen.getAllByRole("button", { name: "需求记录" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));
    expect(
      screen.getByRole("dialog", { name: "问题需求记录" }),
    ).toBeInTheDocument();
  });

  it("blocks another submission when pending reviews reserve every remaining total slot", () => {
    questionPortfolioUseQuery.mockReturnValue({
      data: {
        quotaPeriodId: "formal-period",
        questions: Array.from({ length: 23 }, (_, index) => ({
          id: `pending-question-${index}`,
          question: `等待分类的问题 ${index + 1}`,
          category: null,
          source: "user",
          status: "candidate",
          selectionApprovalStatus: "pending",
        })),
      },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

    expect(screen.getByRole("button", { name: "提交专业审核" })).toBeDisabled();
    expect(
      screen.getByText(
        "当前服务的问题额度已用满，请联系服务管理员调整当前服务问题。",
      ),
    ).toBeInTheDocument();
  });

  it("keeps new questions disabled until the next authoritative luxury unlock", () => {
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          quotas: progressiveLuxuryQuotas("awaiting_unlock"),
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));
    fireEvent.change(screen.getByRole("textbox", { name: "目标问题" }), {
      target: { value: "下一季度可以新增这个问题吗？" },
    });

    expect(screen.getByRole("button", { name: "下一季度开放" })).toBeDisabled();
    expect(
      screen.getByText(/本季度已解锁的问题额度已用完，下一季度额度将于/),
    ).toHaveTextContent("2026");
    expect(
      screen.queryByText(/联系服务管理员调整当前服务问题/),
    ).not.toBeInTheDocument();
  });

  it("marks formal word-bank candidates as opening next quarter", () => {
    portalUseQuery.mockReturnValue({
      data: {
        portal: {
          ...portalPayload,
          quotas: progressiveLuxuryQuotas("awaiting_unlock"),
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));

    const candidate = screen.getByRole("button", { name: "下一季度开放" });
    expect(candidate).toBeDisabled();
    fireEvent.click(candidate);
    expect(
      screen.queryByRole("textbox", { name: "目标问题" }),
    ).not.toBeInTheDocument();
  });

  it("renders the administrator-published phased roadmap in the formal progress report", () => {
    render(<UserBrandDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "进度报告" }));

    expect(screen.getByRole("tab", { name: /优化前基准/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /优化进度报告/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "新企业 GEO 优化进度报告" }),
    ).toBeInTheDocument();
    expect(screen.getByText("短期 1–4 周")).toBeInTheDocument();
    expect(
      screen.getByText("核验证书、本部关系与学校性质"),
    ).toBeInTheDocument();
    expect(screen.getByText("形成该说与不要说清单")).toBeInTheDocument();
    expect(screen.queryByText(/香港中文大学/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2026 年 6 月" }));
    expect(
      screen.getByRole("heading", { name: "新企业 GEO 六月进度报告" }),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

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
    expect(screen.getByRole("button", { name: "申请修改" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "申请删除" })).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: `查看“${question.question}”的需求记录`,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "需求记录" })).toHaveLength(1);

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

  it("fails closed when the service portal cannot be loaded", () => {
    portalUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });

    render(<UserBrandDashboard />);

    expect(
      screen.getByRole("heading", { name: "服务配置暂未同步" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知识库智能体" }));
    expect(screen.getByText(/服务能力尚未同步/)).toBeInTheDocument();
  });
});
