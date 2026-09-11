import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicServicePortalQuestion } from "@shared/service-portal";
import type { WorkbenchStatePatch } from "@shared/workbench-task";
import type { ServicePortalView } from "./service-portal";
import {
  BusinessWorkspaceProvider,
  type BusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  maintain: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  questions: [] as unknown[],
  dashboard: {} as any,
  portfolioError: false,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        questionPortfolio: { invalidate: mocks.invalidate },
        portal: { invalidate: mocks.invalidate },
        responseLogic: { invalidate: mocks.invalidate },
      },
    }),
    workspace: {
      questionPortfolio: {
        useQuery: () => ({
          data: { questions: mocks.questions },
          isLoading: false,
          isError: mocks.portfolioError,
          refetch: mocks.refetch,
        }),
      },
      dashboard: {
        useQuery: () => ({
          data: mocks.dashboard,
          isLoading: false,
          isError: false,
          refetch: mocks.refetch,
        }),
      },
      requestQuestionSelection: {
        useMutation: () => ({ mutateAsync: mocks.create }),
      },
      questionMaintenance: {
        execute: { useMutation: () => ({ mutateAsync: mocks.maintain }) },
      },
    },
  },
}));
import { QuestionsWorkflow } from "./QuestionsWorkflow";
const portal = {
  mode: "operator",
  capabilities: { questionSelection: { allowed: true } },
  quotas: [],
} as unknown as ServicePortalView;
const question = (
  id = "question-saved",
  title = "服务端确认的问题",
): PublicServicePortalQuestion =>
  ({
    id,
    question: title,
    category: "industry",
    source: "user",
    status: "selected",
    revision: 4,
    responseLogicConfirmed: false,
  }) as PublicServicePortalQuestion;
