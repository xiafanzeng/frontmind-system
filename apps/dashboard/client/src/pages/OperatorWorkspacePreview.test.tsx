import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperatorWorkspacePreview from "./OperatorWorkspacePreview";
import { OPERATOR_MODULES } from "@/dashboard/operator-navigation";

vi.mock("@/components/ChatArea", () => ({
  MessageBubble: ({
    message,
  }: {
    message: { id: string; content: string };
  }) => <div data-message-id={message.id}>{message.content}</div>,
}));
vi.mock("@/contexts/ConversationContext", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  ConversationProvider: ({ children }: any) => children,
  useConversation: () => ({
    state: { conversations: [] },
    commitKnowledgeBaseObservation: vi.fn(),
  }),
}));
vi.mock("@/dashboard/OperatorNavigation", async () => {
  const { OPERATOR_MODULES } = await import("@/dashboard/operator-navigation");
  return {
    OperatorSidebar: ({
      projects,
      activeProject,
      onSelectProject,
      onSelectView,
      onNavigate,
      taskNavigation,
    }: any) => (
      <nav aria-label="项目导航预览">
        <button onClick={() => onNavigate("/agent")}>通用智能体</button>
        <select
          aria-label="切换预览项目"
          value={activeProject?.id ?? ""}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {projects.map((project: any) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {OPERATOR_MODULES.map((module) => (
          <button
            key={module.id}
            onClick={() => onSelectView(module.views[0].id)}
          >
            {module.label}
          </button>
        ))}
        {taskNavigation}
      </nav>
    ),
  };
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const selectModule = (name: string) =>
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "项目导航预览" })).getByRole(
      "button",
      { name },
    ),
  );
const selectAgent = (name: string) =>
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "切换子 Agent" })).getByRole(
      "button",
      { name },
    ),
  );

describe("operator workspace layout acceptance", () => {
  it("uses real knowledge nodes at right, main business content and inspector summaries for every agent", () => {
    const { container } = render(<OperatorWorkspacePreview />);
    expect(
      container.querySelector('[data-layout="knowledge"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "主工作区" })).toContainElement(
      screen.getByRole("textbox", { name: "样例任务输入" }),
    );
    expect(
      screen.getByRole("complementary", { name: "知识节点与资料" }),
    ).not.toContainElement(
      screen.getByRole("textbox", { name: "样例任务输入" }),
    );
    expect(container.querySelector(".operator-project-context")).toBeNull();
    for (const module of OPERATOR_MODULES) {
      selectModule(module.label);
      for (const agent of module.views) {
        selectAgent(agent.label);
        expect(
          within(
            screen.getByRole("navigation", { name: "切换子 Agent" }),
          ).getByRole("button", { name: agent.label }),
        ).toHaveAttribute("aria-pressed", "true");
        if (agent.id !== "knowledge") {
          expect(
            container.querySelector('[data-layout="workflow"]'),
          ).toBeInTheDocument();
          const auxiliary = screen.getByRole("complementary", {
            name: "任务辅助区",
          });
          expect(auxiliary.querySelector("table")).toBeNull();
          expect(auxiliary.querySelector("textarea")).toBeNull();
        }
      }
    }
  });
  it("shows the general welcome and attachment composer in a single workspace", () => {
    const { container } = render(<OperatorWorkspacePreview />);
    selectModule("通用智能体");
    expect(
      container.querySelector('[data-layout="single"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "有什么想一起完成的？" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "继续对话" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("添加预览附件")).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "任务辅助区" }),
    ).toBeNull();
  });
  it("keeps drafts and conversation history independent between agents and projects", () => {
    render(<OperatorWorkspacePreview />);
    selectModule("通用智能体");
    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "通用任务草稿" },
    });
    selectModule("内容制作");
    selectModule("通用智能体");
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "通用任务草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送预览消息" }));
    fireEvent.click(screen.getByRole("button", { name: "新任务" }));
    expect(screen.queryByText("通用任务草稿")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^历史$/ }),
    ).toBeNull();
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "任务历史" })).getByRole(
        "button",
        { name: /^任务 1/ },
      ),
    );
    expect(screen.getByText("通用任务草稿")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "切换预览项目" }), {
      target: { value: "design-project-2" },
    });
    selectModule("通用智能体");
    expect(screen.queryByText("通用任务草稿")).toBeNull();
  });
  it("starts the media workflow with a directory and keeps the handoff steps in main", () => {
    render(<OperatorWorkspacePreview />);
    selectModule("媒体发布");
    selectAgent("媒体库");
    const main = screen.getByRole("region", { name: "主工作区" });
    expect(within(main).getByRole("table")).toBeInTheDocument();
    expect(
      within(main).queryByRole("textbox", { name: "继续对话" }),
    ).toBeNull();
    fireEvent.click(
      within(main).getByRole("checkbox", { name: "选择科技观察" }),
    );
    fireEvent.click(
      within(main).getByRole("button", { name: "选择稿件并继续" }),
    );
    expect(
      within(main).getByRole("heading", { name: "选择冻结稿件" }),
    ).toBeInTheDocument();
    fireEvent.click(within(main).getByRole("button", { name: "交给发布助手" }));
    expect(
      within(main).getByRole("heading", { name: "标题与发布预检" }),
    ).toBeInTheDocument();
  });
});
