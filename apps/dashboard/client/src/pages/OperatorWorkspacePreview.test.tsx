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
    within(screen.getByRole("navigation", { name: "切换业务子页面" })).getByRole(
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
    expect(screen.getByLabelText("知识库版本与下载")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新任务" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "任务历史" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "任务" })).toBeNull();
    for (const module of OPERATOR_MODULES) {
      selectModule(module.label);
      for (const agent of module.views) {
        selectAgent(agent.label);
        expect(
          within(
            screen.getByRole("navigation", { name: "切换业务子页面" }),
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
          if (agent.id === "keywords") {
            expect(
              within(auxiliary).getByRole("heading", { name: "项目词库" }),
            ).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "新任务" })).toBeNull();
            expect(
              screen.queryByRole("listbox", { name: "任务历史" }),
            ).toBeNull();
            expect(screen.queryByRole("tab", { name: "任务" })).toBeNull();
            expect(screen.queryByRole("tab", { name: "成果" })).toBeNull();
          }
        }
      }
    }
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
    fireEvent.click(screen.getByText("投放工作记录", { selector: "summary" }));
    expect(
      within(
        screen.getByRole("listbox", { name: "投放工作记录" }),
      ).getAllByRole("option"),
    ).toHaveLength(2);
    expect(screen.queryByText("任务 3")).toBeNull();
  });

  it.each([
    ["意图优化", "优化问题", "优化问题", "选题工作记录", null],
    ["媒体发布", "稿件", "稿件与版本", "编辑工作记录", null],
    ["媒体发布", "媒体库", "投放选择", "选媒工作记录", "开始新的选媒"],
    ["媒体发布", "发布工作台", "发布进度", "投放工作记录", null],
    ["进度监控", "问题监控", "监控项目与运行", "监控工作记录", null],
    ["进度监控", "进度报告", "分析范围与报告", "分析记录", null],
    ["AI专用官网", "网站管理", "站点与版本", "建站与配置记录", null],
    [
      "AI专用官网",
      "内容分析与 AI 部件",
      "分析与部件配置",
      "预览配置记录",
      null,
    ],
  ])(
    "shows %s / %s business resources before secondary work records",
    (moduleName, agentName, title, history, newAction) => {
      render(<OperatorWorkspacePreview />);
      selectModule(moduleName!);
      selectAgent(agentName!);
      const auxiliary = screen.getByRole("complementary", {
        name: "任务辅助区",
      });
      expect(
        within(auxiliary).getByRole("heading", { name: title! }),
      ).toBeInTheDocument();
      expect(within(auxiliary).queryByRole("tablist")).toBeNull();
      const disclosure = within(auxiliary).getByText(history!, {
        selector: "summary",
      });
      expect(disclosure.parentElement).not.toHaveAttribute("open");
      expect(
        within(auxiliary).getByRole("listbox", { name: history! }),
      ).not.toBeVisible();
      fireEvent.click(disclosure);
      expect(
        within(auxiliary).getByRole("listbox", { name: history! }),
      ).toBeInTheDocument();
      expect(
        within(auxiliary).queryByRole("button", {
          name: "新任务",
        }),
      ).toBeNull();
      if (newAction) {
        fireEvent.click(
          within(auxiliary).getByRole("button", {
            name: newAction,
          }),
        );
        expect(within(auxiliary).getAllByRole("option")).toHaveLength(2);
      } else {
        expect(
          auxiliary.querySelector(".workbench-task-navigation__new"),
        ).toBeNull();
      }
    },
  );

  it.each([
    ["AI专用官网", "企业问答", "会话", "知识来源", "新会话", "会话历史"],
    ["意图优化", "应答逻辑", "问题", "应答版本", "选择问题", "已有应答问题"],
    ["内容制作", "内容工作台", "制作任务", "交付文件", "新建制作", "制作记录"],
  ])(
    "uses dedicated %s / %s panel labels while preserving preview task switching",
    (moduleName, agentName, historyTab, outputTab, newAction, history) => {
      render(<OperatorWorkspacePreview />);
      selectModule(moduleName);
      selectAgent(agentName);
      const auxiliary = screen.getByRole("complementary", {
        name: "任务辅助区",
      });
      expect(
        within(auxiliary).getByRole("tab", { name: outputTab }),
      ).toBeInTheDocument();
      fireEvent.click(within(auxiliary).getByRole("tab", { name: historyTab }));
      fireEvent.click(
        within(auxiliary).getByRole("button", { name: newAction }),
      );
      expect(
        within(auxiliary).getByRole("listbox", { name: history }),
      ).toBeInTheDocument();
      expect(within(auxiliary).getAllByRole("option")).toHaveLength(2);
      expect(within(auxiliary).queryByRole("tab", { name: "成果" })).toBeNull();
    },
  );

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
        screen.getByRole("navigation", { name: "切换业务子页面" }),
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

});
