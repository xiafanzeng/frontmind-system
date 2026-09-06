import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "@/lib/frontmind-api";

const mocks = vi.hoisted(() => ({
  assignments: [] as Array<{
    projectAssignmentId: string;
    customerUserId: number;
    customerName: string;
    customerUsername: string;
    roleType:
      | "ai_operations_engineer"
      | "monitoring_optimization_engineer"
      | "content_distribution_engineer";
    marketEdition?: "domestic" | "overseas";
  }>,
  workbenchUseQuery: vi.fn(),
  ticketsUseQuery: vi.fn(),
  fetchNextTickets: vi.fn(),
  refetchTickets: vi.fn(),
  refetchWorkbench: vi.fn(),
  refetchTicketDetail: vi.fn(),
  workbenchData: { customers: [], tickets: [] } as any,
  approveQuestionSelectionMutation: vi.fn(),
  adjustQuestionQuotaMutation: vi.fn(),
  updateBrandTrackingLimitMutation: vi.fn(),
  updateTicketMutation: vi.fn(),
  approveSiteRebuildMutation: vi.fn(),
  decideQuestionMaintenanceMutation: vi.fn(),
  ticketsData: {
    items: [],
    filters: { customers: [] },
    counts: { pending: 0, completed: 0 },
    nextPending: null as any,
    nextCursor: null as null | {
      actionRank: number;
      updatedAt: number;
      id: string;
    },
    limit: 50,
  } as any,
  detailData: null as any,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    delivery: {
      mine: {
        assignments: {
          useQuery: () => ({
            data: mocks.assignments,
            isLoading: false,
          }),
        },
        workbench: {
          useQuery: (...args: unknown[]) => {
            mocks.workbenchUseQuery(...args);
            return {
              data: mocks.workbenchData,
              refetch: mocks.refetchWorkbench,
            };
          },
        },
        tickets: {
          useInfiniteQuery: (...args: unknown[]) => {
            mocks.ticketsUseQuery(args[0]);
            const fallbackItems = (mocks.workbenchData.tickets ?? []).map(
              (ticket: any) => ({
                ...ticket,
                customerName:
                  mocks.assignments.find(
                    (assignment) => assignment.customerUserId === ticket.userId,
                  )?.customerName || `客户 ${ticket.userId}`,
                customerUsername:
                  mocks.assignments.find(
                    (assignment) => assignment.customerUserId === ticket.userId,
                  )?.customerUsername || null,
                assignedProjectAssignmentId:
                  ticket.assignedProjectAssignmentId ||
                  mocks.assignments.find(
                    (assignment) => assignment.customerUserId === ticket.userId,
                  )?.projectAssignmentId,
                statusGroup: ["completed", "rejected", "cancelled"].includes(
                  ticket.status,
                )
                  ? "completed"
                  : "pending",
              }),
            );
            const data = mocks.ticketsData.items.length
              ? mocks.ticketsData
              : {
                  ...mocks.ticketsData,
                  items: fallbackItems,
                  filters: {
                    customers: mocks.assignments.map((assignment) => ({
                      id: assignment.customerUserId,
                      name: assignment.customerName,
                      username: assignment.customerUsername,
                    })),
                  },
                  counts: {
                    pending: fallbackItems.filter(
                      (ticket: any) => ticket.statusGroup === "pending",
                    ).length,
                    completed: fallbackItems.filter(
                      (ticket: any) => ticket.statusGroup === "completed",
                    ).length,
                  },
                  nextPending:
                    fallbackItems.find(
                      (ticket: any) => ticket.statusGroup === "pending",
                    ) ?? null,
                };
            return {
              data: { pages: [data], pageParams: [undefined] },
              isLoading: false,
              isFetching: false,
              isFetchingNextPage: false,
              hasNextPage: Boolean(data.nextCursor),
              error: null,
              refetch: mocks.refetchTickets,
              fetchNextPage: mocks.fetchNextTickets,
            };
          },
        },
        ticketDetail: {
          useQuery: () => ({
            data: mocks.detailData,
            isLoading: false,
            error: null,
            refetch: mocks.refetchTicketDetail,
          }),
        },
        approveQuestionSelection: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.approveQuestionSelectionMutation,
          }),
        },
        adjustQuestionQuota: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.adjustQuestionQuotaMutation,
          }),
        },
        updateBrandTrackingLimit: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.updateBrandTrackingLimitMutation,
          }),
        },
        updateTicket: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.updateTicketMutation,
          }),
        },
        approveSiteRebuild: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.approveSiteRebuildMutation,
          }),
        },
        decideQuestionMaintenance: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.decideQuestionMaintenanceMutation,
          }),
        },
        publishWebsiteStyleSamples: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: vi.fn(),
          }),
        },
      },
    },
  },
}));

