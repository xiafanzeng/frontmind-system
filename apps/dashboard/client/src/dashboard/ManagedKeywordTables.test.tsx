import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ManagedKeywordTables, {
  BrandQuestionUniverseGenerationAction,
} from "./ManagedKeywordTables";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        brandQuestionUniverse: {
          observe: { invalidate: async () => undefined },
        },
        dashboard: { invalidate: async () => undefined },
      },
    }),
    workspace: {
      brandQuestionUniverse: {
        observe: {
          useQuery: () => ({
            data: {
              canStart: true,
              knowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
              dashboardRevision: 3,
              reason: "ready",
              operation: null,
            },
            error: null,
          }),
        },
        start: {
          useMutation: () => ({
            mutate: () => undefined,
            isPending: false,
            error: null,
          }),
        },
      },
    },
  },
}));

const tables = [
  {
    id: "question-list-1",
    title: "问题列表",
    columns: [
      "序号",
      "问题",
      "核心词",
      "核心词分类",
      "热度",
      "创建日期",
      "问题细分",
    ],
    rows: [
      ["1", "品牌问题", "品牌", "品牌核心词", "10", "2026-07-27", "品牌认知"],
      ["2", "场景问题", "场景", "场景痛点词", "20", "2026-07-27", "场景方案"],
      ["3", "行业问题", "行业", "品类行业词", "30", "2026-07-27", "品类发现"],
      ["4", "竞品问题", "竞品", "竞品对比词", "40", "2026-07-27", "竞品对比"],
    ],
  },
];

describe("ManagedKeywordTables", () => {
  it("renders the exact generation action and respects its eligibility fence", () => {
    const onStart = vi.fn();
    const { rerender } = render(
      <BrandQuestionUniverseGenerationAction
        disabled
        status="请先完成并发布当前认证知识库。"
        onStart={onStart}
      />,
    );
    const button = screen.getByRole("button", { name: "抓取品牌全域词库" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "请先完成并发布当前认证知识库。",
    );
    fireEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();

    rerender(
      <BrandQuestionUniverseGenerationAction
        disabled={false}
        status="已就绪，可基于当前知识库抓取品牌全域词库。"
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "抓取品牌全域词库" }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("renders the customer word bank without internal delivery copy or hidden source columns", () => {
    render(<ManagedKeywordTables tables={tables} />);

    expect(
      screen.getByText(
        "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "全域词库" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/AI 监控与优化工程师|正式词表|交付工单/),
    ).not.toBeInTheDocument();

    const categoryFilter = screen.getByLabelText("主分类");
    expect(
      within(categoryFilter).getByRole("option", { name: "全部主分类" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).getByRole("option", { name: "行业排名词" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).queryByRole("option", { name: "行业词" }),
    ).not.toBeInTheDocument();
    const keywordTable = screen.getByRole("table");
    expect(
      within(keywordTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["问题", "主分类", "问题细分"]);
    expect(screen.queryByLabelText("排序")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/热度从高到低|热度从低到高/),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "序号" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "核心词" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "创建日期" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByText("2026-07-27"),
    ).not.toBeInTheDocument();
    expect(within(keywordTable).getByText("美誉舆情词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("产品场景词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("行业排名词")).toBeInTheDocument();
  });

  it("filters rows using the mapped category rather than the source wording", () => {
    render(<ManagedKeywordTables tables={tables} />);

    fireEvent.change(screen.getByLabelText("主分类"), {
      target: { value: "industry" },
    });

    expect(screen.getByText("行业问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌问题")).not.toBeInTheDocument();
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 1 条");
  });

  it("sends the authoritative table id and original row index into problem optimization", () => {
    const onUseQuestion = vi.fn();
    render(
      <ManagedKeywordTables tables={tables} onUseQuestion={onUseQuestion} />,
    );

    fireEvent.change(screen.getByLabelText("主分类"), {
      target: { value: "product_scenario" },
    });

    const scenarioRow = screen.getByText("场景问题").closest("tr");
    expect(scenarioRow).not.toBeNull();
    expect(
      within(scenarioRow!).getByRole("cell", { name: "选择并进入问题优化" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(scenarioRow!).getByRole("button", {
        name: "选择并进入问题优化",
      }),
    );

    expect(onUseQuestion).toHaveBeenCalledWith({
      question: "场景问题",
      category: "product_scenario",
      tableId: "question-list-1",
      rowIndex: 1,
    });
  });

  it("filters by question subdivision while preserving the uploaded row order", () => {
    render(<ManagedKeywordTables tables={tables} />);

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).getByText("品牌问题")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("场景问题")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("行业问题")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("竞品问题")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("问题细分"), {
      target: { value: "场景方案" },
    });
    expect(screen.getByText("场景问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌问题")).not.toBeInTheDocument();
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 1 条");
  });

  it("does not allow an unknown source category to fall back to another quota", () => {
    const onUseQuestion = vi.fn();
    render(
      <ManagedKeywordTables
        tables={[
          {
            ...tables[0],
            rows: [["1", "未知类型问题", "未知", "无法识别", "10", ""]],
          },
        ]}
        onUseQuestion={onUseQuestion}
      />,
    );

    const action = screen.getByRole("button", {
      name: "选择并进入问题优化",
    });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onUseQuestion).not.toHaveBeenCalled();
  });

  it("marks only the categories withheld until the next service quarter", () => {
    const onUseQuestion = vi.fn();
    render(
      <ManagedKeywordTables
        tables={tables}
        onUseQuestion={onUseQuestion}
        quotaAvailability={{
          industry: {
            available: false,
            unavailableLabel: "下一季度开放",
          },
          product_scenario: { available: true },
        }}
      />,
    );

    const industryRow = screen.getByText("行业问题").closest("tr");
    const industryAction = within(industryRow!).getByRole("button", {
      name: "下一季度开放",
    });
    expect(industryAction).toBeDisabled();

    const scenarioRow = screen.getByText("场景问题").closest("tr");
    expect(
      within(scenarioRow!).getByRole("button", {
        name: "选择并进入问题优化",
      }),
    ).toBeEnabled();
    fireEvent.click(industryAction);
    expect(onUseQuestion).not.toHaveBeenCalled();
  });

  it("shows a neutral waiting state before a word bank is published", () => {
    render(<ManagedKeywordTables tables={[]} />);

    expect(
      screen.getByRole("heading", { name: "品牌全域词库正在准备中" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("内容发布后会自动显示在这里。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/工单|AI 监控与优化工程师|候选问题目录/),
    ).not.toBeInTheDocument();
  });

  it("hides the generation action after the published 160-row word bank exists", () => {
    const publishedRows = Array.from({ length: 160 }, (_, index) => [
      String(index + 1),
      `品牌问题 ${index + 1}`,
      "品牌",
      "品牌核心词",
      String(160 - index),
      "2026-08-24",
      "品牌认知",
    ]);

    render(
      <ManagedKeywordTables
        tables={[{ ...tables[0]!, rows: publishedRows }]}
        generationEnabled
      />,
    );

    expect(screen.getByText(/共/)).toHaveTextContent("共 160 条词库记录");
    expect(
      screen.queryByRole("button", { name: "抓取品牌全域词库" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the generation action available until a word bank is published", () => {
    render(<ManagedKeywordTables tables={[]} generationEnabled />);

    expect(
      screen.getByRole("button", { name: "抓取品牌全域词库" }),
    ).toBeInTheDocument();
  });
});
