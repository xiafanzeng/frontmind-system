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
  deliveryWorkbenchHref,
  deliveryMemberNavForRole,
  ROLE_DASHBOARD_SECTIONS,
  siteRebuildResetNeedsAutomaticRefresh,
  siteRebuildResetProjection,
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

  it("normalizes the exact and rolling-compatible reset projection", () => {
    expect(
      siteRebuildResetProjection({
        siteRebuildResetState: "blocked",
        siteRebuildResetIssue: "esa_runtime_required",
        siteRebuildCanRecheck: true,
      }),
    ).toEqual({
      state: "blocked",
      issue: "esa_runtime_required",
      canRecheck: true,
    });
    expect(
      siteRebuildResetProjection({ siteRebuildResetPending: true }),
    ).toEqual({
      state: "blocked",
      issue: null,
      canRecheck: true,
    });
    expect(
      siteRebuildResetProjection({
        siteRebuildResetState: null,
        siteRebuildResetApplied: true,
        siteRebuildResetPending: true,
        status: "in_progress",
      }),
    ).toEqual({ state: null, issue: null, canRecheck: false });
    expect(
      siteRebuildResetNeedsAutomaticRefresh({
        siteRebuildResetState: "reconciling",
      }),
    ).toBe(true);
    expect(
      siteRebuildResetNeedsAutomaticRefresh({
        siteRebuildResetState: "completed",
      }),
    ).toBe(false);
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

  it.each([
    ["question_maintenance", "questions"],
    ["knowledge_reset", "knowledge-build"],
    ["question_catalog", "keywords"],
    ["site_rebuild", "website"],
  ] as const)(
    "routes a %s demand to the %s customer-dashboard module",
    (operation, section) => {
      expect(
        deliveryWorkbenchHref({
          projectAssignmentId: MONITORING_PROJECT_ID,
          ticketId: "8a67e445-37bb-45ed-9268-4ca9437e4d75",
          operation,
        }),
      ).toBe(
        `/delivery/workbench?projectAssignmentId=${MONITORING_PROJECT_ID}&section=${section}&ticketId=8a67e445-37bb-45ed-9268-4ca9437e4d75&focus=1`,
      );
    },
  );

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

  it("merges current-project demands and history into one customer workbench", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/DeliveryMemberDashboard.tsx"),
      "utf8",
    );
    const workbenchSource = source.slice(
      source.indexOf("function CustomerWorkbenchView("),
      source.indexOf("const TERMINAL_STATUS_LABELS"),
    );

    expect(workbenchSource).toContain("limit: 50");
    expect(workbenchSource).toContain("ticket.assignedProjectAssignmentId ===");
    expect(workbenchSource).toContain("<DeliveryTicketActions");
    expect(workbenchSource).toContain("<KnowledgeResetDecision");
    expect(workbenchSource).toContain("DeliveryHistoryDetailDialog");
    expect(workbenchSource).toContain('aria-label="按状态筛选"');
    expect(workbenchSource).toContain("customerTickets.fetchNextPage");
    expect(workbenchSource).toContain("加载更多需求");
    expect(workbenchSource).toContain('mode="fullscreen"');
    expect(workbenchSource).toContain('layout="workspace"');
    expect(workbenchSource).not.toContain("customer-delivery-preview");
    expect(source).not.toContain("function MyTicketsView(");
  });

  it("switches the unified workbench between assigned customers", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        roleType: "ai_operations_engineer",
      },
      {
        projectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
        customerUserId: 202,
        customerName: "客户乙",
        customerUsername: "customer-b",
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.ticketsData = {
      items: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          userId: 101,
          customerName: "客户甲",
          customerUsername: "customer-a",
          title: "甲公司需求",
          operation: "site_check",
          status: "submitted",
          statusGroup: "pending",
          assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
          revision: 1,
        },
        {
          id: "5a67e445-37bb-45ed-9268-4ca9437e4d72",
          userId: 202,
          customerName: "客户乙",
          customerUsername: "customer-b",
          title: "乙公司需求",
          operation: "site_check",
          status: "completed",
          statusGroup: "completed",
          assignedProjectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
          revision: 2,
          updatedAt: Date.parse("2026-08-01T00:00:00.000Z"),
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "客户甲", username: "customer-a" },
          { id: 202, name: "客户乙", username: "customer-b" },
        ],
      },
      counts: { pending: 1, completed: 1 },
      nextPending: {
        id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
        userId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        title: "甲公司需求",
        operation: "site_check",
        status: "submitted",
      },
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard />);

    const selector = await screen.findByRole("combobox", {
      name: "当前客户",
    });
    expect(selector).toHaveValue("1e9f33bc-40e2-4a8e-9bda-40d92a94b11f");
    expect(screen.getByText("甲公司需求")).toBeInTheDocument();
    expect(screen.queryByText("乙公司需求")).not.toBeInTheDocument();
    expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
      customerUserId: 101,
      projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
      limit: 50,
    });

    fireEvent.change(selector, {
      target: { value: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f" },
    });

    await waitFor(() =>
      expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
        customerUserId: 202,
        projectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
        limit: 50,
      }),
    );
    expect(screen.queryByText("甲公司需求")).not.toBeInTheDocument();
    expect(screen.getByText("乙公司需求")).toBeInTheDocument();
    expect(sessionStorage.setItem).toHaveBeenLastCalledWith(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
    );
  });

  it("uses the server dependency decision even when the completed prerequisite is outside the visible page", () => {
    mocks.assignments = [monitoringAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "6a67e445-37bb-45ed-9268-4ca9437e4d73",
          userId: 101,
          customerName: "客户甲",
          title: "首次监控",
          operation: "initial_monitoring",
          status: "submitted",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
          revision: 1,
        },
      ],
      filters: {
        customers: [{ id: 101, name: "客户甲", username: "customer-a" }],
      },
      counts: { pending: 1, completed: 1 },
      nextPending: {
        id: "6a67e445-37bb-45ed-9268-4ca9437e4d73",
        userId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        title: "首次监控",
        operation: "initial_monitoring",
        status: "submitted",
      },
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(screen.queryByText("等待前置需求")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始处理" }),
    ).toBeInTheDocument();
  });

  it("uses the dedicated approval action for a customer question modification", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "8a67e445-37bb-45ed-9268-4ca9437e4d75",
          userId: 101,
          customerName: "客户甲",
          title: "修改问题申请",
          operation: "question_maintenance",
          category: "question_modify",
          topic: "旧问题是什么？",
          description: JSON.stringify({
            questionSnapshot: "完整的原问题正文，不应使用截断的 topic。",
            proposedQuestion: "修改后的问题是什么？",
            reason: "旧问题表达不准确",
          }),
          status: "submitted",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
          revision: 2,
        },
      ],
      filters: {
        customers: [{ id: 101, name: "客户甲", username: "customer-a" }],
      },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "审批修改问题" }));
    expect(
      screen.getByText("完整的原问题正文，不应使用截断的 topic。"),
    ).toBeInTheDocument();
    expect(screen.getByText("修改后的问题是什么？")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "我已核对目标问题与变更内容，确认通过后立即执行。",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "通过并执行" }));

    await waitFor(() =>
      expect(mocks.decideQuestionMaintenanceMutation).toHaveBeenCalledWith({
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        ticketId: "8a67e445-37bb-45ed-9268-4ca9437e4d75",
        expectedRevision: 2,
        decision: "approve",
      }),
    );
    expect(mocks.updateTicketMutation).not.toHaveBeenCalled();
  });

  it.each([
    "submitted",
    "needs_information",
    "scheduled",
    "in_progress",
  ] as const)(
    "shows only the dedicated site-rebuild approval for %s tickets",
    (status) => {
      mocks.assignments = [aiOperationsAssignment];
      mocks.ticketsData = {
        items: [
          {
            id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
            userId: 101,
            customerName: "示例客户",
            customerUsername: "example.customer",
            title: "重新制作官网",
            operation: "site_rebuild",
            status,
            statusGroup: "pending",
            dependencySatisfied: true,
            dependencyBlockReason: null,
            assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
            revision: 7,
            siteRebuildResetApplied: false,
          },
        ],
        filters: {
          customers: [
            { id: 101, name: "示例客户", username: "example.customer" },
          ],
        },
        counts: { pending: 1, completed: 0 },
        nextPending: null,
        nextCursor: null,
        limit: 50,
      };

      render(<DeliveryMemberDashboard customerWorkbench />);

      expect(
        screen.getByRole("button", { name: "通过重置需求" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "开始处理" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "等待用户补充" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "填写交付结果" }),
      ).not.toBeInTheDocument();
    },
  );

  it("confirms a site rebuild through the dedicated backend action", async () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          customerName: "示例客户",
          customerUsername: "example.customer",
          title: "重新制作官网",
          operation: "site_rebuild",
          status: "submitted",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          revision: 7,
          siteRebuildResetApplied: false,
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "示例客户", username: "example.customer" },
        ],
      },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "通过重置需求" }));
    expect(
      screen.getByRole("heading", { name: "通过官网重置需求？" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "确认后，旧官网将进入安全下线流程；下线确认完成后，当前官网轮次将重置，企业知识库保持不变，客户可点击“从知识库开始建站”创建全新官网任务。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));

    await waitFor(() =>
      expect(mocks.approveSiteRebuildMutation).toHaveBeenCalledWith({
        projectAssignmentId: AI_OPERATIONS_PROJECT_ID,
        ticketId: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
        expectedRevision: 7,
      }),
    );
    expect(mocks.updateTicketMutation).not.toHaveBeenCalled();
  });

  it("shows an applied site rebuild as static status without actions", () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          customerName: "示例客户",
          customerUsername: "example.customer",
          title: "重新制作官网",
          operation: "site_rebuild",
          status: "in_progress",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          revision: 8,
          siteRebuildResetApplied: true,
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "示例客户", username: "example.customer" },
        ],
      },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(screen.getByText("重置需求已通过")).toBeInTheDocument();
    expect(
      screen.getByText(
        "旧官网已下线；企业知识库保持不变，客户可点击“从知识库开始建站”。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "通过重置需求" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始处理" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "等待用户补充" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "填写交付结果" }),
    ).not.toBeInTheDocument();
  });

  it("lets staff approve a second reset request on the same rebuild ticket", () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          customerName: "示例客户",
          customerUsername: "example.customer",
          title: "重新制作官网",
          operation: "site_rebuild",
          status: "submitted",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          revision: 9,
          siteRebuildResetApplied: true,
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "示例客户", username: "example.customer" },
        ],
      },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      screen.getByRole("button", { name: "通过重置需求" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("重置需求已通过")).not.toBeInTheDocument();
  });

  it("keeps a pending reset visibly incomplete and retryable", () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          customerName: "示例客户",
          customerUsername: "example.customer",
          title: "重新制作官网",
          operation: "site_rebuild",
          status: "in_progress",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          revision: 8,
          siteRebuildResetApplied: false,
          siteRebuildResetPending: true,
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "示例客户", username: "example.customer" },
        ],
      },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(screen.getByText("官网重置需要处理")).toBeInTheDocument();
    expect(screen.queryByText("重置需求已通过")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新检查" }),
    ).toBeInTheDocument();
  });

  it("shows the real reset blocker and only offers an explicit recheck", () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "5f47e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          customerName: "示例客户",
          customerUsername: "example.customer",
          title: "重新制作官网",
          operation: "site_rebuild",
          status: "in_progress",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
          revision: 8,
          siteRebuildResetState: "blocked",
          siteRebuildResetIssue: "esa_runtime_required",
          siteRebuildCanRecheck: true,
        },
      ],
      filters: { customers: [] },
      counts: { pending: 1, completed: 0 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench systemAdminMode />);

    expect(
      screen.getByText("发布运行环境尚未就绪，官网重置尚未开始。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新检查" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "通过重置需求" }),
    ).not.toBeInTheDocument();
  });

  it("refreshes an active reset every three seconds and on focus, then stops at terminal state", async () => {
    vi.useFakeTimers();
    try {
      const ticketId = "5f47e445-37bb-45ed-9268-4ca9437e4d91";
      mocks.assignments = [aiOperationsAssignment];
      const ticket = {
        id: ticketId,
        userId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        title: "重新制作官网",
        operation: "site_rebuild",
        status: "in_progress",
        statusGroup: "pending",
        dependencySatisfied: true,
        dependencyBlockReason: null,
        assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
        revision: 8,
        siteRebuildResetState: "queued",
        siteRebuildResetIssue: null,
        siteRebuildCanRecheck: false,
      };
      mocks.ticketsData = {
        items: [ticket],
        filters: { customers: [] },
        counts: { pending: 1, completed: 0 },
        nextPending: null,
        nextCursor: null,
        limit: 50,
      };
      window.history.replaceState(
        {},
        "",
        `/admin/delivery-workbench?projectAssignmentId=${AI_OPERATIONS_PROJECT_ID}&section=website&ticketId=${ticketId}&focus=1`,
      );
      const view = render(
        <DeliveryMemberDashboard customerWorkbench systemAdminMode />,
      );
      expect(screen.getByText("正在完成官网重置")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      expect(mocks.refetchTickets).toHaveBeenCalledTimes(1);
      expect(mocks.refetchWorkbench).toHaveBeenCalledTimes(1);
      expect(mocks.refetchTicketDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      expect(mocks.refetchTickets).toHaveBeenCalledTimes(2);
      expect(mocks.refetchWorkbench).toHaveBeenCalledTimes(2);
      expect(mocks.refetchTicketDetail).toHaveBeenCalledTimes(2);

      ticket.siteRebuildResetState = "completed";
      view.rerender(
        <DeliveryMemberDashboard customerWorkbench systemAdminMode />,
      );
      expect(screen.getByText("重置需求已通过")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(6_000);
        await Promise.resolve();
      });
      expect(mocks.refetchTickets).toHaveBeenCalledTimes(2);
      expect(mocks.refetchWorkbench).toHaveBeenCalledTimes(2);
      expect(mocks.refetchTicketDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [false, "当前需求状态：待通过重置。"],
    [
      true,
      "当前需求状态：旧官网已下线，企业知识库保持不变；客户可点击“从知识库开始建站”。",
    ],
  ] as const)(
    "projects the real site-rebuild state in the focused customer card (applied: %s)",
    (resetApplied, expectedState) => {
      const ticketId = "5f47e445-37bb-45ed-9268-4ca9437e4d91";
      mocks.assignments = [aiOperationsAssignment];
      mocks.ticketsData = {
        items: [
          {
            id: ticketId,
            userId: 101,
            customerName: "示例客户",
            customerUsername: "example.customer",
            title: "重新制作官网",
            operation: "site_rebuild",
            status: "in_progress",
            statusGroup: "pending",
            dependencySatisfied: true,
            dependencyBlockReason: null,
            assignedProjectAssignmentId: AI_OPERATIONS_PROJECT_ID,
            revision: 8,
            siteRebuildResetApplied: resetApplied,
          },
        ],
        filters: {
          customers: [
            { id: 101, name: "示例客户", username: "example.customer" },
          ],
        },
        counts: { pending: 1, completed: 0 },
        nextPending: null,
        nextCursor: null,
        limit: 50,
      };
      window.history.replaceState(
        {},
        "",
        `/delivery/workbench?projectAssignmentId=${AI_OPERATIONS_PROJECT_ID}&section=website&ticketId=${ticketId}&focus=1`,
      );

      render(<DeliveryMemberDashboard customerWorkbench />);

      const focusedCard = screen.getByTestId("focused-customer-demand");
      expect(within(focusedCard).getByText(expectedState)).toBeInTheDocument();
      if (resetApplied) {
        expect(
          within(focusedCard).queryByRole("button", {
            name: "通过重置需求",
          }),
        ).not.toBeInTheDocument();
        expect(
          within(focusedCard).getByText("重置需求已通过"),
        ).toBeInTheDocument();
      } else {
        expect(
          within(focusedCard).getByRole("button", {
            name: "通过重置需求",
          }),
        ).toBeInTheDocument();
      }
      expect(
        within(focusedCard).queryByRole("button", { name: "开始处理" }),
      ).not.toBeInTheDocument();
      expect(
        within(focusedCard).queryByRole("button", {
          name: "等待用户补充",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(focusedCard).queryByRole("button", {
          name: "填写交付结果",
        }),
      ).not.toBeInTheDocument();
    },
  );

  it("loads subsequent current-project ticket pages", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "7a67e445-37bb-45ed-9268-4ca9437e4d74",
          userId: 101,
          customerName: "客户甲",
          title: "待处理需求",
          operation: "site_check",
          status: "submitted",
          statusGroup: "pending",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: MONITORING_PROJECT_ID,
          revision: 1,
        },
      ],
      filters: {
        customers: [{ id: 101, name: "客户甲", username: "customer-a" }],
      },
      counts: { pending: 51, completed: 0 },
      nextPending: {
        id: "7a67e445-37bb-45ed-9268-4ca9437e4d74",
        userId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        title: "待处理需求",
        operation: "site_check",
        status: "submitted",
      },
      nextCursor: {
        actionRank: 1,
        updatedAt: Date.parse("2026-08-01T00:00:00.000Z"),
        id: "7a67e445-37bb-45ed-9268-4ca9437e4d74",
      },
      limit: 50,
    };

    render(<DeliveryMemberDashboard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "加载更多需求" }),
    );

    expect(mocks.fetchNextTickets).toHaveBeenCalledTimes(1);
  });

  it("filters current-project history without leaving the workbench", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.ticketsData = {
      items: [
        {
          id: "8a67e445-37bb-45ed-9268-4ca9437e4d75",
          userId: 101,
          customerName: "客户甲",
          title: "已完成历史",
          operation: "site_check",
          status: "completed",
          statusGroup: "completed",
          dependencySatisfied: true,
          dependencyBlockReason: null,
          assignedProjectAssignmentId: MONITORING_PROJECT_ID,
          revision: 2,
          updatedAt: Date.parse("2026-08-01T00:00:00.000Z"),
        },
      ],
      filters: {
        customers: [{ id: 101, name: "客户甲", username: "customer-a" }],
      },
      counts: { pending: 3, completed: 1 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard />);
    fireEvent.change(
      await screen.findByRole("combobox", { name: "按状态筛选" }),
      { target: { value: "completed" } },
    );

    await waitFor(() =>
      expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
        customerUserId: 101,
        projectAssignmentId: MONITORING_PROJECT_ID,
        statusGroup: "completed",
        limit: 50,
      }),
    );
    expect(screen.getByText("已完成历史")).toBeInTheDocument();
    expect(screen.getByText("待处理 3")).toHaveClass("text-red-600");
    expect(screen.getByText("已完成 1")).toBeInTheDocument();
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
    expect(screen.getByText("系统管理员 · 需求处理")).toBeInTheDocument();
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

  it("rejects a focused ticket that belongs to another customer assignment", () => {
    const projectA = "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f";
    const projectB = "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f";
    const ticketB = "4a67e445-37bb-45ed-9268-4ca9437e4d72";
    mocks.assignments = [
      {
        projectAssignmentId: projectA,
        customerUserId: 101,
        customerName: "客户 A",
        customerUsername: "customer-a",
        roleType: "ai_operations_engineer",
      },
      {
        projectAssignmentId: projectB,
        customerUserId: 202,
        customerName: "客户 B",
        customerUsername: "customer-b",
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.detailData = {
      ticket: {
        id: ticketB,
        userId: 202,
        assignedProjectAssignmentId: projectB,
        title: "客户 B 的知识库需求",
        operation: "knowledge_maintenance",
        status: "submitted",
        createdByUserId: 202,
        revision: 1,
        updatedAt: Date.parse("2026-08-08T00:00:00.000Z"),
      },
    };
    window.history.replaceState(
      {},
      "",
      `/admin/delivery-workbench?projectAssignmentId=${projectA}&section=knowledge&ticketId=${ticketB}&focus=1`,
    );

    render(<DeliveryMemberDashboard customerWorkbench systemAdminMode />);

    expect(
      screen.getByText(
        "当前需求不属于所选客户岗位，请返回客户工作台重新选择。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("客户 B 的知识库需求")).not.toBeInTheDocument();
    expect(mocks.updateTicketMutation).not.toHaveBeenCalled();
  });

  it("keeps the customer workbench focused on preview and only exposes the selected project's actions", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 1,
        scheduled: 0,
        in_progress: 0,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          userId: 101,
          title: "客户新提交的官网需求",
          operation: "site_check",
          status: "submitted",
          createdByUserId: 101,
          revision: 1,
          updatedAt: Date.parse("2026-07-31T00:00:00.000Z"),
        },
      ],
      customerQuestions: [],
      dashboard: {
        revision: 3,
        payload: {
          brandName: "示例客户",
          headline: "不应显示的品牌建设内容",
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
        },
      },
      aiOperationsPreview: {
        websiteWorkspace: {
          marketEdition: "domestic",
          quotas: {
            content_asset_publish: {},
            website_content_publish: {},
          },
          contentAssetCatalog: [],
          websiteContentCatalog: [],
          preferredMediaOptions: [],
          deliveryOwners: {},
          websiteWorkflow: {
            domainStatus: "completed",
            icpStatus: "completed",
            canSubmitContent: true,
          },
          tickets: [],
        },
        knowledgeProgress: null,
        knowledgeSnapshot: null,
      },
    };
    mocks.ticketsData = {
      items: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          userId: 101,
          customerName: "示例客户",
          title: "客户新提交的官网需求",
          operation: "site_check",
          status: "submitted",
          statusGroup: "pending",
          createdByUserId: 101,
          assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
          dependencyBlockReason: null,
          revision: 1,
          updatedAt: Date.parse("2026-07-31T00:00:00.000Z"),
        },
        {
          id: "5a67e445-37bb-45ed-9268-4ca9437e4d72",
          userId: 101,
          customerName: "示例客户",
          title: "同客户其他岗位需求",
          operation: "site_check",
          status: "submitted",
          statusGroup: "pending",
          assignedProjectAssignmentId: "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
          dependencyBlockReason: null,
          revision: 2,
          updatedAt: Date.parse("2026-07-30T00:00:00.000Z"),
        },
        {
          id: "6a67e445-37bb-45ed-9268-4ca9437e4d73",
          userId: 101,
          customerName: "示例客户",
          title: "当前岗位历史需求",
          operation: "site_check",
          status: "completed",
          statusGroup: "completed",
          assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
          dependencyBlockReason: null,
          revision: 3,
          updatedAt: Date.parse("2026-07-29T00:00:00.000Z"),
        },
      ],
      filters: {
        customers: [
          { id: 101, name: "示例客户", username: "example.customer" },
        ],
      },
      counts: { pending: 2, completed: 1 },
      nextPending: null,
      nextCursor: {
        actionRank: 1,
        updatedAt: Date.parse("2026-07-29T00:00:00.000Z"),
        id: "6a67e445-37bb-45ed-9268-4ca9437e4d73",
      },
      limit: 50,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      await screen.findByRole("heading", { name: "客户工作台" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-role-label")).toHaveTextContent(
      "工程师",
    );
    expect(screen.queryByText("AI 监控与优化工程师")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 内容制作工程师")).not.toBeInTheDocument();
    expect(
      screen.queryByText("客户", { selector: "h3" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("用户新提交")).toBeNull();
    expect(
      document.querySelector("[data-new-customer-ticket='true']"),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "AI 友好内容" })).toBeNull();
    expect(screen.queryByText("我的未结束需求")).toBeNull();
    expect(screen.queryByText("现在优先处理")).toBeNull();
    expect(
      within(screen.getByTestId("customer-content-actions")).getByText(
        "客户需求",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("客户新提交的官网需求")).toBeInTheDocument();
    const pendingTicket = screen
      .getByText("客户新提交的官网需求")
      .closest("[data-pending-ticket='true']");
    expect(pendingTicket).toHaveClass("border-red-500", "bg-red-50/80");
    expect(
      within(pendingTicket as HTMLElement).getByText("已提交"),
    ).toHaveClass("bg-destructive");
    expect(screen.queryByText("同客户其他岗位需求")).not.toBeInTheDocument();
    expect(screen.getByText("当前岗位历史需求")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "按状态筛选" }),
    ).toBeInTheDocument();
    expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
      customerUserId: 101,
      projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
      limit: 50,
    });
    expect(screen.queryByLabelText("客户看板")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多需求" }));
    expect(mocks.fetchNextTickets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
        expectedRevision: 1,
        status: "in_progress",
      }),
    );
    await waitFor(() => {
      expect(mocks.refetchTickets).toHaveBeenCalled();
      expect(mocks.refetchWorkbench).toHaveBeenCalled();
    });
  });

  it("shows customer names and opens the full knowledge-reset history detail", () => {
    mocks.assignments = [
      {
        projectAssignmentId: "3e9f33bc-40e2-4a8e-9bda-40d92a94b33f",
        customerUserId: 12,
        customerName: "星河科技",
        customerUsername: "xinghe",
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.ticketsData = {
      items: [
        {
          id: "297769f5-9ec5-4d64-9c3a-9abdb603632d",
          userId: 12,
          customerName: "星河科技",
          customerUsername: "xinghe",
          title: "知识库重置申请",
          operation: "knowledge_reset",
          status: "completed",
          statusGroup: "completed",
          assignedProjectAssignmentId: "3e9f33bc-40e2-4a8e-9bda-40d92a94b33f",
          publicSummary: "已批准并完成清理，共清理 8 项。",
          resolvedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        },
      ],
      filters: {
        customers: [
          { id: 12, name: "星河科技", username: "xinghe" },
          { id: 18, name: "远山制造", username: "yuanshan" },
        ],
      },
      counts: { pending: 0, completed: 1 },
      nextPending: null,
      nextCursor: null,
      limit: 50,
    };
    mocks.detailData = {
      ticket: {
        title: "知识库重置申请",
        operation: "knowledge_reset",
        status: "completed",
        resolvedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        updatedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        description: "重新上传了正确的企业资料",
        publicSummary: "已批准并完成知识库清理",
        internalNote: null,
        deliveryLinks: [],
      },
      customer: { id: 12, name: "星河科技", username: "xinghe" },
      events: [
        {
          id: "event-status-transition",
          actorRole: "delivery_member",
          kind: "status_changed",
          message: null,
          fromStatus: "submitted",
          toStatus: "in_progress",
          createdAt: Date.parse("2026-07-30T10:00:00.000Z"),
        },
      ],
      attachments: [],
      rootContext: {
        ticket: {
          type: "website_operation",
          category: "company_news",
          title: "发布客户官网新闻",
          topic: "新品发布",
          description: "请使用客户提供的正式新闻稿。",
          preferredMedia: "官网",
          targetPage: "/news",
          materialUrls: ["https://example.com/brief"],
        },
        attachments: [{ id: "root-file", filename: "正式新闻稿.docx" }],
      },
      knowledgeReset: {
        reasonCode: "upload_error",
        reasonNote: "上传了错误文件",
        status: "approved",
        decisionNote: "确认可重置",
        cleanupSummary: { snapshots: 3, attachments: 5 },
        decidedAt: Date.parse("2026-07-30T12:00:00.000Z"),
      },
    };

    render(<DeliveryMemberDashboard />);

    expect(
      screen.getByRole("option", { name: "星河科技" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /知识库重置申请/ }));

    expect(screen.getByText("知识库重置结果")).toBeInTheDocument();
    expect(screen.getByText(/上传了错误文件/)).toBeInTheDocument();
    expect(screen.getByText(/审批结果：已批准/)).toBeInTheDocument();
    expect(screen.getByText(/确认可重置/)).toBeInTheDocument();
    expect(screen.getByText(/知识库快照 3/)).toBeInTheDocument();
    expect(screen.getByText("已提交 → 处理中")).toBeInTheDocument();
    expect(screen.queryByText("submitted → in_progress")).toBeNull();
    expect(screen.getByText("原始客户需求")).toBeInTheDocument();
    expect(screen.getByText("发布客户官网新闻")).toBeInTheDocument();
    expect(
      screen.getByText("请使用客户提供的正式新闻稿。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/正式新闻稿\.docx/)).toBeInTheDocument();
    expect(screen.getAllByText(/完成时间/)).toHaveLength(2);

    const openCustomerDashboardButton = screen.getByRole("button", {
      name: "进入客户看板",
    });
    expect(openCustomerDashboardButton).toHaveClass(
      "bg-blue-600",
      "text-white",
    );
    fireEvent.click(openCustomerDashboardButton);
    expect(
      document.querySelector('main[data-mode="fullscreen"]'),
    ).not.toBeNull();
    expect(screen.getByLabelText("客户看板")).toHaveAttribute(
      "data-layout",
      "workspace",
    );
    expect(
      screen.getByRole("button", { name: "返回客户工作台" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "知识库智能体" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("uses one structured delivery confirmation instead of prompt-driven handoff", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "content_distribution_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [
        {
          id: 101,
          username: "example.customer",
          displayName: "示例客户",
          details: ["内容需求 1", "已完成 0", "待处理 1"],
        },
      ],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d72",
          userId: 101,
          title: "制作并发布 AI 友好内容资产",
          operation: "content_asset_publish",
          status: "in_progress",
          revision: 3,
          contentAssetIds: [],
          updatedAt: Date.parse("2026-07-31T00:00:00.000Z"),
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(screen.getByText("完成交付并确认下游交接")).toBeInTheDocument();
    expect(
      screen.getByText(/按客户原始入口自动生成媒体分发或官网发布子任务/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /公开链接/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /用户侧验收/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("下一步发布目标")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /交付结果摘要/ }), {
      target: { value: "内容资产已经发布并完成用户侧核验。" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: /已确认内容资产 ID/ }),
      {
        target: { value: "asset-1" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d72",
        expectedRevision: 3,
        status: "completed",
        message: "内容资产已经发布并完成用户侧核验。",
        handoff: {
          contentAssetIds: ["asset-1"],
        },
      }),
    );
  });

  it("routes an active API-key ticket to the system administrator without engineer inputs", async () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d80",
          userId: 101,
          title: "配置 Jenova 平台 API 密钥",
          operation: "build_exception",
          status: "in_progress",
          credentialTargetUserId: 101,
          revision: 1,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      await screen.findByText("等待系统管理员配置 API Key"),
    ).toBeInTheDocument();
    expect(screen.getByText(/API与人员管理/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "填写交付结果" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "等待用户补充" }),
    ).not.toBeInTheDocument();
  });

  it("closes an unknown historical operation with summary only", async () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d81",
          userId: 101,
          title: "历史自定义交付事项",
          operation: "legacy_custom_operation",
          status: "in_progress",
          revision: 2,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(screen.getByText(/只保存交付摘要/)).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /公开链接/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /用户侧验收/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /交付结果摘要/ }), {
      target: { value: "历史事项已经核对并处理。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: AI_OPERATIONS_PROJECT_ID,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d81",
        expectedRevision: 2,
        status: "completed",
        message: "历史事项已经核对并处理。",
      }),
    );
  });

  it("selects a formal monitoring batch and approved optimization questions without hand-entered ids", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d91",
          userId: 101,
          title: "完成首次监控",
          operation: "initial_monitoring",
          status: "in_progress",
          revision: 5,
        },
      ],
      monitoringBatches: [
        {
          batchKey: "formal-batch-2026-08",
          sourceName: "首次监控正式数据.xlsx",
          collectedAt: Date.parse("2026-08-08T03:00:00.000Z"),
          sampleCount: 24,
        },
      ],
      customerQuestions: [
        {
          id: "approved-question-1",
          category: "industry",
          question: "该品牌在行业中的优势是什么？",
          status: "selected",
          selectionApprovalStatus: "approved",
          revision: 3,
        },
        {
          id: "pending-question-2",
          category: "reputation",
          question: "这条问题仍在待审核吗？",
          status: "candidate",
          selectionApprovalStatus: "pending",
          revision: 1,
        },
      ],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    const batchSelect = screen.getByRole("combobox", {
      name: "正式监控批次",
    });
    expect(
      within(batchSelect).getByRole("option", {
        name: /formal-batch-2026-08.*24 条答案/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /问题 ID/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "这条问题仍在待审核吗？" }),
    ).not.toBeInTheDocument();

    fireEvent.change(batchSelect, {
      target: { value: "formal-batch-2026-08" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /该品牌在行业中的优势是什么/,
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /交付结果摘要/ }), {
      target: { value: "首次监控已完成并核对正式结果。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: MONITORING_PROJECT_ID,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d91",
        expectedRevision: 5,
        status: "completed",
        message: "首次监控已完成并核对正式结果。",
        handoff: {
          monitoringBatchKey: "formal-batch-2026-08",
          optimizationQuestionIds: ["approved-question-1"],
        },
      }),
    );
  });

  it("excludes the retest baseline from the formal batch selector", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d92",
          userId: 101,
          title: "效果复测",
          operation: "monitoring_retest",
          status: "in_progress",
          monitoringBatchKey: "baseline-batch",
          revision: 2,
        },
      ],
      monitoringBatches: [
        {
          batchKey: "baseline-batch",
          sourceName: "基线.xlsx",
          collectedAt: Date.parse("2026-07-01T03:00:00.000Z"),
          sampleCount: 12,
        },
        {
          batchKey: "retest-batch",
          sourceName: "复测.xlsx",
          collectedAt: Date.parse("2026-08-08T03:00:00.000Z"),
          sampleCount: 12,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    const batchSelect = screen.getByRole("combobox", {
      name: "本次复测的新监控批次",
    });
    expect(
      within(batchSelect).queryByRole("option", { name: /baseline-batch/ }),
    ).not.toBeInTheDocument();
    expect(
      within(batchSelect).getByRole("option", { name: /retest-batch/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/复测前基线：baseline-batch/)).toBeInTheDocument();
  });

  it("shows brand-keyword evidence as read-only and blocks completion until it is formal", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d93",
          userId: 101,
          title: "配置品牌词库与问题目录",
          operation: "question_catalog",
          status: "in_progress",
          revision: 2,
        },
      ],
      monitoringBatches: [],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(
      screen.getByText("当前正式数据尚不满足完成条件"),
    ).toBeInTheDocument();
    expect(screen.getByText("尚未发布")).toBeInTheDocument();
    expect(screen.queryByText(/审核通过的问题/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成并交接" })).toBeDisabled();
    expect(
      screen.queryByRole("textbox", { name: /词库|问题 ID/ }),
    ).not.toBeInTheDocument();
  });

  it("allows brand-keyword completion after publication without requiring an approved question", async () => {
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d94",
          userId: 101,
          title: "配置品牌词库",
          operation: "question_catalog",
          status: "in_progress",
          revision: 3,
        },
      ],
      monitoringBatches: [],
      customerQuestions: [],
      dashboard: {
        revision: 4,
        payload: {
          brandName: "示例客户",
          headline: "",
          summary: "",
          metrics: [],
          sections: [],
          keywordTables: [
            {
              id: "published-keywords",
              title: "正式品牌词库",
              columns: ["关键词"],
              rows: [["示例品牌"]],
            },
          ],
          questions: [],
          monitoringAnswers: [],
          citations: [],
          contentAssets: [],
          optimizationReport: null,
          progressReports: [],
        },
      },
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(screen.getByText("已发布")).toBeInTheDocument();
    expect(screen.queryByText(/审核通过的问题/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("当前正式数据尚不满足完成条件"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /交付结果摘要/ })).toHaveValue(
      "品牌词库已发布",
    );
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: MONITORING_PROJECT_ID,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d94",
        expectedRevision: 3,
        status: "completed",
        message: "品牌词库已发布",
      }),
    );
  });

  it("locks the requested channel media and sends it as structured handoff", async () => {
    mocks.assignments = [
      {
        ...monitoringAssignment,
        roleType: "content_distribution_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d82",
          userId: 101,
          title: "登记媒体渠道分发结果",
          operation: "channel_distribution",
          status: "in_progress",
          preferredMedia: "知乎",
          revision: 3,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    const targetMedia = screen.getByRole("combobox", {
      name: /目标媒体或渠道/,
    });
    expect(targetMedia).toHaveValue("知乎");
    expect(targetMedia).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /交付结果摘要/ }), {
      target: { value: "渠道发布已完成。" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /公开链接/ }), {
      target: { value: "https://www.zhihu.com/question/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: MONITORING_PROJECT_ID,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d82",
        expectedRevision: 3,
        status: "completed",
        message: "渠道发布已完成。",
        publicUrl: "https://www.zhihu.com/question/1",
        handoff: { targetMedia: "知乎" },
      }),
    );
  });

  it("shows inherited website content assets as read-only completion context", async () => {
    mocks.assignments = [aiOperationsAssignment];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d83",
          userId: 101,
          title: "发布企业事实页面",
          operation: "company_facts",
          status: "in_progress",
          contentAssetIds: ["asset-inherited-1"],
          revision: 4,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);
    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(screen.getByText("asset-inherited-1")).toBeInTheDocument();
    expect(screen.getByText(/不能在完成时改写/)).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /本页面绑定的内容资产 ID/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /用户侧验收/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /交付结果摘要/ }), {
      target: { value: "企业事实页面已发布。" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /公开链接/ }), {
      target: { value: "https://example.com/about" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: AI_OPERATIONS_PROJECT_ID,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d83",
        expectedRevision: 4,
        status: "completed",
        message: "企业事实页面已发布。",
        publicUrl: "https://example.com/about",
        handoff: { contentAssetIds: ["asset-inherited-1"] },
      }),
    );
  });

  it("exposes only the brand-keyword upload for a catalog ticket", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "monitoring_optimization_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 1,
        needs_information: 0,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d74",
          userId: 101,
          customerName: "示例客户",
          title: "配置品牌词库与问题目录",
          operation: "question_catalog",
          status: "in_progress",
          revision: 2,
          dashboardRevision: 7,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          preview: {
            sourceName: "brand-keywords.json",
            fileHash: "a".repeat(64),
            preflightToken: "signed-preflight-token",
            summary: ["品牌词库将由 0 条更新为 160 条"],
            recordStats: [
              {
                label: "品牌词库",
                beforeCount: 0,
                afterCount: 160,
                added: 160,
                updated: 0,
                removed: 0,
                unchanged: 0,
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    render(<DeliveryMemberDashboard customerWorkbench />);

    const keywordInput = await screen.findByLabelText("上传品牌词库");
    expect(
      screen.queryByText("配置品牌词库与问题目录"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("配置品牌词库").length).toBeGreaterThan(0);
    expect(keywordInput).toHaveAttribute(
      "accept",
      expect.stringContaining(".xlsx"),
    );
    expect(screen.queryByLabelText("上传问题目录")).not.toBeInTheDocument();
    fireEvent.change(keywordInput, {
      target: {
        files: [
          new File(['{"keywordTables":[]}'], "brand-keywords.json", {
            type: "application/json",
          }),
        ],
      },
    });

    expect(
      await screen.findByText("业务文件预检与发布确认"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("品牌词库将由 0 条更新为 160 条"),
    ).toBeInTheDocument();
    const preflightHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(preflightHeaders).toMatchObject({
      "x-dashboard-module": "keywords",
      "x-import-preview": "true",
      "x-delivery-ticket-id": "4a67e445-37bb-45ed-9268-4ca9437e4d74",
      "x-delivery-project-assignment-id":
        "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
    });

    fireEvent.click(screen.getByRole("button", { name: "确认发布到正式数据" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const publishHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(publishHeaders).toMatchObject({
      "x-dashboard-module": "keywords",
      "x-import-file-hash": "a".repeat(64),
      "x-import-preflight-token": "signed-preflight-token",
    });
    expect(publishHeaders["x-import-preview"]).toBeUndefined();
    await waitFor(() => expect(mocks.refetchTickets).toHaveBeenCalled());
    fetchSpy.mockRestore();
  });

  it.each([
    { actorLabel: "工程师", systemAdminMode: false },
    { actorLabel: "系统管理员", systemAdminMode: true },
  ])(
    "$actorLabel can adjust the current customer's four question quotas",
    async ({ systemAdminMode }) => {
      mocks.assignments = [monitoringAssignment];
      mocks.workbenchData = {
        customers: [],
        counts: {
          submitted: 0,
          scheduled: 0,
          in_progress: 0,
          needs_information: 0,
          completed: 0,
        },
        tickets: [],
        customerQuestions: [],
        dashboard: null,
        questionQuota: questionQuotaFixture,
      };
      if (systemAdminMode) {
        window.history.replaceState(
          {},
          "",
          `/admin/delivery-workbench?projectAssignmentId=${MONITORING_PROJECT_ID}`,
        );
      }

      render(
        <DeliveryMemberDashboard
          customerWorkbench
          systemAdminMode={systemAdminMode}
        />,
      );

      const editor = await screen.findByTestId("question-quota-editor");
      expect(within(editor).getByText("行业排名词")).toBeInTheDocument();
      for (const [label, category] of [
        ["行业排名词", "industry"],
        ["竞品对比词", "competitor_comparison"],
        ["美誉舆情词", "reputation"],
        ["产品场景词", "product_scenario"],
      ] as const) {
        expect(
          within(editor).getByText(label).closest("[data-category]"),
        ).toHaveAttribute("data-category", category);
      }
      expect(
        within(editor).getByText("已确认 1 · 待审核预留 1"),
      ).toBeInTheDocument();
      fireEvent.click(within(editor).getByRole("button", { name: "修改额度" }));

      const productScenarioInput =
        within(editor).getByLabelText("产品场景词额度");
      expect(productScenarioInput).toHaveValue(5);
      fireEvent.change(productScenarioInput, { target: { value: "1" } });
      expect(within(editor).getByRole("alert")).toHaveTextContent(
        "产品场景词额度不能低于已确认与待审核预留数量 2",
      );
      expect(
        within(editor).getByRole("button", { name: "保存额度" }),
      ).toBeDisabled();

      fireEvent.change(productScenarioInput, { target: { value: "6" } });
      fireEvent.change(within(editor).getByLabelText("调整原因"), {
        target: { value: "根据客户本期需求调整" },
      });
      fireEvent.click(within(editor).getByRole("button", { name: "保存额度" }));

      await waitFor(() =>
        expect(mocks.adjustQuestionQuotaMutation).toHaveBeenCalledWith({
          projectAssignmentId: MONITORING_PROJECT_ID,
          quotaPeriodId: QUESTION_QUOTA_PERIOD_ID,
          expectedRevision: 3,
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 6,
          reason: "根据客户本期需求调整",
        }),
      );
      expect(
        mocks.adjustQuestionQuotaMutation.mock.calls[0]?.[0],
      ).not.toHaveProperty("userId");
      await waitFor(() => expect(mocks.refetchWorkbench).toHaveBeenCalled());
    },
  );

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

  it("requires the engineer to classify a self-entered question before approval", async () => {
    const question = {
      id: "pending-direct-question",
      category: null,
      source: "user",
      status: "candidate",
      selectionApprovalStatus: "pending",
      question: "新企业如何验证产品交付能力？",
      intent: null,
      revision: 4,
    };
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [],
      customerQuestions: [question],
      dashboard: null,
      questionQuota: questionQuotaFixture,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(await screen.findByText("问题来源：自主填写")).toBeInTheDocument();
    const categorySelect = screen.getByRole("combobox", {
      name: `“${question.question}”的问题类型`,
    });
    expect(categorySelect).toHaveValue("");
    expect(
      within(categorySelect).getByRole("option", {
        name: "行业排名词（额度已满）",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText("行业排名词额度已满，请选择仍有额度的问题类型。"),
    ).toBeInTheDocument();

    const approveButton = screen.getByRole("button", { name: "审核通过" });
    expect(approveButton).toBeDisabled();

    fireEvent.change(categorySelect, {
      target: { value: "competitor_comparison" },
    });
    expect(approveButton).toBeEnabled();
    fireEvent.click(approveButton);

    await waitFor(() =>
      expect(mocks.approveQuestionSelectionMutation).toHaveBeenCalledWith({
        projectAssignmentId: MONITORING_PROJECT_ID,
        questionId: question.id,
        expectedRevision: 4,
        category: "competitor_comparison",
      }),
    );
    expect(mocks.refetchWorkbench).toHaveBeenCalled();
  });

  it("keeps an existing question category as a Chinese badge without forcing reassignment", async () => {
    const question = {
      id: "pending-categorized-question",
      category: "product_scenario",
      source: "admin",
      status: "candidate",
      selectionApprovalStatus: "pending",
      question: "产品适合哪些使用场景？",
      intent: null,
      revision: 7,
    };
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [],
      customerQuestions: [question],
      dashboard: null,
      questionQuota: questionQuotaFixture,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(await screen.findByText(question.question)).toBeInTheDocument();
    expect(screen.getAllByText("产品场景词").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("combobox", {
        name: `“${question.question}”的问题类型`,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "审核通过" }));

    await waitFor(() =>
      expect(mocks.approveQuestionSelectionMutation).toHaveBeenCalledWith({
        projectAssignmentId: MONITORING_PROJECT_ID,
        questionId: question.id,
        expectedRevision: 7,
      }),
    );
  });

  it("blocks approval when every category quota is full", async () => {
    const question = {
      id: "pending-total-full-question",
      category: null,
      source: "user",
      status: "candidate",
      selectionApprovalStatus: "pending",
      question: "这个问题应该归到哪一类？",
      intent: null,
      revision: 2,
    };
    mocks.assignments = [monitoringAssignment];
    mocks.workbenchData = {
      customers: [],
      tickets: [],
      customerQuestions: [question],
      dashboard: null,
      questionQuota: {
        ...questionQuotaFixture,
        remaining: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
      },
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    const categorySelect = await screen.findByRole("combobox", {
      name: `“${question.question}”的问题类型`,
    });
    expect(categorySelect).toBeEnabled();
    expect(
      screen.getByText(
        "行业排名词、竞品对比词、美誉舆情词、产品场景词额度已满，请选择仍有额度的问题类型。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审核通过" })).toBeDisabled();
    expect(mocks.approveQuestionSelectionMutation).not.toHaveBeenCalled();
  });

  it("hides the question quota editor from non-monitoring assignments", async () => {
    mocks.assignments = [
      {
        ...monitoringAssignment,
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [],
      tickets: [],
      customerQuestions: [],
      dashboard: null,
      questionQuota: questionQuotaFixture,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    await screen.findByTestId("current-delivery-target");
    expect(
      screen.queryByTestId("question-quota-editor"),
    ).not.toBeInTheDocument();
  });

  it("does not let an engineer bypass customer style selection", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "ai_operations_engineer",
      },
    ];
    mocks.workbenchData = {
      customers: [],
      counts: {
        submitted: 0,
        scheduled: 0,
        in_progress: 0,
        needs_information: 1,
        completed: 0,
      },
      tickets: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d73",
          userId: 101,
          title: "提供 AI 专用官网图片风格样例",
          operation: "website_style_samples",
          status: "needs_information",
          revision: 4,
          websiteStyleWorkflowRevision: 3,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      await screen.findByText(
        "已发布本批三张样例，正在等待客户选择或退回重做。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始处理" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "填写交付结果" }),
    ).not.toBeInTheDocument();
  });
});
