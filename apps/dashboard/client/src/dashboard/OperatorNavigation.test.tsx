import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorSidebar, OperatorTabs, type EnterpriseProjectView } from "./OperatorNavigation";
import { operatorRouteForView, operatorViewFromRoute, operatorViewPath } from "./operator-navigation";

const project: EnterpriseProjectView = { id: "project-a", name: "企业甲", ownerUserId: 1, revision: 1 };
const sidebarProps = () => ({ projects: [project], activeProject: project, activeEntry: "project" as const, collapsed: false, onCollapse: vi.fn(), onNavigate: vi.fn(), onSelectProject: vi.fn(), onCreateProject: vi.fn().mockResolvedValue(undefined), onRenameProject: vi.fn().mockResolvedValue(undefined), onDeleteProject: vi.fn().mockResolvedValue(undefined) });
async function chooseProjectAction(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "项目管理" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
  return screen.findByRole("dialog");
}

describe("operator workspace navigation", () => {
  it("offers six persistent modules and nested knowledge views", () => {
    const select = vi.fn();
    render(<OperatorTabs view="knowledge-display" projectName="企业甲" onSelect={select} />);
    const modules = screen.getByRole("tablist", { name: "项目板块" });
    expect(within(modules).getAllByRole("tab")).toHaveLength(6);
    expect(within(modules).getAllByRole("tab").filter(tab => tab.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "知识库展示" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("tab", { name: /意图优化/ }));
    expect(select).toHaveBeenCalledWith("questions");
    fireEvent.keyDown(screen.getByRole("tab", { name: /品牌建设/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /意图优化/ })).toHaveFocus();
    expect(screen.queryByText("服务首页")).not.toBeInTheDocument();
    expect(screen.getByText("AI智能品牌优化")).toBeInTheDocument();
  });

  it("reuses the FrontMind logo and puts project actions inside project management", async () => {
    const props = sidebarProps();
    render(<OperatorSidebar {...props} projects={[]} activeProject={undefined} />);
    expect(screen.getByRole("img", { name: "FrontMind" })).toHaveAttribute("src", "/frontmind-contract-logo-white.svg");
    expect(screen.queryByText(/MindPromise|智诺|AI智能品牌优化方案/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建企业项目" })).not.toBeInTheDocument();
    const dialog = await chooseProjectAction("新建企业项目");
    expect(dialog.closest("aside")).toBeNull();
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: " 企业乙 " } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onCreateProject).toHaveBeenCalledWith("企业乙");
    fireEvent.click(screen.getByRole("button", { name: "账号与余额" }));
    expect(props.onNavigate).toHaveBeenCalledWith("/account");
  });

  it("renames the current project from a prefilled dialog", async () => {
    const props = sidebarProps();
    render(<OperatorSidebar {...props} />);
    await chooseProjectAction("重命名当前项目");
    expect(screen.getByLabelText("项目名称")).toHaveValue("企业甲");
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: " 甲品牌 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onRenameProject).toHaveBeenCalledWith("甲品牌");
  });

  it("requires explicit confirmation before deleting and supports cancellation", async () => {
    const props = sidebarProps();
    render(<OperatorSidebar {...props} />);
    const dialog = await chooseProjectAction("删除当前项目");
    expect(within(dialog).getByText("企业甲")).toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toHaveFocus());
    expect(screen.queryByText(/恢复/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "项目管理" })).toHaveFocus();
    await chooseProjectAction("删除当前项目");
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onDeleteProject).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending deletion open and preserves the project on failure", async () => {
    let rejectDelete!: (error: Error) => void;
    const props = sidebarProps();
    props.onDeleteProject.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectDelete = reject; }));
    render(<OperatorSidebar {...props} />);
    await chooseProjectAction("删除当前项目");
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(props.onDeleteProject).toHaveBeenCalledTimes(1);
    await act(async () => rejectDelete(new Error("删除失败，请重试")));
    expect(screen.getByRole("alert")).toHaveTextContent("删除失败，请重试");
    expect(screen.getByRole("button", { name: "删除项目" })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not delete a newly selected project through an old confirmation", async () => {
    const props = sidebarProps();
    const { rerender } = render(<OperatorSidebar {...props} />);
    await chooseProjectAction("删除当前项目");
    rerender(<OperatorSidebar {...props} activeProject={{ ...project, id: "project-b", name: "企业乙" }} />);
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("当前项目已切换");
    expect(within(screen.getByRole("dialog")).getByText("企业甲")).toBeInTheDocument();
  });

  it("keeps project management and empty-state creation available when collapsed", async () => {
    const props = sidebarProps();
    render(<OperatorSidebar {...props} collapsed />);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByRole("button", { name: "企业甲" })).not.toBeInTheDocument();
    await chooseProjectAction("新建企业项目");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => window.dispatchEvent(new Event("operator-create-project")));
    expect(await screen.findByRole("dialog", { name: "新建企业项目" })).toBeInTheDocument();
  });

  it("uses project views and preserves canonical monitoring deep links", () => {
    expect(operatorViewFromRoute(operatorRouteForView("questions"))).toBe("questions");
    expect(operatorRouteForView("historical-results", "archived-question")).toEqual({ section: "historical-results", sub: "archived-question" });
    expect(operatorViewFromRoute({ section: "historical-results", sub: "archived-question" })).toBe("questions");
    expect(operatorViewPath("monitoring")).toBe("/monitoring-system");
    expect(operatorViewFromRoute({ section: "publishing-module", sub: "/publishing/articles" })).toBe("articles");
  });
});
