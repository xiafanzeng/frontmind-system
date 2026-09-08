import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetRefetch: vi.fn(),
  resetMutation: vi.fn(),
  knowledgeRefetch: vi.fn(),
  deliveryTicketCreate: vi.fn(),
  progressRefetch: vi.fn(),
  publishKnowledge: vi.fn(),
  progressUseQuery: vi.fn(),
  setKnowledgeData: vi.fn(),
  setProgressData: vi.fn(),
  invalidateProgress: vi.fn(),
  createConversation: vi.fn(),
  setActive: vi.fn(),
  discardConversationLocally: vi.fn(),
  discardKnowledgeBaseConversationsLocally: vi.fn(),
  refreshConversationsAfterDiscard: vi.fn(),
  refreshConversations: vi.fn(),
  clearSyncError: vi.fn(),
  nodeProps: vi.fn(),
  homeProps: vi.fn(),
  activeConversation: null as any,
  hydrated: true,
  conversationLoading: false,
  syncError: null as string | null,
  resetIsError: false,
  progressIsError: false,
  progressData: { progress: null } as any,
  scopedProgressOverride: false,
  scopedProgressData: undefined as any,
  knowledgeData: { snapshot: null } as any,
  resetStatus: {
    revision: 0,
    hasKnowledge: false,
    locked: false,
    canReset: false,
    unavailableReason: "当前没有可重置的知识库记录",
    pending: null,
  } as any,
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { role: "user" } }),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    state: {
      conversations: mocks.activeConversation ? [mocks.activeConversation] : [],
    },
    activeConversation: mocks.activeConversation,
    loading: mocks.conversationLoading,
    hydrated: mocks.hydrated,
    syncError: mocks.syncError,
    createConversation: mocks.createConversation,
    setActive: mocks.setActive,
    discardConversationLocally: mocks.discardConversationLocally,
    discardKnowledgeBaseConversationsLocally:
      mocks.discardKnowledgeBaseConversationsLocally,
    refreshConversationsAfterDiscard: mocks.refreshConversationsAfterDiscard,
    refreshConversations: mocks.refreshConversations,
    clearSyncError: mocks.clearSyncError,
  }),
}));
vi.mock("@/components/KnowledgeBaseViewer", () => ({
  default: () => <div>knowledge viewer</div>,
}));
vi.mock("@/components/KnowledgeNodeWorkspace", () => ({
  default: (props: {
    progress?: { operationState?: string } | null;
    loading?: boolean;
    emptyMessage?: string;
  }) => {
    mocks.nodeProps(props);
    return (
    <div data-testid="knowledge-progress-panel">
      {props.loading
        ? "progress-loading"
        : props.progress?.operationState ||
          props.emptyMessage ||
          "progress-empty"}
    </div>
  );
  },
}));
vi.mock("@/components/KnowledgeWorkspaceStatus", () => ({ default: () => null }));
vi.mock("@/lib/knowledge-snapshot", () => ({ syncKnowledgeBaseArchiveFromOutput: mocks.publishKnowledge }));
vi.mock("@/pages/Home", () => ({
  default: (props: unknown) => { mocks.homeProps(props); return <div data-testid="knowledge-home">knowledge home</div>; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        knowledge: {
          setData: mocks.setKnowledgeData,
        },
        knowledgeProgress: {
          setData: mocks.setProgressData,
          invalidate: mocks.invalidateProgress,
        },
      },
    }),
    workspace: {
      knowledgeProgress: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.progressUseQuery(input, options);
          const data =
            input && mocks.scopedProgressOverride
              ? mocks.scopedProgressData
              : mocks.progressData;
          return {
            data,
            isLoading: data === undefined && !mocks.progressIsError,
            isError: mocks.progressIsError,
            refetch: mocks.progressRefetch,
          };
        },
      },
      knowledge: {
        useQuery: () => ({
          data: mocks.knowledgeData,
          isLoading: false,
          refetch: mocks.knowledgeRefetch,
        }),
      },
      deliveryTickets: {
        create: {
          useMutation: () => ({
            mutateAsync: mocks.deliveryTicketCreate,
            isPending: false,
          }),
        },
      },
      knowledgeReset: {
        status: {
          useQuery: () => ({
            data: mocks.resetStatus,
            isError: mocks.resetIsError,
            refetch: mocks.resetRefetch,
          }),
        },
        reset: {
          useMutation: () => ({
            mutateAsync: mocks.resetMutation,
            isPending: false,
          }),
        },
      },
    },
  },
}));

