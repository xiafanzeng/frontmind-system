import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectAgentWorkbench from "./ProjectAgentWorkbench";
import {
  createWorkbenchModules,
  WorkbenchModuleContext,
} from "./agent-workbench";
import {
  ConversationContextProvider,
  useConversation,
  type Conversation,
} from "@/contexts/ConversationContext";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import { initialWorkbenchTaskState } from "@shared/workbench-task";
import { WorkbenchTaskToolbar } from "./WorkbenchTaskToolbar";
const api = vi.hoisted(() => ({
  bind: vi.fn(),
  save: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: { workRecords: { list: { useQuery: () => ({ data: { records: [], nextCursor: null } }) } } },
    conversation: {
      workbenchBind: { useMutation: () => ({ mutateAsync: api.bind }) },
      workbenchSaveState: { useMutation: () => ({ mutateAsync: api.save }) },
      workbenchHandoff: { useMutation: () => ({ mutateAsync: api.handoff }) },
    },
  },
}));
vi.mock("@/pages/Home", () => ({
  default: function NativeChat() {
    const { activeConversation } = useConversation();
    return (
      <textarea aria-label="对话输入" data-task={activeConversation?.id} />
    );
  },
}));
function Workspace({
  children,
  initialConversations = [],
}: {
  children: React.ReactNode;
  initialConversations?: Conversation[];
}) {
  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);
  const [active, setActive] = useState<string | null>(null);
  return (
    <ConversationContextProvider
      value={
        {
          hydrated: true,
          loading: false,
          syncError: null,
          workbenchScopeKey: "workbench-integration",
          state: { conversations, activeConversationId: active },
          activeConversation:
            conversations.find((item) => item.id === active) ?? null,
          setActive,
          deleteConversation: (id: string) =>
            setConversations((items) => items.filter((item) => item.id !== id)),
          isKnowledgeBaseConversation: () => false,
          flushConversation: async () => true,
          refreshConversations: async () => undefined,
          createConversation: (options: any) => {
            const id = `local-${conversations.length}`;
            setConversations((current) => [
              ...current,
              {
                id,
                title: "新任务",
                messages: [],
                status: "idle",
                createdAt: 1,
                updatedAt: 1,
                ...options,
              },
            ]);
            setActive(id);
            return id;
          },
        } as any
      }
    >
      {children}
    </ConversationContextProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
  window.history.replaceState({}, "", "/");
  api.bind.mockImplementation(async ({ agentId }) =>
    initialWorkbenchTaskState(agentId),
  );
  api.save.mockImplementation(async ({ agentId, expectedRevision, patch }) => ({
    ...initialWorkbenchTaskState(agentId),
    revision: expectedRevision + 1,
    values: patch.values ?? {},
  }));
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});
describe("conversational project workbench", () => {
  it.each([true, false])(
    "keeps the project keyword catalog independent of stale task links (saved resource: %s)",
    (saved) => {
      const module = createWorkbenchModules(
        () => null,
        () => undefined,
        "keywords",
      ).find((item) => item.id === "brand")!;
      const row = (
        id: string,
        updatedAt: number,
        agentId: "keywords" | "media",
      ): Conversation => ({
        id,
        title: id,
        messages: [],
        status: "idle",
        createdAt: 1,
        updatedAt,
        workbenchAgentId: agentId,
        workbench: initialWorkbenchTaskState(agentId),
      });
      const retained = saved
        ? [
            row("historical-keywords", 1, "keywords"),
            row("current-keywords", 2, "keywords"),
            row("foreign-media", 3, "media"),
          ]
        : [row("foreign-media", 3, "media")];
      function Catalog() {
        const { task } = useBusinessWorkspace();
        const { state } = useConversation();
        useBusinessWorkspaceSummary({
          title: "项目词库",
          scope: "project",
          items: [{ label: "当前生效词库", value: "版本 7 · 160 条问题" }],
        });
        return (
          <>
            <output aria-label="词库绑定">{task?.taskId}</output>
            <output aria-label="保留记录">
              {state.conversations.map((item) => item.id).join(",")}
            </output>
          </>
        );
      }
      const page = () => (
        <Workspace initialConversations={retained}>
          <WorkbenchModuleContext.Provider value={module}>
            <ProjectAgentWorkbench projectId="a">
              <Catalog />
            </ProjectAgentWorkbench>
          </WorkbenchModuleContext.Provider>
        </Workspace>
      );
      window.history.replaceState(
        {},
        "",
        `/?view=keywords&workbenchTask=${saved ? "historical-keywords" : "foreign-media"}`,
      );
      const view = render(page());
      const expected = saved ? "current-keywords" : "local-1";
      expect(screen.getByLabelText("词库绑定")).toHaveTextContent(expected);
      const main = screen.getByRole("region", { name: "主工作区" });
      expect(
        within(main).getByRole("heading", { name: "项目词库" }),
      ).toBeInTheDocument();
      expect(main).toHaveTextContent("版本 7 · 160 条问题");
      expect(
        screen.queryByRole("complementary", { name: "任务辅助区" }),
      ).toBeNull();
      expect(screen.queryByRole("tab", { name: "任务" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "成果" })).toBeNull();
      expect(screen.queryByRole("button", { name: "新任务" })).toBeNull();
      expect(screen.queryByRole("listbox", { name: "任务历史" })).toBeNull();
      retained.forEach((item) =>
        expect(screen.getByLabelText("保留记录")).toHaveTextContent(item.id),
      );
      view.unmount();
      render(page());
      expect(screen.getByLabelText("词库绑定")).toHaveTextContent(expected);
      expect(api.bind).not.toHaveBeenCalled();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.handoff).not.toHaveBeenCalled();
    },
  );
  it("keeps an already restored business outcome visible on first mount", () => {
    function RestoredBusiness() {
      useBusinessWorkspaceSummary({
        items: [],
        outputs: [
          {
            id: "saved-question",
            title: "已保存的优化问题",
            status: "已确认",
            version: "1",
          },
        ],
      });
      return <p>已恢复的业务步骤</p>;
    }
    const module = createWorkbenchModules(
      () => null,
      () => undefined,
      "questions",
    ).find((item) => item.id === "intent")!;
    render(
      <Workspace
        initialConversations={[
          {
            id: "restored",
            title: "原任务",
            messages: [],
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
            workbenchAgentId: "questions",
            workbench: initialWorkbenchTaskState("questions"),
          },
        ]}
      >
        <WorkbenchModuleContext.Provider value={module}>
          <ProjectAgentWorkbench projectId="a">
            <RestoredBusiness />
          </ProjectAgentWorkbench>
        </WorkbenchModuleContext.Provider>
      </Workspace>,
    );
    expect(
      within(screen.getByRole("region", { name: "主工作区" })).getByText(
        "已保存的优化问题",
      ),
    ).toBeInTheDocument();
  });
  it("starts real business content in the main pane without a placeholder chat", () => {
    const open = vi.fn();
    const module = createWorkbenchModules(() => null, open, "media").find(
      (item) => item.id === "publishing",
    )!;
    render(
      <Workspace>
        <WorkbenchModuleContext.Provider value={module}>
          <ProjectAgentWorkbench projectId="a">
            <p>真实媒体目录</p>
          </ProjectAgentWorkbench>
        </WorkbenchModuleContext.Provider>
      </Workspace>,
    );
    expect(
      within(screen.getByRole("region", { name: "主工作区" })).getByText(
        "真实媒体目录",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/主工作区中的业务内容会随操作逐步展开/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("对话输入")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "切换业务子页面" }),
      ).getByRole("button", { name: "稿件" }),
    );
    expect(open).toHaveBeenCalledWith("articles");
    expect(api.bind).not.toHaveBeenCalled();
  });
  it("preserves local business input during first server binding", async () => {
    function Catalog() {
      const { task } = useBusinessWorkspace();
      const [query, setQuery] = useState("");
      return (
        <>
          <input
            aria-label="媒体搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button onClick={() => void task?.saveState({ values: { query } })}>
            应用条件
          </button>
        </>
      );
    }
    const module = createWorkbenchModules(
      () => null,
      () => undefined,
      "media",
    ).find((item) => item.id === "publishing")!;
    render(
      <Workspace>
        <WorkbenchModuleContext.Provider value={module}>
          <ProjectAgentWorkbench projectId="a">
            <Catalog />
          </ProjectAgentWorkbench>
        </WorkbenchModuleContext.Provider>
      </Workspace>,
    );
    const input = screen.getByRole("textbox", { name: "媒体搜索" });
    fireEvent.change(input, { target: { value: "人工智能" } });
    fireEvent.click(screen.getByText("应用条件"));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.bind).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "local-0", agentId: "media" }),
    );
    expect(screen.getByRole("textbox", { name: "媒体搜索" })).toBe(input);
    expect(input).toHaveValue("人工智能");
  });
});