vi.mock("@/components/PortalShell", () => ({
  PortalCard: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => <section className={className}>{children}</section>,
  default: ({
    eyebrow,
    title,
    navItems,
    roleLabel,
    toolbar,
    mode,
    children,
  }: {
    eyebrow?: string;
    title?: string;
    navItems?: Array<{ label: string }>;
    roleLabel?: string;
    toolbar?: React.ReactNode;
    mode?: "standard" | "fullscreen";
    children?: React.ReactNode;
  }) => (
    <main data-mode={mode || "standard"}>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <span data-testid="portal-nav-labels">
        {navItems?.map((item) => item.label).join("|")}
      </span>
      {roleLabel && <p data-testid="project-role-label">{roleLabel}</p>}
      {toolbar && <div data-testid="portal-toolbar">{toolbar}</div>}
      {children}
    </main>
  ),
}));

vi.mock("@/components/DashboardSkeletonEditor", async () => {
  const { default: Mirror } = await import(
    "@/components/CustomerDashboardMirror"
  );
  return {
    default: (props: any) => (
      <Mirror
        layout="workspace"
        payload={props.workspace?.payload}
        allowedSections={props.allowedSections}
        initialSection={props.initialSection}
        heading="客户看板"
        renderSectionWorkspace={props.renderSectionWorkspace}
        knowledgePreview={props.knowledgePreview}
        responseLogicRecords={props.responseLogicRecords}
        editActions={
          <button onClick={props.onExitDashboard}>返回客户工作台</button>
        }
      />
    ),
  };
});

vi.mock("@/pages/AdminDashboard", () => ({
  channelDistributionUrl: "/dashboard?section=channel-distribution",
  getAdminNav: () => [
    {
      label: "客户交付工作台",
      href: "/admin/workspace",
      icon: () => null,
    },
  ],
  issueMonitorUrl: "/dashboard?section=issue-monitor",
}));

import DeliveryMemberDashboard, {
  deliveryDashboardSectionsForAssignment,
  deliveryMemberNavForRole,
  ROLE_DASHBOARD_SECTIONS,
} from "./DeliveryMemberDashboard";

const MONITORING_PROJECT_ID = "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f";
const AI_OPERATIONS_PROJECT_ID = "7e9f33bc-40e2-4a8e-9bda-40d92a94b77f";
const QUESTION_QUOTA_PERIOD_ID = "065593df-4fd7-4512-8b1d-babfdf8af81d";

const monitoringAssignment = {
  projectAssignmentId: MONITORING_PROJECT_ID,
  customerUserId: 101,
  customerName: "示例客户",
  customerUsername: "example.customer",
  roleType: "monitoring_optimization_engineer" as const,
};

const aiOperationsAssignment = {
  ...monitoringAssignment,
  projectAssignmentId: AI_OPERATIONS_PROJECT_ID,
  roleType: "ai_operations_engineer" as const,
  marketEdition: "overseas" as const,
};

const brandTrackingUsageFixture = {
  rolling30DayCost: "2.50000000",
  lifetimeCost: "12.50000000",
  limit: "10.00000000",
  remaining: "7.50000000",
  exceededBy: "0.00000000",
  windowStartedAt: "2026-07-10T00:00:00.000Z",
  windowEndsAt: "2026-08-09T00:00:00.000Z",
  pendingReconciliationCount: 0,
  hasUnknownUsage: false,
  keyConfigured: true,
  blocked: false,
  blockReason: null,
};

const questionQuotaFixture = {
  periodId: QUESTION_QUOTA_PERIOD_ID,
  revision: 3,
  validFrom: Date.parse("2026-07-01T00:00:00.000Z"),
  validUntil: Date.parse("2026-10-01T00:00:00.000Z"),
  limits: {
    industryLimit: 1,
    competitorComparisonLimit: 1,
    reputationLimit: 1,
    productScenarioLimit: 5,
    totalQuestionLimit: 8,
  },
  unlockedLimits: {
    industryLimit: 1,
    competitorComparisonLimit: 1,
    reputationLimit: 1,
    productScenarioLimit: 5,
    totalQuestionLimit: 8,
  },
  unlockStage: { current: 1, total: 1 },
  nextUnlockAt: null,
  progressiveUnlock: false,
  selectedUsage: {
    industry: 1,
    competitorComparison: 0,
    reputation: 0,
    productScenario: 1,
    total: 2,
  },
  reservedUsage: {
    industry: 1,
    competitorComparison: 0,
    reputation: 0,
    productScenario: 2,
    total: 3,
  },
  remaining: {
    industry: 0,
    competitorComparison: 1,
    reputation: 1,
    productScenario: 3,
    total: 5,
  },
};

