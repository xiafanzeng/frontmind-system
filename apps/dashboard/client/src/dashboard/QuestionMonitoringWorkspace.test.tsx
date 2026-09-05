import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  citationsQuery: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      monitoring: {
        sampleCitations: {
          useQuery: (...args: unknown[]) => mocks.citationsQuery(...args),
        },
      },
    },
  },
}));

import QuestionMonitoringWorkspace from "./QuestionMonitoringWorkspace";

const previewIntents = [
  {
    id: "reputation",
    name: "美誉舆情",
    subtitle: "测试口碑问题",
    questions: ["测试品牌的用户口碑如何？"],
  },
  {
    id: "basic",
    name: "产品场景",
    subtitle: "测试产品场景问题",
    questions: ["测试产品适合什么场景？", "测试产品有哪些使用边界？"],
  },
  {
    id: "ranking",
    name: "行业排名",
    subtitle: "测试行业问题",
    questions: ["测试行业有哪些代表品牌？"],
  },
  {
    id: "comparison",
    name: "竞品对比",
    subtitle: "测试对比问题",
    questions: ["测试产品与同类方案有什么区别？"],
  },
];

const previewAnswerBooks = Object.fromEntries(
  previewIntents.map((intent) => [
    intent.id,
    {
      label: intent.name,
      platforms: [
        {
          name: "测试模型",
          questions: intent.questions.map((question) => ({
            question,
            date: "2026-07-24",
            answers: [
              {
                id: `${intent.id}-${question}-1`,
                answerNo: 1,
                content: "第一条测试回答。",
                citationCount: 0,
                screenshotUrl: "",
                collectedAt: "2026-07-24",
                citations: [],
              },
              {
                id: `${intent.id}-${question}-2`,
                answerNo: 2,
                content: "第二条测试回答。",
                citationCount: 0,
                screenshotUrl: "",
                collectedAt: "2026-07-24",
                citations: [],
              },
            ],
          })),
        },
      ],
    },
  ]),
);

const managedGroups = [
  {
    id: "scenario",
    title: "产品场景",
    subtitle: "数控设备选型与加工需求",
    tone: "teal" as const,
    questions: [
      {
        id: "machine-selection",
        question: "验收企业的专业方案适合哪些业务场景？",
        intent: "核验产品适用范围与技术边界。",
        summary: "结合规格参数和行业案例说明适用场景。",
      },
      {
        id: "machine-service",
        question: "验收企业提供哪些配套服务？",
        intent: "核验配套服务范围。",
        summary: "结合正式资料说明服务范围。",
      },
    ],
  },
];

