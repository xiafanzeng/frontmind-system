import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({ detailData: null as any }));

afterEach(() => {
  routeMocks.detailData = null;
  window.history.replaceState({}, "", "/");
});

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/workspace", vi.fn()],
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      deliveryTickets: {
        list: {
          useInfiniteQuery: () => ({
            data: {
              pages: [{ tickets: [], quotas: {}, nextCursor: null }],
            },
            refetch: vi.fn(),
            fetchNextPage: vi.fn(),
            hasNextPage: false,
            isFetchingNextPage: false,
            isFetching: false,
            isLoading: false,
            error: null,
          }),
        },
        detail: {
          useQuery: () => ({
            data: routeMocks.detailData,
            refetch: vi.fn(),
            isLoading: false,
            error: null,
          }),
        },
        delete: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        adjustQuota: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        update: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        addMessage: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        recordDelivery: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

import AdminDeliveryTicketWorkspace, {
  permanentDeliveryTicketDeletionConfirmation,
  ticketTypeLabel,
} from "./AdminDeliveryTicketWorkspace";

const executionPreviewFixtures = {
  tickets: [
    {
      id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
      userId: 42,
      type: "website_operation" as const,
      category: "company_facts",
      title: "发布企业事实页面",
      status: "in_progress" as const,
      revision: 2,
      createdAt: "2026-07-30T22:43:00+08:00",
      updatedAt: "2026-07-30T22:43:00+08:00",
    },
  ],
  events: [],
  periodId: "2026-q3",
  revision: 1,
  contentAssetQuota: {
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 10,
  },
  websiteContentQuota: {
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 10,
  },
};

describe("AdminDeliveryTicketWorkspace streamlined UI", () => {
  it("labels problem-level work items by their operation instead of website operations", () => {
    expect(ticketTypeLabel("website_operation", "question_review")).toBe(
      "问题审核",
    );
    expect(ticketTypeLabel("website_operation", "question_modify")).toBe(
      "问题修改",
    );
    expect(ticketTypeLabel("website_operation", "question_delete")).toBe(
      "问题删除",
    );
  });

  it("normalizes legacy question-catalog titles without rewriting stored data", () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        preview
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: [
            {
              ...executionPreviewFixtures.tickets[0],
              operation: "question_catalog",
              category: "question_catalog",
              categoryLabel: "品牌词库与问题目录",
              title: "配置品牌词库与问题目录",
              topic: "品牌词库与问题目录",
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText("配置品牌词库").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("配置品牌词库与问题目录"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("品牌词库与问题目录")).not.toBeInTheDocument();
  });

  it("uses an explicit irreversible confirmation and exposes deletion only to system administrators", () => {
    expect(
      permanentDeliveryTicketDeletionConfirmation({
        title: "发布企业事实页面",
      }),
    ).toContain(
      "确认永久删除需求“发布企业事实页面”？关联附件、官网样例与需求处理记录也会永久删除",
    );
    expect(
      permanentDeliveryTicketDeletionConfirmation({
        operation: "website_build",
      }),
    ).toContain("确认永久删除需求“未命名需求”？");
    expect(
      permanentDeliveryTicketDeletionConfirmation({
        operation: "question_catalog",
      }),
    ).toContain("确认永久删除需求“配置品牌词库”？");

    const { rerender } = render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        preview
        previewFixtures={executionPreviewFixtures}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /永久删除需求/ }),
    ).not.toBeInTheDocument();

    rerender(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        canExecuteDelivery
        preview
        previewFixtures={executionPreviewFixtures}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: /永久删除需求/ }),
    ).toHaveLength(2);
  });

  it("shows only the ticket workspace without standalone website tools", () => {
    const openCustomerDashboard = vi.fn();
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        onOpenCustomerDashboard={openCustomerDashboard}
      />,
    );

    expect(screen.getByText("测试企业需求记录")).toBeInTheDocument();
    expect(screen.getAllByText("客户需求")).toHaveLength(2);
    expect(screen.queryByText("客户官网内容进度")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入客户看板" })).toHaveClass(
      "bg-blue-600",
      "text-white",
    );
    expect(
      screen.queryByText("批量更新官网内容（高级工具）"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("右侧会只读展示需求、资料与历史处理记录。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "右侧会展示需求、资料、公开交流、内部备注和处理动作。",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps quota summaries read-only even when quota adjustment permission is present", () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        servicePlanCode="luxury"
        serviceStatus="active"
        canAdjustQuota
        preview
        previewFixtures={executionPreviewFixtures}
      />,
    );

    expect(screen.getByText("当前服务周期发布额度")).toBeInTheDocument();
    expect(screen.getAllByText("0 / 10")).toHaveLength(2);
    expect(
      screen.getByText("提交时预留，需求完成后正式消耗；交付管理员仅可查看。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "调整额度" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存额度" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("内容资产发布上限")).not.toBeInTheDocument();
    expect(screen.queryByText("官网内容发布上限")).not.toBeInTheDocument();
  });

  it("marks every pending list item in red and preserves the selected state", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: [
            {
              ...executionPreviewFixtures.tickets[0],
              id: "3a67e445-37bb-45ed-9268-4ca9437e4d70",
              title: "新提交官网需求",
              status: "submitted" as const,
            },
            {
              ...executionPreviewFixtures.tickets[0],
              id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
              title: "处理中官网需求",
              status: "in_progress" as const,
            },
          ],
        }}
      />,
    );

    const submittedRow = screen
      .getAllByText("新提交官网需求")[0]
      ?.closest("article");
    const inProgressRow = screen
      .getAllByText("处理中官网需求")[0]
      ?.closest("article");

    expect(submittedRow).toHaveTextContent("新提交官网需求");
    expect(submittedRow).toHaveAttribute("data-pending-ticket", "true");
    expect(submittedRow).toHaveClass("is-pending-alert");
    await waitFor(() => expect(submittedRow).toHaveClass("is-selected"));
    expect(within(submittedRow as HTMLElement).getByText("已提交")).toHaveClass(
      "is-pending-alert",
    );
    expect(
      within(inProgressRow as HTMLElement).getByText("处理中"),
    ).toHaveClass("is-pending-alert");
    expect(inProgressRow).toHaveAttribute("data-pending-ticket", "true");
    expect(inProgressRow).toHaveClass("is-pending-alert");
  });

  it("keeps a knowledge reset ticket focused on the customer and reset result", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        previewFixtures={{
          tickets: [
            {
              id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
              userId: 42,
              type: "knowledge_base",
              category: "knowledge_reset",
              title: "知识库重置申请",
              status: "completed",
              publicSummary: "知识库已清空，可以重新开始首次构建。",
              revision: 2,
              createdAt: "2026-07-30T22:43:00+08:00",
              updatedAt: "2026-07-30T22:43:00+08:00",
            },
          ],
          events: [
            {
              id: "submitted",
              visibility: "customer",
              actorLabel: "用户",
              statusTo: "submitted",
              message: "客户提交知识库重置申请。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
            {
              id: "completed",
              visibility: "customer",
              actorLabel: "工程师",
              statusTo: "completed",
              message: "知识库重置已批准并完成清理。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
          ],
          periodId: "2026-q3",
          revision: 1,
          contentAssetQuota: {
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 0,
          },
          websiteContentQuota: {
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 0,
          },
        }}
      />,
    );

    expect(await screen.findByText("@test-user")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("客户未填写重置原因。")).toBeInTheDocument();
    expect(screen.getByText("处理记录")).toBeInTheDocument();
    expect(screen.getByText("重置处理结果")).toBeInTheDocument();
    expect(
      screen.getByText("知识库已清空，可以重新开始首次构建。"),
    ).toBeInTheDocument();

    expect(screen.queryByText("管理员内部记录")).not.toBeInTheDocument();
    expect(screen.queryByText("回复客户与回传成果")).not.toBeInTheDocument();
    expect(screen.queryByText("结构化交付记录")).not.toBeInTheDocument();
    expect(
      screen.queryByText("完成需求并发布内容总结"),
    ).not.toBeInTheDocument();
  });

  it("keeps a role-owned ticket read-only until its project assignment is synchronized", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: executionPreviewFixtures.tickets.map((ticket) => ({
            ...ticket,
            type: "content_asset" as const,
            workflowDomain: "content_distribution_engineer" as const,
            operation: "content_asset_publish" as const,
            assignedMemberId: 19,
            assignedMemberName: "AI 内容制作工程师",
          })),
        }}
      />,
    );

    expect(await screen.findByText(/项目岗位尚未同步/)).toBeInTheDocument();
    expect(
      screen.queryByText("完成需求并发布内容总结"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("保存交付记录")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: /进入系统管理员处理工作台/,
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps grouped filters while showing exact internal workflow states", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: [
            executionPreviewFixtures.tickets[0],
            {
              ...executionPreviewFixtures.tickets[0],
              id: "4a67e445-37bb-45ed-9268-4ca9437e4d72",
              title: "已关闭历史需求",
              status: "rejected" as const,
            },
          ],
          events: [
            {
              id: "scheduled",
              visibility: "internal" as const,
              actorLabel: "工程师",
              statusTo: "scheduled",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
            {
              id: "completed",
              visibility: "internal" as const,
              actorLabel: "工程师",
              statusTo: "rejected",
              createdAt: "2026-07-31T22:43:00+08:00",
            },
          ],
        }}
      />,
    );

    const statusFilter = screen.getByLabelText("筛选需求状态");
    expect(statusFilter).toContainHTML(
      '<option value="pending">待处理</option>',
    );
    expect(statusFilter).toContainHTML(
      '<option value="completed">已结束</option>',
    );
    expect(statusFilter.querySelectorAll("option")).toHaveLength(3);
    expect(await screen.findAllByText("处理中")).not.toHaveLength(0);
    expect(screen.getByText("未受理")).toBeInTheDocument();
    expect(screen.getByText("状态更新为已排期")).toBeInTheDocument();
    expect(screen.getByText("状态更新为未受理")).toBeInTheDocument();
    expect(screen.queryByText(/催办/)).not.toBeInTheDocument();
  });

  it("keeps a legacy no-workflow ticket read-only even for an authorized system administrator", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: executionPreviewFixtures.tickets.map((ticket) => ({
            ...ticket,
            type: "content_asset" as const,
            workflowDomain: null,
            assignedProjectAssignmentId: null,
          })),
          events: [
            {
              id: "customer-history",
              visibility: "customer" as const,
              actorLabel: "客户",
              message: "请按提交资料处理。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
            {
              id: "internal-history",
              visibility: "internal" as const,
              actorLabel: "系统管理员",
              message: "旧票等待同步项目岗位。",
              createdAt: "2026-07-31T10:00:00+08:00",
            },
          ],
        }}
      />,
    );

    expect(
      await screen.findByText(
        "旧版需求未关联项目岗位，本页只读；请先同步项目岗位后，再进入对应客户工作台处理。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("请按提交资料处理。")).toBeInTheDocument();
    expect(screen.getByText("旧票等待同步项目岗位。")).toBeInTheDocument();
    expect(screen.getByText("结构化交付记录")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发送客户可见回复" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存内部备注" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存交付记录" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "完成需求" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: /进入系统管理员处理工作台/,
      }),
    ).not.toBeInTheDocument();
  });

  it("never exposes the legacy knowledge-base ZIP upload fallback", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: executionPreviewFixtures.tickets.map((ticket) => ({
            ...ticket,
            type: "knowledge_base" as const,
            category: "knowledge_base_maintenance",
            title: "更新品牌知识库",
            workflowDomain: null,
            assignedProjectAssignmentId: null,
          })),
          events: [
            {
              id: "knowledge-history",
              visibility: "customer" as const,
              actorLabel: "客户",
              message: "客户提交知识库更新申请。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText("处理记录")).toBeInTheDocument();
    expect(screen.getByText("客户提交知识库更新申请。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "上传知识库 ZIP" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("上传并发布通过校验的新知识库 ZIP"),
    ).not.toBeInTheDocument();
  });

  it("sends a system administrator to the full workbench for a role-owned ticket", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: executionPreviewFixtures.tickets.map((ticket) => ({
            ...ticket,
            type: "content_asset" as const,
            workflowDomain: "content_distribution_engineer" as const,
            operation: "content_asset_publish" as const,
            assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
            assignedMemberId: 19,
            assignedMemberName: "AI 内容制作工程师",
          })),
        }}
      />,
    );

    expect(await screen.findByText(/使用完整岗位处理流程/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: /进入系统管理员处理工作台/,
      }),
    ).toHaveAttribute(
      "href",
      "/admin/delivery-workbench?projectAssignmentId=1e9f33bc-40e2-4a8e-9bda-40d92a94b11f&section=content&ticketId=4a67e445-37bb-45ed-9268-4ca9437e4d71&focus=1",
    );
    expect(
      screen.queryByText("完成需求并发布内容总结"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("保存交付记录")).not.toBeInTheDocument();
    expect(screen.queryByText(/当前为交付协调模式/)).not.toBeInTheDocument();
  });

  it("opens a ticketId deep link even when the ticket is outside the loaded list", async () => {
    const ticketId = "4a67e445-37bb-45ed-9268-4ca9437e4d79";
    routeMocks.detailData = {
      ticket: {
        id: ticketId,
        userId: 42,
        type: "website_operation",
        category: "company_facts",
        title: "列表外的企业事实需求",
        status: "submitted",
        revision: 1,
        createdAt: "2026-08-08T12:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      },
      events: [],
    };
    window.history.replaceState(
      {},
      "",
      `/admin/customers/42/workspace?ticketId=${ticketId}`,
    );

    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "列表外的企业事实需求" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("请选择一张需求")).not.toBeInTheDocument();
  });

  it("shows administrators the complete internal workflow without leaking raw enums", async () => {
    const rootId = "4a67e445-37bb-45ed-9268-4ca9437e4d70";
    const currentId = "4a67e445-37bb-45ed-9268-4ca9437e4d71";
    const distributionId = "4a67e445-37bb-45ed-9268-4ca9437e4d72";
    routeMocks.detailData = {
      ticket: {
        id: currentId,
        parentTicketId: rootId,
        rootTicketId: rootId,
        isWorkflowContainer: false,
        userId: 42,
        type: "content_asset",
        category: "content_asset_publish",
        operation: "content_asset_publish",
        workflowDomain: "content_distribution_engineer",
        title: "制作客户内容资产",
        status: "in_progress",
        revision: 2,
        createdAt: "2026-08-08T12:00:00.000Z",
        updatedAt: "2026-08-08T13:00:00.000Z",
      },
      events: [],
      workflowRelations: {
        root: {
          id: rootId,
          parentTicketId: null,
          rootTicketId: null,
          operation: null,
          status: "in_progress",
          workflowDomain: null,
          assignedMemberId: null,
          assignedMemberName: null,
        },
        children: [
          {
            id: currentId,
            parentTicketId: rootId,
            rootTicketId: rootId,
            operation: "content_asset_publish",
            status: "in_progress",
            workflowDomain: "content_distribution_engineer",
            assignedMemberId: 19,
            assignedMemberName: "内容工程师甲",
          },
          {
            id: distributionId,
            parentTicketId: currentId,
            rootTicketId: rootId,
            operation: "channel_distribution",
            status: "submitted",
            workflowDomain: "content_distribution_engineer",
            assignedMemberId: 19,
            assignedMemberName: "内容工程师甲",
          },
        ],
      },
    };
    window.history.replaceState(
      {},
      "",
      `/admin/customers/42/workspace?ticketId=${currentId}`,
    );

    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
      />,
    );

    expect(await screen.findByText("内部工单链路")).toBeInTheDocument();
    expect(screen.getByText("客户原始需求")).toBeInTheDocument();
    expect(screen.getByText("第 1 步 · 内容资产发布")).toBeInTheDocument();
    expect(screen.getByText("第 2 步 · 渠道分发")).toBeInTheDocument();
    expect(screen.getAllByText(/AI 内容制作工程师/)).not.toHaveLength(0);
    expect(screen.queryByText("in_progress")).not.toBeInTheDocument();
    expect(screen.queryByText("submitted")).not.toBeInTheDocument();
    expect(
      screen.queryByText("content_distribution_engineer"),
    ).not.toBeInTheDocument();
  });
});