import EmbeddedKnowledgeBasePanel, {
  KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS,
  isKnowledgeBaseProgressProjectionOlder,
  shouldDiscardConversationAfterKnowledgeReset,
} from "./EmbeddedKnowledgeBasePanel";

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

beforeEach(() => {
  mocks.publishKnowledge.mockReset().mockResolvedValue(true);
  mocks.resetMutation
    .mockReset()
    .mockResolvedValue({ revision: 1, cleanup: {} });
  mocks.resetRefetch.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeRefetch.mockReset().mockResolvedValue(undefined);
  mocks.deliveryTicketCreate.mockReset().mockResolvedValue(undefined);
  mocks.progressRefetch.mockReset().mockResolvedValue(undefined);
  mocks.progressUseQuery.mockReset();
  mocks.setKnowledgeData.mockReset();
  mocks.setProgressData.mockReset();
  mocks.invalidateProgress.mockReset().mockResolvedValue(undefined);
  mocks.createConversation
    .mockReset()
    .mockReturnValue("knowledge-conversation");
  mocks.setActive.mockReset();
  mocks.discardConversationLocally.mockReset();
  mocks.discardKnowledgeBaseConversationsLocally
    .mockReset()
    .mockReturnValue([]);
  mocks.refreshConversationsAfterDiscard
    .mockReset()
    .mockResolvedValue(undefined);
  mocks.refreshConversations.mockReset().mockResolvedValue(undefined);
  mocks.clearSyncError.mockReset();
  mocks.nodeProps.mockReset();
  mocks.homeProps.mockReset();
  mocks.resetIsError = false;
  mocks.progressIsError = false;
  mocks.progressData = { progress: null };
  mocks.scopedProgressOverride = false;
  mocks.scopedProgressData = undefined;
  mocks.hydrated = true;
  mocks.conversationLoading = false;
  mocks.syncError = null;
  mocks.knowledgeData = { snapshot: null };
  mocks.activeConversation = null;
  mocks.resetStatus = {
    revision: 0,
    hasKnowledge: false,
    locked: false,
    canReset: false,
    unavailableReason: "当前没有可重置的知识库记录",
    pending: null,
  };
});

describe("knowledge-base progress projection ordering", () => {
  const progress = (input: {
    id?: string;
    revision: number;
    updatedAt: number;
  }) =>
    ({
      build: {
        id: input.id || "build-1",
        revision: input.revision,
        updatedAt: input.updatedAt,
      },
    }) as any;

  it("rejects an older revision or older replacement build", () => {
    const current = progress({ revision: 3, updatedAt: 300 });
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ revision: 2, updatedAt: 400 }),
        current,
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ id: "build-2", revision: 0, updatedAt: 200 }),
        current,
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ revision: 4, updatedAt: 250 }),
        current,
      ),
    ).toBe(false);
  });
});

