import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import ChatInput from "./ChatInput";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => true),
  continueKnowledgeBaseAttachmentAttempt: vi.fn(async () => true),
  discardKnowledgeBaseAttachmentAttempt: vi.fn(),
  commitKnowledgeBaseObservation: vi.fn(),
  wakeKnowledgeBaseConversation: vi.fn(),
  rollbackPendingKnowledgeBaseTurn: vi.fn(),
  knowledgeBaseAttachmentAttempt: null as any,
  activeConversation: {
    id: "kb-conversation",
    taskId: "kb-task",
    status: "awaiting_input",
    messages: [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
      {
        id: "assistant",
        role: "assistant",
        content: "## 法定主体与成立时间\n正文",
        timestamp: 2,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-2",
          presentationKey: "presentation-2",
          revision: 2,
          leafId: "identity.legal",
        },
      },
    ],
    knowledgeBase: {
      generation: 1,
      stateEpoch: 2,
      activeTurnId: "turn-2",
      activeClientRequestId: "request-2",
      interactionState: "awaiting_input",
      canReply: true,
      presentationKey: "presentation-2",
      revision: 2,
      leafId: "identity.legal",
      notice: null,
    },
  } as any,
}));

vi.mock("@/hooks/useSendMessage", () => ({
  useSendMessage: () => ({
    sendMessage: mocks.sendMessage,
    uploadProgress: null,
    knowledgeBaseAttachmentAttempt: mocks.knowledgeBaseAttachmentAttempt,
    continueKnowledgeBaseAttachmentAttempt:
      mocks.continueKnowledgeBaseAttachmentAttempt,
    discardKnowledgeBaseAttachmentAttempt:
      mocks.discardKnowledgeBaseAttachmentAttempt,
  }),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    activeConversation: mocks.activeConversation,
    commitKnowledgeBaseObservation: mocks.commitKnowledgeBaseObservation,
    wakeKnowledgeBaseConversation: mocks.wakeKnowledgeBaseConversation,
    rollbackPendingKnowledgeBaseTurn: mocks.rollbackPendingKnowledgeBaseTurn,
  }),
  currentKnowledgeBaseReplySnapshot: (conversation: any) => {
    const state = conversation?.knowledgeBase;
    const presentationTurnId = state?.presentationTurnId ?? state?.activeTurnId;
    const matches =
      conversation?.status === "awaiting_input" &&
      state?.canReply &&
      state?.presentationKey &&
      presentationTurnId &&
      conversation.messages.some(
        (message: any) =>
          message.knowledgeBase?.kind === "presentation" &&
          message.knowledgeBase?.turnId === presentationTurnId &&
          message.knowledgeBase?.presentationKey === state.presentationKey &&
          message.knowledgeBase?.revision === state.revision &&
          message.knowledgeBase?.leafId === state.leafId,
      );
    return matches
      ? {
          generation: state.generation,
          stateEpoch: state.stateEpoch,
          revision: state.revision,
          leafId: state.leafId,
          presentationKey: state.presentationKey,
          presentationTurnId,
        }
      : null;
  },
}));

vi.mock("./KnowledgeBaseManagedUploadRecovery", () => ({
  default: () => (
    <div data-testid="knowledge-base-managed-upload-recovery">
      Dashboard 同轮附件恢复
    </div>
  ),
}));

vi.mock("@/lib/frontmind-api", () => ({
  MODEL_OPTIONS: [
    {
      value: "frontmind-pro",
      label: "FrontMind Pro",
      description: "test",
    },
  ],
  getConfig: () => ({ agentProfile: "frontmind-pro" }),
  saveConfig: vi.fn(),
}));

