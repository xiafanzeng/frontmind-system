import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DashboardPayload } from "@shared/dashboard";

vi.mock("@/dashboard/UserBrandDashboard", () => ({
  ManagedDashboardSection: () => <div>服务首页用户页</div>,
  ManagedKeywordTables: () => <div>品牌全域词库用户页</div>,
  PublishedContentAssets: () => <div>已发布内容资产用户页</div>,
  buildServiceQuestionGroups: (questions: any[]) => [
    {
      id: "purchased",
      title: "已购问题",
      subtitle: "",
      tone: "plum",
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        intent: question.intent ?? "",
        summary: question.rationale ?? "",
      })),
    },
  ],
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
  ServiceHome: ({
    portal,
    loading,
    marketEdition,
    allowBrandTrackingManagement,
    showPublicOpinionJourneyItem,
    onNavigate,
  }: any) => (
    <div>
      {loading
        ? "客户服务首页加载中"
        : `客户真实服务首页 · ${portal.plan.name}`}
      {marketEdition === "overseas" &&
        showPublicOpinionJourneyItem !== false && (
          <button
            type="button"
            onClick={() => onNavigate("public-opinion", "brand-tracking")}
          >
            {allowBrandTrackingManagement ? "管理舆情监控" : "进入舆情监控"}
          </button>
        )}
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
  it("keeps the nested customer menu clear of the role menu on mobile", () => {
    const css = readFileSync(
      resolve(
        process.cwd(),
        "client/src/components/customer-dashboard-mirror.css",
      ),
      "utf8",
    );

    expect(css).toContain(
      ".customer-dashboard-mirror--workspace .mobile-menu-btn",
    );
    expect(css).toMatch(/\.mobile-menu-btn\s*\{[^}]*right:\s*16px;/s);
    expect(css).toMatch(/\.mobile-menu-btn\s*\{[^}]*left:\s*auto;/s);
    expect(css).toContain(
      ".customer-dashboard-mirror--workspace .customer-dashboard-mirror-nav",
    );
    expect(css).not.toContain(
      ".customer-dashboard-editor-actions > .inline-flex",
    );
  });

  it("uses the full portal workspace without widening role access", () => {
    const { container } = render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["website", "knowledge"]}
        initialSection="website"
        layout="workspace"
        renderSectionWorkspace={(section) =>
          section === "website" ? <div>当前需求处理区</div> : null
        }
      />,
    );

    const dashboard = container.querySelector(".customer-dashboard-mirror");
    expect(dashboard).toHaveAttribute("data-layout", "workspace");
    expect(dashboard).toHaveClass("customer-dashboard-mirror--workspace");
    expect(screen.getByText("当前需求处理区")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "问题优化" })).toBeNull();
  });

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

  it("reserves the overseas brand-tracking section for usage-only delivery controls", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["knowledge-build", "brand-tracking"]}
        initialSection="brand-tracking"
        renderSectionWorkspace={(section) =>
          section === "brand-tracking" ? (
            <div>滚动 30 天已使用 $2.5 · 上限 $10 · 剩余 $7.5</div>
          ) : null
        }
      />,
    );

    expect(
      screen.getByRole("tab", { name: "品牌追踪智能体" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/滚动 30 天已使用/)).toBeInTheDocument();
    expect(screen.queryByText(/Jenova Key/)).toBeNull();
    expect(screen.queryByText(/会话记录/)).toBeNull();
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

  it("uses the business projection for a pre-create failure in the dashboard mirror", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        initialSection="knowledge-build"
        knowledgePreview={{
          progress: {
            operationState: "reset_required",
            contentAvailability: "none",
            taskCreationState: "not_attempted",
            failureStage: "provider_file_registration",
            retainedCustomerAttachmentCount: 9,
            generatedSystemAttachmentCount: 2,
          } as any,
          activity: {
            build: {
              companyName: "示例品牌",
              conversationId: "conversation-precreate",
              status: "protocol_error",
              protocolError: "provider raw failure",
            },
            turns: [
              {
                id: "turn-precreate",
                status: "failed",
                errorMessage: "provider raw failure",
              },
            ],
            messages: [],
          },
        }}
      />,
    );

    expect(
      screen.getAllByText(
        "9/9 个附件已保留，知识库任务未创建。请申请重置后重新上传资料。",
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(/本轮已停止/)).toBeNull();
    expect(screen.queryByText(/已完成内容不受影响/)).toBeNull();
    expect(screen.queryByText(/provider raw failure/)).toBeNull();
    expect(screen.queryByText(/11\/11/)).toBeNull();
  });

  it("uses explicit activity business fields when progress is temporarily unavailable", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        initialSection="knowledge-build"
        knowledgePreview={{
          activity: {
            build: {
              companyName: "示例品牌",
              conversationId: "conversation-precreate-activity",
              status: "protocol_error",
              protocolError: "provider raw failure",
              operationState: "reset_required",
              taskCreationState: "not_attempted",
              failureStage: "provider_file_registration",
              retainedCustomerAttachmentCount: 9,
              generatedSystemAttachmentCount: 2,
            },
            turns: [
              {
                id: "turn-precreate-activity",
                status: "failed",
                errorMessage: "provider raw failure",
              },
            ],
            messages: [],
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "9/9 个附件已保留，知识库任务未创建。请申请重置后重新上传资料。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/本轮已停止/)).toBeNull();
    expect(screen.queryByText(/provider raw failure/)).toBeNull();
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
      screen.getByRole("tab", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "舆情监控" })).toBeNull();
  });

  it("renders overseas sentiment management in the same customer dashboard", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        servicePortal={servicePortal}
        marketEdition="overseas"
        allowBrandTrackingManagement
        brandTrackingManagement={<div>客户 Jenova 管理页</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "舆情监控" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "管理舆情监控" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "舆情监控" }));
    expect(screen.getByText("客户 Jenova 管理页")).toBeInTheDocument();
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

  it("prefers the current purchased question over stale published dashboard content", () => {
    render(
      <CustomerDashboardMirror
        payload={{
          ...payload,
          questions: [
            {
              id: "question-old",
              groupId: "purchased",
              groupTitle: "已购问题",
              groupSubtitle: "官网购买时已确认的问题",
              tone: "plum",
              question: "旧问题正文？",
              intent: "旧问题意图",
              summary: "旧问题依据",
            },
          ],
        }}
        servicePortal={
          {
            ...servicePortal,
            purchasedQuestions: [
              {
                id: "question-new",
                kind: "basic",
                question: "修改后的当前问题？",
                intent: "当前问题意图",
                rationale: "当前问题依据",
                revision: 2,
                intentRevision: 1,
                intentConfirmedRevision: 1,
                intentConfirmedAt: Date.UTC(2026, 7, 8),
                intentConfirmed: true,
                statusLabel: "已确认",
              },
            ],
            capabilities: {
              ...servicePortal.capabilities,
              intentOptimization: { allowed: true },
            },
          } as any
        }
        initialSection="questions"
      />,
    );

    expect(screen.getByText("修改后的当前问题？")).toBeInTheDocument();
    expect(screen.getByText("当前问题意图")).toBeInTheDocument();
    expect(screen.queryByText("旧问题正文？")).not.toBeInTheDocument();
    expect(screen.queryByText("旧问题意图")).not.toBeInTheDocument();
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

  it("derives the four category colors from stable group ids for legacy titles", () => {
    const questions = [
      ["industry", "旧行业标题"],
      ["competitor_comparison", "旧竞品标题"],
      ["reputation", "旧口碑标题"],
      ["product_scenario", "旧产品标题"],
    ].map(([groupId, groupTitle], index) => ({
      id: `question-${index}`,
      groupId,
      groupTitle,
      groupSubtitle: "",
      tone: "plum" as const,
      question: `示例问题 ${index + 1}`,
      intent: "",
      summary: "",
    }));

    render(
      <CustomerDashboardMirror
        payload={{ ...payload, questions }}
        allowedSections={["questions"]}
        initialSection="questions"
      />,
    );

    expect(
      questions.map((question) =>
        screen
          .getByText(question.question)
          .closest("article")
          ?.getAttribute("data-category"),
      ),
    ).toEqual([
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario",
    ]);
  });
});
