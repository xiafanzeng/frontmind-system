import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentProductionDto } from "@shared/content-production";

const mocks = vi.hoisted(() => ({
  conversation: null as any,
  conversations: [] as any[],
  create: vi.fn(() => "new-job"),
  select: vi.fn(),
  send: vi.fn(async () => true),
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
    workflowVersion: "2.3.0",
    workflowStatus: "awaiting_blueprint_confirmation",
    currentStage: "E4",
    confirmation: "awaiting_blueprint_confirmation",
    progressPosition: 13,
    completedConfirmations: [
      "awaiting_research_inputs",
      "awaiting_pattern_confirmation",
    ],
    availableActions: ["confirm_blueprint"],
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conversation = null;
  mocks.conversations = [];
  mocks.retrieve.mockResolvedValue({
    id: "task-1",
    purpose: "content_production",
    status: "completed",
    model: "frontmind-base",
    contentProduction: progress(),
  });
});

describe("内容制作原流程界面", () => {
  it("starts a chosen task once after the newly created conversation becomes active, preserving its real inputs", async () => {
    const view = render(<ContentProductionWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /撰写单问题文章/ }));
    fireEvent.change(screen.getByLabelText("正式问题"), {
      target: { value: "这个产品适用于哪些场景？" },
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
          question: "这个产品适用于哪些场景？",
        }),
      }),
    );
    view.rerender(<ContentProductionWorkspace />);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("shows the original chat and frozen KB source, keeping the lane forward when the Runner requests an earlier confirmation", async () => {
    mocks.conversation = {
      id: "job-1",
      title: "已保存的文章任务",
      taskId: "task-1",
      messages: [],
      status: "completed",
    };
    mocks.conversations = [mocks.conversation];
    mocks.retrieve.mockResolvedValue({
      id: "task-1",
      status: "completed",
      contentProduction: progress({
        currentStage: "E2",
        confirmation: "awaiting_pattern_confirmation",
        availableActions: ["confirm_pattern"],
      }),
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
    fireEvent.change(screen.getByLabelText("采用回复中的备选（可选）"), {
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
            selectedPattern: "P02",
          },
        },
      ),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("sends the selected title count in both the visible message and the original confirmation action", async () => {
    mocks.conversation = {
      id: "job-1",
      title: "文章任务",
      taskId: "task-1",
      messages: [],
      status: "completed",
    };
    mocks.conversations = [mocks.conversation];
    mocks.retrieve.mockResolvedValue({
      id: "task-1",
      status: "completed",
      contentProduction: progress({
        currentStage: "E10",
        workflowStatus: "awaiting_title_count",
        confirmation: "awaiting_title_count",
        progressPosition: 19,
        availableActions: ["set_title_count"],
      }),
    });
    render(<ContentProductionWorkspace />);
    fireEvent.change(await screen.findByLabelText("标题数量"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成标题并完成交付" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.stringContaining("8 个"),
        [],
        { contentProductionAction: { kind: "set_title_count", titleCount: 8 } },
      ),
    );
    expect(screen.queryByText("本次任务已完成")).toBeNull();
  });

  it("ignores a late older status read instead of moving a task back to an earlier stage", async () => {
    let older!: (value: unknown) => void;
    let newer!: (value: unknown) => void;
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
    mocks.conversation = {
      id: "job-1",
      title: "文章任务",
      taskId: "task-1",
      messages: [],
      status: "running",
    };
    mocks.conversations = [mocks.conversation];
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
          currentStage: "E10",
          progressPosition: 19,
          confirmation: "awaiting_title_count",
          availableActions: ["set_title_count"],
        }),
      }),
    );
    await screen.findByLabelText("标题数量");
    await act(async () =>
      older({
        id: "task-1",
        status: "completed",
        contentProduction: progress(),
      }),
    );
    expect(screen.getByLabelText("标题数量")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "确认蓝图，开始正文" }),
    ).toBeNull();
    expect(
      view.container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("标题与最终交付");
  });

  it("does not insert article research confirmation into pack preparation or the fixed P14 foundation flow", () => {
    expect(
      contentProductionLane("new_reference_pack").map((step) => step.title),
    ).not.toContain("候选优化");
    expect(
      contentProductionLane("foundation_article").map((step) => step.title),
    ).not.toContain("研究与文章类型");
    expect(
      contentProductionLane("single_article").map((step) => step.title),
    ).toContain("研究与文章类型");
    expect(
      contentProductionLane("import_foundation").map((step) => step.title),
    ).toEqual(["导入已有底稿"]);
  });

  it("shows the import conversation outcome without inventing Runner stages or completed workflow", async () => {
    mocks.conversation = {
      id: "import-1",
      title: "导入品牌底稿",
      taskId: "task-1",
      messages: [],
      status: "completed",
    };
    mocks.conversations = [mocks.conversation];
    mocks.retrieve.mockResolvedValue({
      id: "task-1",
      status: "completed",
      contentProduction: progress({
        mode: "import_foundation",
        workflowStatus: null,
        currentStage: null,
        confirmation: null,
        progressPosition: 0,
        availableActions: [],
        source: "awaiting_runner",
      }),
    });
    render(<ContentProductionWorkspace />);
    await screen.findByText("本轮整理已结束，请查看回复与附件");
    expect(screen.getByText("导入已有底稿作为后续参考")).toBeTruthy();
    expect(screen.queryByText("交付 Reference Pack")).toBeNull();
    expect(screen.queryByText("本次任务已完成")).toBeNull();
  });
});
