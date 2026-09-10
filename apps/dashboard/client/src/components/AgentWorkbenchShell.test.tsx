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

let workspaceWidth = 1712;
const props = {
  projectId: "a",
  moduleId: "brand",
  title: "品牌建设",
  taskTitle: "品牌资料整理",
  main: <textarea aria-label="任务草稿" defaultValue="保留我的对话" />,
  auxiliary: <div>辅助摘要</div>,
};
function viewport(
  width: number,
  container = width < 1024 ? width : width - (width < 1280 ? 56 : 208),
) {
  workspaceWidth = container;
  vi.stubGlobal("innerWidth", width);
  fireEvent(window, new Event("resize"));
}
beforeEach(() => {
  workspaceWidth = 1712;
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

describe("AgentWorkbenchShell persistent outcomes", () => {
  it("keeps outcomes and live save status visible without a hide-card control", () => {
    const { container } = render(
      <AgentWorkbenchShell {...props} status="正在保存" />,
    );
    expect(
      container.querySelector(".agent-workbench-shell__taskbar"),
    ).toBeNull();
    const aside = screen.getByRole("complementary", { name: "任务辅助区" });
    expect(within(aside).getByRole("status")).toHaveTextContent("正在保存");
    expect(aside).toHaveTextContent("辅助摘要");
    expect(
      screen.queryByRole("button", { name: /收起任务信息|打开任务信息/ }),
    ).toBeNull();
  });
  it("uses the actual two-column space at a 5:2 ratio and bounds resize to a 480px main and 200px result", () => {
    expect(workbenchPaneGeometry(1280)).toEqual({
      minAux: 200,
      maxAux: 752,
      width: 352,
    });
    expect(workbenchPaneGeometry(2400).width).toBe(672);
    expect(workbenchPaneGeometry(2400, 0.9).width).toBe(1872);
    expect(workbenchPaneGeometry(1280, 0.1).width).toBe(200);
    for (const width of [768, 968, 1072, 1232, 1712]) {
      const geometry = workbenchPaneGeometry(width);
      expect(geometry.width).toBeGreaterThanOrEqual(200);
      expect(width - 48 - geometry.width).toBeGreaterThanOrEqual(480);
      expect((width - 48 - geometry.width) / geometry.width).toBeCloseTo(2.5);
    }
  });
  it.each([390, 767, 768, 769, 1023, 1024, 1025, 1279, 1280, 1281, 1440, 1920])(
    "keeps the same draft and result mounted through viewport %i",
    (width) => {
      const { container } = render(
        <AgentWorkbenchShell {...props} layout="knowledge" />,
      );
      const draft = screen.getByRole("textbox", { name: "任务草稿" });
      const aside = screen.getByRole("complementary");
      fireEvent.change(draft, { target: { value: "跨尺寸保留" } });
      act(() => viewport(width));
      expect(screen.getByRole("complementary")).toBe(aside);
      expect(aside).toBeVisible();
      expect(screen.getByRole("textbox")).toBe(draft);
      expect(draft).toHaveValue("跨尺寸保留");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        container
          .querySelector(".agent-workbench-shell")
          ?.classList.contains("is-stacked"),
      ).toBe(width < 768);
      expect(Boolean(screen.queryByRole("separator"))).toBe(width >= 768);
    },
  );
  it("ignores the prior floating-panel preference and restores the new ratio", () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === "frontmind.workbench.v4.auxiliary-ratio" ? "0.9" : null,
    );
    viewport(1488, 1280);
    render(<AgentWorkbenchShell {...props} />);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "352",
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(localStorage.removeItem).toHaveBeenCalledWith(WORKBENCH_RATIO_KEY);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "352",
    );
  });
  it("rescales a saved proportion against the entire available width", () => {
    vi.mocked(localStorage.getItem).mockReturnValue("0.24");
    viewport(1648, 1440);
    render(<AgentWorkbenchShell {...props} />);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "334",
    );
    act(() => viewport(2048, 1840));
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "430",
    );
  });
  it("bounds pointer and keyboard resizing without reserving a second result width", () => {
    viewport(2560, 2304);
    const { container } = render(<AgentWorkbenchShell {...props} />);
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "200");
    vi.spyOn(
      container.querySelector(".agent-workbench-shell__layout")!,
      "getBoundingClientRect",
    ).mockReturnValue({ left: 256, right: 2560, width: 2304 } as DOMRect);
    fireEvent.pointerDown(separator, { button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(separator).toHaveAttribute("aria-valuenow", "1776");
    fireEvent.pointerMove(window, { clientX: 2550 });
    expect(separator).toHaveAttribute("aria-valuenow", "200");
    fireEvent.pointerMove(window, { clientX: 1844 });
    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", "700");
    expect(localStorage.setItem).toHaveBeenLastCalledWith(
      WORKBENCH_RATIO_KEY,
      String(700 / 2256),
    );
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(separator).toHaveAttribute("aria-valuenow", "700");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "645");
  });
  it("retains the actual result editor and scroll position across all breakpoints", () => {
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
    const { container } = render(
      <AgentWorkbenchShell {...props} auxiliary={<Editor />} />,
    );
    const editor = screen.getByRole("textbox", { name: "知识节点正文" });
    const scroll = container.querySelector(
      ".agent-workbench-shell__auxiliary-content",
    )!;
    fireEvent.change(editor, { target: { value: "不能丢失的节点修改" } });
    scroll.scrollTop = 120;
    for (const width of [1024, 768, 390, 1920]) {
      act(() => viewport(width));
      expect(screen.getByRole("textbox", { name: "知识节点正文" })).toBe(
        editor,
      );
      expect(editor).toHaveValue("不能丢失的节点修改");
      expect(scroll.scrollTop).toBe(120);
    }
  });
  it("keeps contextual subagent controls in the result card without remounting the composer", () => {
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
    const draft = screen.getByRole("textbox");
    const aside = screen.getByRole("complementary");
    fireEvent.click(within(aside).getByRole("button", { name: "媒体库" }));
    expect(aside).toHaveTextContent("media 摘要");
    expect(screen.getByRole("textbox")).toBe(draft);
  });
  it("keeps an empty result card visible before any artifact exists", () => {
    render(
      <AgentWorkbenchShell
        {...props}
        auxiliary={undefined}
        resultTitle="成果与资料"
      />,
    );
    expect(screen.getByRole("complementary")).toHaveTextContent(
      "成果与资料将在处理资料后显示",
    );
  });
  it("supports a deliberate single-pane surface", () => {
    render(<AgentWorkbenchShell {...props} layout="single" />);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("textbox")).toBeVisible();
  });
  it("hands a node request back to its main reader on mobile without a drawer", async () => {
    viewport(390);
    const main = (
      <article tabIndex={-1} aria-label="节点正文">
        只读知识
      </article>
    );
    const view = render(<AgentWorkbenchShell {...props} main={main} />);
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        main={main}
        conversationFocusRequest={{ node: "2" }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("article", { name: "节点正文" })).toHaveFocus(),
    );
    expect(screen.getByRole("complementary")).toBeVisible();
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
  it("preserves the conversation width and static reading anchor through ten detail expansions", async () => {
    const { container } = render(
      <AgentWorkbenchShell
        {...props}
        auxiliary={
          <details>
            <summary>成果详情</summary>
            <p>内部展开内容</p>
          </details>
        }
        taskKey="long-task"
      />,
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const shell = container.querySelector(
      ".agent-workbench-shell",
    ) as HTMLElement;
    const width = shell.style.getPropertyValue("--agent-aux-width");
    const main = screen.getByRole("region", { name: "主工作区" });
    const scroll = main.firstElementChild!;
    const draft = screen.getByRole("textbox");
    scroll.scrollTop = 280;
    fireEvent.scroll(scroll);
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByText("成果详情"));
      expect(shell.style.getPropertyValue("--agent-aux-width")).toBe(width);
      expect(screen.getByRole("textbox")).toBe(draft);
      expect(main.firstElementChild).toBe(scroll);
      expect(scroll.scrollTop).toBe(280);
    }
  });
  it("remains resizable when local preferences are blocked", () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AgentWorkbenchShell {...props} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
    expect(screen.getByRole("complementary")).toBeVisible();
  });
});
