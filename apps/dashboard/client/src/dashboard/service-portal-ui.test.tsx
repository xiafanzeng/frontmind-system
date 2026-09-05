import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  getCapability,
  normalizeServicePortal,
  type ServiceCapabilityKey,
} from "./service-portal";
import {
  ServiceAccountDrawer,
  ServiceHome,
  ServiceLockedPage,
} from "./service-portal-ui";

const capabilityKeys: ServiceCapabilityKey[] = [
  "knowledgeBuild",
  "knowledgeDisplay",
  "globalKeywords",
  "questionSelection",
  "intentOptimization",
  "responseLogic",
  "monitoring",
  "channelDistribution",
  "progressReport",
  "contentAssets",
];

function workflowPortal() {
  return normalizeServicePortal({
    schemaVersion: 1,
    account: {
      username: "workflow.user",
      displayName: "流程测试企业",
    },
    service: {
      planCode: "advanced",
      planName: "进阶版",
      status: "active",
      billingLabel: "季度服务",
    },
    knowledge: {
      version: 2,
      status: "display_ready",
    },
    quotas: {
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
      usage: {
        industry: 1,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 0,
        total: 1,
      },
    },
    purchasedQuestions: [
      {
        id: "question-1",
        category: "reputation",
        question: "品牌有哪些可信证据？",
        status: "selected",
      },
    ],
    historicalQuestions: [
      {
        id: "history-question-1",
        category: "reputation",
        question: "上一服务周期的品牌可信度结论是什么？",
        status: "selected",
      },
    ],
    capabilities: Object.fromEntries(
      capabilityKeys.map((key) => [
        key,
        {
          allowed: true,
          effectiveStatus: "available",
          reason: null,
        },
      ]),
    ),
    workflowSteps: [
      {
        id: "response_logic",
        label: "服务端应答逻辑门禁",
        status: "locked",
        lockedReason: "请先完成服务端记录的问题优化。",
        href: "/response-logic",
        nextAction: {
          kind: "optimize_service_questions",
          label: "先完成问题优化",
          href: "/intent-optimization",
        },
      },
    ],
    nextAction: {
      kind: "view_knowledge",
      label: "查看知识库",
      href: "/knowledge-base",
    },
  });
}

describe("service workflow UI gates", () => {
  it("renders the authoritative workflow instead of the fallback journey", () => {
    const portal = workflowPortal();
    const onNavigate = vi.fn();

    render(
      <ServiceHome
        portal={portal}
        onNavigate={onNavigate}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(screen.getByText("服务端应答逻辑门禁")).toBeInTheDocument();
    expect(
      screen.getByText("请先完成服务端记录的问题优化。"),
    ).toBeInTheDocument();
    expect(screen.getByText("待解锁")).toBeInTheDocument();
    expect(screen.queryByText("已购问题优化")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看原因" }));
    expect(onNavigate).toHaveBeenCalledWith("response-logic", "agent");
  });

  it("shows authoritative quotas on the service home without enumerating purchased questions", () => {
    const portal = workflowPortal();
    const onNavigate = vi.fn();

    render(
      <ServiceHome
        portal={portal}
        onNavigate={onNavigate}
        onOpenAccount={vi.fn()}
      />,
    );

    const quotaOverview = screen.getByRole("region", {
      name: "套餐配额",
    });
    expect(within(quotaOverview).getByText("行业词")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("1 / 1")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("产品场景词")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("0 / 5")).toBeInTheDocument();

    const packageScope = screen.getByTestId("service-plan-scope");
    const planSummary = screen.getByTestId("service-plan-summary");
    const planCard = screen.getByLabelText("当前服务版本：进阶版");
    expect(planCard).toHaveClass("self-start");
    expect(planSummary).not.toHaveClass("sm:grid-cols-2");
    expect(packageScope).toHaveClass("grid-cols-2");
    expect(packageScope.children).toHaveLength(4);
    expect(within(packageScope).getByText("竞品对比词")).not.toHaveClass(
      "truncate",
    );
    expect(within(packageScope).getByText("竞品对比词")).not.toHaveClass(
      "whitespace-nowrap",
    );

    expect(screen.getByText("1 个已购问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌有哪些可信证据？")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看已购问题" }));
    expect(onNavigate).toHaveBeenCalledWith("intent", "question-optimization");
  });

  it("keeps the knowledge base and package quota together in an equal-width overview column", () => {
    render(
      <ServiceHome
        portal={workflowPortal()}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    const overview = screen.getByTestId("service-home-overview");
    const knowledgeAndQuota = screen.getByLabelText("知识库与套餐配额");
    const quotaOverview = within(knowledgeAndQuota).getByRole("region", {
      name: "套餐配额",
    });
    const knowledgeLabel = within(knowledgeAndQuota).getByText("当前知识库");

    expect(overview).toHaveClass("lg:grid-cols-2");
    expect(overview.children).toHaveLength(2);
    expect(knowledgeAndQuota).toContainElement(quotaOverview);
    expect(
      knowledgeLabel.compareDocumentPosition(quotaOverview) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the standalone suggested-next-step card off the service home", () => {
    const portal = workflowPortal();
    portal.primaryNextAction = {
      kind: "await_channel_distribution",
      label: "查看渠道分发进度",
      href: "/channel-distribution",
    };

    render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(screen.queryByText("建议下一步")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "查看渠道分发进度" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("当前步骤优先")).not.toBeInTheDocument();
  });

  it("keeps package quotas out of the account drawer", async () => {
    const portal = workflowPortal();

    render(
      <ServiceAccountDrawer
        portal={portal}
        companyName="流程测试企业"
        preview
        open
        onOpenChange={vi.fn()}
      />,
    );

    const accountDialog = await screen.findByRole("dialog");
    const accountOverlay = document.querySelector(
      '[data-slot="sheet-overlay"]',
    );
    expect(
      within(accountDialog).getByRole("heading", { name: "账号与服务" }),
    ).toBeInTheDocument();
    expect(accountDialog).toHaveClass("z-[1210]");
    expect(accountOverlay).toHaveClass("z-[1200]");
    expect(
      within(accountDialog).queryByRole("region", { name: "套餐配额" }),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("套餐配额"),
    ).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("1 / 1")).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("0 / 5")).not.toBeInTheDocument();
  });

  it("shows the locked route's real reason and only its server next action", () => {
    const portal = workflowPortal();
    const onNavigate = vi.fn();
    const access = getCapability(portal, "responseLogic");

    render(
      <ServiceLockedPage
        title="应答逻辑智能体"
        access={access}
        portal={portal}
        onNavigate={onNavigate}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(
      screen.getByText("请先完成服务端记录的问题优化。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "账号与服务" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "先完成问题优化" }));
    expect(onNavigate).toHaveBeenCalledWith("intent", "question-optimization");
  });

  it("keeps historical questions out of the compact service-home summary", () => {
    const portal = workflowPortal();

    render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(screen.queryByText("只读历史问题")).not.toBeInTheDocument();
    expect(
      screen.queryByText("上一服务周期的品牌可信度结论是什么？"),
    ).not.toBeInTheDocument();
  });
});
