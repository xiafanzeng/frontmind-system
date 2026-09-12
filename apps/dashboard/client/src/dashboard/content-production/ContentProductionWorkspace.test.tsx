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
import { getUnsavedWorkspaceDrafts } from "@/lib/workspace-navigation-guard";

const mocks = vi.hoisted(() => ({
  conversation: null as any,
  conversations: [] as any[],
  hydrated: true,
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
    hydrated: mocks.hydrated,
  }),
}));
vi.mock("@/hooks/useSendMessage", () => ({
  useSendMessage: () => ({ sendMessage: mocks.send }),
}));
vi.mock("@/lib/frontmind-api", () => ({
  retrieveTask: mocks.retrieve,
  getModelDisplayName: () => "High",
}));
vi.mock("@/components/FilePreview", () => ({
  default: ({ file }: any) => <div data-testid="deliverable">{file.name}</div>,
}));
vi.mock("@/pages/Home", () => ({
  default: (props: any) => {
    mocks.home(props);
    return (
      <div data-testid="original-chat">
        原聊天与附件{props.conversationFooter}
      </div>
    );
  },
}));
import ContentProductionWorkspace, {
  contentProductionLane,
  contentProductionFinished,
  contentArtifactUrl,
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
    pauseTitle: "文章写作方案确认",
    choices: [
      "确认写作方案",
      "修改写作方案",
      "补充材料",
      "返回上一步",
      "更换文风",
    ],
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
  mocks.hydrated = true;
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
  it("does not expose the frozen model effort in a historical production task", async () => {
    paused("awaiting_blueprint_confirmation");
    render(<ContentProductionWorkspace />);
    await screen.findByText("FrontMind 内容智能体");
    expect(screen.queryByText(/\b(Low|High|Max)\b/)).not.toBeInTheDocument();
  });

  it("offers the four native entries before brand inputs, and waits for an active new conversation before dispatching once", async () => {
    const view = render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(4);
    expect(
      within(dialog).getByRole("radio", { name: /制作品牌深度文章/ }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("radio", { name: /^导入 P0/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /围绕问题写文章/ }));
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
    fireEvent.click(screen.getByRole("radio", { name: /制作品牌深度文章/ }));
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
      title: "测试企业 · 制作品牌深度文章",
      messages: [],
      status: "idle",
    };
    mocks.conversations = [mocks.conversation];
    view.rerender(<ContentProductionWorkspace />);
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("请先展示本任务的资料选择步骤"),
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
    fireEvent.click(screen.getByRole("radio", { name: /围绕问题写文章/ }));
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
    ).toContain("确认文章写作方案");
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
        expect.stringContaining("多对象推荐与选择指南"),
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
      "使用已有品牌资料包",
      "choose_reference_pack_route",
      "use",
    ],
    [
      "awaiting_reference_pack_route",
      "创建新的品牌资料包",
      "choose_reference_pack_route",
      "create",
    ],
    ["awaiting_p0_route", "新建品牌文章", "choose_p0_route", "create"],
    ["awaiting_p0_route", "导入已有品牌文章", "choose_p0_route", "import"],
    [
      "awaiting_p0_example_confirmation",
      "采用完整例文文风",
      "choose_p0_examples",
      "top20",
    ],
    [
      "awaiting_p0_example_confirmation",
      "使用默认写作规范",
      "choose_p0_examples",
      "workflow",
    ],
    ["awaiting_example_confirmation", "参考例文的文风", "choose_examples", "A"],
    [
      "awaiting_example_confirmation",
      "参考 AI 答案的文风",
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
      "企业材料或品牌资料包",
      "provide_reference_pack_inputs",
    ],
    [
      "awaiting_question_research_inputs",
      "本题 AI 答案或更新后的品牌资料包",
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
      fireEvent.change(await screen.findByLabelText("写作方案调整（可选）"), {
        target: { value: "把适用条件放到开头。" },
      });
      fireEvent.click(screen.getByRole("button", { name: "提交写作方案修改" }));
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
      screen.queryByRole("button", { name: "确认写作方案，开始正文" }),
    ).toBeNull();
    expect(
      view.container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("正文与最终交付");
    expect(screen.queryByLabelText("标题数量")).toBeNull();
  });

  it("finishes the actual Pack job and requires a separate article task without claiming the original P0 goal has finished", async () => {
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
    expect(view.container.querySelector('[aria-current="step"]')).toBeNull();
    expect(screen.getByText("品牌资料包已完成")).toBeInTheDocument();
    expect(
      screen.getByText(/本次选择先创建资料包，文章尚未制作/),
    ).toBeInTheDocument();
    expect(
      contentProductionLane("p0", "reference_pack").map((step) => step.title),
    ).not.toContain("确认品牌文章写作方案");
    expect(screen.queryByText("本次任务已完成")).toBeNull();
    expect(contentProductionLane("p0").map((step) => step.title)).toContain(
      "确认品牌文章写作方案",
    );
    expect(contentProductionLane("import_foundation")).toEqual(
      contentProductionLane("p0"),
    );
    expect(
      contentProductionLane("single_article").map((step) => step.title),
    ).not.toContain("候选优化");
  });
});

