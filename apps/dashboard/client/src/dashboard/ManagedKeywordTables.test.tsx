import { BusinessWorkspaceProvider } from "./BusinessWorkspaceContext";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ManagedKeywordTables, {
  BrandQuestionUniverseGenerationAction,
} from "./ManagedKeywordTables";
import { initialWorkbenchTaskState } from "@shared/workbench-task";

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  dashboardFetch: vi.fn(),
  refetch: vi.fn(async () => ({})),
  cancel: vi.fn(async () => undefined),
  start: vi.fn(async (_input: unknown) => ({})),
  navigate: vi.fn(),
}));
vi.mock("wouter/use-browser-location", () => ({ navigate: mocks.navigate }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.observe.mockReturnValue({
    data: {
      canStart: true,
      knowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
      dashboardRevision: 3,
      reason: "ready",
      operation: null,
    },
    error: null,
    isSuccess: true,
    refetch: mocks.refetch,
  });
});
afterEach(() => vi.useRealTimers());

const keywordWorkbench = (children: React.ReactNode) => (
  <BusinessWorkspaceProvider
    value={{
      isWorkbench: true,
      agentId: "keywords",
      taskId: null,
      setSummary: () => undefined,
    }}
  >
    {children}
  </BusinessWorkspaceProvider>
);

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        brandQuestionUniverse: {
          observe: { invalidate: async () => undefined, cancel: mocks.cancel },
        },
        dashboard: {
          invalidate: async () => undefined,
          fetch: mocks.dashboardFetch,
        },
      },
    }),
    workspace: {
      brandQuestionUniverse: {
        observe: {
          useQuery: mocks.observe,
        },
        start: {
          useMutation: () => ({
            mutate: () => undefined,
            mutateAsync: mocks.start,
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

it("shows the real publication prerequisite after choosing generation", () => {
  mocks.observe.mockReturnValue({
    data: undefined,
    error: null,
    isPending: true,
    refetch: mocks.refetch,
  });
  const { container } = render(
    keywordWorkbench(
      <ManagedKeywordTables
        tables={[]}
        generationEnabled
        knowledgePublished={false}
      />,
    ),
  );
  // The generation control renders directly on the tables landing.
  expect(
    screen.getByRole("heading", { name: "先发布企业知识库" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/节点确认后/)).toHaveTextContent("更新知识库");
  expect(screen.getByRole("button", { name: "前往智能知识库" })).toBeEnabled();
  expect(mocks.observe).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ enabled: false }),
  );
  expect(screen.queryByText("正在检查抓取条件…")).toBeNull();
  expect(screen.queryByRole("button", { name: "抓取品牌全域词库" })).toBeNull();
  expect(container.querySelector(".panel")).toBeNull();
  expect(container.querySelector(".keyword-start-step")).toBeInTheDocument();
});

it("opens the existing directory on request even when published knowledge is unavailable", () => {
  render(
    keywordWorkbench(
      <ManagedKeywordTables
        tables={tables}
        dashboardRevision={7}
        generationEnabled
        knowledgePublished={false}
      />,
    ),
  );
  expect(screen.getByRole("table")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "挑选与生成" }));
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "从现有词库挑选" }));
  expect(
    screen.getByRole("region", { name: "品牌全域词库选择器" }),
  ).toBeInTheDocument();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("heading", { name: "先发布企业知识库" }),
  ).toBeNull();
});

