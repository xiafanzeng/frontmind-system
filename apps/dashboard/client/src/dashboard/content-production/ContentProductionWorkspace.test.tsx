import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_PRODUCTION_CONFIRMATION_ACTIONS,
  type ContentProductionConfirmation as Confirmation,
  type ContentProductionDto,
} from "@shared/content-production";

const mocks = vi.hoisted(() => ({
  conversation: null as any,
  conversations: [] as any[],
  create: vi.fn(() => "new-job"),
  select: vi.fn(),
  send: vi.fn(async (_prompt: string, _files?: File[], _options?: any) => true),
  retrieve: vi.fn(),
  home: vi.fn(),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  ConversationPurposeProvider: ({ children }: { children: any }) => children,
  useConversation: () => ({
    state: { conversations: mocks.conversations },
    activeConversation: mocks.conversation,
    createConversation: mocks.create,
    setActive: mocks.select,
    hydrated: true,
  }),
}));
vi.mock("@/hooks/useSendMessage", () => ({
  useSendMessage: () => ({ sendMessage: mocks.send }),
}));
vi.mock("@/lib/frontmind-api", () => ({
  retrieveTask: mocks.retrieve,
  getModelDisplayName: () => "High",
}));
vi.mock("@/pages/Home", () => ({
  default: (props: any) => {
    mocks.home(props);
    return <div data-testid="original-chat">原聊天与附件</div>;
  },
}));
import ContentProductionWorkspace, {
  contentProductionLane,
} from "./ContentProductionWorkspace";

