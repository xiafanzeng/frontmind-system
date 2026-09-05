import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminDeliveryDispatch from "./AdminDeliveryDispatch";

const refetch = vi.fn();
const { authState, deleteTicketMock, setLocationMock } = vi.hoisted(() => ({
  authState: { adminAccessLevel: "delivery_admin" },
  deleteTicketMock: vi.fn(),
  setLocationMock: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 7,
      role: "admin",
      adminAccessLevel: authState.adminAccessLevel,
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/delivery-dispatch", setLocationMock],
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/pages/AdminDashboard", () => ({
  getAdminNav: () => [],
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      deliveryTickets: {
        delete: {
          useMutation: () => ({
            mutateAsync: deleteTicketMock,
            isPending: false,
            variables: undefined,
          }),
        },
      },
    },
    delivery: {
      management: {
        overview: {
          useQuery: () => ({
            data: {
              projects: [
                {
                  id: 9,
                  username: "customer-9",
                  displayName: "特力智行",
                  managerId: 7,
                  managerDisplayName: "交付管理员",
                },
              ],
              assignments: [
                {
                  id: "assignment-9",
                  customerUserId: 9,
                  roleType: "ai_operations_engineer",
                  engineerUserId: 19,
                  engineerUsername: "engineer-19",
                  engineerDisplayName: "AI 运维工程师",
                },
              ],
              engineers: [
                {
                  id: 19,
                  username: "engineer-19",
                  displayName: "AI 运维工程师",
                },
              ],
              tickets: [
                {
                  id: "1c4ebabb-d47d-44c7-9499-46b145cd9982",
                  userId: 9,
                  type: "website_operation",
                  title: "新提交官网需求",
                  operation: "question_review",
                  status: "submitted",
                  revision: 1,
                  workflowDomain: "monitoring_optimization_engineer",
                  assignedProjectAssignmentId: null,
                  assignedMemberId: null,
                },
                {
                  id: "2b4ebabb-d47d-44c7-9499-46b145cd9983",
                  userId: 9,
                  type: "knowledge_base",
                  title: "知识库复核",
                  status: "in_progress",
                  revision: 2,
                  workflowDomain: "ai_operations_engineer",
                  assignedProjectAssignmentId: "assignment-9",
                  assignedMemberId: 19,
                },
              ],
              completedTickets: [],
              terminalTickets: [
                {
                  id: "2f8b630a-bfeb-460b-baba-68d092da26b0",
                  userId: 9,
                  type: "content_asset",
                  title: "历史未受理内容",
                  status: "rejected",
                  revision: 3,
                  workflowDomain: "content_distribution_engineer",
                  assignedProjectAssignmentId: "assignment-8",
                  assignedMemberId: 18,
                },
              ],
              ticketEvents: [
                {
                  id: "event-1",
                  ticketId: "2b4ebabb-d47d-44c7-9499-46b145cd9983",
                  actorRole: "admin",
                  message: null,
                  fromStatus: "submitted",
                  toStatus: "in_progress",
                  createdAt: "2026-08-02T00:00:00.000Z",
                },
              ],
            },
            isLoading: false,
            isFetching: false,
            error: null,
            refetch,
          }),
        },
      },
    },
  },
}));

describe("AdminDeliveryDispatch", () => {
  beforeEach(() => {
    authState.adminAccessLevel = "delivery_admin";
    deleteTicketMock.mockReset();
    deleteTicketMock.mockResolvedValue({ success: true });
    refetch.mockReset();
    setLocationMock.mockReset();
  });

  it("renders exact Chinese internal states for every ticket", () => {
    render(<AdminDeliveryDispatch />);

    expect(screen.getByRole("heading", { name: "需求" })).toBeInTheDocument();
    expect(screen.getByTestId("pending-ticket-summary")).toHaveClass(
      "border-red-500",
      "bg-red-50/80",
    );
    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已结束").length).toBeGreaterThan(0);
    expect(screen.getByText("知识库复核")).toBeInTheDocument();
    expect(screen.getByText("历史未受理内容")).toBeInTheDocument();
    expect(screen.getByText("已提交")).toBeInTheDocument();
    expect(screen.getByText("处理中")).toBeInTheDocument();
    expect(screen.getByText("未受理")).toBeInTheDocument();
  });

  it("highlights every pending ticket while retaining assignment warnings", () => {
    render(<AdminDeliveryDispatch />);

    const submittedRow = screen
      .getByText("新提交官网需求")
      .closest("div.rounded-xl");
    const inProgressRow = screen
      .getByText("知识库复核")
      .closest("div.rounded-xl");

    expect(submittedRow).toHaveAttribute("data-pending-ticket", "true");
    expect(submittedRow).toHaveClass("border-red-500", "bg-red-50/80");
    expect(within(submittedRow as HTMLElement).getByText("已提交")).toHaveClass(
      "bg-destructive",
    );
    expect(
      within(submittedRow as HTMLElement).getByText("岗位归属同步异常"),
    ).toBeInTheDocument();
    expect(
      within(submittedRow as HTMLElement).getByText("问题审核", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(submittedRow as HTMLElement).queryByText("官网运营", {
        exact: false,
      }),
    ).not.toBeInTheDocument();
    expect(inProgressRow).toHaveAttribute("data-pending-ticket", "true");
    expect(inProgressRow).toHaveClass("border-red-500", "bg-red-50/80");
  });

  it("has customer and role filters but no administrator dispatch controls", () => {
    render(<AdminDeliveryDispatch />);

    expect(screen.getByLabelText("筛选客户")).toBeInTheDocument();
    expect(screen.getByLabelText("筛选执行岗位")).toBeInTheDocument();
    expect(screen.queryByLabelText("需求优先级")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存优先级" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "催办" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "永久删除需求" }),
    ).not.toBeInTheDocument();
  });

  it("opens active and completed demands in the canonical customer workspace", () => {
    render(<AdminDeliveryDispatch />);

    const detailButtons = screen.getAllByRole("button", {
      name: "查看需求详情",
    });

    fireEvent.click(detailButtons[0]);
    expect(setLocationMock).toHaveBeenLastCalledWith(
      "/admin/customers/9/workspace?ticketId=1c4ebabb-d47d-44c7-9499-46b145cd9982",
    );

    fireEvent.click(detailButtons[detailButtons.length - 1]);
    expect(setLocationMock).toHaveBeenLastCalledWith(
      "/admin/customers/9/workspace?ticketId=2f8b630a-bfeb-460b-baba-68d092da26b0",
    );
  });

  it("lets only a system administrator permanently delete pending or completed demands", async () => {
    authState.adminAccessLevel = "system_admin";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminDeliveryDispatch />);

    const deleteButtons = screen.getAllByRole("button", {
      name: "永久删除需求",
    });
    expect(deleteButtons).toHaveLength(3);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() =>
      expect(deleteTicketMock).toHaveBeenCalledWith({
        userId: 9,
        ticketId: "1c4ebabb-d47d-44c7-9499-46b145cd9982",
        expectedRevision: 1,
        confirmation: "DELETE_TICKET",
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/关联附件、官网样例与需求处理记录也会永久删除/),
    );
    expect(refetch).toHaveBeenCalled();
  });

  it("renders empty-message events with exact Chinese transitions", () => {
    render(<AdminDeliveryDispatch />);

    fireEvent.click(screen.getByRole("button", { name: "处理记录（1）" }));
    expect(screen.getByText("已提交 → 处理中")).toBeInTheDocument();
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.queryByText(/^admin$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in_progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/submitted/)).not.toBeInTheDocument();
  });
});