it("surfaces a real observation error and retries the read without starting a generation", async () => {
  mocks.observe.mockReturnValue({
    data: undefined,
    error: new Error("连接暂不可用"),
    isError: true,
    refetch: mocks.refetch,
  });
  render(
    keywordWorkbench(
      <ManagedKeywordTables tables={[]} generationEnabled knowledgePublished />,
    ),
  );
  expect(screen.getByText("连接暂不可用")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("offers a read retry after the initial observation stalls without declaring generation failed", () => {
  vi.useFakeTimers();
  mocks.observe.mockReturnValue({
    data: undefined,
    error: null,
    isPending: true,
    refetch: mocks.refetch,
  });
  render(
    keywordWorkbench(
      <ManagedKeywordTables tables={[]} generationEnabled knowledgePublished />,
    ),
  );
  expect(
    screen.getByRole("heading", { name: "正在读取词库生成条件" }),
  ).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(12_000));
  expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
  expect(screen.getByText(/读取超时/)).toBeInTheDocument();
  expect(screen.queryByText(/生成失败/)).toBeNull();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("confirms a versioned selection before an explicit idempotent handoff", async () => {
  const handoff = vi.fn();
  let failConfirmation = true;
  const saveState = vi.fn(async (patch: any) => {
    if (patch.step === "keyword-confirmed" && failConfirmation) {
      failConfirmation = false;
      throw new Error("选题记录未保存，请重试");
    }
    return {};
  });
  const createHandoff = vi.fn(async () => ({
    conversationId: "target-question-task",
  }));
  const catalog = [
    {
      id: "words",
      title: "全域问题",
      columns: ["问题", "主分类"],
      rows: Array.from({ length: 25 }, (_, index) => [
        `问题 ${index + 1}`,
        "产品场景词",
      ]),
    },
  ];
  mocks.dashboardFetch.mockResolvedValue({
    revision: 7,
    payload: { keywordTables: catalog },
  });
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "keywords",
        taskId: "task-1",
        task: {
          scopeKey: "p1:keywords",
          taskId: "task-1",
          ensureTask: async () => "task-1",
          saveState,
          handoff: createHandoff,
          state: null,
        } as any,
        setSummary: () => undefined,
      }}
    >
      <ManagedKeywordTables
        dashboardRevision={7}
        tables={catalog}
        onUseQuestion={handoff}
      />
    </BusinessWorkspaceProvider>,
  );
  expect(screen.getByRole("table")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "挑选与生成" }));
  fireEvent.click(screen.getByRole("button", { name: "从现有词库挑选" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: /^问题 1\s*产品场景词/ }));
  expect(handoff).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认选题" }));
  await screen.findByText("选题记录未保存，请重试");
  expect(screen.queryByRole("button", { name: "交给问题优化" })).toBeNull();
  expect(screen.queryByText(/业务已保存/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认选题" }));
  await screen.findByRole("button", { name: "交给问题优化" });
  expect(createHandoff).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "交给问题优化" }));
  await waitFor(() =>
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "问题 1",
        tableId: "words",
        rowIndex: 0,
        workbenchTaskId: "target-question-task",
      }),
    ),
  );
  expect(createHandoff).toHaveBeenCalledWith(
    expect.objectContaining({
      targetAgentId: "questions",
      idempotencyKey: "keyword:7:words:0",
      values: expect.objectContaining({
        questionLibraryRef: {
          dashboardRevision: 7,
          tableId: "words",
          rowIndex: 0,
        },
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
});

it("summarizes the project catalog and retained keyword references with the current selection taking precedence", () => {
  const setSummary = vi.fn();
  const handoff = vi.fn();
  const saveState = vi.fn();
  const selection = {
    dashboardRevision: 7,
    tableId: "question-list-1",
    rowIndex: 0,
    question: "品牌问题",
    category: "reputation",
  };
  const stateFor = (
    confirmed: typeof selection,
    agentId: "keywords" | "media" = "keywords",
  ) => ({
    ...initialWorkbenchTaskState(agentId),
    values: {
      keywordsWorkflow: {
        entry: "start",
        pending: confirmed,
        confirmed,
        filters: { query: "", category: "", page: 0 },
      },
    },
  });
  const current = {
    ...stateFor(selection),
    records: [
      {
        id: "handoff",
        label: "已交给问题优化",
        detail: "当前交接结果",
        status: "completed",
        timestamp: 2,
        targetTask: { conversationId: "question-target", agentId: "questions" },
      },
    ],
  };
  const old = {
    ...stateFor({ ...selection, question: "已过期的同一引用" }),
    records: [{ ...current.records[0], detail: "旧交接结果" }],
  };
  const retained = stateFor({
    ...selection,
    rowIndex: 1,
    question: "场景问题",
    category: "product_scenario",
  });
  const foreign = stateFor(
    { ...selection, rowIndex: 2, question: "其他智能体的私有选题" },
    "media",
  );
  window.history.replaceState(
    {},
    "",
    "/?enterpriseProjectId=project-7&view=keywords",
  );
  const view = render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "keywords",
        taskId: "current",
        setSummary,
        task: {
          scopeKey: "owner-7:project-7:keywords",
          taskId: "current",
          state: current,
          tasks: [
            { workbench: old },
            { workbench: retained },
            { workbench: foreign },
          ],
          handoff,
          saveState,
        } as any,
      }}
    >
      <ManagedKeywordTables tables={tables} dashboardRevision={7} />
    </BusinessWorkspaceProvider>,
  );
  const summary = setSummary.mock.calls.at(-1)?.[0];
  expect(summary).toMatchObject({
    title: "项目词库",
    scope: "project",
    items: [{ label: "当前生效词库", value: "版本 7 · 4 条问题" }],
  });
  expect(summary.outputs.map((item: any) => item.title)).toEqual([
    "品牌问题",
    "场景问题",
    "当前交接结果",
  ]);
  act(() => summary.outputs.at(-1).onOpen());
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.stringContaining("workbenchTask=question-target"),
  );
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.stringContaining("enterpriseProjectId=project-7"),
  );
  expect(handoff).not.toHaveBeenCalled();
  expect(saveState).not.toHaveBeenCalled();
  view.rerender(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "keywords",
        taskId: null,
        setSummary,
        task: {
          scopeKey: "owner-8:project-8:keywords",
          taskId: null,
          state: null,
          tasks: [],
          handoff,
          saveState,
        } as any,
      }}
    >
      <ManagedKeywordTables tables={[]} />
    </BusinessWorkspaceProvider>,
  );
  expect(setSummary.mock.calls.at(-1)?.[0].outputs).toEqual([]);
  expect(setSummary.mock.calls.at(-1)?.[0].items).toEqual([]);
  window.history.replaceState({}, "", "/");
});
