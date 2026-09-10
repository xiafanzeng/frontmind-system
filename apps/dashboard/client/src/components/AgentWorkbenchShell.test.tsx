import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  AgentWorkbenchShell,
  workbenchPaneGeometry,
  WORKBENCH_RATIO_KEY,
} from "./AgentWorkbenchShell";
import {
  createWorkbenchModules,
  WorkbenchModuleContext,
} from "@/dashboard/agent-workbench";
import type { OperatorView } from "@/dashboard/operator-navigation";

let workspaceWidth = 1664;
const props = {
  projectId: "a",
  moduleId: "brand",
  title: "品牌建设",
  taskTitle: "品牌资料整理",
  main: <textarea aria-label="任务草稿" defaultValue="保留我的对话" />,
  auxiliary: <div>辅助摘要</div>,
};
function viewport(width: number, container = width - 256) {
  workspaceWidth = container;
  vi.stubGlobal("innerWidth", width);
  fireEvent(window, new Event("resize"));
}
beforeEach(() => {
  workspaceWidth = 1664;
  vi.stubGlobal("innerWidth", 1920);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => workspaceWidth,
  );
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentWorkbenchShell", () => {
  it("removes the title bar and keeps the panel control and live save status with outcomes", () => {
    const { container } = render(
      <AgentWorkbenchShell {...props} status="正在保存" />,
    );
    expect(
      container.querySelector(".agent-workbench-shell__taskbar"),
    ).toBeNull();
    expect(screen.queryByText("品牌资料整理")).not.toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(within(aside).getByRole("status")).toHaveTextContent("正在保存");
    fireEvent.click(screen.getByRole("button", { name: "收起任务信息" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开任务信息" }));
    expect(screen.getByRole("complementary")).toHaveTextContent("辅助摘要");
  });
  it("bounds floating panels to preserve a readable centered main surface", () => {
    expect(workbenchPaneGeometry(1280)).toEqual({
      minAux: 300,
      maxAux: 308,
      width: 308,
    });
    expect(workbenchPaneGeometry(1664).width).toBe(384);
    expect(workbenchPaneGeometry(2400).width).toBe(512);
    expect(workbenchPaneGeometry(2400, 0.9).width).toBe(868);
    expect(workbenchPaneGeometry(1280, 0.1).width).toBe(300);
  });
  it.each([
    ["brand", "knowledge"],
    ["general", "workflow"],
    ["publishing", "workflow"],
  ] as const)(
    "switches %s to a drawer below 1280px of available workspace",
    (moduleId, layout) => {
      viewport(1536, 1280);
      render(
        <AgentWorkbenchShell {...props} moduleId={moduleId} layout={layout} />,
      );
      expect(screen.getByRole("separator")).toHaveAttribute(
        "aria-valuenow",
        "308",
      );
      act(() => viewport(1536, 1279));
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "打开任务信息" }),
      ).toBeVisible();
    },
  );
  it("restores a proportional preference when changing the available width", () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === WORKBENCH_RATIO_KEY ? "0.24" : null,
    );
    viewport(1696, 1440);
    render(<AgentWorkbenchShell {...props} />);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "334",
    );
    act(() => viewport(2096, 1840));
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "369",
    );
  });
  it("keeps contextual subagent controls in the floating panel without remounting the main composer", () => {
    function Workbench() {
      const [view, setView] = useState<OperatorView>("publishing");
      const module = createWorkbenchModules(() => null, setView, view).find(
        (item) => item.id === "publishing",
      )!;
      return (
        <WorkbenchModuleContext.Provider value={module}>
          <AgentWorkbenchShell {...props} auxiliary={<p>{view} 摘要</p>} />
        </WorkbenchModuleContext.Provider>
      );
    }
    render(<Workbench />);
    const draft = screen.getByRole("textbox", { name: "任务草稿" });
    fireEvent.change(draft, { target: { value: "保留未发送内容" } });
    const main = screen.getByRole("region", { name: "主工作区" });
    const aside = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(main).toContainElement(draft);
    expect(within(main).queryByRole("navigation")).not.toBeInTheDocument();
    const selector = within(aside).getByRole("navigation", {
      name: "切换子 Agent",
    });
    expect(
      within(selector).getByRole("button", { name: "发布工作台" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(selector).getByRole("button", { name: "媒体库" }));
    expect(
      within(selector).getByRole("button", { name: "媒体库" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(aside).toHaveTextContent("media 摘要");
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("保留未发送内容");
  });
  it("uses one complete main pane for general conversations", () => {
    render(<AgentWorkbenchShell {...props} layout="single" />);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.queryByText("辅助摘要")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开任务信息" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "主工作区" })).toContainElement(
      screen.getByRole("textbox"),
    );
  });
  it.each([
    ["general", "workflow"],
    ["brand", "knowledge"],
    ["publishing", "workflow"],
  ] as const)(
    "keeps the native %s conversation usable across a floating panel, drawer and collapse",
    async (moduleId, layout) => {
      viewport(1920);
      render(
        <AgentWorkbenchShell
          {...props}
          moduleId={moduleId}
          layout={layout}
          scrollMain={false}
        />,
      );
      const draft = screen.getByRole("textbox", { name: "任务草稿" });
      fireEvent.change(draft, { target: { value: "保留未发送的草稿" } });
      expect(screen.getByRole("complementary")).toBeVisible();
      act(() => viewport(2560));
      fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
      expect(screen.getByRole("separator")).toHaveAttribute(
        "aria-valuenow",
        "820",
      );
      act(() => viewport(1440));
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "打开任务信息" }));
      expect(screen.getByRole("dialog")).toHaveTextContent("辅助摘要");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      act(() => viewport(1536));
      expect(screen.getByRole("complementary")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "收起任务信息" }));
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
      act(() => viewport(390, 390));
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toBe(draft);
      expect(draft).toHaveValue("保留未发送的草稿");
    },
  );
  it("keeps backward-compatible conversation props in main, never in the auxiliary pane", () => {
    render(
      <AgentWorkbenchShell
        projectId="a"
        moduleId="knowledge"
        title="智能知识库"
        layout="knowledge"
        conversation={<p>真实协作对话</p>}
        result={<p>固定知识节点</p>}
      />,
    );
    expect(screen.getByRole("region", { name: "主工作区" })).toHaveTextContent(
      "真实协作对话",
    );
    expect(
      screen.getByRole("complementary", { name: "知识节点与资料" }),
    ).toHaveTextContent("固定知识节点");
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuemin",
      "300",
    );
    act(() => viewport(2256, 2000));
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-valuenow", "512");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "668");
  });
  it("bounds mouse and keyboard resizing while reserving equal space around the main surface", () => {
    viewport(2560);
    const { container } = render(<AgentWorkbenchShell {...props} />);
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-valuenow", "512");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "536");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "512");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    vi.spyOn(
      container.querySelector(".agent-workbench-shell__layout")!,
      "getBoundingClientRect",
    ).mockReturnValue({ left: 256, right: 2560, width: 2304 } as DOMRect);
    fireEvent.pointerDown(separator, { button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(separator).toHaveAttribute("aria-valuenow", "820");
    fireEvent.pointerMove(window, { clientX: 2550 });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    fireEvent.pointerMove(window, { clientX: 1844 });
    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", "700");
    expect(localStorage.setItem).toHaveBeenLastCalledWith(
      WORKBENCH_RATIO_KEY,
      String(700 / 1536),
    );
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(separator).toHaveAttribute("aria-valuenow", "700");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "512");
  });
  it.each([
    [1024, 768],
    [1440, 1184],
    [1023, 1280],
  ])(
    "prioritizes main when viewport %i or container %i cannot fit both panes",
    async (width, available) => {
      viewport(width, available);
      render(<AgentWorkbenchShell {...props} />);
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toBeVisible();
      expect(screen.getByText("辅助摘要")).not.toBeVisible();
      const toggle = screen.getByRole("button", { name: "打开任务信息" });
      fireEvent.click(toggle);
      expect(
        screen.getByRole("dialog", { name: "任务信息" }),
      ).toHaveTextContent("辅助摘要");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(toggle).toHaveFocus();
    },
  );
  it("keeps the same editor and its draft across collapse, responsive drawer, and reopening", async () => {
    function Editor() {
      const [value, setValue] = useState("");
      return (
        <input
          aria-label="知识节点正文"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    render(
      <AgentWorkbenchShell
        {...props}
        layout="knowledge"
        auxiliary={<Editor />}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "知识节点正文" });
    fireEvent.change(editor, { target: { value: "不能丢失的节点修改" } });
    fireEvent.click(screen.getByRole("button", { name: "收起任务信息" }));
    fireEvent.click(screen.getByRole("button", { name: "打开任务信息" }));
    expect(screen.getByRole("textbox", { name: "知识节点正文" })).toBe(editor);
    act(() => viewport(768));
    fireEvent.click(screen.getByRole("button", { name: "打开任务信息" }));
    expect(screen.getByRole("textbox", { name: "知识节点正文" })).toBe(editor);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    act(() => viewport(1920));
    expect(screen.getByRole("textbox", { name: "知识节点正文" })).toBe(editor);
    expect(editor).toHaveValue("不能丢失的节点修改");
  });
  it("hands an AI node-edit request back to the main composer", async () => {
    const view = render(<AgentWorkbenchShell {...props} />);
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        conversationFocusRequest={{ node: "1.1" }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toHaveFocus(),
    );
  });
  it("returns focus to a read-only node after closing the mobile auxiliary drawer", async () => {
    viewport(390, 390);
    const view = render(
      <AgentWorkbenchShell
        {...props}
        main={
          <article tabIndex={-1} aria-label="节点正文">
            只读知识
          </article>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开任务信息" }));
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        main={
          <article tabIndex={-1} aria-label="节点正文">
            只读知识
          </article>
        }
        conversationFocusRequest={{ node: "2" }}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("article", { name: "节点正文" })).toHaveFocus();
  });
  it("restores each task's reading position without scrolling after ordinary updates", async () => {
    const view = render(
      <AgentWorkbenchShell
        {...props}
        taskKey="first"
        main={<p>长任务内容</p>}
      />,
    );
    const scroll = screen.getByRole("region", {
      name: "主工作区",
    }).firstElementChild!;
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    Object.defineProperties(scroll, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 600 },
    });
    scroll.scrollTop = 280;
    fireEvent.scroll(scroll);
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        taskKey="second"
        main={<p>第二任务内容</p>}
      />,
    );
    await waitFor(() => expect(scroll.scrollTop).toBe(0));
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        taskKey="first"
        main={<p>更新后的长任务内容</p>}
      />,
    );
    await waitFor(() => expect(scroll.scrollTop).toBe(280));
  });
  it("remains usable when local preferences are blocked", () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AgentWorkbenchShell {...props} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
    expect(
      screen.getByRole("complementary", { name: "任务辅助区" }),
    ).toHaveTextContent("辅助摘要");
  });
});