describe("EmbeddedKnowledgeBasePanel reset action", () => {
  const activeBuild = (conversationId = "current-kb", currentLeafId: string | null = "1.1") => ({
    operationState: "waiting_output",
    build: { id: `build-${conversationId}`, conversationId, revision: 2, contentVersion: 1, updatedAt: 10, currentLeafId },
    branches: [],
    packageAllowed: false,
  });
  const approvedConversation = (id: string) => ({
    id, title: "企业知识库构建", status: "awaiting_input", createdAt: 1, updatedAt: 2,
    knowledgeBase: { initialized: true, generation: 1, stateEpoch: 2, presentationKey: `key-${id}`, presentationTurnId: `turn-${id}`, canReply: true, leafId: "1.1" },
    messages: [{ id: "presentation", role: "assistant", content: "已确认正文", timestamp: 2, knowledgeBase: { kind: "presentation", presentationKey: `key-${id}`, turnId: `turn-${id}`, serverOwned: true } }],
  });
  const publishedSnapshot = { id: "published-old", sourceFileName: "knowledge.zip", archiveHash: "a".repeat(64), archiveAvailable: true };

  it("does not substitute an old active conversation for a missing authoritative current build", () => {
    mocks.activeConversation = approvedConversation("old-kb");
    mocks.progressData = { progress: activeBuild("missing-current-kb") };
    mocks.knowledgeData = { snapshot: publishedSnapshot };
    render(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    expect(screen.getByText("当前构建记录无法继续。请确认重置后重新上传资料。")).toBeVisible();
    expect(screen.queryByTestId("knowledge-home")).not.toBeInTheDocument();
    expect(screen.queryByText("knowledge viewer")).not.toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.nodeProps.mock.lastCall?.[0]).toMatchObject({ progress: { build: { conversationId: "missing-current-kb" } }, disabled: true });
  });

  it("uses historical snapshot fallback only when no current build is available", () => {
    mocks.activeConversation = approvedConversation("old-kb");
    mocks.progressData = { progress: null };
    mocks.knowledgeData = { snapshot: publishedSnapshot };
    render(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    expect(screen.getByText("knowledge viewer")).toBeVisible();
    expect(screen.queryByTestId("knowledge-home")).not.toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("keeps current progress ahead of a published snapshot while latest-progress recovery is incomplete", async () => {
    const current = activeBuild();
    mocks.activeConversation = approvedConversation("current-kb");
    mocks.progressData = { progress: current };
    mocks.knowledgeData = { snapshot: publishedSnapshot };
    const { rerender } = render(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("knowledge-home")).toBeVisible());
    mocks.scopedProgressOverride = true;
    mocks.scopedProgressData = { progress: current };
    mocks.progressData = undefined;
    rerender(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    expect(screen.getByTestId("knowledge-home")).toBeVisible();
    expect(screen.getByTestId("knowledge-progress-panel")).toHaveTextContent("waiting_output");
    expect(screen.queryByText("knowledge viewer")).not.toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("locks the opposite editor without locking the source of a draft", async () => {
    mocks.activeConversation = approvedConversation("current-kb");
    mocks.progressData = { progress: activeBuild() };
    render(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("knowledge-home")).toBeVisible());
    act(() => mocks.nodeProps.mock.lastCall?.[0].onDirtyChange(true));
    expect(mocks.homeProps.mock.lastCall?.[0].knowledgeEditingBlocked).toBe(true);
    expect(mocks.nodeProps.mock.lastCall?.[0].disabled).toBe(false);
    act(() => { mocks.nodeProps.mock.lastCall?.[0].onDirtyChange(false); mocks.nodeProps.mock.lastCall?.[0].onEditTargetChange({ leafId: "1.1", title: "企业简介", mode: "direct" }); });
    expect(mocks.homeProps.mock.lastCall?.[0].knowledgeEditingBlocked).toBe(true);
    act(() => { mocks.nodeProps.mock.lastCall?.[0].onEditTargetChange(null); mocks.homeProps.mock.lastCall?.[0].onComposerDirtyChange(true); });
    expect(mocks.nodeProps.mock.lastCall?.[0].disabled).toBe(true);
    expect(mocks.homeProps.mock.lastCall?.[0].knowledgeEditingBlocked).toBe(false);
  });

  it("clears a stale AI target label when the authoritative workflow advances to another node", async () => {
    mocks.activeConversation = approvedConversation("current-kb");
    mocks.progressData = { progress: activeBuild() };
    const { rerender } = render(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("knowledge-home")).toBeVisible());
    act(() => mocks.nodeProps.mock.lastCall?.[0].onEditTargetChange({ leafId: "1.1", title: "企业简介", mode: "ai" }));
    expect(screen.getByText("正在修改：企业简介")).toBeVisible();
    const next = activeBuild("current-kb", "1.2");
    next.build.revision = 3;
    mocks.progressData = { progress: next };
    rerender(<EmbeddedKnowledgeBasePanel mode="workspace" page="build" onPageChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("正在修改：企业简介")).not.toBeInTheDocument());
  });

  it("keeps the enterprise project on the header archive download", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState(null, "", `/?enterpriseProjectId=${projectId}`);
    mocks.knowledgeData = { snapshot: { id: "snapshot-1", sourceFileName: "knowledge.zip", archiveHash: "a".repeat(64), archiveAvailable: true } };
    render(<EmbeddedKnowledgeBasePanel page="display" onPageChange={vi.fn()} />);
    expect(screen.getByRole("link", { name: "下载已更新版本" })).toHaveAttribute("href", `/api/dashboard/knowledge/snapshots/snapshot-1/archive?enterpriseProjectId=${projectId}`);
  });
  it("does not mount the build flow before reset status is known", () => {
    mocks.resetStatus = undefined;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("正在确认知识库重置状态…")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("fails closed when reset status cannot be read", () => {
    mocks.resetStatus = undefined;
    mocks.resetIsError = true;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("知识库状态读取失败")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("fails closed when the latest build conversation cannot be read", () => {
    mocks.progressData = undefined;
    mocks.progressIsError = true;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("starts the latest progress read before conversation hydration completes", () => {
    mocks.hydrated = false;
    mocks.conversationLoading = true;
    mocks.progressData = undefined;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    const latestQueryOptions = mocks.progressUseQuery.mock.calls.find(
      ([, options]) =>
        (options as { refetchOnWindowFocus?: unknown })
          ?.refetchOnWindowFocus === true,
    )?.[1];
    expect(latestQueryOptions).toBeDefined();
    expect(latestQueryOptions).not.toHaveProperty("enabled");
    expect(screen.getByText("正在读取当前构建会话…")).toBeInTheDocument();
  });

  it("uses the latest canonical business state while the scoped query is still loading", async () => {
    mocks.activeConversation = {
      id: "latest-kb",
      title: "企业知识库构建",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    mocks.progressData = {
      progress: {
        build: {
          id: "latest-build",
          conversationId: "latest-kb",
          generation: 1,
          stateEpoch: 2,
          revision: 0,
          updatedAt: 2,
        },
        operationState: "waiting_output",
      },
    };
    mocks.scopedProgressOverride = true;
    mocks.scopedProgressData = undefined;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("knowledge-progress-panel")).toHaveTextContent(
        "waiting_output",
      ),
    );
    expect(screen.queryByText("progress-loading")).not.toBeInTheDocument();
  });

  it("turns a hanging recovery into an explicit retry within 15 seconds", async () => {
    vi.useFakeTimers();
    mocks.hydrated = false;
    mocks.conversationLoading = true;
    mocks.progressData = undefined;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );
    expect(screen.getByText("正在读取当前构建会话…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS);
    });

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(
      screen.getByText(/未能在 15 秒内读取当前构建会话/),
    ).toBeInTheDocument();
  });

  it("times out when conversation loading hangs after hydration and progress", async () => {
    vi.useFakeTimers();
    mocks.hydrated = true;
    mocks.conversationLoading = true;
    mocks.activeConversation = {
      id: "loading-kb",
      title: "企业知识库构建",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    mocks.progressData = {
      progress: {
        build: {
          id: "loading-build",
          conversationId: "loading-kb",
          generation: 1,
          stateEpoch: 1,
          revision: 0,
          updatedAt: 2,
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );
    expect(screen.getByText("正在读取当前构建会话…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS);
    });

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(
      screen.getByText(/未能在 15 秒内读取当前构建会话/),
    ).toBeInTheDocument();
  });

  it("retries both conversation hydration and authoritative progress", () => {
    mocks.syncError = "会话同步暂时中断";

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );
    act(() => screen.getByRole("button", { name: "重新读取" }).click());

    expect(mocks.clearSyncError).toHaveBeenCalledTimes(1);
    expect(mocks.refreshConversations).toHaveBeenCalledTimes(1);
    expect(mocks.progressRefetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing approved presentation visible while recovery fails", () => {
    mocks.hydrated = false;
    mocks.conversationLoading = true;
    mocks.syncError = "会话同步暂时中断";
    mocks.progressData = undefined;
    mocks.progressIsError = true;
    mocks.activeConversation = {
      id: "last-good-kb",
      title: "企业知识库构建",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      knowledgeBase: {
        initialized: true,
        generation: 1,
        stateEpoch: 2,
        activeTurnId: "running-turn",
        activeClientRequestId: "running-request",
        presentationTurnId: "last-good-turn",
        interactionState: "executing",
        canReply: false,
        presentationKey: "presentation-key",
        revision: 1,
        leafId: "1.6",
        notice: null,
      },
      messages: [
        {
          id: "last-good-presentation",
          role: "assistant",
          content: "# 已验证节点\n\n可继续阅读的正文",
          timestamp: 1,
          knowledgeBase: {
            kind: "presentation",
            presentationKey: "presentation-key",
            turnId: "last-good-turn",
            serverOwned: true,
          },
        },
      ],
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByTestId("knowledge-home")).toBeInTheDocument();
    expect(screen.queryByText("构建会话读取失败")).not.toBeInTheDocument();
  });

  it("does not treat a stale presentation from an old KB coordinate as last-good", () => {
    mocks.progressData = undefined;
    mocks.progressIsError = true;
    mocks.activeConversation = {
      id: "stale-kb-presentation",
      title: "企业知识库构建",
      status: "error",
      createdAt: 1,
      updatedAt: 2,
      knowledgeBase: {
        initialized: true,
        generation: 2,
        stateEpoch: 3,
        activeTurnId: null,
        activeClientRequestId: null,
        presentationTurnId: "current-turn",
        interactionState: "failed",
        canReply: false,
        presentationKey: "current-presentation",
        revision: 2,
        leafId: "1.6",
        notice: null,
      },
      messages: [
        {
          id: "old-presentation",
          role: "assistant",
          content: "旧正文",
          timestamp: 1,
          knowledgeBase: {
            kind: "presentation",
            presentationKey: "old-presentation",
            turnId: "old-turn",
            serverOwned: true,
          },
        },
      ],
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(screen.queryByTestId("knowledge-home")).not.toBeInTheDocument();
  });

  it("opens reset confirmation directly from the named toolbar button without resetting data", async () => {
    mocks.progressIsError = true;
    mocks.resetStatus = { ...mocks.resetStatus, canReset: true, hasKnowledge: true, unavailableReason: null };
    render(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={vi.fn()} />);
    const resetButton = screen.getByRole("button", { name: "重置知识库" });
    expect(screen.queryByRole("button", { name: "知识库更多操作" })).not.toBeInTheDocument();
    fireEvent.click(resetButton);
    expect(screen.getByRole("dialog", { name: "重置知识库" })).toBeVisible();
    expect(mocks.resetMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(resetButton).toHaveFocus());
    expect(mocks.resetMutation).not.toHaveBeenCalled();
  });

  it("returns focus to the workspace title after reset makes the reset button unavailable", async () => {
    mocks.progressIsError = true;
    mocks.resetStatus = { ...mocks.resetStatus, canReset: true, hasKnowledge: true, unavailableReason: null };
    const onPageChange = vi.fn();
    const { rerender } = render(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={onPageChange} />);
    mocks.resetRefetch.mockImplementation(async () => {
      mocks.resetStatus = { ...mocks.resetStatus, canReset: false, hasKnowledge: false, revision: 1 };
      rerender(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={onPageChange} />);
    });
    fireEvent.click(screen.getByRole("button", { name: "重置知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重置知识库" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("heading", { name: "智能知识库" })).toHaveFocus());
    expect(mocks.resetMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps the named reset button unavailable when there is no resettable knowledge", () => {
    mocks.progressIsError = true;
    render(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "重置知识库" })).toBeDisabled();
  });

  it("keeps legacy display selections inside the unified node workspace", () => {
    mocks.activeConversation = approvedConversation("current-kb");
    mocks.progressData = { progress: activeBuild() };
    mocks.knowledgeData = { snapshot: publishedSnapshot };
    render(<EmbeddedKnowledgeBasePanel mode="workspace" page="display" onPageChange={vi.fn()} />);
    expect(screen.getByTestId("knowledge-home")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-progress-panel")).toBeInTheDocument();
    expect(screen.queryByText("knowledge viewer")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载已更新版本" })).toBeInTheDocument();
  });

  it("opens the direct reset dialog from a failed build reset CTA", () => {
    mocks.progressIsError = true;
    mocks.resetStatus = {
      revision: 0,
      hasKnowledge: true,
      locked: false,
      canReset: true,
      unavailableReason: null,
      engineer: { id: 9, name: "运维" },
      pending: null,
    };
    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:request-knowledge-reset"),
      );
    });

    expect(
      screen.getByRole("dialog", { name: "重置知识库" }),
    ).toBeInTheDocument();
  });

  it("uses a complete progress event without refetching the same projection", async () => {
    const progress = {
      build: {
        id: "build-1",
        conversationId: "knowledge-conversation",
        companyName: "FrontMind",
        status: "executing",
        revision: 0,
        currentLeafId: null,
        protocolError: null,
        updatedAt: 1,
      },
      summary: {
        total: 0,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 0,
        current: 0,
        needsVerification: 0,
        overallPercent: 0,
      },
      branches: [],
      packageAllowed: false,
    };
    mocks.activeConversation = {
      id: "knowledge-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.progressData = { progress };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("knowledge-home")).toBeInTheDocument(),
    );
    const nextProgress = {
      ...progress,
      build: { ...progress.build, updatedAt: 2 },
    };
    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:knowledge-progress-updated", {
          detail: {
            progress: nextProgress,
            generation: 1,
            stateEpoch: 2,
          },
        }),
      );
    });

    expect(mocks.setProgressData).toHaveBeenCalledWith(
      { conversationId: "knowledge-conversation" },
      expect.any(Function),
    );
    expect(mocks.progressRefetch).not.toHaveBeenCalled();
  });

  it("selects the fresh conversation requested by a failed-build rebuild action", async () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "error",
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.progressData = {
      progress: {
        build: {
          id: "failed-build",
          conversationId: "knowledge-conversation",
          revision: 0,
          updatedAt: 1,
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-home")).toBeInTheDocument(),
    );
    mocks.setActive.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:new-knowledge-base-build", {
          detail: { conversationId: "fresh-knowledge-conversation" },
        }),
      );
    });

    expect(mocks.setActive).toHaveBeenCalledWith(
      "fresh-knowledge-conversation",
    );
  });

  it("requires an explicit update dialog without a decorative percentage notice", () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      status: "completed",
    };
    mocks.progressData = {
      progress: {
        packageAllowed: true,
        build: {
          status: "ready_to_publish",
          conversationId: "knowledge-conversation",
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.queryByText(/知识库已达到\s+100%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新知识库" }));
    expect(screen.getByRole("dialog", { name: "更新知识库" })).toHaveTextContent("正在执行和历史任务仍使用原来绑定的版本");
  });

  it("reads an uncertain publish result before permitting another update request", async () => {
    mocks.activeConversation = { id: "knowledge-conversation", status: "completed" };
    mocks.progressData = { progress: { packageAllowed: true, build: { status: "ready_to_publish", conversationId: "knowledge-conversation" } } };
    mocks.publishKnowledge.mockRejectedValueOnce(new Error("response lost"));
    mocks.progressRefetch.mockResolvedValue({ data: { progress: { packageAllowed: true, build: { status: "published", conversationId: "knowledge-conversation" } } } });
    const onPageChange = vi.fn();
    render(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole("button", { name: "更新知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新读取更新结果" }));
    await waitFor(() => expect(mocks.knowledgeRefetch).toHaveBeenCalled());
    expect(mocks.publishKnowledge).toHaveBeenCalledTimes(1);
    expect(mocks.progressRefetch).toHaveBeenCalled();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("does not retarget an open update confirmation to another conversation", () => {
    mocks.activeConversation = { id: "knowledge-conversation", status: "completed" };
    mocks.progressData = { progress: { packageAllowed: true, build: { status: "ready_to_publish", conversationId: "knowledge-conversation" } } };
    const { rerender } = render(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "更新知识库" }));
    mocks.activeConversation = { id: "another-conversation", status: "completed" };
    rerender(<EmbeddedKnowledgeBasePanel page="build" mode="workspace" onPageChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    expect(mocks.publishKnowledge).not.toHaveBeenCalled();
  });

  it("discards established local KB state when first mounted after a completed reset", () => {
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: null,
        revision: 2,
        hasKnowledge: false,
        conversation: {
          id: "reset-conversation",
          title: "企业知识库构建",
          messages: [
            {
              id: "server-turn",
              role: "user",
              content: "开始构建企业知识库",
              timestamp: 1,
              knowledgeBase: {
                kind: "pending_user",
                serverOwned: true,
                clientRequestId: "request-1",
              },
            },
          ],
          status: "awaiting_input",
          createdAt: 1,
          updatedAt: 2,
          knowledgeBase: {
            initialized: true,
            generation: 1,
            stateEpoch: 2,
            activeTurnId: null,
            activeClientRequestId: null,
            presentationTurnId: "turn-1",
            interactionState: "awaiting_input",
            canReply: true,
            presentationKey: "presentation-1",
            revision: 1,
            leafId: "1.1",
            notice: null,
          },
        },
      }),
    ).toBe(true);
  });

  it("clears every local KB lane immediately when an approved revision is observed", () => {
    mocks.discardKnowledgeBaseConversationsLocally.mockReturnValue([
      "stale-after-reset",
    ]);
    mocks.resetStatus = {
      ...mocks.resetStatus,
      revision: 2,
      hasKnowledge: false,
    };
    render(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );
    expect(mocks.discardKnowledgeBaseConversationsLocally).toHaveBeenCalledWith(
      undefined,
    );
    expect(mocks.setKnowledgeData).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
    );
    expect(mocks.setKnowledgeData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.knowledgeRefetch.mock.invocationCallOrder[0]!,
    );
    expect(mocks.setProgressData).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
    );
    expect(mocks.setProgressData).toHaveBeenCalledWith(
      { conversationId: "stale-after-reset" },
      expect.any(Function),
    );
    expect(mocks.invalidateProgress).toHaveBeenCalledTimes(1);
    expect(mocks.refreshConversationsAfterDiscard).toHaveBeenCalledTimes(1);
  });

  it("treats a blank KB conversation as stale across an approved revision", () => {
    const blankConversation = {
      id: "new-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "idle" as const,
      createdAt: 1,
      updatedAt: 1,
      knowledgeBase: {
        initialized: false,
        generation: 0,
        stateEpoch: 0,
        activeTurnId: null,
        activeClientRequestId: null,
        presentationTurnId: null,
        interactionState: "queued" as const,
        canReply: false,
        presentationKey: null,
        revision: null,
        leafId: null,
        notice: null,
      },
    };
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: null,
        revision: 2,
        hasKnowledge: true,
        conversation: blankConversation,
      }),
    ).toBe(false);
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: 1,
        revision: 2,
        hasKnowledge: false,
        conversation: blankConversation,
      }),
    ).toBe(true);
  });
});

it("resets directly from the published page with the captured reset revision", async () => {
  mocks.resetStatus = {
    revision: 3,
    hasKnowledge: true,
    canReset: true,
    unavailableReason: null,
  };
  const onPageChange = vi.fn();
  const { rerender } = render(
    <EmbeddedKnowledgeBasePanel page="display" onPageChange={onPageChange} />,
  );
  act(() => window.dispatchEvent(new Event("frontmind:request-knowledge-reset")));
  expect(screen.queryByText(/审批|分配.*工程师|工单/)).not.toBeInTheDocument();
  mocks.resetStatus = { ...mocks.resetStatus, revision: 4 };
  rerender(
    <EmbeddedKnowledgeBasePanel page="display" onPageChange={onPageChange} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
  await waitFor(() =>
    expect(mocks.resetMutation).toHaveBeenCalledWith({ expectedRevision: 3 }),
  );
  await waitFor(() => expect(onPageChange).toHaveBeenCalledWith("build"));
});
