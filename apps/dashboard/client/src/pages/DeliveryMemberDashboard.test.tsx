import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
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
  }>,
  workbenchUseQuery: vi.fn(),
  ticketsUseQuery: vi.fn(),
  fetchNextTickets: vi.fn(),
  refetchTickets: vi.fn(),
  refetchWorkbench: vi.fn(),
  workbenchData: { customers: [], tickets: [] } as any,
  updateTicketMutation: vi.fn(),
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
          }),
        },
        approveQuestionSelection: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: vi.fn(),
          }),
        },
        updateTicket: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: mocks.updateTicketMutation,
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
    children,
  }: {
    eyebrow?: string;
    title?: string;
    navItems?: Array<{ label: string }>;
    roleLabel?: string;
    toolbar?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <main>
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
  deliveryMemberNavForRole,
  ROLE_DASHBOARD_SECTIONS,
} from "./DeliveryMemberDashboard";

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
    mocks.updateTicketMutation.mockResolvedValue({
      success: true,
      handoffTicketIds: [],
    });
    vi.mocked(sessionStorage.getItem).mockReturnValue(null);
    window.history.replaceState({}, "", "/");
  });

  it("places role tools in the left navigation and limits them by role", () => {
    expect(
      deliveryMemberNavForRole("ai_operations_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["我的工单", "客户工作台", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("monitoring_optimization_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["我的工单", "客户工作台", "问题监控", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("content_distribution_engineer").map(
        (item) => item.label,
      ),
    ).toEqual(["我的工单", "客户工作台", "渠道分发", "通用智能体"]);
    expect(
      deliveryMemberNavForRole("ai_operations_engineer").map(
        (item) => item.label,
      ),
    ).not.toContain("问题监控");
    expect(
      deliveryMemberNavForRole("monitoring_optimization_engineer").map(
        (item) => item.group,
      ),
    ).toEqual(["工作台", "工作台", "工具", "工具"]);
  });

  it("limits every engineer preview to customer-facing output owned by that role", () => {
    expect(ROLE_DASHBOARD_SECTIONS.ai_operations_engineer).toEqual([
      "knowledge-build",
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
      "content",
    ]);

    for (const sections of Object.values(ROLE_DASHBOARD_SECTIONS)) {
      expect(sections).not.toContain("brand");
    }
  });

  it("keeps the customer workbench action panel scoped and leaves history in My Tickets", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/DeliveryMemberDashboard.tsx"),
      "utf8",
    );
    const workbenchSource = source.slice(
      source.indexOf("function CustomerWorkbenchView("),
      source.indexOf("const TERMINAL_STATUS_LABELS"),
    );

    expect(workbenchSource).toContain('statusGroup: "pending"');
    expect(workbenchSource).toContain("limit: 50");
    expect(workbenchSource).toContain("ticket.assignedProjectAssignmentId ===");
    expect(workbenchSource).toContain("<DeliveryTicketActions");
    expect(workbenchSource).toContain("<KnowledgeResetDecision");
    expect(workbenchSource).toContain('href="#customer-content-actions"');
    expect(workbenchSource).not.toContain("DeliveryHistoryDetailDialog");
    expect(workbenchSource).not.toContain('aria-label="按状态筛选"');
    expect(workbenchSource).toContain("customerActionTickets.fetchNextPage");
    expect(workbenchSource).toContain("加载更多可操作内容");
    expect(workbenchSource).not.toContain(
      "href={`/?customerUserId=${currentAssignment.customerUserId}`}",
    );
  });

  it("loads every assigned customer's tickets by default and filters only after a customer click", async () => {
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
          title: "甲公司工单",
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
          title: "乙公司工单",
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
        title: "甲公司工单",
        operation: "site_check",
        status: "submitted",
      },
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard />);

    expect(screen.getAllByText("甲公司工单").length).toBeGreaterThan(0);
    expect(screen.getByText("乙公司工单")).toBeInTheDocument();
    expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({ limit: 50 });
    expect(mocks.workbenchUseQuery).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByLabelText("客户快捷筛选")).getByRole("button", {
        name: "客户乙",
      }),
    );

    await waitFor(() =>
      expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
        customerUserId: 202,
        limit: 50,
      }),
    );
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("uses the server dependency decision even when the completed prerequisite is outside the visible page", () => {
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

    render(<DeliveryMemberDashboard />);

    expect(screen.queryByText("等待前置工单")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始处理" }),
    ).toBeInTheDocument();
  });

  it("loads subsequent ticket pages through the stable server cursor", () => {
    mocks.ticketsData = {
      items: [
        {
          id: "7a67e445-37bb-45ed-9268-4ca9437e4d74",
          userId: 101,
          customerName: "客户甲",
          title: "待处理工单",
          operation: "site_check",
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
      counts: { pending: 51, completed: 0 },
      nextPending: {
        id: "7a67e445-37bb-45ed-9268-4ca9437e4d74",
        userId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        title: "待处理工单",
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
    fireEvent.click(screen.getByRole("button", { name: "加载更多工单" }));

    expect(mocks.fetchNextTickets).toHaveBeenCalledTimes(1);
  });

  it("keeps the authoritative next pending ticket visible while filtering completed history", async () => {
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
          revision: 2,
          updatedAt: Date.parse("2026-08-01T00:00:00.000Z"),
        },
      ],
      filters: {
        customers: [{ id: 101, name: "客户甲", username: "customer-a" }],
      },
      counts: { pending: 3, completed: 1 },
      nextPending: {
        id: "9a67e445-37bb-45ed-9268-4ca9437e4d76",
        userId: 101,
        customerName: "客户甲",
        customerUsername: "customer-a",
        title: "服务端优先工单",
        operation: "site_check",
        status: "in_progress",
      },
      nextCursor: null,
      limit: 50,
    };

    render(<DeliveryMemberDashboard />);
    fireEvent.change(screen.getByRole("combobox", { name: "按状态筛选" }), {
      target: { value: "completed" },
    });

    await waitFor(() =>
      expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
        statusGroup: "completed",
        limit: 50,
      }),
    );
    expect(screen.getByText("服务端优先工单")).toBeInTheDocument();
    expect(screen.queryByText("当前没有待处理工单")).not.toBeInTheDocument();
  });

  it("shows the project-assignment empty state and clears a stale selection", async () => {
    vi.mocked(sessionStorage.getItem).mockReturnValue(
      "stale-project-assignment",
    );

    render(<DeliveryMemberDashboard customerWorkbench />);

    expect(
      screen.getByRole("heading", { name: "我的客户工作台" }),
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
      name: "当前客户项目",
    });
    expect(screen.queryByTestId("portal-toolbar")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("current-delivery-target")).getByRole(
        "combobox",
        { name: "当前客户项目" },
      ),
    ).toBe(projectSelector);
    expect(projectSelector).toHaveValue("1e9f33bc-40e2-4a8e-9bda-40d92a94b11f");
    expect(
      screen.getByRole("option", {
        name: "示例客户 · AI 运维工程师",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-role-label")).toHaveTextContent(
      "示例客户 · AI 运维工程师",
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
      screen.getByRole("heading", { name: "系统管理员处理工作台" }),
    ).toBeInTheDocument();
    expect(screen.getByText("系统管理员 · 工单处理")).toBeInTheDocument();
    expect(screen.getByTestId("portal-nav-labels")).toHaveTextContent(
      "客户交付工作台",
    );
    expect(screen.getByTestId("portal-nav-labels")).not.toHaveTextContent(
      "我的工单",
    );
    expect(screen.getByRole("link", { name: "返回客户工单" })).toHaveAttribute(
      "href",
      "/admin/workspace",
    );
    expect(screen.getByRole("combobox", { name: "当前客户项目" })).toHaveValue(
      "2e9f33bc-40e2-4a8e-9bda-40d92a94b22f",
    );
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
          title: "客户新提交的官网工单",
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
          title: "客户新提交的官网工单",
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
          title: "同客户其他岗位工单",
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
          title: "当前岗位历史工单",
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
      await screen.findByRole("heading", { name: "我的客户工作台" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-role-label")).toHaveTextContent(
      "AI 运维工程师",
    );
    expect(screen.queryByText("AI 监控与优化工程师")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 内容分发工程师")).not.toBeInTheDocument();
    expect(
      screen.queryByText("客户", { selector: "h3" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("用户新提交")).toBeNull();
    expect(
      document.querySelector("[data-new-customer-ticket='true']"),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "AI 友好内容" })).toBeNull();
    expect(screen.queryByText("我的未结束工单")).toBeNull();
    expect(screen.queryByText("现在优先处理")).toBeNull();
    expect(
      within(screen.getByTestId("customer-content-actions")).getByText(
        "内容提交与修改",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("客户新提交的官网工单")).toBeInTheDocument();
    expect(screen.queryByText("同客户其他岗位工单")).not.toBeInTheDocument();
    expect(screen.queryByText("当前岗位历史工单")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "按状态筛选" }),
    ).not.toBeInTheDocument();
    expect(mocks.ticketsUseQuery).toHaveBeenLastCalledWith({
      customerUserId: 101,
      projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
      statusGroup: "pending",
      limit: 50,
    });
    expect(
      screen.getByRole("link", { name: "提交或修改当前客户内容" }),
    ).toHaveAttribute("href", "#customer-content-actions");
    fireEvent.click(screen.getByRole("button", { name: "加载更多可操作内容" }));
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
    mocks.ticketsData = {
      items: [
        {
          id: "297769f5-9ec5-4d64-9c3a-9abdb603632d",
          customerUserId: 12,
          customerName: "星河科技",
          customerUsername: "xinghe",
          title: "知识库重置申请",
          operation: "knowledge_reset",
          status: "completed",
          statusGroup: "completed",
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
        status: "completed",
        resolvedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        updatedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        description: "重新上传了正确的企业资料",
        publicSummary: "已批准并完成知识库清理",
        internalNote: null,
        deliveryLinks: [],
      },
      customer: { id: 12, name: "星河科技", username: "xinghe" },
      events: [],
      attachments: [],
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
      screen.getByRole("option", { name: /星河科技/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /远山制造/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /知识库重置申请/ }));

    expect(screen.getByText("知识库重置结果")).toBeInTheDocument();
    expect(screen.getByText(/上传了错误文件/)).toBeInTheDocument();
    expect(screen.getByText(/审批结果：已批准/)).toBeInTheDocument();
    expect(screen.getByText(/确认可重置/)).toBeInTheDocument();
    expect(screen.getByText(/snapshots 3/)).toBeInTheDocument();
    expect(screen.getAllByText(/完成时间/)).toHaveLength(2);
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
          details: ["内容工单 1", "已完成 0", "待处理 1"],
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

    render(<DeliveryMemberDashboard />);

    fireEvent.click(
      await screen.findByRole("button", { name: "填写交付结果" }),
    );

    expect(screen.getByText("完成交付并确认下游交接")).toBeInTheDocument();
    expect(screen.getByText(/系统会按所选发布目标/)).toBeInTheDocument();
    expect(screen.queryByText("media、website")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/已完成首轮问题监控/), {
      target: { value: "内容资产已经发布并完成用户侧核验。" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://"), {
      target: { value: "https://example.com/asset/1" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: /已确认内容资产 ID/ }),
      {
        target: { value: "asset-1" },
      },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /我已完成用户侧验收/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "完成并交接" }));

    await waitFor(() =>
      expect(mocks.updateTicketMutation).toHaveBeenCalledWith({
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d72",
        expectedRevision: 3,
        status: "completed",
        message: "内容资产已经发布并完成用户侧核验。",
        publicUrl: "https://example.com/asset/1",
        handoff: {
          contentAssetIds: ["asset-1"],
          publishTargets: ["media"],
        },
      }),
    );
  });

  it("previews a business module in a structured dialog before publishing", async () => {
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
          title: "发布问题目录",
          operation: "question_catalog",
          status: "in_progress",
          revision: 2,
          dashboardRevision: 7,
        },
      ],
      customerQuestions: [],
      dashboard: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm");
    const promptSpy = vi.spyOn(window, "prompt");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          preview: {
            sourceName: "question-catalog.json",
            fileHash: "a".repeat(64),
            preflightToken: "signed-preflight-token",
            summary: ["问题目录将由 4 条更新为 6 条"],
            recordStats: [
              {
                label: "问题目录",
                beforeCount: 4,
                afterCount: 6,
                added: 2,
                updated: 0,
                removed: 0,
                unchanged: 4,
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

    render(<DeliveryMemberDashboard />);

    const fileInput = await screen.findByLabelText("上传问题目录");
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['{"questions":[]}'], "question-catalog.json", {
            type: "application/json",
          }),
        ],
      },
    });

    expect(
      await screen.findByText("业务文件预检与发布确认"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("问题目录将由 4 条更新为 6 条"),
    ).toBeInTheDocument();
    expect(screen.getByText(/现有 4 条 → 发布后 6 条/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认发布到正式数据" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const publishHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(publishHeaders["x-import-preflight-token"]).toBe(
      "signed-preflight-token",
    );
    expect(publishHeaders["x-import-preview"]).toBeUndefined();
    await waitFor(() => expect(mocks.refetchTickets).toHaveBeenCalled());

    confirmSpy.mockRestore();
    promptSpy.mockRestore();
    fetchSpy.mockRestore();
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

    render(<DeliveryMemberDashboard />);

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