describe("内容任务隔离与交付复用", () => {
  it("recognizes only authoritative terminal jobs, including P0, and does not confuse a completed turn with a completed job", () => {
    expect(
      contentProductionFinished(
        progress({
          jobKind: "p0",
          workflowStatus: "p0_ready",
          confirmation: null,
        }),
      ),
    ).toBe(true);
    expect(
      contentProductionFinished(
        progress({
          jobKind: "reference_pack",
          workflowStatus: "positioning_ready",
          confirmation: null,
        }),
      ),
    ).toBe(true);
    expect(
      contentProductionFinished(
        progress({
          jobKind: "article",
          workflowStatus: "completed",
          confirmation: null,
        }),
      ),
    ).toBe(true);
    expect(
      contentProductionFinished(
        progress({
          jobKind: "p0",
          workflowStatus: "positioning_ready",
          confirmation: null,
        }),
      ),
    ).toBe(false);
    expect(
      contentProductionFinished(progress({ workflowStatus: "completed" })),
    ).toBe(false);
    expect(
      contentProductionFinished(
        progress({
          workflowStatus: "completed",
          confirmation: null,
          source: "awaiting_runner",
        }),
      ),
    ).toBe(false);
  });

  it("accepts only owned same-origin artifact URLs for results and Pack handoff", () => {
    expect(
      contentArtifactUrl(
        "/api/frontmind/v2/artifacts/owned-opaque/content?enterpriseProjectId=project",
      ),
    ).toBe(
      "/api/frontmind/v2/artifacts/owned-opaque/content?enterpriseProjectId=project",
    );
    expect(
      contentArtifactUrl(
        "https://attacker.test/api/frontmind/v2/artifacts/owned/content",
      ),
    ).toBeNull();
    expect(
      contentArtifactUrl("/api/frontmind/v2/artifacts/owned/other"),
    ).toBeNull();
    expect(contentArtifactUrl("javascript:alert(1)")).toBeNull();
  });

  it("does not briefly expose the previous task confirmation while the next task status is loading", async () => {
    paused("awaiting_blueprint_confirmation");
    const view = render(<ContentProductionWorkspace />);
    await screen.findByRole("button", { name: "确认写作方案，开始正文" });
    const firstSignal = mocks.retrieve.mock.calls[0][1].signal as AbortSignal;
    let resolveNext!: (value: unknown) => void;
    mocks.retrieve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );
    mocks.conversation = {
      id: "job-2",
      taskId: "task-2",
      title: "第二任务",
      messages: [],
      status: "completed",
    };
    view.rerender(<ContentProductionWorkspace />);
    expect(
      screen.queryByRole("button", { name: "确认写作方案，开始正文" }),
    ).toBeNull();
    expect(firstSignal.aborted).toBe(true);
    await act(async () =>
      resolveNext({
        id: "task-1",
        purpose: "content_production",
        status: "completed",
        contentProduction: progress(),
      }),
    );
    expect(
      await screen.findByText("任务状态与当前内容任务不匹配，请重新读取。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认写作方案，开始正文" }),
    ).toBeNull();
  });

  it("retains startup text and files when sending fails instead of silently discarding the new task", async () => {
    mocks.send.mockResolvedValue(false);
    const view = render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.click(screen.getByRole("radio", { name: /制作品牌深度文章/ }));
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "保留企业" },
    });
    const file = new File(["企业材料"], "company.md", {
      type: "text/markdown",
    });
    fireEvent.change(screen.getByLabelText(/上传材料或品牌资料包/), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    mocks.conversation = {
      id: "new-job",
      title: "保留任务",
      messages: [],
      status: "idle",
    };
    mocks.conversations = [mocks.conversation];
    view.rerender(<ContentProductionWorkspace />);
    expect(await screen.findByText("查看已保留的开场信息")).toBeInTheDocument();
    expect(screen.getByText("文件：company.md")).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    view.rerender(<ContentProductionWorkspace />);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const originalArgs = mocks.send.mock.calls[0];
    mocks.send.mockResolvedValue(true);
    fireEvent.click(screen.getByText("查看已保留的开场信息"));
    fireEvent.click(screen.getByRole("button", { name: "重试本次开场请求" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]).toEqual(originalArgs);
    expect(mocks.send.mock.calls[1][1]?.[0]).toBe(file);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("查看已保留的开场信息")).toBeNull();
  });

  it("requires explicit Pack selection, fetches owned ZIP bytes, and starts a separate P0 task with that original File", async () => {
    paused("awaiting_core_positioning_confirmation", {
      mode: "new_reference_pack",
      jobKind: "reference_pack",
      workflowStatus: "positioning_ready",
      confirmation: null,
      availableActions: [],
      progressPosition: 7,
    });
    mocks.conversation.messages = [
      {
        id: "pack-output",
        role: "assistant",
        content: "资料包已交付",
        outputFiles: [
          {
            fileUrl: "/api/frontmind/v2/artifacts/pack/content",
            fileName: "Reference_Pack_v5.zip",
            mimeType: "application/zip",
          },
          {
            fileUrl: "/api/frontmind/v2/artifacts/private/content",
            fileName: "frontmind_workflow_job_snapshot_123.zip",
            mimeType: "application/zip",
          },
          {
            fileUrl: "https://provider.test/private.zip",
            fileName: "private.zip",
            mimeType: "application/zip",
          },
        ],
      },
    ];
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const view = render(<ContentProductionWorkspace />);
      const next = await screen.findByRole("button", {
        name: "使用此资料包制作品牌文章",
      });
      expect(next).toBeDisabled();
      expect(screen.getAllByTestId("deliverable")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText("用于下一任务的资料包"), {
        target: { value: "/api/frontmind/v2/artifacts/pack/content" },
      });
      fireEvent.click(next);
      const dialog = await screen.findByRole("dialog");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "/api/frontmind/v2/artifacts/pack/content",
      );
      expect(
        within(dialog).getByRole("radio", { name: /制作品牌深度文章/ }),
      ).toBeChecked();
      expect(within(dialog).getByLabelText("企业名称")).toHaveValue("测试企业");
      expect(
        within(dialog).getByText(/已带入资料包：品牌资料包_v5.zip/),
      ).toBeInTheDocument();
      expect(mocks.create).not.toHaveBeenCalled();
      const supplement = new File(["补充企业事实"], "supplement.pdf", {
        type: "application/pdf",
      });
      fireEvent.change(within(dialog).getByLabelText(/补充企业材料/), {
        target: { files: [supplement] },
      });
      expect(
        within(dialog).getByText(
          /已选择：Reference_Pack_v5.zip、supplement.pdf/,
        ),
      ).toBeInTheDocument();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "创建并开始" }),
      );
      mocks.conversation = {
        id: "new-job",
        title: "新的 P0",
        messages: [],
        status: "idle",
      };
      mocks.conversations.push(mocks.conversation);
      view.rerender(<ContentProductionWorkspace />);
      await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
      const [prompt, files, options] = mocks.send.mock.calls[0];
      expect(prompt).toContain("Reference_Pack_v5.zip");
      expect(files?.[0]).toBeInstanceOf(File);
      expect(files?.[0].name).toBe("Reference_Pack_v5.zip");
      expect(files).toHaveLength(2);
      expect(files?.[1]).toBe(supplement);
      expect(options.contentProduction).toMatchObject({
        mode: "p0",
        knowledgeSource: "files",
      });
      expect(options).not.toHaveProperty("contentProductionAction");
      expect(options.contentProduction).not.toHaveProperty(
        "referencePackRoute",
      );
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reuseEmpty: false,
          purpose: "content_production",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("locks the opposite composer during a confirmation submission and preserves fields on failure", async () => {
  paused("awaiting_blueprint_confirmation");
  let finish!: (value: boolean) => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<ContentProductionWorkspace />);
  fireEvent.change(await screen.findByLabelText("写作方案调整（可选）"), {
    target: { value: "保留这个修改" },
  });
  const button = screen.getByRole("button", { name: "提交写作方案修改" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.home).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operatorWorkspace: true,
      knowledgeEditingBlocked: true,
    }),
  );
  await act(async () => finish(false));
  expect(screen.getByLabelText("写作方案调整（可选）")).toHaveValue(
    "保留这个修改",
  );
  expect(mocks.home).toHaveBeenLastCalledWith(
    expect.objectContaining({ knowledgeEditingBlocked: false }),
  );
});

