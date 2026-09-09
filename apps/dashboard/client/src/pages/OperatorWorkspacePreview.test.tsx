import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OperatorWorkspacePreview from "./OperatorWorkspacePreview";
import { OPERATOR_MODULES } from "@/dashboard/operator-navigation";

vi.mock("@/components/ChatArea", () => ({
  MessageBubble: ({
    message,
  }: {
    message: { id: string; content: string };
  }) => <div data-message-id={message.id}>{message.content}</div>,
}));
vi.mock("@/dashboard/OperatorNavigation", async () => {
  const { OPERATOR_MODULES } = await import("@/dashboard/operator-navigation");
  return {
    OperatorSidebar: ({
      projects,
      activeProject,
      onSelectProject,
      onSelectView,
    }: {
      projects: { id: string; name: string }[];
      activeProject?: { id: string };
      onSelectProject: (id: string) => void;
      onSelectView: (view: string) => void;
    }) => (
      <nav aria-label="项目导航预览">
        <select
          aria-label="切换预览项目"
          value={activeProject?.id ?? ""}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {projects.map((project) => (
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
      </nav>
    ),
  };
});

afterEach(cleanup);

const resultTitles = {
  knowledge: "品牌知识底稿",
  keywords: "品牌全域词库",
  questions: "待优化的客户问题",
  "response-logic": "产品选型应答逻辑",
  monitoring: "目标问题监控记录",
  reports: "品牌优化进度报告",
  content: "品牌文章草稿",
  publishing: "发布准备清单",
  articles: "稿件管理",
  media: "媒体渠道库",
  "enterprise-qa": "企业问答示例",
  website: "企业网站内容配置",
  "content-insights": "内容表现与 AI 部件",
};

function selectModule(label: string) {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "项目导航预览" })).getByRole(
      "button",
      { name: label },
    ),
  );
}
function selectSubagent(label: string) {
  fireEvent.click(
    within(screen.getByRole("group", { name: "子智能体" })).getByRole(
      "button",
      { name: label },
    ),
  );
}
function selectProject(id: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "切换预览项目" }), {
    target: { value: id },
  });
}

describe("OperatorWorkspacePreview subagent results", () => {
  it("keeps the subagent selector in collaboration and changes the result for every subagent", () => {
    render(<OperatorWorkspacePreview />);
    const conversation = screen.getByRole("region", { name: "智能体协作" });
    expect(
      within(conversation).getByRole("group", { name: "子智能体" }),
    ).toBeInTheDocument();

    for (const module of OPERATOR_MODULES) {
      selectModule(module.label);
      for (const view of module.views) {
        selectSubagent(view.label);
        const group = within(conversation).getByRole("group", {
          name: "子智能体",
        });
        expect(
          within(group).getByRole("button", { name: view.label }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
          screen.getByRole("heading", {
            level: 2,
            name: resultTitles[view.id],
          }),
        ).toBeInTheDocument();
      }
    }
  });

  it("keeps the shared project conversation while isolating another project's draft and running state", () => {
    render(<OperatorWorkspacePreview />);
    const input = screen.getByRole("textbox", { name: "继续对话" });
    fireEvent.change(input, { target: { value: "星辰项目待发问题" } });
    selectModule("媒体发布");
    selectSubagent("媒体库");
    expect(screen.getByRole("textbox", { name: "继续对话" })).toBe(input);
    expect(input).toHaveValue("星辰项目待发问题");
    fireEvent.click(screen.getByRole("button", { name: "发送预览消息" }));
    fireEvent.click(screen.getByRole("button", { name: "演示长任务" }));

    selectProject("design-project-2");
    expect(screen.queryByText("星辰项目待发问题")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "演示长任务" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "教育项目草稿" },
    });

    selectProject("design-project");
    expect(screen.getByText("星辰项目待发问题")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "完成演示任务" }),
    ).toBeInTheDocument();
    selectProject("design-project-2");
    expect(screen.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "教育项目草稿",
    );
  });

  it("stores edits by project and subagent rather than overwriting another result in the same module", () => {
    render(<OperatorWorkspacePreview />);
    selectModule("媒体发布");
    selectSubagent("稿件");
    fireEvent.click(screen.getByRole("button", { name: "编辑成果" }));
    fireEvent.change(screen.getByRole("textbox", { name: "成果正文" }), {
      target: { value: "星辰项目专用稿件" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并返回" }));
    expect(screen.getByText("星辰项目专用稿件")).toBeInTheDocument();

    selectSubagent("媒体库");
    expect(screen.queryByText("星辰项目专用稿件")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "媒体渠道库" }),
    ).toBeInTheDocument();
    selectSubagent("稿件");
    expect(screen.getByText("星辰项目专用稿件")).toBeInTheDocument();
    selectProject("design-project-2");
    expect(screen.queryByText("星辰项目专用稿件")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "稿件管理" }),
    ).toBeInTheDocument();
    selectProject("design-project");
    expect(screen.getByText("星辰项目专用稿件")).toBeInTheDocument();
  });
});