describe("DeliveryMemberDashboard project context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assignments = [];
    mocks.workbenchData = { customers: [], tickets: [] };
    mocks.ticketsData = {
      items: [],
      filters: { customers: [] },
      counts: { pending: 0, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };
    mocks.detailData = null;
    mocks.approveQuestionSelectionMutation.mockResolvedValue({ success: true });
    mocks.adjustQuestionQuotaMutation.mockResolvedValue({ success: true });
    mocks.updateBrandTrackingLimitMutation.mockResolvedValue({ success: true });
    mocks.updateTicketMutation.mockResolvedValue({
      success: true,
      handoffTicketIds: [],
    });
    mocks.approveSiteRebuildMutation.mockResolvedValue({
      success: true,
      resetApplied: true,
    });
    mocks.decideQuestionMaintenanceMutation.mockResolvedValue({
      decision: "approved",
    });
    vi.mocked(sessionStorage.getItem).mockReturnValue(null);
    window.history.replaceState({}, "", "/");
  });

  it("places role tools in the left navigation and limits them by role", () => {
    expect(
      deliveryMemberNavForRole("ai_operations_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["客户工作台", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("monitoring_optimization_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["客户工作台", "问题监控", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("content_distribution_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["客户工作台", "渠道分发", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("ai_operations_engineer").map(
        (item) => item.label,
      ),
    ).not.toContain("问题监控");
    expect(
      deliveryMemberNavForRole("monitoring_optimization_engineer").map(
        (item) => item.group,
      ),
    ).toEqual(["工作台", "工具", "工具"]);
  });

  it("limits every engineer preview to customer-facing output owned by that role", () => {
    expect(ROLE_DASHBOARD_SECTIONS.ai_operations_engineer).toEqual([
      "knowledge-build",
      "brand-tracking",
      "knowledge",
      "website",
    ]);
    expect(ROLE_DASHBOARD_SECTIONS.monitoring_optimization_engineer).toEqual([
      "keywords",
      "questions",
      "monitoring",
      "report",
    ]);
    expect(ROLE_DASHBOARD_SECTIONS.content_distribution_engineer).toEqual([
      "response-logic",
      "content",
    ]);

    for (const sections of Object.values(ROLE_DASHBOARD_SECTIONS)) {
      expect(sections).not.toContain("brand");
    }
    expect(
      deliveryDashboardSectionsForAssignment(
        "ai_operations_engineer",
        "domestic",
      ),
    ).not.toContain("brand-tracking");
    expect(
      deliveryDashboardSectionsForAssignment(
        "ai_operations_engineer",
        "overseas",
      ),
    ).toContain("brand-tracking");
  });

  it("shows the project-assignment empty state and clears a stale selection", async () => {
    vi.mocked(sessionStorage.getItem).mockReturnValue(
      "stale-project-assignment",
    );

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      screen.getByRole("heading", { name: "客户工作台" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("尚未分配客户项目，请联系交付管理员"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/固定角色团队/)).toBeNull();
    await waitFor(() =>
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      ),
    );
  });

  it("selects a customer project and queries the workbench by project assignment", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "ai_operations_engineer",
      },
    ];

    render(<DeliveryMemberDashboard customerWorkbench />);

    const projectSelector = await screen.findByRole("combobox", {
      name: "当前客户",
    });
    expect(screen.queryByTestId("portal-toolbar")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("current-delivery-target")).getByRole(
        "combobox",
        { name: "当前客户" },
      ),
    ).toBe(projectSelector);
    expect(projectSelector).toHaveValue("1e9f33bc-40e2-4a8e-9bda-40d92a94b11f");
    expect(
      screen.getByRole("option", {
        name: "示例客户",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-role-label")).toHaveTextContent(
      "工程师",
    );
    await waitFor(() =>
      expect(mocks.workbenchUseQuery).toHaveBeenLastCalledWith(
        {
          projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        },
        { enabled: true },
      ),
    );
    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
    );
  });

  it("opens the requested project first in system-administrator mode", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 202,
        customerName: "同一客户",
        customerUsername: "same-customer",
        roleType: "ai_operations_engineer",
      },
      {
        projectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
        customerUserId: 202,
        customerName: "同一客户",
        customerUsername: "same-customer",
        roleType: "content_distribution_engineer",
      },
    ];
    vi.mocked(sessionStorage.getItem).mockReturnValue(
      "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
    );
    window.history.replaceState(
      {},
      "",
      "/admin/delivery-workbench?projectAssignmentId=2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
    );

    render(<DeliveryMemberDashboard customerWorkbench systemAdminMode />);

    expect(
      screen.getByRole("heading", { name: "系统管理员工作台" }),
    ).toBeInTheDocument();
    expect(screen.getByText("系统管理员 · 客户工作台")).toBeInTheDocument();
    expect(screen.getByTestId("portal-nav-labels")).toHaveTextContent(
      "客户交付工作台",
    );
    expect(screen.getByTestId("portal-nav-labels")).not.toHaveTextContent(
      "我的需求",
    );
    expect(
      screen.getByRole("link", { name: "返回客户工作台" }),
    ).toHaveAttribute("href", "/admin/customers/202/workspace");
    expect(screen.getByRole("combobox", { name: "当前客户" })).toHaveValue(
      "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
    );
    expect(
      screen.getByRole("option", { name: "同一客户 · AI 运维工程师" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: "同一客户 · AI 内容制作工程师",
      }),
    ).toBeInTheDocument();
    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
    );
    await waitFor(() =>
      expect(mocks.workbenchUseQuery).toHaveBeenLastCalledWith(
        {
          projectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
        },
        { enabled: true },
      ),
    );
  });

  it("explains Luxury's quarterly unlock and caps every editable field at the unlocked tier", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [],
      customerQuestions: [],
      dashboard: null,
      questionQuota: {
        ...questionQuotaFixture,
        progressiveUnlock: true,
        unlockStage: { current: 1, total: 4 },
        nextUnlockAt: Date.parse("2026-09-30T16:00:00.000Z"),
      },
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    const editor = await screen.findByTestId("question-quota-editor");
    expect(editor).toHaveTextContent("豪华版按季度自动解锁");
    expect(editor).toHaveTextContent("当前第 1/4 档");
    expect(editor).toHaveTextContent("2026/10/1");
    fireEvent.click(within(editor).getByRole("button", { name: "修改额度" }));
    expect(within(editor).getByLabelText("行业排名词额度")).toHaveAttribute(
      "max",
      "1",
    );
    expect(within(editor).getByLabelText("产品场景词额度")).toHaveAttribute(
      "max",
      "5",
    );
  });

  it.each([
    { actorLabel: "AI 运维工程师", systemAdminMode: false },
    { actorLabel: "系统管理员", systemAdminMode: true },
  ])(
    "$actorLabel can adjust only the overseas brand-tracking usage quota",
    async ({ systemAdminMode }) => {
      mocks.assignments = [aiOperationsAssignment];
      mocks.workbenchData = {
        customers: [
          {
            id: 101,
            displayName: "示例客户",
            marketEdition: "overseas",
          },
        ],
        tickets: [],
        customerQuestions: [],
        dashboard: null,
        brandTrackingUsage: brandTrackingUsageFixture,
      };
      if (systemAdminMode) {
        window.history.replaceState(
          {},
          "",
          `/admin/delivery-workbench?projectAssignmentId=${AI_OPERATIONS_PROJECT_ID}`,
        );
      }

      render(
        <DeliveryMemberDashboard
          customerWorkbench
          systemAdminMode={systemAdminMode}
        />,
      );

      const openCustomerDashboardButton = await screen.findByRole("button", {
        name: "进入客户看板",
      });
      expect(openCustomerDashboardButton).toHaveClass(
        "bg-blue-600",
        "text-white",
      );
      fireEvent.click(openCustomerDashboardButton);
      fireEvent.click(
        await screen.findByRole("tab", { name: "品牌追踪智能体" }),
      );

      const editor = await screen.findByTestId("brand-tracking-usage-editor");
      expect(within(editor).getByText("2,500积分")).toBeInTheDocument();
      expect(within(editor).getByText("10,000积分")).toBeInTheDocument();
      expect(within(editor).getByText("7,500积分")).toBeInTheDocument();
      expect(editor).toHaveTextContent("不提供对话内容或凭据配置能力");
      expect(editor).not.toHaveTextContent("会话");
      expect(editor.textContent).not.toMatch(/\$|美元|费用/u);

      fireEvent.click(within(editor).getByRole("button", { name: "修改额度" }));
      const limitInput =
        within(editor).getByLabelText("品牌追踪滚动 30 天积分上限");
      expect(limitInput).toHaveValue("10000");
      fireEvent.change(limitInput, { target: { value: "1.000001" } });
      expect(within(editor).getByRole("alert")).toHaveTextContent(
        "最多 15 位整数和 5 位小数",
      );
      expect(
        within(editor).getByRole("button", { name: "保存积分上限" }),
      ).toBeDisabled();
      fireEvent.change(limitInput, { target: { value: "25000" } });
      fireEvent.click(
        within(editor).getByRole("button", { name: "保存积分上限" }),
      );

      await waitFor(() =>
        expect(mocks.updateBrandTrackingLimitMutation).toHaveBeenCalledWith({
          projectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          limitCredits: "25000",
        }),
      );
      expect(
        mocks.updateBrandTrackingLimitMutation.mock.calls[0]?.[0],
      ).not.toHaveProperty("userId");
      await waitFor(() => expect(mocks.refetchWorkbench).toHaveBeenCalled());
    },
  );
});
