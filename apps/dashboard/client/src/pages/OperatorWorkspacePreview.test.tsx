import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperatorWorkspacePreview, {
  PREVIEW_STORAGE_KEY,
} from "./OperatorWorkspacePreview";
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
  sessionStorage.removeItem(PREVIEW_STORAGE_KEY);
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
  it("keeps the polished general welcome and tasks/results in the shared workspace", () => {
    const { container } = render(<OperatorWorkspacePreview />);
    selectModule("通用智能体");
    expect(
      container.querySelector('[data-layout="workflow"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "有什么想一起完成的？" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "继续对话" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("添加预览附件")).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "任务辅助区" }),
    ).toContainElement(screen.getByRole("button", { name: "新任务" }));
    expect(
      screen.getByRole("navigation", { name: "项目导航预览" }),
    ).not.toContainElement(screen.getByRole("button", { name: "新任务" }));
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
    expect(screen.queryByRole("button", { name: /^历史$/ })).toBeNull();
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
  it("unfolds the media directory, confirms selection and hands off to a separate task", () => {
    render(<OperatorWorkspacePreview />);
    selectModule("媒体发布");
    selectAgent("媒体库");
    const main = screen.getByRole("region", { name: "主工作区" });
    expect(within(main).queryByRole("table")).toBeNull();
    fireEvent.click(within(main).getByRole("button", { name: "浏览媒体目录" }));
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
    fireEvent.click(
      within(main).getByRole("button", { name: /企业智能客服选型指南 · v1/ }),
    );
    fireEvent.click(within(main).getByRole("button", { name: "确认投放选择" }));
    fireEvent.click(within(main).getByRole("button", { name: "交给发布助手" }));
    expect(
      within(main).getByRole("heading", { name: "标题与发布预检" }),
    ).toBeInTheDocument();
    selectAgent("媒体库");
    fireEvent.click(within(main).getByRole("button", { name: "交给发布助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "任务" }));
    expect(
      within(screen.getByRole("listbox", { name: "任务历史" })).getAllByRole(
        "option",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText("任务 3")).toBeNull();
  });

  it("selects a word-bank resource inside the question task and retains only confirmed outcomes", () => {
    render(<OperatorWorkspacePreview />);
    selectModule("意图优化");
    const main = screen.getByRole("region", { name: "主工作区" });
    const right = screen.getByRole("complementary", { name: "任务辅助区" });
    fireEvent.click(within(main).getByRole("button", { name: "从词库挑选" }));
    fireEvent.click(
      within(main).getAllByRole("button", { name: "选择问题" })[0],
    );
    expect(
      within(right).getByText("确认后的成果会保留在这里。"),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: "切换子 Agent" }),
      ).getByRole("button", { name: "优化问题" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(main).getByRole("button", { name: "检查问题并继续" }),
    );
    fireEvent.click(
      within(main).getByRole("button", { name: "确认加入优化问题" }),
    );
    expect(
      within(right).getByText("已加入优化清单 · 待制作应答"),
    ).toBeInTheDocument();
    expect(within(right).queryByRole("table")).toBeNull();
    fireEvent.click(within(main).getByRole("button", { name: "进入应答逻辑" }));
    expect(
      within(main).getByRole("heading", { name: "检查并完善应答草稿" }),
    ).toBeInTheDocument();
  });

  it("restores a task draft after reloading the local preview without borrowing another agent's draft", () => {
    const first = render(<OperatorWorkspacePreview />);
    selectModule("通用智能体");
    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "刷新后仍保留的任务资料" },
    });
    first.unmount();
    render(<OperatorWorkspacePreview />);
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "刷新后仍保留的任务资料",
    );
    fireEvent.click(screen.getByRole("button", { name: "新任务" }));
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue("");
    selectModule("内容制作");
    expect(screen.queryByText("刷新后仍保留的任务资料")).toBeNull();
  });
});
