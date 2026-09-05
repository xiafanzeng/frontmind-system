import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  getCapability,
  normalizeServicePortal,
  type ServiceCapabilityKey,
} from "./service-portal";
import {
  SalesAdvisorDialog,
  ServiceAccountDrawer,
  ServiceHome,
  ServiceLockedPage,
} from "./service-portal-ui";

function withRuntimeTimeZone<T>(timeZone: string, run: () => T) {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }
}

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
  "brandTracking",
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
    expect(screen.getByText("未解锁")).toBeInTheDocument();
    expect(screen.queryByText("已购问题优化")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看原因" }));
    expect(onNavigate).toHaveBeenCalledWith("response-logic", "agent");
  });

  it("adds an independently unlocked Jenova entry only for overseas service homes", () => {
    const portal = workflowPortal();
    const onNavigate = vi.fn();
    const { rerender } = render(
      <ServiceHome
        portal={portal}
        marketEdition="domestic"
        onNavigate={onNavigate}
      />,
    );

    expect(screen.queryByText("舆情监控")).not.toBeInTheDocument();

    rerender(
      <ServiceHome
        portal={portal}
        marketEdition="overseas"
        onNavigate={onNavigate}
      />,
    );

    const entry = screen.getByText("舆情监控").closest("article");
    expect(entry).not.toBeNull();
    expect(within(entry!).getByText("已解锁")).toBeInTheDocument();
    expect(
      within(entry!).getByText(
        "通过 FrontMind 品牌追踪智能体监测品牌评价、舆情趋势与潜在风险。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(entry!).getByRole("button", { name: "进入" }));
    expect(onNavigate).toHaveBeenCalledWith("public-opinion", "brand-tracking");

    rerender(
      <ServiceHome
        portal={portal}
        marketEdition="overseas"
        showPublicOpinionJourneyItem={false}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.queryByText("舆情监控")).not.toBeInTheDocument();
  });

  it("keeps overseas brand tracking visible but non-interactive on Basic", () => {
    const portal = workflowPortal();
    portal.plan.code = "basic";
    portal.plan.name = "普通版";
    portal.capabilities.brandTracking = {
      allowed: false,
      effectiveStatus: "locked",
      reason: "普通版不包含品牌舆情追踪。",
    };
    const onNavigate = vi.fn();
    render(
      <ServiceHome
        portal={portal}
        marketEdition="overseas"
        onNavigate={onNavigate}
      />,
    );

    const entry = screen.getByText("舆情监控").closest("article");
    expect(entry).not.toBeNull();
    expect(within(entry!).getByText("未解锁")).toBeInTheDocument();
    const button = within(entry!).getByRole("button", { name: "进入" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("uses only unlocked and locked labels throughout the intelligent service path", () => {
    const portal = workflowPortal();
    portal.workflowSteps = [
      {
        ...portal.workflowSteps[0],
        id: "knowledge",
        label: "已完成知识库",
        status: "complete",
      },
      {
        ...portal.workflowSteps[0],
        id: "question",
        label: "可进入问题选题",
        status: "ready",
      },
      portal.workflowSteps[0],
    ];

    render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(screen.getAllByText("已解锁")).toHaveLength(3);
    expect(screen.getByText("未解锁")).toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText("可进行")).not.toBeInTheDocument();
    expect(screen.queryByText("待解锁")).not.toBeInTheDocument();
    expect(screen.queryByText("已开放")).not.toBeInTheDocument();
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
    expect(within(quotaOverview).getByText("行业排名词")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("1 / 1")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("产品场景词")).toBeInTheDocument();
    expect(within(quotaOverview).getByText("0 / 5")).toBeInTheDocument();

    const packageScope = screen.getByTestId("service-plan-scope");
    const planSummary = screen.getByTestId("service-plan-summary");
    const planCard = screen.getByLabelText("当前服务版本：进阶版");
    expect(planCard).not.toHaveClass("self-start");
    expect(planSummary).not.toHaveClass("sm:grid-cols-2");
    expect(packageScope).toHaveClass("flex", "flex-wrap");
    expect(packageScope).not.toHaveClass("grid", "sm:grid-cols-2");
    expect(packageScope).toHaveAttribute(
      "aria-label",
      "套餐包含的智能服务板块",
    );
    expect(within(packageScope).getAllByRole("listitem")[0]).toHaveClass(
      "rounded-full",
      "shrink-0",
    );
    expect(within(packageScope).getAllByRole("listitem")).toHaveLength(7);
    expect(within(packageScope).getByText("知识库智能体")).toBeInTheDocument();
    expect(
      within(packageScope).getByText("品牌全域词库与选题"),
    ).toBeInTheDocument();
    expect(
      within(packageScope).getByText("AI 友好内容资产"),
    ).toBeInTheDocument();
    expect(
      within(packageScope).queryByText("行业排名词"),
    ).not.toBeInTheDocument();
    expect(
      within(packageScope).queryByText("竞品对比词"),
    ).not.toBeInTheDocument();
    expect(
      within(packageScope).queryByText("美誉舆情词"),
    ).not.toBeInTheDocument();
    expect(
      within(packageScope).queryByText("产品场景词"),
    ).not.toBeInTheDocument();
    expect(packageScope).not.toHaveTextContent(/\d/u);

    expect(screen.getByText("1 个已购问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌有哪些可信证据？")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看已购问题" }));
    expect(onNavigate).toHaveBeenCalledWith("intent", "question-optimization");
  });

  it("shows the luxury quarterly unlock stage and Shanghai unlock date from a US runtime", () => {
    const portal = workflowPortal();
    portal.plan = {
      ...portal.plan,
      code: "luxury",
      name: "豪华版",
    };
    portal.quotas = [
      {
        key: "industry",
        label: "行业排名词",
        limit: 1,
        entitlementLimit: 4,
        used: 1,
        unit: "个词",
      },
      {
        key: "competitor",
        label: "竞品对比词",
        limit: 1,
        entitlementLimit: 4,
        used: 0,
        unit: "个词",
      },
      {
        key: "reputation",
        label: "美誉舆情词",
        limit: 1,
        entitlementLimit: 4,
        used: 0,
        unit: "个词",
      },
      {
        key: "scenario",
        label: "产品场景词",
        limit: 5,
        entitlementLimit: 20,
        used: 2,
        unit: "个词",
      },
    ];
    portal.quotaUnlock = {
      current: 1,
      total: 4,
      nextUnlockAt: "2026-10-01T00:00:00+08:00",
      capacityState: "available",
    };

    withRuntimeTimeZone("America/Los_Angeles", () =>
      render(
        <ServiceHome
          portal={portal}
          onNavigate={vi.fn()}
          onOpenAccount={vi.fn()}
        />,
      ),
    );

    const quotaOverview = screen.getByRole("region", { name: "套餐配额" });
    expect(
      within(quotaOverview).getByText("第 1/4 服务季度"),
    ).toBeInTheDocument();
    expect(
      within(quotaOverview).getByText(/当前已解锁 8 \/ 全年 32 个问题/),
    ).toBeInTheDocument();
    expect(
      within(quotaOverview).getByText(/下一季度额度将于/),
    ).toHaveTextContent("2026/10/01");
    expect(
      within(quotaOverview).getByText("已用 1 / 已解锁 1"),
    ).toBeInTheDocument();
    expect(within(quotaOverview).getAllByText("全年 4 个词")).toHaveLength(3);
    expect(within(quotaOverview).getByText("全年 20 个词")).toBeInTheDocument();
  });

  it("keeps legacy luxury contracts on the original quota presentation", () => {
    const portal = workflowPortal();
    portal.plan = { ...portal.plan, code: "luxury", name: "豪华版" };
    portal.quotas = [
      {
        key: "industry",
        label: "行业排名词",
        limit: 4,
        entitlementLimit: 4,
        used: 1,
        unit: "个词",
      },
    ];
    portal.quotaUnlock = {
      current: 1,
      total: 1,
      nextUnlockAt: null,
      capacityState: "available",
    };

    render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    const quotaOverview = screen.getByRole("region", { name: "套餐配额" });
    expect(
      within(quotaOverview).queryByText(/服务季度/),
    ).not.toBeInTheDocument();
    expect(within(quotaOverview).getByText("1 / 4")).toBeInTheDocument();
    expect(within(quotaOverview).queryByText(/全年 4/)).not.toBeInTheDocument();
  });

  it("explains the quarterly unlock cadence before a luxury upgrade", () => {
    render(
      <SalesAdvisorDialog open onOpenChange={vi.fn()} targetPlan="luxury" />,
    );

    expect(screen.getByText(/豪华版全年包含 4 个行业排名词/)).toHaveTextContent(
      "每季度新增 1、1、1、5 个",
    );
  });

  it.each([
    [
      "basic",
      [
        "知识库展示",
        "问题优化",
        "应答逻辑智能体",
        "问题监控",
        "进度报告",
        "AI 友好内容资产",
      ],
    ],
    [
      "advanced",
      [
        "知识库智能体",
        "品牌全域词库与选题",
        "问题优化",
        "应答逻辑智能体",
        "问题监控",
        "进度报告",
        "AI 友好内容资产",
      ],
    ],
    [
      "luxury",
      [
        "知识库智能体",
        "品牌全域词库与选题",
        "问题优化",
        "应答逻辑智能体",
        "问题监控",
        "进度报告",
        "AI 友好内容资产",
      ],
    ],
  ] as const)(
    "renders the exact %s service-module matrix",
    (planCode, labels) => {
      const portal = workflowPortal();
      portal.plan.code = planCode;
      portal.plan.name =
        planCode === "basic"
          ? "普通版"
          : planCode === "luxury"
            ? "豪华版"
            : "进阶版";

      render(
        <ServiceHome
          portal={portal}
          onNavigate={vi.fn()}
          onOpenAccount={vi.fn()}
        />,
      );

      const packageScope = screen.getByTestId("service-plan-scope");
      expect(
        within(packageScope)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(labels);
      if (planCode === "basic") {
        expect(
          within(packageScope).queryByText("知识库智能体"),
        ).not.toBeInTheDocument();
        expect(
          within(packageScope).queryByText("品牌全域词库与选题"),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("adds brand tracking only to the overseas service scope", () => {
    const portal = workflowPortal();
    const view = render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(
      within(screen.getByTestId("service-plan-scope")).queryByText(
        "舆情监控·品牌追踪",
      ),
    ).not.toBeInTheDocument();

    view.rerender(
      <ServiceHome
        portal={portal}
        marketEdition="overseas"
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    const packageScope = screen.getByTestId("service-plan-scope");
    expect(
      within(packageScope).getByText("舆情监控·品牌追踪"),
    ).toBeInTheDocument();
    expect(within(packageScope).getAllByRole("listitem")).toHaveLength(8);
  });

  it("describes the Website-synced basic knowledge base across every state", () => {
    const portal = workflowPortal();
    portal.plan.code = "basic";
    portal.plan.name = "普通版";
    portal.workflowSteps = [
      {
        id: "knowledge",
        label: "知识库展示",
        status: "complete",
        lockedReason: "",
        href: "/knowledge-base",
      },
    ];
    portal.knowledgeBase.status = "ready";

    const view = render(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "知识库由 Website 流程自动同步至本账号，服务团队可补录；完成后可直接查看。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "知识库由 Website 流程自动同步至本账号，服务团队可补录，可直接查看。",
      ),
    ).toBeInTheDocument();

    portal.knowledgeBase.status = "importing";
    view.rerender(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Website 流程正在自动同步知识库至本账号，服务团队也可补录；完成后会在此显示。",
      ),
    ).toBeInTheDocument();

    portal.knowledgeBase.status = "missing";
    view.rerender(
      <ServiceHome
        portal={portal}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Website 流程尚未完成知识库自动同步；服务团队可补录，完成后会在此显示。",
      ),
    ).toBeInTheDocument();
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

  it.each([
    ["pending", "先完成问题优化"],
    ["locked", "升级豪华版"],
    ["unavailable", "先完成问题优化"],
  ] as const)(
    "removes request history from a %s route while keeping its server action",
    (effectiveStatus, actionLabel) => {
      const portal = workflowPortal();
      const onNavigate = vi.fn();
      const onOpenAccount = vi.fn();
      const access = {
        ...getCapability(portal, "responseLogic"),
        allowed: false,
        effectiveStatus,
      };

      render(
        <ServiceLockedPage
          title="应答逻辑智能体"
          access={access}
          portal={portal}
          onNavigate={onNavigate}
          onOpenAccount={onOpenAccount}
        />,
      );

      expect(
        screen.getByText("请先完成服务端记录的问题优化。"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "需求记录" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: actionLabel }));
      if (effectiveStatus === "locked") {
        expect(onOpenAccount).toHaveBeenCalledTimes(1);
      } else {
        expect(onNavigate).toHaveBeenCalledWith(
          "intent",
          "question-optimization",
        );
      }
    },
  );

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
