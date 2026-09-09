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
import { AgentWorkbenchShell } from "./AgentWorkbenchShell";
import {
  createWorkbenchModules,
  WorkbenchModuleContext,
} from "@/dashboard/agent-workbench";
import type { OperatorView } from "@/dashboard/operator-navigation";

let workspaceWidth = 1184;
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
  workspaceWidth = 1184;
  vi.stubGlobal("innerWidth", 1440);
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
  it("keeps the dialogue left and contextual subagent controls right without remounting the main composer", () => {
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
      "420",
    );
    act(() => viewport(2256, 2000));
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-valuenow", "900");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "1399");
  });
  it("bounds mouse and keyboard resizing to preserve 600px for main", () => {
    const { container } = render(<AgentWorkbenchShell {...props} />);
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "344");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "280");
    act(() => viewport(1440, 1000));
    vi.spyOn(
      container.querySelector(".agent-workbench-shell")!,
      "getBoundingClientRect",
    ).mockReturnValue({ left: 256, right: 1256, width: 1000 } as DOMRect);
    fireEvent.pointerDown(separator, { button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", "399");
    expect(localStorage.setItem).toHaveBeenCalled();
  });
  it.each([
    [1024, 768],
    [1440, 850],
  ])(
    "prioritizes main when viewport %i or container %i cannot fit both panes",
    async (width, available) => {
      viewport(width, available);
      render(<AgentWorkbenchShell {...props} />);
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toBeVisible();
      expect(screen.queryByText("辅助摘要")).not.toBeInTheDocument();
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
    act(() => viewport(1440));
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