function progress(
  overrides: Partial<ContentProductionDto> = {},
): ContentProductionDto {
  return {
    mode: "single_article",
    enterpriseName: "测试企业",
    workflowVersion: "4.11.0",
    jobKind: "article",
    runnerRevision: 7,
    workflowStatus: "awaiting_blueprint_confirmation",
    currentStage: "blueprint",
    productionStep: null,
    confirmation: "awaiting_blueprint_confirmation",
    pauseTitle: "文章蓝图确认",
    choices: ["确认蓝图", "修改蓝图", "补充材料", "返回上一步", "更换文风"],
    progressPosition: 18,
    completedConfirmations: [
      "awaiting_response_brief",
      "awaiting_pattern_confirmation",
    ],
    availableActions: ["confirm_blueprint", "revise_current_step"],
    knowledgeBase: {
      snapshotId: "snapshot",
      version: 2,
      sourceFileName: "企业资料.zip",
      documentCount: 55,
      contentHash: "hash",
    },
    source: "runner_job_state",
    ...overrides,
  };
}
function paused(
  confirmation: Confirmation,
  overrides: Partial<ContentProductionDto> = {},
) {
  mocks.conversation = {
    id: "job-1",
    title: "已保存的制作任务",
    taskId: "task-1",
    messages: [],
    status: "completed",
  };
  mocks.conversations = [
    mocks.conversation,
    { id: "job-2", title: "另一篇文章任务" },
  ];
  mocks.retrieve.mockResolvedValue({
    id: "task-1",
    status: "completed",
    contentProduction: progress({
      confirmation,
      workflowStatus: confirmation,
      availableActions: CONTENT_PRODUCTION_CONFIRMATION_ACTIONS[confirmation],
      ...overrides,
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.conversation = null;
  mocks.conversations = [];
  mocks.send.mockResolvedValue(true);
  mocks.retrieve.mockResolvedValue({
    id: "task-1",
    purpose: "content_production",
    status: "completed",
    model: "frontmind-base",
    contentProduction: progress(),
  });
});

describe("内容制作 v4.11 原流程界面", () => {
  it("offers the four native entries before brand inputs, and waits for an active new conversation before dispatching once", async () => {
    const view = render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(4);
    expect(
      within(dialog).getByRole("radio", { name: /创建或导入 P0/ }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("radio", { name: /^导入 P0/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /撰写单问题文章/ }));
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByLabelText("正式问题"), {
      target: { value: "这个产品适用于哪些场景？" },
    });
    fireEvent.change(screen.getByLabelText("问题编号（可选）"), {
      target: { value: "q123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "content_production",
        reuseEmpty: false,
      }),
    );
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.conversation = {
      id: "new-job",
      title: "测试企业 · 单问题文章",
      messages: [],
      status: "idle",
    };
    mocks.conversations = [mocks.conversation];
    view.rerender(<ContentProductionWorkspace />);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.send).toHaveBeenCalledWith(
      expect.stringContaining("这个产品适用于哪些场景？"),
      [],
      expect.objectContaining({
        purpose: "content_production",
        contentProduction: expect.objectContaining({
          mode: "single_article",
          enterpriseName: "测试企业",
          knowledgeSource: "published",
          questionId: "q123",
          question: "这个产品适用于哪些场景？",
        }),
      }),
    );
    expect(mocks.send.mock.calls[0][2].contentProduction).not.toHaveProperty(
      "entry",
    );
    view.rerender(<ContentProductionWorkspace />);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("starts the native P0 route without prematurely requiring uploaded materials", async () => {
    const view = render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.click(screen.getByRole("radio", { name: /创建或导入 P0/ }));
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByLabelText("企业资料来源"), {
      target: { value: "files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    mocks.conversation = {
      id: "new-job",
      title: "测试企业 · 创建或导入 P0",
      messages: [],
      status: "idle",
    };
    mocks.conversations = [mocks.conversation];
    view.rerender(<ContentProductionWorkspace />);
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("请先展示本任务的原始路由或资料输入步骤"),
        [],
        expect.objectContaining({
          contentProduction: expect.objectContaining({
            mode: "p0",
            knowledgeSource: "files",
          }),
        }),
      ),
    );
  });

  it("accepts an existing question ID without demanding the same question text again", () => {
    render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.click(screen.getByRole("radio", { name: /撰写单问题文章/ }));
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByLabelText("问题编号（可选）"), {
      target: { value: "q-existing" },
    });
    expect(
      (screen.getByLabelText("正式问题") as HTMLTextAreaElement).required,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("preserves original chat, frozen sources, multiple jobs and highest lane position while allowing an earlier Pattern correction", async () => {
    paused("awaiting_pattern_confirmation", {
      currentStage: "E2",
      progressPosition: 18,
    });
    const { container } = render(<ContentProductionWorkspace />);
    await screen.findByRole("button", { name: "确认文章类型" });
    expect(
      container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("确认文章蓝图");
    expect(screen.getByText("企业知识库 v2 · 55 份资料")).toBeTruthy();
    expect(screen.getByTestId("original-chat")).toBeTruthy();
    expect(mocks.home).toHaveBeenLastCalledWith(
      expect.objectContaining({
        purpose: "content_production",
        hideSidebar: true,
        showKnowledgeBaseStarter: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认文章类型" }));
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("采用的文章类型"), {
      target: { value: "P02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认文章类型" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("P02"),
        [],
        {
          contentProductionAction: {
            kind: "confirm_pattern",
            revision: 7,
            selectedPattern: "P02",
          },
        },
      ),
    );
    fireEvent.change(screen.getByLabelText("选择内容制作任务"), {
      target: { value: "job-2" },
    });
    expect(mocks.select).toHaveBeenCalledWith("job-2");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "awaiting_reference_pack_route",
      "使用已有 Reference Pack",
      "choose_reference_pack_route",
      "use",
    ],
    [
      "awaiting_reference_pack_route",
      "创建新的 Reference Pack",
      "choose_reference_pack_route",
      "create",
    ],
    ["awaiting_p0_route", "新建 P0", "choose_p0_route", "create"],
    ["awaiting_p0_route", "导入已有 P0", "choose_p0_route", "import"],
    [
      "awaiting_p0_example_confirmation",
      "采用完整例文文风",
      "choose_p0_examples",
      "top20",
    ],
    [
      "awaiting_p0_example_confirmation",
      "仅用工作流写作规范",
      "choose_p0_examples",
      "workflow",
    ],
    [
      "awaiting_example_confirmation",
      "方案 A：Top20 文风",
      "choose_examples",
      "A",
    ],
    [
      "awaiting_example_confirmation",
      "方案 B：AI 答案文风",
      "choose_examples",
      "B",
    ],
  ] as const)(
    "honors the explicit %s choice %s without inventing a default",
    async (pause, label, kind, route) => {
      paused(pause);
      render(<ContentProductionWorkspace />);
      fireEvent.click(await screen.findByRole("button", { name: label }));
      await waitFor(() =>
        expect(mocks.send).toHaveBeenCalledWith(expect.any(String), [], {
          contentProductionAction: { kind, revision: 7, route },
        }),
      );
    },
  );

  it("submits competitor names and roles as dialogue, then requires the updated scope to be shown before confirming it", async () => {
    paused("awaiting_competitor_selection", {
      mode: "new_reference_pack",
      jobKind: "reference_pack",
      progressPosition: 4,
      pauseTitle: "确认本次要与哪些选择区分",
    });
    const view = render(<ContentProductionWorkspace />);
    fireEvent.change(await screen.findByLabelText("本次比较范围"), {
      target: { value: "A 为比较对象，B 只作同类举例，C 不纳入。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认当前比较范围" }));
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更新比较对象与角色" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("B 只作同类举例"),
        [],
        {
          contentProductionAction: {
            kind: "update_competitor_selection",
            revision: 7,
            selection: "A 为比较对象，B 只作同类举例，C 不纳入。",
          },
        },
      ),
    );
    paused("awaiting_competitor_selection", {
      runnerRevision: 8,
      progressPosition: 4,
    });
    mocks.conversation.messages = [{ id: "updated-scope" }];
    view.rerender(<ContentProductionWorkspace />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("本次比较范围") as HTMLTextAreaElement).value,
      ).toBe(""),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认当前比较范围" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith(
        expect.stringContaining("这不是最终定位确认"),
        [],
        {
          contentProductionAction: { kind: "confirm_competitors", revision: 8 },
        },
      ),
    );
  });

  it("requires both explicit E1 response requirements and a brand recognition judgment", async () => {
    paused("awaiting_response_brief");
    render(<ContentProductionWorkspace />);
    const send = await screen.findByRole("button", {
      name: "提交应答要求与品牌认知判断",
    });
    fireEvent.click(send);
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "本题无额外企业应答要求" }),
    );
    fireEvent.click(send);
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByLabelText("两篇 AI 答案中的品牌认知是否充分？"),
      { target: { value: "insufficient" } },
    );
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("无额外要求"),
        [],
        {
          contentProductionAction: {
            kind: "submit_response_brief",
            revision: 7,
            noExtraRequirements: true,
            aiBrandRecognition: "insufficient",
          },
        },
      ),
    );
  });

  it.each([
    [
      "awaiting_reference_pack_input",
      "企业材料或 Reference Pack",
      "provide_reference_pack_inputs",
    ],
    [
      "awaiting_question_research_inputs",
      "本题 AI 答案或更新后的 Reference Pack",
      "provide_question_research_inputs",
    ],
  ] as const)(
    "retains original attachments and source explanations at %s",
    async (pause, label, kind) => {
      paused(pause);
      render(<ContentProductionWorkspace />);
      const answer = new File(["完整 AI 答案"], "answer-platform-one.md", {
        type: "text/markdown",
      });
      fireEvent.change(await screen.findByLabelText(label), {
        target: { files: [answer] },
      });
      fireEvent.change(screen.getByLabelText("资料说明"), {
        target: { value: "该文件来自平台一，平台二的完整答案已在上一轮提供。" },
      });
      fireEvent.click(screen.getByRole("button", { name: "提交资料并继续" }));
      await waitFor(() =>
        expect(mocks.send).toHaveBeenCalledWith(
          expect.stringContaining("平台二的完整答案已在上一轮提供"),
          [answer],
          { contentProductionAction: { kind, revision: 7 } },
        ),
      );
    },
  );

  it.each([
    "awaiting_p0_blueprint_confirmation",
    "awaiting_blueprint_confirmation",
  ] as const)(
    "submits revisions at %s without claiming the changed blueprint is already confirmed",
    async (pause) => {
      paused(pause);
      render(<ContentProductionWorkspace />);
      fireEvent.change(await screen.findByLabelText("蓝图调整（可选）"), {
        target: { value: "把适用条件放到开头。" },
      });
      fireEvent.click(screen.getByRole("button", { name: "提交蓝图修改" }));
      await waitFor(() =>
        expect(mocks.send).toHaveBeenCalledWith(
          expect.stringContaining("再次展示供我确认"),
          [],
          {
            contentProductionAction: {
              kind:
                pause === "awaiting_p0_blueprint_confirmation"
                  ? "confirm_p0_blueprint"
                  : "confirm_blueprint",
              revision: 7,
              blueprintEdits: "把适用条件放到开头。",
            },
          },
        ),
      );
      expect(screen.queryByLabelText("标题数量")).toBeNull();
    },
  );

  it.each([
    [
      "awaiting_core_positioning_confirmation",
      "确认核心定位并导出资料包",
      "confirm_core_positioning",
    ],
    [
      "awaiting_question_positioning_confirmation",
      "确认本题差异化定位",
      "confirm_question_positioning",
    ],
  ] as const)(
    "keeps %s a separate business decision",
    async (pause, label, kind) => {
      paused(pause);
      render(<ContentProductionWorkspace />);
      fireEvent.click(await screen.findByRole("button", { name: label }));
      await waitFor(() =>
        expect(mocks.send).toHaveBeenCalledWith(expect.any(String), [], {
          contentProductionAction: { kind, revision: 7 },
        }),
      );
    },
  );

  it("allows an explicit legacy direction choice and free-form changes with supplemental files", async () => {
    paused("awaiting_core_positioning_direction");
    render(<ContentProductionWorkspace />);
    fireEvent.change(await screen.findByLabelText("选择定位方向"), {
      target: { value: "方向二" },
    });
    fireEvent.click(screen.getByRole("button", { name: "采用所选定位方向" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("方向二"),
        [],
        {
          contentProductionAction: {
            kind: "choose_core_positioning_direction",
            revision: 7,
            direction: "方向二",
          },
        },
      ),
    );
    fireEvent.click(screen.getByText("修改、补充材料或重新选择"));
    fireEvent.change(screen.getByLabelText("本轮调整说明"), {
      target: { value: "返回比较对象，将 B 改为同类举例。" },
    });
    const file = new File(["补充事实"], "facts.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("补充材料（可选）"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交调整并重新展示" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith(
        expect.stringContaining("返回比较对象"),
        [file],
        {
          contentProductionAction: {
            kind: "revise_current_step",
            revision: 7,
            instructions: "返回比较对象，将 B 改为同类举例。",
          },
        },
      ),
    );
  });

  it("ignores a late older status read instead of replacing a new pause or moving the lane backward", async () => {
    let older!: (value: unknown) => void;
    let newer!: (value: unknown) => void;
    paused("awaiting_blueprint_confirmation");
    mocks.retrieve
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            older = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newer = resolve;
          }),
      );
    const view = render(<ContentProductionWorkspace />);
    mocks.conversation = {
      ...mocks.conversation,
      messages: [{ id: "new-reply" }],
    };
    view.rerender(<ContentProductionWorkspace />);
    await waitFor(() => expect(mocks.retrieve).toHaveBeenCalledTimes(2));
    await act(async () =>
      newer({
        id: "task-1",
        status: "completed",
        contentProduction: progress({
          progressPosition: 19,
          runnerRevision: 9,
          currentStage: "article_production",
          confirmation: null,
          availableActions: [],
        }),
      }),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[aria-current="step"]')?.textContent,
      ).toContain("正文与最终交付"),
    );
    await act(async () =>
      older({
        id: "task-1",
        status: "completed",
        contentProduction: progress(),
      }),
    );
    expect(
      screen.queryByRole("button", { name: "确认蓝图，开始正文" }),
    ).toBeNull();
    expect(
      view.container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("正文与最终交付");
    expect(screen.queryByLabelText("标题数量")).toBeNull();
  });

  it("shows real intermediate Pack progress without claiming the original P0 or article goal has finished", async () => {
    paused("awaiting_core_positioning_confirmation", {
      mode: "p0",
      jobKind: "reference_pack",
      progressPosition: 7,
      workflowStatus: "positioning_ready",
      confirmation: null,
      availableActions: [],
    });
    const view = render(<ContentProductionWorkspace />);
    await screen.findByText("企业知识库 v2 · 55 份资料");
    expect(
      view.container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("交付 Reference Pack");
    expect(screen.queryByText("本次任务已完成")).toBeNull();
    expect(contentProductionLane("p0").map((step) => step.title)).toContain(
      "确认 P0 蓝图",
    );
    expect(contentProductionLane("import_foundation")).toEqual(
      contentProductionLane("p0"),
    );
    expect(
      contentProductionLane("single_article").map((step) => step.title),
    ).not.toContain("候选优化");
  });
});
