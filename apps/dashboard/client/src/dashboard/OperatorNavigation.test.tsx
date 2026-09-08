import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorSidebar, OperatorTabs, type EnterpriseProjectView } from "./OperatorNavigation";
import { canonicalKnowledgeWorkspaceUrl, operatorRouteForView, operatorViewFromRoute, operatorViewPath } from "./operator-navigation";

const project: EnterpriseProjectView = { id: "project-a", name: "企业甲", ownerUserId: 1, revision: 1 };
const sidebarProps = () => ({ projects: [project], activeProject: project, activeEntry: "project" as const, collapsed: false, onCollapse: vi.fn(), onNavigate: vi.fn(), onSelectProject: vi.fn(), onCreateProject: vi.fn().mockResolvedValue(undefined), onRenameProject: vi.fn().mockResolvedValue(undefined), onDeleteProject: vi.fn().mockResolvedValue(undefined) });
async function chooseProjectAction(name: string) {
  if (name === "新建企业项目") {
    fireEvent.click(screen.getByRole("button", { name }));
  } else {
    fireEvent.keyDown(screen.getByRole("button", { name: "管理项目：企业甲" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: name.replace("当前", "") }));
  }
  return screen.findByRole("dialog");
}

describe("operator workspace navigation", () => {
  it("never presents an empty project hint during loading or a failed initial request, and retains known rows while refreshing", () => {
    const props = sidebarProps();
    const view = render(<OperatorSidebar {...props} projects={[]} activeProject={undefined} projectsLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取企业项目");
    expect(screen.queryByText(/点击上方加号新建企业项目/)).toBeNull();
    view.rerender(<OperatorSidebar {...props} projects={[]} activeProject={undefined} projectsError="连接失败" />);
    expect(screen.getByRole("alert")).toHaveTextContent("企业项目暂时无法读取");
    expect(screen.queryByText(/点击上方加号新建企业项目/)).toBeNull();
    view.rerender(<OperatorSidebar {...props} projectsLoading />);
    expect(screen.getByRole("button", { name: "企业甲" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<OperatorSidebar {...props} projects={[]} activeProject={undefined} />);
    expect(screen.getByText(/点击上方加号新建企业项目/)).toBeVisible();
  });
  it("reveals a full project name on keyboard focus without selecting it", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const props = sidebarProps();
    const longProject = { ...project, name: "很长的中文企业项目名称：完整名称在键盘聚焦时同样可见" };
    const view = render(<OperatorSidebar {...props} projects={[longProject]} activeProject={longProject} />);
    try {
      act(() => screen.getByRole("button", { name: longProject.name }).focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(longProject.name);
      expect(props.onSelectProject).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("offers six linked modules and a single knowledge entry", () => {
    const select = vi.fn();
    render(<OperatorTabs view="knowledge-display" projectName="企业甲" onSelect={select} />);
    const modules = screen.getByRole("navigation", { name: "项目板块" });
    expect(within(modules).getAllByRole("link")).toHaveLength(6);
    expect(within(modules).getAllByRole("link").filter(link => link.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "知识库展示" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "智能知识库" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "项目工具" })).toBeInTheDocument();
    expect(screen.queryByText(/^0[1-6]$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "意图优化" }));
    expect(select).toHaveBeenCalledWith("questions");
    select.mockClear();
    const nativeLink = screen.getByRole("link", { name: "意图优化" });
    nativeLink.addEventListener("click", event => event.preventDefault(), { once: true });
    fireEvent.click(nativeLink, { ctrlKey: true });
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByText("服务首页")).not.toBeInTheDocument();
    expect(screen.getByText("AI智能品牌优化")).toBeInTheDocument();
  });

  it("opens creation directly from the plus button and reuses the FrontMind logo", async () => {
    const props = sidebarProps();
    render(<OperatorSidebar {...props} projects={[]} activeProject={undefined} />);
    expect(screen.getByRole("img", { name: "FrontMind" })).toHaveAttribute("src", "/frontmind-contract-logo-white.svg");
    expect(screen.queryByText(/MindPromise|智诺|AI智能品牌优化方案/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建企业项目" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目管理" })).not.toBeInTheDocument();
    const dialog = await chooseProjectAction("新建企业项目");
    expect(dialog.closest("aside")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
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
    expect(props.onRenameProject).toHaveBeenCalledWith("甲品牌", project);
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
    expect(screen.getByRole("button", { name: "管理项目：企业甲" })).toHaveFocus();
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

  it("keeps direct creation and empty-state creation available when collapsed", async () => {
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
  it("renames an unselected row using its captured project and returns focus to that row", async () => {
    const props = sidebarProps();
    const second = { ...project, id: "project-b", name: "企业乙", revision: 3 };
    render(<OperatorSidebar {...props} projects={[project, second]} />);
    const trigger = screen.getByRole("button", { name: "管理项目：企业乙" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名项目" }));
    expect(screen.getByLabelText("项目名称")).toHaveValue("企业乙");
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "乙品牌" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onRenameProject).toHaveBeenCalledWith("乙品牌", second);
    expect(props.onSelectProject).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("does not submit an old project revision", async () => {
    const props = sidebarProps();
    const view = render(<OperatorSidebar {...props} />);
    await chooseProjectAction("重命名当前项目");
    view.rerender(<OperatorSidebar {...props} projects={[{ ...project, revision: 2 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(props.onRenameProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("项目已切换或更新");
  });

  it("canonicalizes old reading URLs without losing scope or extra parameters", () => {
    expect(canonicalKnowledgeWorkspaceUrl("/", "view=knowledge-display&enterpriseProjectId=project-a&operatorOwnerId=7&node=1.2", "#detail")).toBe("/?view=knowledge&enterpriseProjectId=project-a&operatorOwnerId=7&node=1.2#detail");
    expect(canonicalKnowledgeWorkspaceUrl("/knowledge-base", "view=knowledge-display")).toBe("/?view=knowledge");
    expect(canonicalKnowledgeWorkspaceUrl("/", "view=knowledge")).toBeNull();
    expect(canonicalKnowledgeWorkspaceUrl("/publishing", "view=knowledge-display")).toBeNull();
    expect(operatorViewPath("knowledge-display")).toBe("/?view=knowledge");
    expect(operatorRouteForView("knowledge-display")).toEqual({ section: "knowledge-agent", sub: "build" });
  });

  it("contains mobile keyboard focus and releases the main work area when closed", () => {
    const query = vi.spyOn(window, "matchMedia").mockImplementation(() => ({ matches: true, media: "(max-width: 1023px)", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    try {
      const props = sidebarProps();
      const close = vi.fn();
      const view = render(<div className="app-shell"><OperatorSidebar {...props} mobileOpen onCloseMobile={close} /><main data-testid="main">工作内容</main></div>);
      const drawer = screen.getByRole("dialog", { name: "工作区导航" });
      expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(screen.getByTestId("main")).toHaveProperty("inert", true);
      const first = within(drawer).getByRole("button", { name: "AI智能品牌优化" });
      const last = within(drawer).getByRole("button", { name: "收起侧边栏" });
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(first).toHaveFocus();
      fireEvent.keyDown(first, { key: "Escape" });
      expect(close).toHaveBeenCalledTimes(1);
      view.rerender(<div className="app-shell"><OperatorSidebar {...props} mobileOpen={false} onCloseMobile={close} /><main data-testid="main">工作内容</main></div>);
      expect(screen.getByTestId("main")).toHaveProperty("inert", false);
    } finally { query.mockRestore(); }
  });

});