let activeOwner: string;
function taskValue(id = "task-a", project = "project-a") {
  const scopeKey = `account:${project}:questions`;
  const state: {
    values: Record<string, unknown>;
    resources: any[];
    outputRefs: any[];
  } = { values: {}, resources: [], outputRefs: [] };
  const summary: { current: BusinessWorkspaceSummary | null } = {
    current: null,
  };
  const outcomeFailure = { enabled: false };
  const saveState = vi.fn(
    async (
      patch: WorkbenchStatePatch,
      owner?: { conversationId: string; scopeKey: string },
    ) => {
      if (owner && activeOwner !== `${owner.scopeKey}:${owner.conversationId}`)
        throw new Error("任务已切换");
      if (outcomeFailure.enabled && patch.outputRefs?.length)
        throw new Error("任务关联暂时不可用");
      state.values = { ...state.values, ...patch.values };
      if (patch.resources) state.resources = patch.resources;
      if (patch.outputRefs)
        state.outputRefs = [...state.outputRefs, ...patch.outputRefs];
    },
  );
  const ensureTask = vi.fn(async () => id);
  const task = {
    taskId: id,
    scopeKey,
    state,
    saveState,
    ensureTask,
    retry: vi.fn(async () => undefined),
    hydrated: true,
    pending: false,
  } as any;
  const value = {
    taskId: id,
    agentId: "questions",
    isWorkbench: true,
    task,
    setSummary: (value: BusinessWorkspaceSummary | null) => {
      summary.current = value;
    },
  };
  return {
    id,
    scopeKey,
    state,
    summary,
    outcomeFailure,
    ensureTask,
    saveState,
    value,
  };
}
function ui(owner: ReturnType<typeof taskValue>, onResponse = vi.fn()) {
  activeOwner = `${owner.scopeKey}:${owner.id}`;
  return (
    <BusinessWorkspaceProvider value={owner.value}>
      <QuestionsWorkflow portal={portal} onOpenResponseLogic={onResponse} />
    </BusinessWorkspaceProvider>
  );
}
function direct(text = "输入中的原始问题") {
  fireEvent.click(screen.getByRole("button", { name: "自己输入" }));
  fireEvent.change(screen.getByLabelText("目标问题"), {
    target: { value: text },
  });
  fireEvent.change(screen.getByLabelText("问题类别"), {
    target: { value: "industry" },
  });
  fireEvent.click(screen.getByRole("button", { name: "检查这个问题" }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.questions = [];
  mocks.portfolioError = false;
  mocks.dashboard = {
    revision: 11,
    payload: {
      keywordTables: [
        {
          id: "industry-table",
          title: "行业词库",
          columns: ["问题", "核心词分类"],
          rows: [["词库中的真实问题", "行业排名词"]],
        },
      ],
    },
  };
  mocks.create.mockResolvedValue({ question: question() });
  mocks.maintain.mockResolvedValue({
    action: "modify",
    questionId: "question-saved",
    replacementQuestionId: "replacement",
  });
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(cleanup);

describe("QuestionsWorkflow real business steps", () => {
  it("keeps the confirmed revision while a cached portfolio lags and accepts a later portfolio revision", async () => {
    mocks.questions = [
      { ...question(), question: "旧缓存的问题", revision: 3 },
    ];
    mocks.create.mockResolvedValue({
      question: { ...question(), question: "已确认的新版问题", revision: 5 },
    });
    const owner = taskValue();
    const view = render(ui(owner));
    direct();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await screen.findByRole("heading", { name: "这个问题已加入优化清单。" });
    expect(screen.getByText("已确认的新版问题")).toBeInTheDocument();
    expect(screen.queryByText("旧缓存的问题")).not.toBeInTheDocument();
    await waitFor(() => expect(owner.summary.current?.outputs).toEqual([
      expect.objectContaining({ title: "已确认的新版问题", version: 5 }),
    ]));
    mocks.questions = [
      { ...question(), question: "随后更新的问题", revision: 6 },
    ];
    view.rerender(ui(owner));
    expect(screen.getByText("随后更新的问题")).toBeInTheDocument();
    await waitFor(() => expect(owner.summary.current?.outputs).toEqual([
      expect.objectContaining({ title: "随后更新的问题", version: 6 }),
    ]));
  });
  it("returns to edit without creating and restores its own draft before saving the returned entity", async () => {
    const owner = taskValue();
    const onResponse = vi.fn();
    const view = render(ui(owner, onResponse));
    expect(screen.queryByLabelText("目标问题")).not.toBeInTheDocument();
    direct();
    fireEvent.click(
      screen.getAllByRole("button", { name: "返回修改" }).at(-1)!,
    );
    expect(screen.getByLabelText("目标问题")).toHaveValue("输入中的原始问题");
    expect(mocks.create).not.toHaveBeenCalled();
    view.unmount();
    render(ui(owner, onResponse));
    expect(screen.getByLabelText("目标问题")).toHaveValue("输入中的原始问题");
    fireEvent.click(screen.getByRole("button", { name: "检查这个问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    expect(
      await screen.findByRole("heading", { name: "这个问题已加入优化清单。" }),
    ).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledWith({
      mode: "direct",
      question: "输入中的原始问题",
      category: "industry",
    });
    expect(owner.state.outputRefs).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({
          id: "question-saved",
          label: "服务端确认的问题",
        }),
        version: "4",
      }),
    ]);
    await waitFor(() => expect(owner.summary.current?.outputs).toEqual([
      expect.objectContaining({
        id: "question-saved",
        title: "服务端确认的问题",
      }),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "进入应答逻辑" }));
    expect(onResponse).toHaveBeenCalledWith("question-saved");
  });
  it("selects within the existing library and submits exact row coordinates after an explicit confirmation", async () => {
    const owner = taskValue();
    render(ui(owner));
    fireEvent.click(screen.getByRole("button", { name: "从品牌全域词库获取" }));
    fireEvent.click(screen.getByRole("button", { name: /词库中的真实问题/ }));
    expect(
      screen.getByRole("heading", { name: "确认将这个问题加入优化清单？" }),
    ).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "返回修改" }).at(-1)!,
    );
    expect(
      screen.getByRole("button", { name: /词库中的真实问题/ }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /词库中的真实问题/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        mode: "brand_keyword_library",
        dashboardRevision: 11,
        tableId: "industry-table",
        rowIndex: 0,
      }),
    );
    await screen.findByRole("heading", { name: "这个问题已加入优化清单。" });
  });
  it("restores each confirmed question source independently after creating direct and library questions", async () => {
    const directQuestion = question("direct-source", "自主问题");
    const libraryQuestion = question("library-source", "词库中的真实问题");
    mocks.create
      .mockResolvedValueOnce({ question: directQuestion })
      .mockResolvedValueOnce({ question: libraryQuestion });
    const owner = taskValue();
    const view = render(ui(owner));
    direct();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await screen.findByRole("heading", { name: "这个问题已加入优化清单。" });
    fireEvent.click(screen.getByRole("button", { name: "再添加一个" }));
    fireEvent.click(screen.getByRole("button", { name: "从品牌全域词库获取" }));
    fireEvent.click(screen.getByRole("button", { name: /词库中的真实问题/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() =>
      expect(owner.summary.current?.outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "direct-source",
            description: "行业排名词 · 自主输入",
          }),
          expect.objectContaining({
            id: "library-source",
            description: "行业排名词 · 品牌全域词库 · 版本 11",
          }),
        ]),
      ),
    );
    expect(owner.state.values.questionSourceRefs).toEqual({
      "direct-source": { kind: "direct" },
      "library-source": {
        kind: "library",
        dashboardRevision: 11,
        tableId: "industry-table",
        rowIndex: 0,
      },
    });
    view.unmount();
    mocks.questions = [directQuestion, libraryQuestion];
    render(ui(owner));
    await waitFor(() =>
      expect(owner.summary.current?.outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "direct-source",
            description: "行业排名词 · 自主输入",
          }),
          expect.objectContaining({
            id: "library-source",
            description: "行业排名词 · 品牌全域词库 · 版本 11",
          }),
        ]),
      ),
    );
  });
  it("retries only the task association after a successful create when the outbox cannot synchronize", async () => {
    const owner = taskValue();
    owner.outcomeFailure.enabled = true;
    render(ui(owner));
    direct();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    expect(
      await screen.findByText(/业务已保存，任务记录待同步/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认并保存" }),
    ).not.toBeInTheDocument();
    expect(owner.summary.current?.outputs).toEqual([
      expect.objectContaining({ id: "question-saved" }),
    ]);
    owner.outcomeFailure.enabled = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/业务已保存，任务记录待同步/),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(owner.state.outputRefs).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({ id: "question-saved" }),
      }),
    ]);
  });
  it("keeps a late create receipt out of the next project's task and preserves its pending owner association", async () => {
    let finish!: (value: { question: PublicServicePortalQuestion }) => void;
    mocks.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = taskValue();
    const second = taskValue("task-b", "project-b");
    const view = render(ui(first));
    direct("项目甲的问题");
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    view.rerender(ui(second));
    await act(async () =>
      finish({ question: question("question-a", "只属于甲项目") }),
    );
    expect(
      screen.getByRole("heading", { name: "这次想优化什么问题？" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("只属于甲项目")).not.toBeInTheDocument();
    expect(second.state.outputRefs).toEqual([]);
    expect(second.summary.current?.outputs).toEqual([]);
    expect(first.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        outputRefs: [
          expect.objectContaining({
            resource: expect.objectContaining({ id: "question-a" }),
          }),
        ],
      }),
      { conversationId: "task-a", scopeKey: first.scopeKey },
    );
  });
  it("returns from the existing-question picker and preserves exact revision plus retry identity for edits", async () => {
    mocks.questions = [question()];
    mocks.maintain.mockRejectedValueOnce(new Error("连接暂时中断"));
    mocks.maintain.mockImplementationOnce(async () => {
      mocks.questions = [question("replacement", "调整后的问题")];
      return {
        action: "modify",
        questionId: "question-saved",
        replacementQuestionId: "replacement",
      };
    });
    const owner = taskValue();
    render(ui(owner));
    fireEvent.click(screen.getByRole("button", { name: "继续处理已有问题" }));
    fireEvent.click(screen.getByRole("button", { name: "返回选项列表" }));
    expect(
      screen.getByRole("heading", { name: "这次想优化什么问题？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续处理已有问题" }));
    fireEvent.click(screen.getByRole("button", { name: /服务端确认的问题/ }));
    fireEvent.click(screen.getByRole("button", { name: "修改问题" }));
    fireEvent.change(screen.getByLabelText("目标问题"), {
      target: { value: "调整后的问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接暂时中断");
    expect(screen.getByLabelText("目标问题")).toHaveValue("调整后的问题");
    fireEvent.click(screen.getByRole("button", { name: "确认并保存修改" }));
    await screen.findByRole("heading", { name: "这个问题已加入优化清单。" });
    expect(mocks.maintain.mock.calls[0][0]).toEqual(
      mocks.maintain.mock.calls[1][0],
    );
    expect(mocks.maintain.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        questionId: "question-saved",
        expectedRevision: 4,
        action: "modify",
        proposedQuestion: "调整后的问题",
      }),
    );
    expect(owner.summary.current?.outputs).toEqual([
      expect.objectContaining({ id: "replacement" }),
    ]);
  });
});

