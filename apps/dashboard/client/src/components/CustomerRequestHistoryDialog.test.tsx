import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  listUseInfiniteQuery,
  detailUseQuery,
  addMessageUseMutation,
  addMessageMutateAsync,
  listRefetch,
  detailRefetch,
} = vi.hoisted(() => ({
  listUseInfiniteQuery: vi.fn(),
  detailUseQuery: vi.fn(),
  addMessageUseMutation: vi.fn(),
  addMessageMutateAsync: vi.fn().mockResolvedValue(undefined),
  listRefetch: vi.fn().mockResolvedValue(undefined),
  detailRefetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      deliveryTickets: {
        list: { useInfiniteQuery: listUseInfiniteQuery },
        detail: { useQuery: detailUseQuery },
        addMessage: { useMutation: addMessageUseMutation },
      },
    },
  },
}));

import CustomerRequestHistoryDialog, {
  requestHistoryTicketCanReply,
} from "./CustomerRequestHistoryDialog";

describe("CustomerRequestHistoryDialog", () => {
  it("shows the customer two-state history and opens the existing detail boundary", () => {
    const onOpenChange = vi.fn();
    const onOpenTicket = vi.fn();
    const onRefresh = vi.fn();
    const onLoadMore = vi.fn();
    render(
      <CustomerRequestHistoryDialog
        open
        onOpenChange={onOpenChange}
        title="问题需求记录"
        description="问题审核、修改与删除统一显示。"
        tickets={[
          {
            id: "pending-ticket",
            type: "knowledge_base",
            categoryLabel: "问题审核",
            topic: "品牌是否可靠？",
            publicStatus: "pending",
          },
          {
            id: "completed-ticket",
            type: "knowledge_base",
            categoryLabel: "问题删除",
            topic: "删除过期问题",
            publicStatus: "completed",
            publicSummary: "未通过：该问题仍在本期服务中。",
          },
        ]}
        hasMore
        onRefresh={onRefresh}
        onLoadMore={onLoadMore}
        onOpenTicket={onOpenTicket}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "问题需求记录" });
    expect(dialog).toHaveTextContent("品牌是否可靠？");
    expect(dialog).toHaveTextContent("待处理");
    expect(dialog).toHaveTextContent("已完成");
    expect(dialog).toHaveTextContent("未通过：该问题仍在本期服务中。");

    fireEvent.click(screen.getByRole("button", { name: /品牌是否可靠/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenTicket).toHaveBeenCalledWith("pending-ticket");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("polls an open detail and accepts supplements only for server-replyable website/content tickets", async () => {
    listUseInfiniteQuery.mockReturnValue({
      data: {
        pages: [
          {
            tickets: [
              {
                id: "website-ticket",
                type: "website_operation",
                categoryLabel: "企业事实内容",
                topic: "补充企业事实",
                publicStatus: "pending",
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      isError: false,
      error: null,
      refetch: listRefetch,
      fetchNextPage: vi.fn(),
    });
    detailUseQuery.mockReturnValue({
      data: {
        ticket: {
          id: "website-ticket",
          type: "website_operation",
          categoryLabel: "企业事实内容",
          topic: "补充企业事实",
          publicStatus: "pending",
          revision: 2,
          canReply: true,
          canAttach: false,
        },
        events: [],
        attachments: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: detailRefetch,
    });
    addMessageUseMutation.mockReturnValue({
      mutateAsync: addMessageMutateAsync,
      isPending: false,
    });

    render(
      <CustomerRequestHistoryDialog
        open
        onOpenChange={vi.fn()}
        title="官网需求记录"
        description="全部官网需求"
        type="website_operation"
        surface="website_management"
      />,
    );

    fireEvent.click(screen.getByText("补充企业事实").closest("button")!);
    expect(screen.getByLabelText("补充说明")).toBeInTheDocument();
    expect(
      detailUseQuery.mock.calls.some(
        ([, options]) => options.refetchInterval === 30_000,
      ),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("补充说明"), {
      target: { value: "补充新的企业资质说明。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交补充资料" }));
    await waitFor(() =>
      expect(addMessageMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: "website-ticket",
          message: "补充新的企业资质说明。",
          attachments: [],
        }),
      ),
    );
    await waitFor(() => expect(listRefetch).toHaveBeenCalled());
    expect(detailRefetch).toHaveBeenCalled();

    expect(
      requestHistoryTicketCanReply({
        surface: "knowledge_management",
        ticket: {
          type: "website_operation",
          canReply: true,
        },
      }),
    ).toBe(false);
    expect(
      requestHistoryTicketCanReply({
        surface: "response_logic_management",
        ticket: { type: "knowledge_base", canReply: true },
      }),
    ).toBe(false);
  });
});
