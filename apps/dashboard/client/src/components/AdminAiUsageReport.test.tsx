import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
const state = vi.hoisted(() => ({
  query: vi.fn(),
  export: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      admin: { aiUsage: { export: { fetch: state.export } } },
    }),
    admin: { aiUsage: { report: { useQuery: state.query } } },
  },
}));
import { AdminAiUsageReport } from "./AdminAiUsageReport";

beforeEach(() => {
  state.query.mockReset();
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
describe("Admin AI usage report", () => {
  it("restores Website task owners and shows native counters with separate platform and wallet costs", () => {
    render(<AdminAiUsageReport initialScope="website_frontend" />);
    expect(screen.getByText("测试报告")).toBeInTheDocument();
    expect(screen.getByText(/负责人：负责人甲/)).toBeInTheDocument();
    expect(screen.getAllByText("¥1.365596（部分）")).toHaveLength(2);
    expect(screen.getByText("输入 49,010")).toBeInTheDocument();
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
});
