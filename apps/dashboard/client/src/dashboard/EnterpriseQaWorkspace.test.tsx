import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EnterpriseQaWorkspace, {
  EnterpriseQaSourceNote,
} from "./EnterpriseQaWorkspace";
import {
  createWorkbenchModules,
  WorkbenchModuleContext,
} from "./agent-workbench";

const state = vi.hoisted(() => ({
  activeConversation: null as any,
  knowledgeProgress: null as any,
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    activeConversation: state.activeConversation,
    state: {
      conversations: state.activeConversation ? [state.activeConversation] : [],
    },
    hydrated: true,
    createConversation: vi.fn(),
    setActive: vi.fn(),
  }),
  ConversationAgentProvider: ({ children }: any) => children,
  ConversationContextProvider: ({ children }: any) => children,
  ConversationPurposeProvider: ({ children, purpose }: any) => (
    <div data-purpose={purpose} data-testid="purpose">
      {children}
    </div>
  ),
}));

vi.mock("@/hooks/useWorkbenchTask", () => ({
  useWorkbenchTask: () => ({
    taskId: null,
    task: null,
    tasks: [],
    state: null,
    hydrated: true,
    pending: false,
    error: null,
    newTask: vi.fn(),
    selectTask: vi.fn(),
  }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      knowledgeProgress: {
        useQuery: () => ({
          data: { progress: state.knowledgeProgress },
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));
function WorkbenchQa() {
  const module = createWorkbenchModules(
    () => null,
    () => undefined,
    "enterprise-qa",
  ).find((item) => item.id === "extensions")!;
  return (
    <WorkbenchModuleContext.Provider value={module}>
      <EnterpriseQaWorkspace workbench projectId="project-a" />
    </WorkbenchModuleContext.Provider>
  );
}
vi.mock("@/pages/Home", () => ({
  default: (props: any) => (
    <div
      data-testid="chat"
      data-purpose={props.purpose}
      data-starter={String(props.showKnowledgeBaseStarter)}
    >
      <button>新建会话</button>
      <button>开始企业问答</button>
      <textarea aria-label="问答草稿" defaultValue="" />
    </div>
  ),
}));

describe("Enterprise QA source binding", () => {
  beforeEach(() => {
    state.activeConversation = null;
    state.knowledgeProgress = null;
    vi.stubGlobal("innerWidth", 1440);
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("keeps the workbench chat gated while loading and unpublished, with subagents in collaboration", async () => {
    state.activeConversation = { taskId: "historical-task" };
    let resolve!: (response: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkbenchQa />);

    expect(screen.getByText(/正在确认知识库状态/)).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "新任务" }),
    ).not.toBeInTheDocument();
    const main = screen.getByRole("region", { name: "主工作区" });
    const aside = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(within(main).queryByRole("navigation")).not.toBeInTheDocument();
    const selector = within(aside).getByRole("navigation", {
      name: "切换业务子页面",
    });
    expect(
      within(selector).getByRole("button", { name: "企业问答" }),
    ).toHaveAttribute("aria-pressed", "true");

    await act(async () =>
      resolve({ ok: true, json: async () => ({ knowledgeBase: null }) }),
    );
    expect(
      screen.getByRole("heading", { name: "先发布企业知识库，即可开始问答" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/frontmind/v2/runtime-config?purpose=enterprise_qa",
    ]);
  });

  it("shows actual retained files and confirmation readiness in the main unlock steps", async () => {
    state.knowledgeProgress = {
      retainedCustomerAttachmentCount: 4,
      updateAllowed: true,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ knowledgeBase: null }),
        }),
    );
    render(<WorkbenchQa />);
    const main = screen.getByRole("region", { name: "主工作区" });
    expect(
      await within(main).findByText("已保留 4 份资料"),
    ).toBeInTheDocument();
    expect(within(main).getByText("已确认，可更新知识库")).toBeInTheDocument();
    expect(within(main).getByText("尚未发布")).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it("opens scoped workbench chat after publication and keeps its source note and retry behavior", async () => {
    const published = {
      ok: true,
      json: async () => ({
        knowledgeBase: {
          snapshotId: "published",
          version: 8,
          sourceFileName: "企业知识库.md",
          documentCount: 4,
        },
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(published)
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(published);
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkbenchQa />);
    const chat = await screen.findByTestId("chat");
    expect(chat).toHaveAttribute("data-purpose", "enterprise_qa");
    const result = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(screen.getByRole("region", { name: "主工作区" })).toContainElement(
      chat,
    );
    expect(within(result).getByRole("status")).toHaveTextContent("v8");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("问答草稿"), {
      target: { value: "尚未发送的问题" },
    });

    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前任务和输入已保留",
    );
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(screen.getByLabelText("问答草稿")).toHaveValue("尚未发送的问题");
    fireEvent.click(screen.getByRole("button", { name: "重新检查知识库" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("opens real scoped chat and shows the published source used by a new task", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        knowledgeBase: {
          snapshotId: "snapshot-new",
          version: 8,
          sourceFileName: "企业知识库.md",
          documentCount: 12,
          contentHash: "server-only-hash",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("v8"),
    );
    expect(
      screen.getByRole("region", { name: "企业问答知识来源" }),
    ).toHaveTextContent("企业知识库.md");
    expect(
      screen.getByRole("region", { name: "企业问答知识来源" }),
    ).toHaveTextContent("12 篇");
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "server-only-hash",
    );
    expect(screen.getByTestId("chat")).toHaveAttribute(
      "data-purpose",
      "enterprise_qa",
    );
    expect(screen.getByTestId("chat")).toHaveAttribute("data-starter", "false");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/runtime-config?purpose=enterprise_qa",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("reads an existing task's frozen version and discards stale metadata after switching tasks", async () => {
    let resolveOld!: (response: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "snapshot-current",
            version: 3,
            sourceFileName: "历史资料.md",
            documentCount: 5,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    state.activeConversation = { taskId: "task-old" };
    const { rerender } = render(<EnterpriseQaSourceNote />);
    state.activeConversation = { taskId: "task-current" };
    rerender(<EnterpriseQaSourceNote />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("v3"),
    );
    await act(async () => {
      resolveOld({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "snapshot-old",
            version: 1,
            sourceFileName: "过期资料.md",
            documentCount: 1,
          },
        }),
      });
    });
    expect(
      screen.getByRole("region", { name: "企业问答知识来源" }),
    ).toHaveTextContent("历史资料.md");
    expect(
      screen.getByRole("region", { name: "企业问答知识来源" }),
    ).not.toHaveTextContent("过期资料.md");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/frontmind/v2/runtime-config?localTaskId=task-current",
    );
  });

  it("directs an account without a published knowledge base to the real knowledge workspace", async () => {
    window.history.replaceState(
      null,
      "",
      "/enterprise-qa?enterpriseProjectId=11111111-1111-4111-8111-111111111111&operatorOwnerId=7",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ knowledgeBase: null }),
      }),
    );
    render(<EnterpriseQaWorkspace />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "前往智能知识库" }),
    ).toHaveAttribute(
      "href",
      "/?view=knowledge&enterpriseProjectId=11111111-1111-4111-8111-111111111111&operatorOwnerId=7",
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "当前项目尚无可用的已发布知识库",
      ),
    );
  });
  it("keeps chat and creation controls unmounted until publication is confirmed, then allows entry", async () => {
    let resolve!: (response: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    render(<EnterpriseQaWorkspace />);
    expect(
      screen.getByRole("status"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "新建会话" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始企业问答" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      resolve({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "published",
            version: 2,
            sourceFileName: "资料.md",
            documentCount: 4,
          },
        }),
      }),
    );
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
  });

  it("stays locked on failed or invalid source responses and unlocks only after a successful retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ knowledgeBase: { version: 8 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "published",
            version: 8,
            sourceFileName: "资料.md",
            documentCount: 4,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "知识库状态读取失败",
    );
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始企业问答" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
  });

  it("does not let an old conversation snapshot unlock an unpublished project", async () => {
    state.activeConversation = { taskId: "historical-task" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ knowledgeBase: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    expect(
      await screen.findByRole("heading", {
        name: "先发布企业知识库，即可开始问答",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/frontmind/v2/runtime-config?purpose=enterprise_qa",
    );
  });

  it("immediately isolates project switches and ignores delayed responses from the old project", async () => {
    let resolveOldRefresh!: (response: unknown) => void;
    let resolveCurrent!: (response: unknown) => void;
    const published = {
      ok: true,
      json: async () => ({
        knowledgeBase: {
          snapshotId: "project-a-published",
          version: 4,
          sourceFileName: "A资料.md",
          documentCount: 3,
        },
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(published)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveOldRefresh = done;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveCurrent = done;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      null,
      "",
      "/enterprise-qa?enterpriseProjectId=project-a",
    );
    const { rerender } = render(<EnterpriseQaWorkspace />);
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    act(() =>
      window.history.replaceState(
        null,
        "",
        "/enterprise-qa?enterpriseProjectId=project-b",
      ),
    );
    rerender(<EnterpriseQaWorkspace />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    await act(async () => resolveOldRefresh(published));
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    await act(async () =>
      resolveCurrent({ ok: true, json: async () => ({ knowledgeBase: null }) }),
    );
    expect(
      screen.getByRole("heading", { name: "先发布企业知识库，即可开始问答" }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.at(-1)?.[1].headers).toMatchObject({
      "x-enterprise-project-id": "project-b",
    });
    expect(
      screen.getByRole("link", { name: "前往智能知识库" }),
    ).toHaveAttribute("href", "/?view=knowledge&enterpriseProjectId=project-b");
  });

  it("rechecks publication when returning to the page and locks again after it becomes unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "published",
            version: 8,
            sourceFileName: "资料.md",
            documentCount: 4,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ knowledgeBase: null }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    expect(
      await screen.findByRole("heading", {
        name: "先发布企业知识库，即可开始问答",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });
  it("keeps an unlocked chat mounted while a same-project focus check is pending", async () => {
    let resolveRefresh!: (response: unknown) => void;
    const published = {
      ok: true,
      json: async () => ({
        knowledgeBase: {
          snapshotId: "published",
          version: 8,
          sourceFileName: "资料.md",
          documentCount: 4,
        },
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(published)
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolveRefresh = done;
            }),
        ),
    );
    render(<EnterpriseQaWorkspace />);
    const chat = await screen.findByTestId("chat");
    fireEvent(window, new Event("focus"));
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(screen.getByRole("status")).toHaveTextContent("v8");
    await act(async () => resolveRefresh(published));
    expect(screen.getByTestId("chat")).toBe(chat);
  });
  it("unlocks using current publication while preserving an existing conversation's frozen source note", async () => {
    state.activeConversation = { taskId: "frozen-task" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "current",
            version: 8,
            sourceFileName: "当前资料.md",
            documentCount: 4,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "frozen",
            version: 3,
            sourceFileName: "历史资料.md",
            documentCount: 2,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("v3"),
    );
    expect(
      screen.getByRole("region", { name: "企业问答知识来源" }),
    ).toHaveTextContent("历史资料.md");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/frontmind/v2/runtime-config?purpose=enterprise_qa",
      "/api/frontmind/v2/runtime-config?localTaskId=frozen-task",
    ]);
  });
  it.each(["network", "503"])(
    "preserves an unlocked chat and draft on a temporary %s refresh failure, then retries locally",
    async (failure) => {
      const published = {
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "published",
            version: 8,
            sourceFileName: "资料.md",
            documentCount: 4,
          },
        }),
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(published);
      if (failure === "network")
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      else fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      fetchMock.mockResolvedValueOnce(published);
      vi.stubGlobal("fetch", fetchMock);
      render(<EnterpriseQaWorkspace />);
      const chat = await screen.findByTestId("chat");
      fireEvent.change(screen.getByLabelText("问答草稿"), {
        target: { value: "尚未发送的问题" },
      });
      fireEvent(window, new Event("focus"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "当前任务和输入已保留",
      );
      expect(screen.getByTestId("chat")).toBe(chat);
      expect(screen.getByLabelText("问答草稿")).toHaveValue("尚未发送的问题");
      fireEvent.click(screen.getByRole("button", { name: "重新检查知识库" }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("chat")).toBe(chat);
      expect(screen.getByLabelText("问答草稿")).toHaveValue("尚未发送的问题");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("locks an unlocked chat when the server explicitly denies access", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            knowledgeBase: {
              snapshotId: "published",
              version: 8,
              sourceFileName: "资料.md",
              documentCount: 4,
            },
          }),
        })
        .mockResolvedValueOnce({ ok: false, status: 403 }),
    );
    render(<EnterpriseQaWorkspace />);
    expect(await screen.findByTestId("chat")).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "知识库状态读取失败",
    );
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it("times out an initial hung check into a retryable locked page", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ knowledgeBase: null }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("知识库状态读取失败");
    expect(screen.getByRole("button", { name: "重新检查" })).not.toBeDisabled();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    });
    expect(
      screen.getByRole("heading", { name: "先发布企业知识库，即可开始问答" }),
    ).toBeInTheDocument();
  });

  it("retains an unlocked chat and draft when a background source check times out", async () => {
    const published = {
      ok: true,
      json: async () => ({
        knowledgeBase: {
          snapshotId: "published",
          version: 8,
          sourceFileName: "资料.md",
          documentCount: 4,
        },
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(published)
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(published),
    );
    render(<EnterpriseQaWorkspace />);
    const chat = await screen.findByTestId("chat");
    fireEvent.change(screen.getByLabelText("问答草稿"), {
      target: { value: "保留草稿" },
    });
    vi.useFakeTimers();
    fireEvent(window, new Event("focus"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("当前任务和输入已保留");
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(screen.getByLabelText("问答草稿")).toHaveValue("保留草稿");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新检查知识库" }));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(screen.getByLabelText("问答草稿")).toHaveValue("保留草稿");
  });
});
