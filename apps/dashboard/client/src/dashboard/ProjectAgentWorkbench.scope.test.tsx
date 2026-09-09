import { useState, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
const api = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    conversation: {
      workbenchBind: { useMutation: () => ({ mutateAsync: api.mutate }) },
      workbenchSaveState: { useMutation: () => ({ mutateAsync: api.mutate }) },
      workbenchHandoff: { useMutation: () => ({ mutateAsync: api.mutate }) },
    },
  },
}));
vi.mock("@/pages/Home", () => ({
  default: function Chat() {
    const { activeConversation } = useConversation();
    return <output aria-label="问答会话">{activeConversation?.id}</output>;
  },
}));
const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  messages: [],
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const tasks = [
  row("general"),
  row("logic", { executionKind: "response_logic" }),
  row("qa", { purpose: "enterprise_qa" }),
  row("media-a", { workbenchAgentId: "media" }),
  row("articles-a", { workbenchAgentId: "articles" }),
];
function Workspace({ children }: { children: ReactNode }) {
  const [active, setActive] = useState("general");
  return (
    <ConversationContextProvider
      value={
        {
          hydrated: true,
          workbenchScopeKey: "scope-integration",
          state: { conversations: tasks, activeConversationId: active },
          activeConversation: tasks.find((item) => item.id === active),
          setActive,
          isKnowledgeBaseConversation: () => false,
          createConversation: vi.fn(),
          flushConversation: async () => true,
          refreshConversations: async () => undefined,
        } as any
      }
    >
      {children}
    </ConversationContextProvider>
  );
}
function EditorProbe() {
  const { state } = useConversation();
  return (
    <output aria-label="编辑器任务">
      {state.conversations.map((item) => item.id).join(",")}
    </output>
  );
}
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});
describe("workbench task scopes", () => {
  it("isolates subagent history while specialist adapters retain project access", () => {
    const module = createWorkbenchModules(
      () => null,
      () => undefined,
      "media",
    ).find((item) => item.id === "publishing")!;
    render(
      <Workspace>
        <WorkbenchModuleContext.Provider value={module}>
          <ProjectAgentWorkbench projectId="project-a">
            <EditorProbe />
          </ProjectAgentWorkbench>
        </WorkbenchModuleContext.Provider>
      </Workspace>,
    );
    expect(screen.getByLabelText("编辑器任务")).toHaveTextContent(
      "general,logic,qa,media-a,articles-a",
    );
    fireEvent.click(screen.getByRole("tab", { name: "任务" }));
    const history = screen.getByRole("listbox", { name: "任务历史" });
    expect(within(history).getAllByRole("option")).toHaveLength(1);
    expect(history).toHaveTextContent("media-a");
    expect(history).not.toHaveTextContent("articles-a");
    expect(history).not.toHaveTextContent("general");
  });
  it("keeps QA source and main dialogue on the same native task", async () => {
    render(
      <Workspace>
        <ProjectAgentWorkbench projectId="project-a" purpose="enterprise_qa">
          <EditorProbe />
        </ProjectAgentWorkbench>
      </Workspace>,
    );
    expect(await screen.findByLabelText("问答会话")).toHaveTextContent(/^qa$/);
    expect(screen.getByLabelText("编辑器任务")).toHaveTextContent(/^qa$/);
    expect(
      within(screen.getByRole("region", { name: "主工作区" })).getByLabelText(
        "问答会话",
      ),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("complementary", { name: "任务辅助区" }),
      ).getByLabelText("编辑器任务"),
    ).toBeInTheDocument();
  });
  it("keeps unclassified conversations in the general legacy history entry", () => {
    function GeneralWithSidebar() {
      const [target, setTarget] = useState<HTMLDivElement | null>(null);
      return (
        <>
          <aside aria-label="通用任务导航">
            <div ref={setTarget} />
          </aside>
          <ProjectAgentWorkbench
            projectId="account"
            taskNavigationTarget={target}
          />
        </>
      );
    }
    render(
      <Workspace>
        <GeneralWithSidebar />
      </Workspace>,
    );
    const sidebar = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(screen.queryByRole("button", { name: "历史" })).toBeNull();
    fireEvent.click(within(sidebar).getByRole("button", { name: "旧任务" }));
    const history = within(sidebar).getByRole("listbox", { name: "任务历史" });
    expect(within(history).getAllByRole("option")).toHaveLength(1);
    expect(history).toHaveTextContent("general");
    expect(history).not.toHaveTextContent("media-a");
    expect(history).not.toHaveTextContent("logic");
    expect(history).not.toHaveTextContent("qa");
  });
});
