import { useState } from "react";
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

const context = vi.hoisted(() => ({
  current: {
    activeConversation: null,
    state: { conversations: [] },
    hydrated: true,
    createConversation: vi.fn(),
    setActive: vi.fn(),
  } as any,
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => context.current,
  ConversationContextProvider: ({ children }: any) => children,
  ConversationPurposeProvider: ({ children }: any) => children,
}));
vi.mock("@/pages/Home", () => ({
  default: () => {
    const [value, setValue] = useState("");
    return (
      <textarea
        aria-label="对话输入"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));
beforeEach(() => {
  context.current = {
    activeConversation: {
      id: "chat-a",
      title: "我的项目任务",
      status: "running",
      messages: [],
    },
    state: { conversations: [{ id: "chat-a", title: "我的项目任务" }] },
    hydrated: true,
    createConversation: vi.fn(),
    setActive: vi.fn(),
  };
});
afterEach(cleanup);
describe("project conversation and workbench context", () => {
  it("keeps business content in the primary pane and exposes subagent context on the side", async () => {
    const open = vi.fn();
    const modules = createWorkbenchModules((id) => <p>{id} 成果</p>, open);
    const layout = (index: number) => (
      <WorkbenchModuleContext.Provider value={modules[index]!}>
        <ProjectAgentWorkbench projectId="a">
          {modules[index]!.renderResult()}
        </ProjectAgentWorkbench>
      </WorkbenchModuleContext.Provider>
    );
    const { rerender } = render(layout(1));
    fireEvent.click(
      within(screen.getByRole("group", { name: "子智能体" })).getByRole(
        "button",
        {
          name: "应答逻辑",
        },
      ),
    );
    expect(open).toHaveBeenCalledWith("response-logic");
    rerender(layout(2));
    expect(screen.getByText("progress 成果")).toBeInTheDocument();
    expect(screen.queryByText("intent 成果")).not.toBeInTheDocument();
    expect(screen.getByText(/主工作区中的业务内容会随操作逐步展开/u)).toBeInTheDocument();
  });
  it("does not render a separate results pane for the general agent", () => {
    context.current.activeConversation.messages = [
      {
        id: "out-a",
        role: "assistant",
        outputFiles: [
          {
            fileName: "项目A报告.pdf",
            fileUrl: "/api/files/a",
            mimeType: "application/pdf",
          },
          {
            fileName: "无效地址",
            fileUrl: "javascript:alert(1)",
            mimeType: "text/plain",
          },
        ],
      },
    ];
    const { rerender } = render(<ProjectAgentWorkbench projectId="a" />);
    expect(screen.queryByRole("region", { name: "任务成果" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "无效地址" })).not.toBeInTheDocument();
    context.current = {
      ...context.current,
      activeConversation: null,
      state: { conversations: [] },
    };
    rerender(<ProjectAgentWorkbench key="project-b" projectId="b" />);
    expect(screen.queryByText("项目A报告.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("我的项目任务")).not.toBeInTheDocument();
  });
});
