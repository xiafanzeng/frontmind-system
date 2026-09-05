import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  summaryQuery: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      monitoring: {
        citationSummary: {
          useQuery: (...args: unknown[]) => mocks.summaryQuery(...args),
        },
      },
    },
  },
}));

import ManagedCitationWorkbench from "./ManagedCitationWorkbench";

const summaryData = {
  batchKey: "tenant-latest",
  totalCitations: 68,
  channels: [
    {
      name: "百度",
      domain: "baidu.com",
      citationCount: 18,
      share: 0.2647,
    },
    {
      name: "企业官网",
      domain: "example.com",
      citationCount: 9,
      share: 0.1324,
    },
  ],
  contents: [
    {
      title: "验收企业方案中心",
      url: "https://example.com/products",
      channelName: "企业官网",
      domain: "example.com",
      citationCount: 9,
      share: 0.1324,
    },
  ],
};

describe("ManagedCitationWorkbench", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summaryQuery.mockReturnValue({
      data: summaryData,
      isLoading: false,
      isFetching: false,
      error: null,
    });
  });

  it("renders parent-scoped question summaries from the server", () => {
    render(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId="question-1"
        scopeLabel="2026年7月27日"
      />,
    );

    expect(mocks.summaryQuery).toHaveBeenCalledWith(
      { batchKey: "tenant-latest", questionId: "question-1" },
      expect.objectContaining({ enabled: true }),
    );
    expect(
      screen.getByRole("heading", { name: "引用分析" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "渠道引用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "内容引用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", {
        name: "当前问题的渠道引用汇总",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", {
        name: "当前问题的内容引用汇总",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2026年7月27日/)).toBeInTheDocument();
    expect(screen.getByText("26.47%")).toBeInTheDocument();
    expect(screen.getAllByText("13.24%")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    expect(
      screen.getByRole("link", { name: "验收企业方案中心" }),
    ).toHaveAttribute("href", "https://example.com/products");
    expect(screen.queryByText("监控问题")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 模型")).not.toBeInTheDocument();
    expect(screen.queryByText("引用总数")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导出" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the summary scoped to platform, question and date range without total or export actions", () => {
    render(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId="question-1"
        model="deepseek"
        from="2026-07-24"
        to="2026-07-27"
        scopeLabel="2026年7月27日"
      />,
    );

    expect(mocks.summaryQuery).toHaveBeenCalledWith(
      {
        batchKey: "tenant-latest",
        questionId: "question-1",
        model: "deepseek",
        from: "2026-07-24",
        to: "2026-07-27",
      },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText(/日期区间内全部回答/)).toBeInTheDocument();
    expect(screen.queryByText("引用总数")).not.toBeInTheDocument();
    expect(screen.queryByText("68")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导出" }),
    ).not.toBeInTheDocument();
  });

  it("queries across batches when only a question is selected", () => {
    mocks.summaryQuery.mockReturnValue({
      data: {
        batchKey: null,
        totalCitations: 0,
        channels: [],
        contents: [],
      },
      isLoading: false,
      error: null,
    });
    render(
      <ManagedCitationWorkbench batchKey="" selectedQuestionId="question-1" />,
    );

    expect(
      screen.getByText("当前问题在所选监控日期中暂无渠道引用。"),
    ).toBeInTheDocument();
    expect(mocks.summaryQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        batchKey: undefined,
        questionId: "question-1",
      }),
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.queryByText(/香港中文大学/)).not.toBeInTheDocument();
  });

  it("shows independent loading, error and empty summary states", () => {
    mocks.summaryQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
    });
    const { rerender } = render(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId="question-1"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在汇总引用分析");

    mocks.summaryQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("network"),
    });
    rerender(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId="question-1"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("引用分析暂时无法读取");

    mocks.summaryQuery.mockReturnValueOnce({
      data: {
        batchKey: "tenant-latest",
        totalCitations: 0,
        channels: [],
        contents: [],
      },
      isLoading: false,
      error: null,
    });
    rerender(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId="question-1"
      />,
    );
    expect(
      screen.getByText("当前问题在所选监控日期中暂无渠道引用。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("当前问题在所选监控日期中暂无内容引用。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导出" }),
    ).not.toBeInTheDocument();
  });

  it("does not query a summary until the parent has selected a question", () => {
    render(
      <ManagedCitationWorkbench
        batchKey="tenant-latest"
        selectedQuestionId=""
      />,
    );

    expect(screen.getByText("请选择监控问题")).toBeInTheDocument();
    expect(mocks.summaryQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        batchKey: "tenant-latest",
        questionId: "",
      }),
      expect.objectContaining({ enabled: false }),
    );
  });
});
