import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
const state = vi.hoisted(() => ({
  query: vi.fn(),
  export: vi.fn(),
  refetch: vi.fn(),
  taskEvents: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      admin: { aiUsage: { export: { fetch: state.export } } },
    }),
    admin: {
      aiUsage: {
        report: { useQuery: state.query },
        taskEvents: { useQuery: state.taskEvents },
      },
    },
  },
}));
import { AdminAiUsageReport } from "./AdminAiUsageReport";

beforeEach(() => {
  state.query.mockReset();
  state.export.mockReset();
  state.refetch.mockReset();
  state.taskEvents.mockReset();
  state.taskEvents.mockReturnValue({
    data: {
      taskId: "task-a",
      eventPage: 1,
      pageSize: 20,
      totalEvents: 0,
      events: [],
    },
    isLoading: false,
    isFetching: false,
    error: null,
  });
  state.query.mockImplementation((input) => ({
    data: {
      page: input.page,
      pageSize: 20,
      keys: [
        {
          fingerprint: "fp_1234567890123456",
          providerKeyId: "abcd...1234",
          versions: ["官网 v9"],
        },
      ],
      models: ["glm-5.3"],
      owners: ["负责人甲", "负责人乙"],
      states: ["failed", "running", "succeeded"],
      summary: {
        costCny: "1.365596",
        costStatus: "partial",
        chargedCny: "0.000000",
        observedTasks: 21,
        observedEvents: 32,
        unknownEvents: 0,
        inputTokens: "49010",
        outputTokens: "5173",
        cacheReadInputTokens: "414336",
        lastRecordedAt: null,
      },
      tasks: [
        {
          id: "task-a",
          sessionId: "sess-a",
          scope: "website_frontend",
          title: "测试报告",
          businessOwnerName: "负责人甲",
          model: "glm-5.3",
          effort: "high",
          fingerprint: "fp_1234567890123456",
          credentialVersion: 9,
          costCny: "1.365596",
          costStatus: "partial",
          chargedCny: "0.000000",
          inputTokens: "49010",
          outputTokens: "5173",
          cacheReadInputTokens: "414336",
          observedEvents: 32,
          lastEventAt: null,
          pricingVersions: "v1",
          state: "succeeded",
          syncIssue: null,
        },
      ],
    },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: state.refetch,
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Admin AI usage report", () => {
  it("restores Website task owners and shows native counters with separate platform and wallet costs", () => {
    render(<AdminAiUsageReport initialScope="website_frontend" />);
    expect(screen.getByText("测试报告")).toBeInTheDocument();
    expect(screen.getByText(/负责人：负责人甲/)).toBeInTheDocument();
    expect(screen.getAllByText("¥1.365596（部分）")).toHaveLength(2);
    expect(screen.getByText("输入 49,010")).toBeInTheDocument();
    expect(state.taskEvents).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "查看 测试报告 用量明细" }),
    );
    expect(state.taskEvents.mock.lastCall?.[0]).toMatchObject({
      taskId: "task-a",
      eventPage: 1,
    });
    expect(screen.getByText(/Session：sess-a/)).toBeInTheDocument();
    expect(screen.getByLabelText("用量来源")).toHaveValue("website_frontend");
  });
  it("resets server pagination when changing scope and disables requests for invalid dates", () => {
    render(<AdminAiUsageReport />);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(state.query.mock.lastCall?.[0].page).toBe(2);
    fireEvent.change(screen.getByLabelText("用量来源"), {
      target: { value: "website_frontend" },
    });
    expect(state.query.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      scope: "website_frontend",
    });
    fireEvent.change(screen.getByLabelText("用量开始日期"), {
      target: { value: "" },
    });
    expect(state.query.mock.lastCall?.[1].enabled).toBe(false);
    expect(screen.getByText(/请选择有效日期范围/)).toBeInTheDocument();
  });
  it.each([
    { value: "unassigned", owner: { kind: "unassigned" } },
    { value: "name:负责人甲", owner: { kind: "name", value: "负责人甲" } },
  ])(
    "resets pagination for owner filter $value and preserves other owner choices",
    ({ value, owner }) => {
      render(<AdminAiUsageReport initialScope="website_frontend" />);
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      expect(state.query.mock.lastCall?.[0].page).toBe(2);
      fireEvent.change(screen.getByLabelText("用量负责人"), {
        target: { value },
      });
      expect(state.query.mock.lastCall?.[0]).toMatchObject({
        page: 1,
        scope: "website_frontend",
        owner,
      });
      expect(screen.getByLabelText("用量负责人")).toHaveValue(value);
      expect(
        within(screen.getByLabelText("用量负责人")).getByRole("option", {
          name: "负责人乙",
        }),
      ).toHaveValue("name:负责人乙");

      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      fireEvent.change(screen.getByLabelText("用量负责人"), {
        target: { value: "" },
      });
      expect(state.query.mock.lastCall?.[0].page).toBe(1);
      expect(state.query.mock.lastCall?.[0].owner).toBeUndefined();
    },
  );
  it("resets pagination for raw provider-state filters without clearing the owner", () => {
    render(<AdminAiUsageReport />);
    fireEvent.change(screen.getByLabelText("用量负责人"), {
      target: { value: "name:负责人甲" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    fireEvent.change(screen.getByLabelText("用量任务状态"), {
      target: { value: "failed" },
    });
    expect(state.query.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      owner: { kind: "name", value: "负责人甲" },
      state: "failed",
    });
    expect(screen.getByLabelText("用量任务状态")).toHaveValue("failed");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    fireEvent.change(screen.getByLabelText("用量任务状态"), {
      target: { value: "" },
    });
    expect(state.query.mock.lastCall?.[0].page).toBe(1);
    expect(state.query.mock.lastCall?.[0].state).toBeUndefined();
    expect(state.query.mock.lastCall?.[0].owner).toEqual({
      kind: "name",
      value: "负责人甲",
    });
  });
  it("exports the same active owner and state filters used by the report", async () => {
    const createObjectURL = vi.fn(() => "blob:ai-usage-report");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    state.export.mockResolvedValue({
      filename: "usage.csv",
      csv: "任务状态\r\nfailed",
    });
    render(<AdminAiUsageReport initialScope="website_frontend" />);
    fireEvent.change(screen.getByLabelText("用量负责人"), {
      target: { value: "unassigned" },
    });
    fireEvent.change(screen.getByLabelText("用量任务状态"), {
      target: { value: "failed" },
    });
    const activeFilter = state.query.mock.lastCall?.[0];
    fireEvent.click(screen.getByRole("button", { name: "导出事件 CSV" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(state.export).toHaveBeenCalledOnce();
    expect(state.export).toHaveBeenCalledWith(activeFilter);
    expect(activeFilter).toMatchObject({
      owner: { kind: "unassigned" },
      state: "failed",
      page: 1,
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ai-usage-report");
  });
  it("loads and pages task events only when opened, independently of the task list", () => {
    state.taskEvents.mockImplementation((input) => ({
      data: {
        taskId: input.taskId,
        eventPage: input.eventPage,
        pageSize: 20,
        totalEvents: 21,
        events: [
          {
            id: `event-row-${input.eventPage}`,
            eventId: `provider-event-${input.eventPage}`,
            occurredAt: Date.parse("2026-09-07T01:00:00Z"),
            recordedAt: Date.parse("2026-09-07T01:00:01Z"),
            model: "glm-5.3",
            effort: "high",
            inputTokens: "1234",
            outputTokens: "56",
            cacheReadInputTokens: "7890",
            costCny: "0.027220",
            chargedCny: "0.000000",
            costState: "observed",
            isError: false,
            syncIssue: null,
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    }));
    render(<AdminAiUsageReport initialScope="website_frontend" />);
    fireEvent.change(screen.getByLabelText("用量负责人"), {
      target: { value: "unassigned" },
    });
    fireEvent.change(screen.getByLabelText("用量任务状态"), {
      target: { value: "failed" },
    });
    expect(state.taskEvents).not.toHaveBeenCalled();
    const expand = screen.getByRole("button", {
      name: "查看 测试报告 用量明细",
    });
    fireEvent.click(expand);
    expect(state.taskEvents.mock.lastCall?.[0]).toMatchObject({
      ...state.query.mock.lastCall?.[0],
      taskId: "task-a",
      eventPage: 1,
    });
    expect(screen.getByText("provider-event-1")).toBeInTheDocument();
    expect(screen.getByText("1,234 / 56 / 7,890")).toBeInTheDocument();
    expect(screen.getByText("¥0.027220")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页调用" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页调用" }));
    expect(state.taskEvents.mock.lastCall?.[0]).toMatchObject({
      taskId: "task-a",
      eventPage: 2,
      page: 1,
      owner: { kind: "unassigned" },
      state: "failed",
    });
    expect(state.query.mock.lastCall?.[0].page).toBe(1);
    expect(screen.getByText("provider-event-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页调用" })).toBeDisabled();
    fireEvent.click(expand);
    expect(
      screen.queryByRole("region", { name: "任务各轮调用" }),
    ).not.toBeInTheDocument();
    fireEvent.click(expand);
    expect(state.taskEvents.mock.lastCall?.[0].eventPage).toBe(1);
  });
});
