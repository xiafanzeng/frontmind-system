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
import { useBusinessWorkspace } from "./BusinessWorkspaceContext";
import { initialWorkbenchTaskState } from "@shared/workbench-task";
const api = vi.hoisted(() => ({
  bind: vi.fn(),
  save: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
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
function Workspace({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  return (
    <ConversationContextProvider
      value={
        {
          hydrated: true,
          workbenchScopeKey: "workbench-integration",
          state: { conversations, activeConversationId: active },
          activeConversation:
            conversations.find((item) => item.id === active) ?? null,
          setActive,
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
        screen.getByRole("navigation", { name: "切换子 Agent" }),
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
  it("opens a local native general task with no auxiliary pane", async () => {
    render(
      <Workspace>
        <ProjectAgentWorkbench projectId="account" />
      </Workspace>,
    );
    expect(await screen.findByLabelText("对话输入")).toHaveAttribute(
      "data-task",
      "local-0",
    );
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(api.bind).not.toHaveBeenCalled();
  });
});
