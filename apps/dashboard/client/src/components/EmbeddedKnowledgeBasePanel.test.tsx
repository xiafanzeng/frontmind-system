import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetRefetch: vi.fn(),
  knowledgeRefetch: vi.fn(),
  deliveryTicketCreate: vi.fn(),
  progressRefetch: vi.fn(),
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
    canRequest: false,
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
vi.mock("@/components/KnowledgeBaseProgressPanel", () => ({
  default: (props: {
    progress?: { operationState?: string } | null;
    loading?: boolean;
    emptyMessage?: string;
  }) => (
    <div data-testid="knowledge-progress-panel">
      {props.loading
        ? "progress-loading"
        : props.progress?.operationState ||
          props.emptyMessage ||
          "progress-empty"}
    </div>
  ),
}));
vi.mock("@/pages/Home", () => ({
  default: () => <div data-testid="knowledge-home">knowledge home</div>,
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
        submit: {
          useMutation: () => ({
            mutateAsync: vi.fn(),
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
  knowledgeResetButtonLabel,
  shouldDiscardConversationAfterKnowledgeReset,
} from "./EmbeddedKnowledgeBasePanel";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
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
    canRequest: false,
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
  it("uses the exact disabled label while no engineer is assigned", () => {
    expect(knowledgeResetButtonLabel({ locked: false, engineer: null })).toBe(
      "请等待分配AI 运维工程师",
    );
    expect(
      knowledgeResetButtonLabel({
        locked: false,
        engineer: { id: 9, name: "运维" },
      }),
    ).toBe("申请重置知识库");
    expect(knowledgeResetButtonLabel({ locked: true, engineer: null })).toBe(
      "重置申请审批中",
    );
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
    expect(screen.getByText("正在恢复构建会话…")).toBeInTheDocument();
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
    expect(screen.getByText("正在恢复构建会话…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS);
    });

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(
      screen.getByText(/未能在 15 秒内恢复已有构建会话/),
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
    expect(screen.getByText("正在恢复构建会话…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS);
    });

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(
      screen.getByText(/未能在 15 秒内恢复已有构建会话/),
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

  it("keeps reset on the build page only and refreshes it when build progress starts", () => {
    mocks.progressIsError = true;
    const { rerender } = render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    const resetButton = screen.getByRole("button", {
      name: "申请重置知识库",
    });
    expect(resetButton).toBeDisabled();
    expect(resetButton).toHaveAttribute("title", "当前没有可重置的知识库记录");

    rerender(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "申请重置知识库" })).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:knowledge-progress-updated"),
      );
    });
    expect(mocks.resetRefetch).toHaveBeenCalledTimes(1);
  });

  it("opens the existing approval dialog from a failed build reset CTA", () => {
    mocks.progressIsError = true;
    mocks.resetStatus = {
      revision: 0,
      hasKnowledge: true,
      locked: false,
      canRequest: true,
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
      screen.getByRole("dialog", { name: "申请重置知识库" }),
    ).toBeInTheDocument();
  });

  it("shows only maintenance and ZIP actions on the published display page", () => {
    mocks.knowledgeData = {
      snapshot: {
        id: "snapshot-1",
        sourceFileName: "企业知识库.zip",
        archiveHash: "a".repeat(64),
        archiveAvailable: true,
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "提交维护需求" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载成品 ZIP" })).toHaveAttribute(
      "href",
      "/api/dashboard/knowledge/snapshots/snapshot-1/archive",
    );
    expect(screen.queryByRole("button", { name: "申请重置知识库" })).toBeNull();
  });

  it("does not replace a completed build action with a maintenance ticket", () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      status: "completed",
    };
    mocks.knowledgeData = {
      snapshot: {
        id: "snapshot-1",
        sourceFileName: "企业知识库.zip",
        archiveHash: null,
        archiveAvailable: false,
      },
    };
    mocks.progressData = {
      progress: {
        packageAllowed: true,
        build: {
          status: "published",
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

    expect(screen.queryByRole("button", { name: "提交维护需求" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "申请重置知识库" }),
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
      expect(mocks.setActive).toHaveBeenCalledWith("knowledge-conversation"),
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
      expect(mocks.setActive).toHaveBeenCalledWith("knowledge-conversation"),
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

  it("keeps the 100 percent update notice on one line", () => {
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

    expect(screen.getByText(/知识库已达到\s+100%/)).toHaveClass(
      "whitespace-nowrap",
    );
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