const progress: KnowledgeBaseProgressDto = {
  build: {
    id: "build-1",
    conversationId: "kb-conversation",
    companyName: "硅基流动",
    depthPolicy: {
      version: 1,
      minLeaves: 8,
      maxLeaves: 115,
      targetMinLeaves: 8,
      targetMaxLeaves: 115,
    },
    researchSummary: null,
    status: "confirming",
    revision: 2,
    currentLeafId: "identity.legal",
    protocolError: null,
    awaitingResponseSince: null,
    updatedAt: Date.now(),
  },
  summary: {
    total: 2,
    handled: 1,
    confirmed: 1,
    directPrefilled: 0,
    pending: 0,
    current: 1,
    needsVerification: 0,
    overallPercent: 50,
  },
  branches: [
    {
      id: "identity",
      title: "企业身份",
      total: 2,
      handled: 1,
      confirmed: 1,
      directPrefilled: 0,
      pending: 0,
      current: 1,
      needsVerification: 0,
      leaves: [
        {
          id: "identity.role",
          title: "企业定位与核心角色",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 0,
          status: "confirmed",
        },
        {
          id: "identity.legal",
          title: "法定主体与成立时间",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 1,
          status: "current",
        },
      ],
    },
  ],
  packageAllowed: false,
};

const logoRequiredProgress: KnowledgeBaseProgressDto = {
  ...progress,
  build: {
    ...progress.build,
    revision: 0,
    currentLeafId: "identity.role",
    logoRequired: true,
  },
  summary: {
    ...progress.summary,
    handled: 0,
    confirmed: 0,
    pending: 1,
    current: 1,
    overallPercent: 0,
  },
  branches: [
    {
      ...progress.branches[0]!,
      handled: 0,
      confirmed: 0,
      pending: 1,
      current: 1,
      leaves: [
        {
          ...progress.branches[0]!.leaves[0]!,
          status: "current",
        },
        {
          ...progress.branches[0]!.leaves[1]!,
          status: "pending",
        },
      ],
    },
  ],
};

const logoAvailableProgress: KnowledgeBaseProgressDto = {
  ...logoRequiredProgress,
  build: {
    ...logoRequiredProgress.build,
    revision: 1,
    logoRequired: false,
    logoAvailable: true,
  },
};

const optionalLogoProgress: KnowledgeBaseProgressDto = {
  ...logoRequiredProgress,
  build: {
    ...logoRequiredProgress.build,
    executionMode: "materialized_bundle_v1",
    logoRequired: false,
    logoAvailable: false,
  },
};

const responseLogicContext = {
  questionId: "question-1",
  groupId: "group-1",
  groupTitle: "产品场景",
  question: "硅基流动有什么核心产品？",
  intent: "了解产品线",
  summary: "基于企业事实回答",
  draft: {
    concern: "了解产品线",
    conclusion: "",
    facts: "",
    pending: "",
    boundaries: "",
    references: "",
    images: [],
    attachments: [],
  },
};

function showLogoRequiredPresentation() {
  mocks.activeConversation.messages = [
    { id: "user", role: "user", content: "开始构建", timestamp: 1 },
    {
      id: "assistant-logo-required",
      role: "assistant",
      content: "## 企业定位与核心角色\n正文",
      timestamp: 2,
      knowledgeBase: {
        kind: "presentation",
        turnId: "turn-logo-required",
        presentationKey: "presentation-logo-required",
        revision: 0,
        leafId: "identity.role",
      },
    },
  ];
  mocks.activeConversation.knowledgeBase.activeTurnId = "turn-logo-required";
  mocks.activeConversation.knowledgeBase.presentationKey =
    "presentation-logo-required";
  mocks.activeConversation.knowledgeBase.revision = 0;
  mocks.activeConversation.knowledgeBase.leafId = "identity.role";
}