it("shows neutral loading for an unknown historical task instead of inventing Reference Pack stages", async () => {
  paused("awaiting_blueprint_confirmation");
  let finish!: (value: unknown) => void;
  mocks.retrieve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<ContentProductionWorkspace />);
  expect(screen.getByText("正在读取任务信息")).toBeInTheDocument();
  expect(
    screen.getByText("制作阶段将在本任务的信息读取后显示。"),
  ).toBeInTheDocument();
  expect(screen.queryByText("交付品牌资料包")).toBeNull();
  expect(view.container.querySelector('[aria-current="step"]')).toBeNull();
  await act(async () =>
    finish({
      id: "task-1",
      status: "completed",
      purpose: "content_production",
      contentProduction: progress(),
    }),
  );
  expect(
    await screen.findByRole("button", { name: "确认写作方案，开始正文" }),
  ).toBeInTheDocument();
  expect(
    view.container.querySelector('[aria-current="step"]')?.textContent,
  ).toContain("确认文章写作方案");
});

it("places native chat and actionable stage confirmation in main, keeping only a summary at right", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  paused("awaiting_blueprint_confirmation");
  render(<ContentProductionWorkspace workbench projectId="project-1" />);
  const main = screen.getByRole("region", { name: "主工作区" });
  expect(within(main).getByTestId("original-chat")).toBeInTheDocument();
  expect(
    await within(main).findByRole("button", { name: "确认写作方案，开始正文" }),
  ).toBeInTheDocument();
  const auxiliary = screen.getByRole("complementary", { name: "任务辅助区" });
  expect(
    within(auxiliary).queryByRole("button", { name: "确认写作方案，开始正文" }),
  ).toBeNull();
  expect(within(auxiliary).queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: "选择内容制作任务" }),
  ).toBeNull();
  expect(within(main).queryByRole("button", { name: "新任务" })).toBeNull();
  expect(within(main).queryByRole("button", { name: "历史" })).toBeNull();
  expect(
    within(auxiliary).getByRole("tab", { name: "交付文件" }),
  ).toBeInTheDocument();
  fireEvent.click(within(auxiliary).getByRole("tab", { name: "任务中心" }));
  expect(within(main).getByTestId("original-chat")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "已有任务" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "已有任务" }));
  expect(screen.getByRole("listbox", { name: "已有任务" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "新建任务" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "新建任务" }));
  fireEvent.click(screen.getByRole("button", { name: /新建品牌资料包/ }));
  expect(
    screen.queryByRole("heading", { name: "本次要完成什么？" }),
  ).toBeNull();
  expect(
    screen.getByText("当前工作：新建品牌资料包"),
  ).toBeInTheDocument();
});

