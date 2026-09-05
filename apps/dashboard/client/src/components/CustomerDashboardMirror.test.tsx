import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardPayload } from "@shared/dashboard";

vi.mock("@/dashboard/UserBrandDashboard", () => ({
  ManagedDashboardSection: () => <div>服务首页用户页</div>,
  ManagedKeywordTables: () => <div>品牌全域词库用户页</div>,
  PublishedContentAssets: () => <div>已发布内容资产用户页</div>,
}));

vi.mock("@/dashboard/QuestionMonitoringWorkspace", () => ({
  default: () => <div>问题监控用户页</div>,
}));

vi.mock("@/dashboard/ProgressReportWorkspace", () => ({
  default: () => <div>用户进度报告</div>,
}));

vi.mock("@/dashboard/AiWebsiteManagementWorkspace", () => ({
  default: () => <div>AI 友好官网用户页</div>,
}));

vi.mock("@/dashboard/service-portal-ui", () => ({
  ServiceHome: ({ portal, loading }: any) => (
    <div>
      {loading
        ? "客户服务首页加载中"
        : `客户真实服务首页 · ${portal.plan.name}`}
    </div>
  ),
  ServiceLockedPage: ({ title, access }: any) => (
    <div>
      {title}未解锁 · {access.reason}
    </div>
  ),
}));

vi.mock("@/components/KnowledgeBaseProgressPanel", () => ({
  default: () => <div>知识库构建进度用户页</div>,
}));

vi.mock("@/components/KnowledgeBaseViewer", () => ({
  default: () => <div>知识库展示用户页</div>,
}));

import CustomerDashboardMirror from "./CustomerDashboardMirror";

const payload: DashboardPayload = {
  brandName: "示例品牌",
  headline: "示例用户流程",
  summary: "",
  metrics: [],
  sections: [],
  keywordTables: [],
  questions: [],
  monitoringAnswers: [],
  citations: [],
  contentAssets: [],
  optimizationReport: null,
  progressReports: [],
};

const servicePortal = {
  account: { displayName: "示例品牌", username: "demo" },
  service: {
    planCode: "advanced",
    planName: "进阶版",
    status: "active",
    validFrom: Date.UTC(2026, 6, 29),
    validUntil: Date.UTC(2026, 9, 29),
  },
  quotas: null,
  knowledge: { status: "missing" },
  purchasedQuestions: [],
  historicalQuestions: [],
  capabilities: {
    knowledgeBuild: { allowed: true },
    knowledgeDisplay: {
      allowed: false,
      reason: "请先完成知识库智能体。",
    },
    globalKeywords: {
      allowed: false,
      reason: "请先发布知识库。",
    },
    questionSelection: { allowed: false },
    intentOptimization: { allowed: false },
    responseLogic: { allowed: false },
    monitoring: { allowed: false },
    channelDistribution: { allowed: false },
    progressReport: { allowed: false },
    contentAssets: { allowed: true },
  },
  workflowSteps: [
    {
      id: "knowledge",
      label: "知识库智能体",
      status: "ready",
      lockedReason: null,
      href: "/knowledge-base",
    },
    {
      id: "question",
      label: "品牌全域词库与选题",
      status: "locked",
      lockedReason: "请先发布知识库。",
      href: "/brand-question-portfolio",
    },
  ],
};

describe("CustomerDashboardMirror", () => {
  it("shows only the user-flow sections owned by the engineer role", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["keywords", "questions", "monitoring", "report"]}
        initialSection="monitoring"
      />,
    );

    expect(
      screen.getByRole("tab", { name: "品牌全域词库" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题优化" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题监控" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "进度报告" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "AI 友好内容" })).toBeNull();
  });

  it("lets AI operations verify the formal website and knowledge views", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["website", "knowledge"]}
        initialSection="website"
        websiteWorkspace={
          {
            marketEdition: "domestic",
            quotas: {
              content_asset_publish: {},
              website_content_publish: {},
            },
            contentAssetCatalog: [],
            websiteContentCatalog: [],
            preferredMediaOptions: [],
            deliveryOwners: {},
            websiteWorkflow: {},
            tickets: [],
          } as any
        }
        knowledgePreview={{
          progress: {} as any,
          snapshot: {} as any,
        }}
      />,
    );

    expect(screen.getByText("AI 友好官网用户页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "知识库展示" }));
    expect(screen.getByText("知识库展示用户页")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
  });

  it("keeps knowledge activity and progress inside the user-flow knowledge section", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        initialSection="knowledge-build"
        knowledgePreview={{
          progress: {} as any,
          activity: {
            build: {
              companyName: "示例品牌",
              conversationId: "conversation-1",
              status: "构建中",
            },
            turns: [
              {
                id: "turn-1",
                model: "FrontMind Agent",
                status: "completed",
                durationMs: 12_000,
              },
            ],
            messages: [
              {
                id: "message-1",
                role: "assistant",
                content: "已完成资料核验。",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("当前知识库构建")).toBeInTheDocument();
    expect(screen.getByText("FrontMind Agent")).toBeInTheDocument();
    expect(screen.getByText("已完成资料核验。")).toBeInTheDocument();
    expect(screen.getByText("知识库构建进度用户页")).toBeInTheDocument();
  });

  it("renders the complete customer dashboard shell for administrators", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        servicePortal={servicePortal}
      />,
    );

    expect(screen.getByText("客户真实服务首页 · 进阶版")).toBeInTheDocument();
    expect(screen.queryByText("服务首页用户页")).toBeNull();
    expect(screen.getByRole("tab", { name: "服务首页" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "知识库智能体" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "应答逻辑智能体" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "AI 友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
  });

  it("uses the same service entitlement when an administrator opens a locked section", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        servicePortal={servicePortal}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "品牌全域词库" }));
    expect(
      screen.getByText("品牌全域词库未解锁 · 请先发布知识库。"),
    ).toBeInTheDocument();
  });

  it("does not fall back to the published-content page while service access is loading", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        servicePortalLoading
        onRefreshServicePortal={vi.fn()}
      />,
    );

    expect(screen.getByText("客户服务首页加载中")).toBeInTheDocument();
    expect(screen.queryByText("服务首页用户页")).toBeNull();
  });
});
