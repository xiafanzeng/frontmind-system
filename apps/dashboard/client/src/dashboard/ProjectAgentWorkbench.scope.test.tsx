import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectAgentWorkbench from "./ProjectAgentWorkbench";
import { createWorkbenchModules, WorkbenchModuleContext } from "./agent-workbench";
import { useConversation } from "@/contexts/ConversationContext";
const fixture = vi.hoisted(() => ({
  workspace: {
    activeConversation: null,
    state: {
      conversations: [
        { id: "general", title: "品牌讨论" },
        { id: "logic", title: "应答逻辑", executionKind: "response_logic" },
        { id: "qa", title: "企业问答", purpose: "enterprise_qa" },
      ],
    },
    hydrated: true,
    createConversation: vi.fn(),
    setActive: vi.fn(),
  },
}));
vi.mock("@/contexts/ConversationContext", async () => {
  const React = await import("react");
  const Context = React.createContext<any>(null);
  return {
    useConversation: () => React.useContext(Context) ?? fixture.workspace,
    ConversationContextProvider: Context.Provider,
    ConversationPurposeProvider: ({ purpose, children }: any) => (
      <Context.Provider
        value={{
          ...fixture.workspace,
          state: {
            conversations: fixture.workspace.state.conversations.filter(
              (item) =>
                purpose === "general"
                  ? !item.purpose && item.executionKind !== "response_logic"
                  : item.purpose === purpose,
            ),
          },
        }}
      >
        {children}
      </Context.Provider>
    ),
  };
});
vi.mock("@/pages/Home", () => ({ default: () => <div>对话已就绪</div> }));
function EditorProbe() {
  const { state } = useConversation();
  return (
    <output aria-label="编辑器任务">
      {state.conversations.map((item) => item.id).join(",")}
    </output>
  );
}
describe("workbench conversation boundaries", () => {
  it("lets specialist editors restore their task while the central conversation stays filtered", () => {
    const module = createWorkbenchModules(() => null, () => undefined)[0]!;
    render(
      <WorkbenchModuleContext.Provider value={module}>
        <ProjectAgentWorkbench projectId="project-a">
          <EditorProbe />
        </ProjectAgentWorkbench>
      </WorkbenchModuleContext.Provider>,
    );
    expect(screen.getByLabelText("编辑器任务")).toHaveTextContent(
      "general,logic,qa",
    );
    expect(screen.getByRole("combobox")).toHaveValue("开始一个新任务");
    expect(screen.getByRole("combobox")).not.toHaveValue("应答逻辑");
  });
  it("keeps enterprise QA source information bound to the QA conversation", () => {
    render(
      <ProjectAgentWorkbench projectId="project-a" purpose="enterprise_qa">
        <EditorProbe />
      </ProjectAgentWorkbench>,
    );
    expect(screen.getByLabelText("编辑器任务")).toHaveTextContent(/^qa$/);
  });
});
