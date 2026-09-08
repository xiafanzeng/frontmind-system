import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
const state = vi.hoisted(() => ({ query: vi.fn(), refetch: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { admin: { aiUsage: { taskEvents: { useQuery: state.query } } } },
}));
import { AdminAiTaskUsageEvents } from "./AdminAiTaskUsageEvents";
const filter = {
  from: "2026-09-07",
  to: "2026-09-07",
  scope: "website_frontend" as const,
  owner: { kind: "unassigned" as const },
  state: "succeeded",
  page: 3,
};
beforeEach(() => {
  state.query.mockReset();
  state.refetch.mockReset();
  state.query.mockImplementation((input) => ({
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: state.refetch,
    data: {
      taskId: input.taskId,
      eventPage: input.eventPage,
      pageSize: 20,
      totalEvents: 21,
      events: [
        {
          id: `id-${input.eventPage}`,
          eventId: `event-${input.eventPage}`,
          sessionId: "session-a",
          occurredAt: Date.parse("2026-09-07T01:00:00Z"),
          recordedAt: null,
          model: "glm-5.3",
          effort: "high",
          inputTokens: "123456",
          outputTokens: "789",
          cacheReadInputTokens: "1000000",
          costCny: null,
          chargedCny: "0.000000",
          costState: "unknown",
          isError: true,
          syncIssue: "PROVIDER_USAGE_PENDING",
          pricingVersion: "v1",
        },
      ],
    },
  }));
});
describe("task usage event details", () => {
  it("pages events independently from task pages while preserving all report filters", () => {
    render(<AdminAiTaskUsageEvents filter={filter} taskId="task-a" />);
    expect(state.query.mock.lastCall?.[0]).toEqual({
      ...filter,
      taskId: "task-a",
      eventPage: 1,
    });
    expect(screen.getByText("123,456 / 789 / 1,000,000")).toBeInTheDocument();
    expect(screen.getByText("event-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页调用" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页调用" }));
    expect(state.query.mock.lastCall?.[0]).toEqual({
      ...filter,
      taskId: "task-a",
      eventPage: 2,
    });
    expect(screen.getByText("event-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页调用" })).toBeDisabled();
    expect(
      screen.getByText(/最近同步未完成：PROVIDER_USAGE_PENDING/),
    ).toBeInTheDocument();
    expect(screen.getByText(/unknown · 失败请求/)).toBeInTheDocument();
    expect(screen.getAllByText(/待核价/).length).toBeGreaterThan(0);
  });
  it("offers a retry when event loading fails", () => {
    state.query.mockReturnValue({
      isLoading: false,
      error: new Error("读取失败"),
      refetch: state.refetch,
    });
    render(<AdminAiTaskUsageEvents filter={filter} taskId="task-a" />);
    expect(screen.getByRole("alert")).toHaveTextContent("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试事件明细" }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