it("does not create in the next project when task binding completes after navigation", async () => {
  let bind!: (id: string) => void;
  const first = taskValue();
  const second = taskValue("task-b", "project-b");
  first.ensureTask.mockImplementation(
    () =>
      new Promise((resolve) => {
        bind = resolve;
      }),
  );
  const view = render(ui(first));
  direct();
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() => expect(first.ensureTask).toHaveBeenCalledTimes(1));
  view.rerender(ui(second));
  await act(async () => bind("task-a"));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(second.state.outputRefs).toEqual([]);
  expect(
    screen.getByRole("heading", { name: "这次想优化什么问题？" }),
  ).toBeInTheDocument();
});
it("does not apply an old edit after its task binding resumes in another project", async () => {
  let bind!: (id: string) => void;
  mocks.questions = [question()];
  const first = taskValue();
  const second = taskValue("task-b", "project-b");
  first.ensureTask.mockImplementation(
    () =>
      new Promise((resolve) => {
        bind = resolve;
      }),
  );
  const view = render(ui(first));
  fireEvent.click(screen.getByRole("button", { name: "继续处理已有问题" }));
  fireEvent.click(screen.getByRole("button", { name: /服务端确认的问题/ }));
  fireEvent.click(screen.getByRole("button", { name: "修改问题" }));
  fireEvent.change(screen.getByLabelText("目标问题"), {
    target: { value: "原项目的问题修改" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认并保存修改" }));
  await waitFor(() => expect(first.ensureTask).toHaveBeenCalledTimes(1));
  mocks.questions = [];
  view.rerender(ui(second));
  await act(async () => bind("task-a"));
  expect(mocks.maintain).not.toHaveBeenCalled();
  expect(second.state.outputRefs).toEqual([]);
});
it("removes an acknowledged deletion locally even if refreshing the portfolio fails", async () => {
  mocks.questions = [question()];
  mocks.maintain.mockResolvedValue({
    action: "delete",
    questionId: "question-saved",
    replacementQuestionId: null,
  });
  mocks.invalidate.mockRejectedValue(new Error("列表读取失败"));
  const owner = taskValue();
  owner.state.resources = [{ kind: "question", id: "question-saved" }];
  render(ui(owner));
  fireEvent.click(screen.getByRole("button", { name: "继续处理已有问题" }));
  fireEvent.click(screen.getByRole("button", { name: /服务端确认的问题/ }));
  fireEvent.click(screen.getByRole("button", { name: "删除问题" }));
  expect(mocks.maintain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByRole("heading", { name: "这次想优化什么问题？" });
  expect(owner.summary.current?.outputs).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "继续处理已有问题" }));
  expect(
    screen.queryByRole("button", { name: /服务端确认的问题/ }),
  ).not.toBeInTheDocument();
  expect(mocks.maintain).toHaveBeenCalledTimes(1);
});