describe("knowledge-base ChatInput actions", () => {
  beforeEach(() => {
    mocks.sendMessage.mockClear();
    mocks.sendMessage.mockResolvedValue(true);
    mocks.continueKnowledgeBaseAttachmentAttempt.mockClear();
    mocks.discardKnowledgeBaseAttachmentAttempt.mockClear();
    mocks.knowledgeBaseAttachmentAttempt = null;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:logo-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.activeConversation.messages = [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
      {
        id: "assistant",
        role: "assistant",
        content: "## 法定主体与成立时间\n正文",
        timestamp: 2,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-2",
          presentationKey: "presentation-2",
          revision: 2,
          leafId: "identity.legal",
        },
      },
    ];
    mocks.activeConversation.status = "awaiting_input";
    mocks.activeConversation.taskId = "kb-task";
    mocks.activeConversation.previousResponseId = undefined;
    mocks.activeConversation.knowledgeBase.initialized = true;
    mocks.activeConversation.knowledgeBase.activeTurnId = "turn-2";
    mocks.activeConversation.knowledgeBase.activeClientRequestId = "request-2";
    mocks.activeConversation.knowledgeBase.activeTurnOperationType = undefined;
    mocks.activeConversation.knowledgeBase.presentationKey = "presentation-2";
    mocks.activeConversation.knowledgeBase.revision = 2;
    mocks.activeConversation.knowledgeBase.leafId = "identity.legal";
    mocks.activeConversation.knowledgeBase.canReply = true;
    mocks.activeConversation.knowledgeBase.notice = null;
    mocks.activeConversation.knowledgeBase.activeTurnResetRevision = undefined;
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = false;
  });

  it("replaces confirmation with an official Logo picker while Logo input is required", () => {
    showLogoRequiredPresentation();

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={logoRequiredProgress}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "确认当前内容" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择 Logo 原图" }),
    ).toBeInTheDocument();
    expect(screen.getByText("需要上传企业主 Logo")).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp,image/avif,image/gif",
    );
    expect(container.querySelector('input[type="file"]')).not.toHaveAttribute(
      "multiple",
    );
  });

  it("offers an optional Logo upload and an explicit skip for materialized v5", async () => {
    showLogoRequiredPresentation();

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={optionalLogoProgress}
      />,
    );

    expect(
      screen.getByRole("button", { name: "上传 Logo（可选）" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "跳过 Logo，确认当前内容" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "上传 Logo（可选）" }));
    expect(screen.getByText("上传企业主 Logo（可选）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不上传" })).toBeEnabled();
    expect(container.querySelector('input[type="file"]')).not.toHaveAttribute(
      "multiple",
    );
    fireEvent.click(screen.getByRole("button", { name: "暂不上传" }));
    fireEvent.click(
      screen.getByRole("button", { name: "跳过 Logo，确认当前内容" }),
    );

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "确认",
        [],
        expect.objectContaining({
          syncKnowledgeBaseSnapshot: true,
          submissionKind: undefined,
        }),
      ),
    );
  });

  it("hides the ordinary composer while the official Logo upload gate is active", () => {
    showLogoRequiredPresentation();

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={logoRequiredProgress}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(container.querySelector("button svg.lucide-send")).toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("submits one supported image without advancing or confirming the current leaf", async () => {
    showLogoRequiredPresentation();

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={logoRequiredProgress}
      />,
    );
    const logo = new File(["official-logo"], "official-logo.png", {
      type: "image/png",
    });

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [logo] },
    });
    expect(screen.getByText("official-logo.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用此图并继续" }));

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "",
        [logo],
        expect.objectContaining({
          syncKnowledgeBaseSnapshot: true,
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 0,
          knowledgeBaseExpectedLeafId: "identity.role",
          knowledgeBaseExpectedPresentationKey: "presentation-logo-required",
          submissionKind: "logo",
        }),
      ),
    );
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(
      "确认",
      expect.anything(),
      expect.anything(),
    );
  });

  it("replaces an existing first-leaf Logo through the same single-action gate and keeps the preview after failure", async () => {
    showLogoRequiredPresentation();
    const presentation = mocks.activeConversation.messages[1]!.knowledgeBase;
    presentation.revision = 1;
    mocks.activeConversation.knowledgeBase.revision = 1;
    mocks.sendMessage.mockResolvedValueOnce(false);

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={logoAvailableProgress}
      />,
    );

    expect(screen.getByRole("button", { name: "更换 Logo" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更换 Logo" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(container.querySelector("button svg.lucide-send")).toBeNull();

    const replacement = new File(["replacement"], "replacement.png", {
      type: "image/png",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [replacement] },
    });
    expect(
      screen.getByRole("img", { name: "待提交 Logo 预览" }),
    ).toHaveAttribute("src", "blob:logo-preview");
    fireEvent.click(screen.getByRole("button", { name: "使用此图并继续" }));

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "",
        [replacement],
        expect.objectContaining({
          submissionKind: "logo",
          knowledgeBaseExpectedRevision: 1,
          knowledgeBaseExpectedLeafId: "identity.role",
          knowledgeBaseExpectedPresentationKey: "presentation-logo-required",
        }),
      ),
    );
    expect(screen.getByText("replacement.png")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "使用此图并继续" }),
    ).toBeEnabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("uses only FrontMind copy while an accepted Logo is being sent", async () => {
    showLogoRequiredPresentation();
    const presentation = mocks.activeConversation.messages[1]!.knowledgeBase;
    presentation.revision = 1;
    mocks.activeConversation.knowledgeBase.revision = 1;
    let resolveSend!: (sent: boolean) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      }),
    );

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={logoAvailableProgress}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更换 Logo" }));
    expect(
      screen.getByText(
        "Logo 提交轮不会推进节点；FrontMind 接收后会重新呈现当前节点。",
      ),
    ).toBeInTheDocument();

    const replacement = new File(["replacement"], "replacement.png", {
      type: "image/png",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [replacement] },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用此图并继续" }));

    expect(
      await screen.findByRole("button", {
        name: "正在发送至 FrontMind",
      }),
    ).toBeDisabled();
    expect(screen.queryByText(/Manus/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveSend(true);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "更换 Logo" })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "待提交 Logo 预览" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("replacement.png")).not.toBeInTheDocument();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not allow another confirmation until the current presentation renders", () => {
    mocks.activeConversation.messages = [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
    ];

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(
      screen.getByText("正在处理当前节点内容，显示完整后才可确认。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
  });

  it("shows the authoritative current node and sends strict quick actions", async () => {
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseResetRevision={9}
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByText("当前待确认")).toBeInTheDocument();
    expect(screen.getByText(/法定主体与成立时间/)).toBeInTheDocument();
    expect(
      screen.getByText(/建议尽量上传与当前部分相关的补充图片/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /直接预填/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认当前内容" }));

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "确认",
        [],
        expect.objectContaining({
          syncKnowledgeBaseSnapshot: true,
          knowledgeBaseExpectedResetRevision: 9,
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 2,
          knowledgeBaseExpectedLeafId: "identity.legal",
          knowledgeBaseExpectedPresentationKey: "presentation-2",
        }),
      ),
    );
  });

  it("keeps an initialized taskless v2 build replyable from its approved Dashboard presentation", async () => {
    mocks.activeConversation.taskId = undefined;
    mocks.activeConversation.knowledgeBase.initialized = true;
    mocks.activeConversation.knowledgeBase.activeTurnId = null;
    mocks.activeConversation.knowledgeBase.presentationTurnId = "turn-2";

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(
      screen.getByText("可直接确认，也可以输入修改意见或上传补充资料。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(container.querySelector('input[type="file"]')).toBeEnabled();
    expect(
      screen.queryByPlaceholderText(
        "请先点击上方“构建企业知识库”完成资料采集设置",
      ),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认当前内容" }));
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "确认",
        [],
        expect.objectContaining({
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 2,
          knowledgeBaseExpectedLeafId: "identity.legal",
          knowledgeBaseExpectedPresentationKey: "presentation-2",
        }),
      ),
    );
  });

  it("keeps the composer locked when the server denies reply even if a stale client status says awaiting input", () => {
    mocks.activeConversation.status = "awaiting_input";
    mocks.activeConversation.knowledgeBase.initialized = true;
    mocks.activeConversation.knowledgeBase.canReply = false;

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
  });

  it("locks the confirmation synchronously until the request settles", async () => {
    let finishSend!: (sent: boolean) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
    );
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const confirm = screen.getByRole("button", { name: "确认当前内容" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();

    finishSend(true);
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });

  it("disables quick actions when revision text or files are present", () => {
    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "成立日期改为 8 月 30 日" },
    });
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "" } });
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["12345"], "企业资料.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    expect(screen.getByText("企业资料.pdf")).toBeInTheDocument();
    expect(screen.getByText("5 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
  });

  it("rejects files larger than 100 MB at selection time", () => {
    const { container } = render(
      <ChatInput fixedAgentProfile="frontmind-pro" />,
    );
    const oversized = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    });

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [oversized] },
    });

    expect(screen.queryByText("oversized.pdf")).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("文件过大", {
      description: "文件“oversized.pdf”不能超过 100 MB",
    });
  });

  it("grows with the message and caps the composer at eight rows", () => {
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    let scrollHeight = 40;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    scrollHeight = 112;
    fireEvent.change(textarea, { target: { value: "三行左右的补充意见" } });
    expect(textarea).toHaveStyle({ height: "112px", overflowY: "hidden" });

    scrollHeight = 320;
    fireEvent.change(textarea, {
      target: { value: "超过八行的长篇补充意见" },
    });
    expect(textarea).toHaveAttribute("data-max-rows", "8");
    expect(textarea).toHaveStyle({
      height: "208px",
      maxHeight: "208px",
      overflowY: "auto",
    });

    scrollHeight = 40;
    fireEvent.change(textarea, { target: { value: "缩短" } });
    expect(textarea).toHaveStyle({ height: "44px", overflowY: "hidden" });
  });

  it("keeps Shift+Enter for newlines and Enter for submission", async () => {
    render(<ChatInput fixedAgentProfile="frontmind-pro" />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("第一行\n第二行");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "第一行\n第二行",
        [],
        expect.objectContaining({ agentProfile: "frontmind-pro" }),
      ),
    );
  });

  it("locks the model selector after a general Agent task is created", () => {
    mocks.activeConversation.previousResponseId = "local-task-1";
    mocks.activeConversation.messages = [
      {
        id: "general-user",
        role: "user",
        content: "分析资料",
        timestamp: 1,
        modelName: "frontmind-pro",
      },
    ];

    render(<ChatInput />);

    expect(
      screen.getByRole("button", { name: "FrontMind Pro" }),
    ).toBeDisabled();
  });

  it("does not submit Enter while a Chinese IME composition is active", () => {
    render(<ChatInput fixedAgentProfile="frontmind-pro" />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "输入中文" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("intercepts a standalone ambiguous continuation", async () => {
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "继续" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mocks.sendMessage).not.toHaveBeenCalled());
  });

  it("locks the generic composer while the server awaits browser Files", () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = true;
    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
    const fileInput = container.querySelector('input[type="file"]')!;
    expect(fileInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(container.querySelector("svg.lucide-send")).not.toBeInTheDocument();
  });

  it("offers continue and discard only for a matching page-memory attachment attempt", async () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.activeTurnId = "turn-upload";
    mocks.activeConversation.knowledgeBase.activeClientRequestId =
      "request-upload";
    mocks.activeConversation.knowledgeBase.activeTurnResetRevision = 4;
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = true;
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
    });
    mocks.knowledgeBaseAttachmentAttempt = {
      conversationId: "kb-conversation",
      clientRequestId: "request-upload",
      turnId: "turn-upload",
      submissionKind: "revise",
      originalMessageEnvelope: {},
      files: [
        {
          file,
          itemId: "request-upload:1",
          ordinal: 1,
          manifestItem: {
            itemId: "request-upload:1",
            ordinal: 1,
            total: 1,
            filename: "facts.pdf",
            sizeBytes: file.size,
            mimeType: "application/pdf",
            lastModified: 0,
            sha256: "a".repeat(64),
          },
        },
      ],
      generation: 1,
      stateEpoch: 2,
      resetRevision: 4,
      phase: "failed_retryable",
      lastError: "暂存响应中断",
    };

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByText("本轮资料仍保留在当前页面")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续上传当前资料" }));
    await waitFor(() =>
      expect(
        mocks.continueKnowledgeBaseAttachmentAttempt,
      ).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "放弃本轮上传" }));
    expect(mocks.discardKnowledgeBaseAttachmentAttempt).toHaveBeenCalledTimes(
      1,
    );
    expect(screen.queryByText("请重置")).not.toBeInTheDocument();
  });

  it("mounts same-turn recovery for an awaiting revise turn without a page-memory attempt", () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.activeTurnId = "turn-upload";
    mocks.activeConversation.knowledgeBase.activeClientRequestId =
      "request-upload";
    mocks.activeConversation.knowledgeBase.activeTurnResetRevision = 4;
    mocks.activeConversation.knowledgeBase.activeTurnOperationType = "revise";
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = true;

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(
      screen.getByTestId("knowledge-base-managed-upload-recovery"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/申请重置知识库/u)).not.toBeInTheDocument();
  });

  it("does not mount revise recovery for an initial start reservation", () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.activeTurnId = "turn-start";
    mocks.activeConversation.knowledgeBase.activeClientRequestId =
      "request-start";
    mocks.activeConversation.knowledgeBase.activeTurnResetRevision = 4;
    mocks.activeConversation.knowledgeBase.activeTurnOperationType = "start";
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = true;

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(
      screen.queryByTestId("knowledge-base-managed-upload-recovery"),
    ).not.toBeInTheDocument();
  });

  it("shows dispatch reconciliation without a second-send action", () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.activeTurnId = "turn-upload";
    mocks.activeConversation.knowledgeBase.activeClientRequestId =
      "request-upload";
    mocks.activeConversation.knowledgeBase.activeTurnResetRevision = 4;
    mocks.activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments = false;
    mocks.knowledgeBaseAttachmentAttempt = {
      conversationId: "kb-conversation",
      clientRequestId: "request-upload",
      turnId: "turn-upload",
      submissionKind: "revise",
      originalMessageEnvelope: {},
      files: [],
      generation: 1,
      stateEpoch: 2,
      resetRevision: 4,
      phase: "reconciling_dispatch",
    };

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByText("正在核对本轮是否已受理")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续上传当前资料" }),
    ).not.toBeInTheDocument();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("locks the ordinary composer while dedicated Logo provenance repair is required", () => {
    mocks.activeConversation.knowledgeBase.notice = {
      errorKey: "logo-provenance-required",
      code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED",
      message: "请重新上传同一张 Logo",
      severity: "warning" as const,
      retryable: false,
      turnId: "turn-50",
    };

    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
    expect(
      screen.queryByTestId("knowledge-node-action-card"),
    ).not.toBeInTheDocument();
  });

  it("locks only the fixed first response-logic prompt, then allows free text and files", async () => {
    const prompt =
      "请基于最新企业知识库，为“硅基流动有什么核心产品？”生成可核验的应答逻辑。";
    const { container, rerender } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        composerPrefill={prompt}
        responseLogicContext={responseLogicContext}
      />,
    );

    const firstComposer = screen.getByRole("textbox");
    const fileInput = container.querySelector('input[type="file"]')!;
    expect(firstComposer).toHaveValue(prompt);
    expect(firstComposer).toHaveAttribute("readonly");
    expect(fileInput).toBeDisabled();

    fireEvent.keyDown(firstComposer, { key: "Enter" });
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        prompt,
        [],
        expect.objectContaining({ responseLogicContext }),
      ),
    );
    await waitFor(() => expect(firstComposer).toHaveValue(""));

    rerender(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        responseLogicContext={responseLogicContext}
      />,
    );
    const followUpComposer = screen.getByRole("textbox");
    expect(followUpComposer).not.toHaveAttribute("readonly");
    expect(fileInput).not.toBeDisabled();

    fireEvent.change(followUpComposer, {
      target: { value: "请把产品线改成用户最关心的三类。" },
    });
    rerender(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        responseLogicContext={responseLogicContext}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue(
      "请把产品线改成用户最关心的三类。",
    );
    const image = new File(["image"], "产品图.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [image] } });
    fireEvent.click(
      container.querySelector("svg.lucide-send")!.closest("button")!,
    );

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenLastCalledWith(
        "请把产品线改成用户最关心的三类。",
        [image],
        expect.objectContaining({ responseLogicContext }),
      ),
    );
  });

  it("keeps the exact response-logic input in the composer when no task was created", async () => {
    const prompt =
      "请基于最新企业知识库，为“国内第三方软件测评机构推荐”生成可核验的应答逻辑。";
    mocks.sendMessage.mockResolvedValue(false);
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        composerPrefill={prompt}
        responseLogicContext={responseLogicContext}
      />,
    );

    const composer = screen.getByRole("textbox");
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(composer).toHaveValue(prompt);

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(
      prompt,
      [],
      expect.objectContaining({ responseLogicContext }),
    );
    expect(composer).toHaveValue(prompt);
  });
});