it("enters the content workspace without a modal before or after recovery, and opens it only from a chosen task", () => {
  mocks.hydrated = false;
  const view = render(<ContentProductionWorkspace workbench />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建品牌资料包/ })).toBeDisabled();

  mocks.hydrated = true;
  view.rerender(<ContentProductionWorkspace workbench />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /新建品牌资料包/ }));
  expect(screen.getByRole("dialog", { name: "内容任务中心" })).toBeInTheDocument();
  expect(screen.getByLabelText("企业名称")).toBeInTheDocument();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭任务中心" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本次要完成什么？" })).toBeInTheDocument();
});

it("preserves an unsubmitted task and its original files when cancelled, closed with Escape, and reopened", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const file = new File(["企业事实"], "企业材料.txt", { type: "text/plain" });
  const view = render(<ContentProductionWorkspace workbench />);
  fireEvent.click(screen.getByRole("button", { name: /围绕问题写文章/ }));
  fireEvent.change(screen.getByLabelText("企业名称"), { target: { value: "保留的企业" } });
  fireEvent.change(screen.getByLabelText("正式问题"), { target: { value: "产品如何用于日常工作？" } });
  fireEvent.change(screen.getByLabelText("企业资料来源"), { target: { value: "files" } });
  fireEvent.change(screen.getByLabelText(/^上传材料或品牌资料包/), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(getUnsavedWorkspaceDrafts().some((draft) => draft.label === "新建内容任务")).toBe(true);

  const trigger = screen.getByRole("tab", { name: "任务中心" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("tab", { name: "新建任务" }));
  expect(screen.getByLabelText("企业名称")).toHaveValue("保留的企业");
  expect(screen.getByLabelText("正式问题")).toHaveValue("产品如何用于日常工作？");
  expect(screen.getByLabelText("企业资料来源")).toHaveValue("files");
  expect(screen.getByText("已选择：企业材料.txt")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());

  fireEvent.click(screen.getByRole("button", { name: /围绕问题写文章/ }));
  expect(screen.getByLabelText("企业名称")).toHaveValue("保留的企业");
  fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  mocks.conversation = { id: "new-job", title: "保留的企业 · 单问题文章", messages: [], status: "idle" };
  mocks.conversations = [mocks.conversation];
  view.rerender(<ContentProductionWorkspace workbench />);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][1]?.[0]).toBe(file);
  expect(mocks.send.mock.calls[0][2].contentProduction).toMatchObject({
    enterpriseName: "保留的企业", question: "产品如何用于日常工作？", knowledgeSource: "files",
  });
});

it("manually restores an existing task by reading its original taskId without creating or submitting another task", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  paused("awaiting_blueprint_confirmation");
  mocks.conversations[1] = { id: "job-2", taskId: "task-2", title: "另一篇文章任务", messages: [], status: "completed", updatedAt: Date.now() };
  const view = render(<ContentProductionWorkspace workbench />);
  await waitFor(() => expect(mocks.retrieve).toHaveBeenCalledWith("task-1", expect.anything()));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "任务中心" }));
  fireEvent.click(screen.getByRole("button", { name: /另一篇文章任务/ }));
  expect(mocks.select).toHaveBeenCalledWith("job-2");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  mocks.conversation = mocks.conversations[1];
  mocks.retrieve.mockResolvedValue({ id: "task-2", purpose: "content_production", status: "completed", contentProduction: progress() });
  view.rerender(<ContentProductionWorkspace workbench />);
  await waitFor(() => expect(mocks.retrieve).toHaveBeenCalledWith("task-2", expect.anything()));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
