import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminDeliveryDispatch from "./AdminDeliveryDispatch";

const refetch = vi.fn();

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 7,
      role: "admin",
      adminAccessLevel: "delivery_admin",
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/delivery-dispatch", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/pages/AdminDashboard", () => ({
  getAdminNav: () => [],
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
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
                  id: "2b4ebabb-d47d-44c7-9499-46b145cd9983",
                  userId: 9,
                  type: "knowledge_base",
                  title: "知识库复核",
                  status: "in_progress",
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
    refetch.mockReset();
  });

  it("renders all historical records through only two public states", () => {
    render(<AdminDeliveryDispatch />);

    expect(screen.getByRole("heading", { name: "工单" })).toBeInTheDocument();
    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByText("知识库复核")).toBeInTheDocument();
    expect(screen.getByText("历史未受理内容")).toBeInTheDocument();
    expect(screen.queryByText("未受理")).not.toBeInTheDocument();
  });

  it("has customer and role filters but no administrator dispatch controls", () => {
    render(<AdminDeliveryDispatch />);

    expect(screen.getByLabelText("筛选客户")).toBeInTheDocument();
    expect(screen.getByLabelText("筛选执行岗位")).toBeInTheDocument();
    expect(screen.queryByLabelText("工单优先级")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存优先级" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "催办" }),
    ).not.toBeInTheDocument();
  });

  it("renders empty-message events with public two-state wording", () => {
    render(<AdminDeliveryDispatch />);

    fireEvent.click(screen.getByRole("button", { name: "处理记录（1）" }));
    expect(screen.getByText("工单状态更新为待处理。")).toBeInTheDocument();
    expect(screen.queryByText(/in_progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/submitted/)).not.toBeInTheDocument();
  });
});