describe("QuestionMonitoringWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.citationsQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "citation-1",
            sampleId: "managed-answer-1",
            title: "验收企业方案中心",
            url: "https://example.com/products",
            media: "企业官网",
            domain: "example.com",
          },
        ],
        total: 1,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
  });

  it("embeds citation analysis after the answer browser", () => {
    const { container } = render(
      <QuestionMonitoringWorkspace
        previewIntents={previewIntents}
        previewAnswerBooks={previewAnswerBooks}
        distributionContent={
          <div data-testid="embedded-channel-distribution">引用分析双表</div>
        }
      />,
    );

    const browser = container.querySelector(".question-monitor-browser");
    const distribution = screen.getByRole("region", { name: "渠道分发" });
    expect(browser).toBeInstanceOf(HTMLElement);
    expect(
      (browser as HTMLElement).compareDocumentPosition(distribution) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByTestId("embedded-channel-distribution"),
    ).toHaveTextContent("引用分析双表");
  });

  it("keeps four dimensions and exposes question, model and date-range selectors", () => {
    const { container } = render(
      <QuestionMonitoringWorkspace
        previewIntents={previewIntents}
        previewAnswerBooks={previewAnswerBooks}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: "问题监控维度" }),
    ).toBeInTheDocument();
    for (const category of ["美誉舆情", "产品场景", "行业排名", "竞品对比"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(category) }),
      ).toBeInTheDocument();
    }

    expect(
      container.querySelector(".question-monitor-question-rail"),
    ).toBeNull();
    expect(
      container.querySelector(".question-monitor-platform-card"),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "答案浏览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "监控问题" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "监控模型" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("监控开始日期")).toBeInTheDocument();
    expect(screen.getByLabelText("监控结束日期")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "答案内容" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "该答案引用来源" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "监控问题" })).toHaveValue(
      "测试品牌的用户口碑如何？",
    );
    expect(screen.queryByText("ANSWER BROWSER")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /产品场景/ }));
    expect(screen.getByRole("combobox", { name: "监控问题" })).toHaveValue(
      "测试产品适合什么场景？",
    );
    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("1 / 2");

    expect(
      screen.queryByRole("button", { name: "下一个问题" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "监控问题" }), {
      target: {
        value: "测试产品有哪些使用边界？",
      },
    });
    expect(screen.getByRole("combobox", { name: "监控问题" })).toHaveValue(
      "测试产品有哪些使用边界？",
    );
    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("1 / 2");
  });

  it("keeps answer arrows inside the selected model and date range", () => {
    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "old-answer",
            questionId: "machine-selection",
            platform: "A平台",
            collectedAt: "2026-07-23",
            answerNo: 1,
            content: "较早的 A 平台答案。",
            citationCount: 0,
            screenshotUrl: "",
            citations: [],
          },
          {
            id: "latest-b",
            questionId: "machine-selection",
            platform: "B平台",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "最新的 B 平台答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
          {
            id: "latest-a",
            questionId: "machine-selection",
            platform: "A平台",
            collectedAt: "2026-07-24",
            answerNo: 2,
            content: "最新的 A 平台答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
          {
            id: "latest-a-second",
            questionId: "machine-selection",
            platform: "A平台",
            collectedAt: "2026-07-24",
            answerNo: 3,
            content: "同条件下的第二条 A 平台答案。",
            citationCount: 0,
            screenshotUrl: "",
            citations: [],
          },
        ]}
      />,
    );

    expect(screen.getByText("最新的 A 平台答案。")).toBeInTheDocument();
    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("1 / 3");
    fireEvent.change(screen.getByLabelText("监控开始日期"), {
      target: { value: "2026-07-24" },
    });
    expect(screen.getByText("最新的 A 平台答案。")).toBeInTheDocument();
    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一条答案" }));
    expect(
      screen.getByText("同条件下的第二条 A 平台答案。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("最新的 B 平台答案。")).not.toBeInTheDocument();
    expect(screen.queryByText("较早的 A 平台答案。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一条答案" })).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: "监控模型" }), {
      target: { value: "B平台" },
    });
    expect(screen.getByText("最新的 B 平台答案。")).toBeInTheDocument();
  });

  it("normalizes model names and removes answer-side model, date and rank tags", () => {
    const { container } = render(
      <QuestionMonitoringWorkspace
        citationMode="inline"
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "normalized-model-answer",
            questionId: "machine-selection",
            platform: "豆包移动端",
            collectedAt: "2026-07-24",
            answerNo: 7,
            content: "规范化模型答案。",
            citationCount: 3,
            monitorRank: 2,
            screenshotUrl: "",
            citations: [],
          },
        ]}
      />,
    );

    expect(screen.getByRole("option", { name: "豆包" })).toBeInTheDocument();
    expect(container.querySelector(".question-monitor-answer-meta")).toBeNull();
    expect(screen.queryByText("答案 #7")).not.toBeInTheDocument();
    expect(screen.queryByText("答案位次 2")).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "该答案引用来源" }),
    ).toBeInTheDocument();
  });

  it("matches a custom model label to the backend canonical model key", () => {
    render(
      <QuestionMonitoringWorkspace
        citationMode="inline"
        questionGroups={managedGroups}
        modelOptions={[{ value: "企业-专用模型", label: "企业 专用模型" }]}
        selectedModel="企业-专用模型"
        monitoringAnswers={[
          {
            id: "custom-model-answer",
            questionId: "machine-selection",
            platform: "企业 专用模型",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "企业专用模型答案。",
            citationCount: 0,
            screenshotUrl: "",
            citations: [],
          },
        ]}
      />,
    );

    expect(screen.getByText("企业专用模型答案。")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "监控模型" })).toHaveValue(
      "企业-专用模型",
    );
  });

  it("queries and renders only the citations linked to the selected sample", () => {
    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "database-answer-1",
            sourceRecordId: "managed-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content:
              "该产品面向大型复杂零部件加工，具体选型应核验行程、载荷与精度参数。",
            citationCount: 2,
            screenshotUrl: "",
            citations: [
              {
                title: "不应替代正式查询的内嵌信源",
                url: "https://legacy.example.com",
                media: "历史预览",
              },
            ],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );

    expect(mocks.citationsQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleId: "database-answer-1",
        questionId: "machine-selection",
        batchKey: "managed-batch",
        cursor: undefined,
        limit: 10,
      }),
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText(/大型复杂零部件加工/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /验收企业方案中心/ }),
    ).toHaveAttribute("href", "https://example.com/products");
    expect(screen.getByText("企业官网")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(
      screen.queryByText("不应替代正式查询的内嵌信源"),
    ).not.toBeInTheDocument();
  });

  it("paginates precise citations and displays the server total", async () => {
    mocks.citationsQuery.mockImplementation(
      (input: { cursor?: string; limit?: number }) => ({
        data: {
          items: [
            {
              id: input.cursor ? "citation-page-2" : "citation-page-1",
              title: input.cursor ? "第 2 页信源" : "第 1 页信源",
              url: input.cursor
                ? "https://example.com/page-2"
                : "https://example.com/page-1",
              media: "企业官网",
              domain: "example.com",
            },
          ],
          total: 12,
          nextCursor: input.cursor ? null : "citation-page-1",
        },
        isLoading: false,
        isFetching: false,
        error: null,
      }),
    );

    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "database-answer-1",
            sourceRecordId: "managed-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "需要分页读取信源的答案。",
            citationCount: 99,
            screenshotUrl: "",
            citations: [],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );

    expect(screen.getByText("共 12 条引用")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "引用来源分页" }),
    ).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一页引用" }));

    await waitFor(() =>
      expect(mocks.citationsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sampleId: "database-answer-1",
          cursor: "citation-page-1",
          limit: 10,
        }),
        expect.any(Object),
      ),
    );
    expect(
      screen.getByRole("link", { name: /第 2 页信源/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("共 12 条引用")).toBeInTheDocument();
  });

  it("changes the precise sampleId and source list together when an answer changes", async () => {
    mocks.citationsQuery.mockImplementation((input: { sampleId?: string }) => ({
      data: {
        items:
          input.sampleId === "sample-answer-2"
            ? [
                {
                  id: "citation-2",
                  sampleId: "sample-answer-2",
                  title: "第二条答案信源",
                  url: "https://second.example.com/source",
                  media: "第二来源",
                  domain: "second.example.com",
                },
              ]
            : [
                {
                  id: "citation-1",
                  sampleId: "sample-answer-1",
                  title: "第一条答案信源",
                  url: "https://first.example.com/source",
                  media: "第一来源",
                  domain: "first.example.com",
                },
              ],
        total: 1,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    }));

    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "sample-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "第一条答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
          {
            id: "sample-answer-2",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 2,
            content: "第二条答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("link", { name: /第一条答案信源/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一条答案" }));

    await waitFor(() =>
      expect(mocks.citationsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sampleId: "sample-answer-2",
          questionId: "machine-selection",
          batchKey: "managed-batch",
        }),
        expect.any(Object),
      ),
    );
    expect(
      screen.getByRole("link", { name: /第二条答案信源/ }),
    ).toHaveAttribute("href", "https://second.example.com/source");
    expect(
      screen.queryByRole("link", { name: /第一条答案信源/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps per-answer inline citations in preview mode", () => {
    render(
      <QuestionMonitoringWorkspace
        citationMode="inline"
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "preview-answer",
            questionId: "machine-selection",
            platform: "预览平台",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "预览答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [
              {
                title: "预览内嵌信源",
                url: "https://preview.example.com/source",
                media: "预览来源",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /预览内嵌信源/ })).toHaveAttribute(
      "href",
      "https://preview.example.com/source",
    );
    expect(screen.getByText("预览来源")).toBeInTheDocument();
    expect(mocks.citationsQuery).not.toHaveBeenCalled();
  });

  it("loads the next sample page from the answer arrow and advances after append", async () => {
    const onLoadMoreAnswers = vi.fn();
    const firstAnswer = {
      id: "page-1-answer",
      questionId: "machine-selection",
      platform: "DeepSeek",
      collectedAt: "2026-07-24",
      answerNo: 1,
      content: "第一页答案。",
      citationCount: 0,
      screenshotUrl: "",
      citations: [],
    };
    const secondAnswer = {
      ...firstAnswer,
      id: "page-2-answer",
      answerNo: 2,
      content: "第二页答案。",
    };
    const { rerender } = render(
      <QuestionMonitoringWorkspace
        citationMode="inline"
        questionGroups={managedGroups}
        monitoringAnswers={[firstAnswer]}
        totalAnswerCount={2}
        hasMoreAnswers
        onLoadMoreAnswers={onLoadMoreAnswers}
      />,
    );

    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一条答案" }));
    expect(onLoadMoreAnswers).toHaveBeenCalledTimes(1);

    rerender(
      <QuestionMonitoringWorkspace
        citationMode="inline"
        questionGroups={managedGroups}
        monitoringAnswers={[firstAnswer, secondAnswer]}
        totalAnswerCount={2}
        hasMoreAnswers={false}
        onLoadMoreAnswers={onLoadMoreAnswers}
      />,
    );

    expect(await screen.findByText("第二页答案。")).toBeInTheDocument();
    expect(screen.getByLabelText("当前答案序号")).toHaveTextContent("2 / 2");
  });

  it("resets question and answer state when managed enterprise data changes", async () => {
    const { rerender } = render(
      <QuestionMonitoringWorkspace
        questionGroups={[
          {
            ...managedGroups[0],
            id: "first-enterprise",
            title: "企业一",
            questions: [
              {
                id: "first-question",
                question: "企业一的核心产品是什么？",
                intent: "核验企业一产品。",
                summary: "企业一产品摘要。",
              },
            ],
          },
        ]}
        monitoringAnswers={[
          {
            id: "first-answer",
            questionId: "first-question",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "企业一回答内容。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
        ]}
      />,
    );

    rerender(
      <QuestionMonitoringWorkspace
        questionGroups={[
          {
            ...managedGroups[0],
            id: "second-enterprise",
            title: "企业二",
            questions: [
              {
                id: "second-question",
                question: "企业二提供哪些解决方案？",
                intent: "核验企业二方案。",
                summary: "企业二方案摘要。",
              },
            ],
          },
        ]}
        monitoringAnswers={[
          {
            id: "second-answer",
            questionId: "second-question",
            platform: "千问",
            collectedAt: "2026-07-25",
            answerNo: 1,
            content: "企业二回答内容。",
            citationCount: 3,
            screenshotUrl: "",
            citations: [],
          },
        ]}
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "监控问题" }),
    ).toHaveValue("企业二提供哪些解决方案？");
    expect(screen.getByText("企业二回答内容。")).toBeInTheDocument();
    expect(screen.queryByText(/企业一/)).not.toBeInTheDocument();
  });

  it("shows truthful answer and source empty states", () => {
    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[]}
      />,
    );

    expect(screen.getByText("等待同步答案记录")).toBeInTheDocument();
    expect(
      screen.getByText("查看各AI平台的答案与引用信源记录"),
    ).toBeInTheDocument();
    expect(screen.getByText("暂无可匹配的答案")).toBeInTheDocument();
    expect(mocks.citationsQuery).not.toHaveBeenCalled();
  });

  it("shows truthful precise-source loading and empty states", () => {
    mocks.citationsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
    });
    const { rerender } = render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "managed-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "监控答案。",
            citationCount: 0,
            screenshotUrl: "",
            citations: [],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在匹配当前答案的引用信源",
    );

    mocks.citationsQuery.mockReturnValue({
      data: { items: [], total: 0, nextCursor: null },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    rerender(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "managed-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "监控答案。",
            citationCount: 0,
            screenshotUrl: "",
            citations: [],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );
    expect(screen.getByText("当前答案暂无精确信源")).toBeInTheDocument();
    expect(
      screen.getByText(/未关联样本的记录不会在这里混入/),
    ).toBeInTheDocument();
  });

  it("announces question changes and reports a citation failure without stale sources", async () => {
    mocks.citationsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("network"),
    });
    render(
      <QuestionMonitoringWorkspace
        questionGroups={managedGroups}
        monitoringAnswers={[
          {
            id: "managed-answer-1",
            questionId: "machine-selection",
            platform: "DeepSeek",
            collectedAt: "2026-07-24",
            answerNo: 1,
            content: "监控答案。",
            citationCount: 1,
            screenshotUrl: "",
            citations: [],
          },
        ]}
        batchKey="managed-batch"
        onSelectedQuestionIdChange={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "当前答案的引用信源暂时无法读取",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "监控问题" }), {
      target: { value: "验收企业提供哪些配套服务？" },
    });
    await waitFor(() =>
      expect(screen.getByText("暂无答案样本。")).toBeInTheDocument(),
    );
  });
});
