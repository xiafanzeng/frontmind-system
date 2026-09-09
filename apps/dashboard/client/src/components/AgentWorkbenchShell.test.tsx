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

let narrow = false;
let change: (() => void) | undefined;
const props = {
  projectId: "a",
  moduleId: "brand",
  title: "品牌建设",
  resultTitle: "品牌成果",
  conversation: <textarea aria-label="任务草稿" defaultValue="保留我的对话" />,
  result: <div>成果正文</div>,
};
beforeEach(() => {
  narrow = false;
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return narrow;
      },
      addEventListener: (_: string, callback: () => void) => {
        change = callback;
      },
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("AgentWorkbenchShell", () => {
  it("switches subagents only from results while retaining the conversation draft", () => {
    function Workbench() {
      const [view, setView] = useState<OperatorView>("publishing");
      const module = createWorkbenchModules(() => null, setView, view).find(
        (item) => item.id === "publishing",
      )!;
      return (
        <WorkbenchModuleContext.Provider value={module}>
          <AgentWorkbenchShell {...props} result={<p>{view} 当前成果</p>} />
        </WorkbenchModuleContext.Provider>
      );
    }
    render(<Workbench />);
    const draft = screen.getByRole("textbox", { name: "任务草稿" });
    fireEvent.change(draft, { target: { value: "保留未发送内容" } });
    const selector = screen.getByRole("group", { name: "子智能体" });
    expect(
      within(screen.getByRole("region", { name: "任务对话" })).queryByRole(
        "group",
        { name: "子智能体" },
      ),
    ).not.toBeInTheDocument();
    expect(
      within(selector).getByRole("button", { name: "发布工作台" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(selector).getByRole("button", { name: "媒体库" }));
    expect(
      within(selector).getByRole("button", { name: "媒体库" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(selector).getByRole("button", { name: "发布工作台" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("media 当前成果")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "任务草稿" })).toBe(draft);
    expect(draft).toHaveValue("保留未发送内容");
  });
  it("keeps dialogue mounted when module results change and resizes with keyboard", () => {
    const { rerender } = render(<AgentWorkbenchShell {...props} />);
    const draft = screen.getByRole("textbox");
    fireEvent.change(draft, { target: { value: "未发送的想法" } });
    const separator = screen.getByRole("separator");
    const before = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before + 32);
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "320");
    rerender(
      <AgentWorkbenchShell
        {...props}
        moduleId="intent"
        resultTitle="优化问题"
        result={<p>另一个成果</p>}
      />,
    );
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("未发送的想法");
    expect(screen.getByRole("region", { name: "优化问题" })).toHaveTextContent(
      "另一个成果",
    );
    expect(screen.queryByText("成果正文")).not.toBeInTheDocument();
  });
  it("bounds pointer resizing against the actual workspace, not the browser width", () => {
    const { container } = render(<AgentWorkbenchShell {...props} />);
    const root = container.querySelector(".agent-workbench-shell")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 280,
      right: 1280,
      width: 1000,
    } as DOMRect);
    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(
      Number(screen.getByRole("separator").getAttribute("aria-valuenow")),
    ).toBe(640);
  });
  it("opens narrow results in a modal, closes on Escape and restores trigger focus", async () => {
    narrow = true;
    render(
      <AgentWorkbenchShell
        {...props}
        actions={[
          {
            id: "edit",
            label: "打开编辑器",
            kind: "open-editor",
            run: vi.fn(),
          },
        ]}
      />,
    );
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.queryByText("成果正文")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "查看成果" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "品牌成果" })).toHaveTextContent(
      "成果正文",
    );
    expect(
      screen.getByRole("button", { name: "打开编辑器" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("textbox")).toHaveValue("保留我的对话");
  });
  it("preserves editor state when expanding the desktop result", () => {
    function Editor() {
      const [value, setValue] = useState("");
      return (
        <input
          aria-label="编辑成果"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    render(<AgentWorkbenchShell {...props} result={<Editor />} />);
    fireEvent.change(screen.getByRole("textbox", { name: "编辑成果" }), {
      target: { value: "本地修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "展开成果面板" }));
    expect(screen.getByRole("textbox", { name: "编辑成果" })).toHaveValue(
      "本地修改",
    );
    fireEvent.click(screen.getByRole("button", { name: "还原成果面板" }));
    expect(screen.getByRole("textbox", { name: "编辑成果" })).toHaveValue(
      "本地修改",
    );
  });
  it("restores the conversation and focuses its composer for a desktop AI edit request", async () => {
    const view = render(<AgentWorkbenchShell {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "展开成果面板" }));
    view.rerender(
      <AgentWorkbenchShell
        {...props}
        conversationFocusRequest={{ node: "1.1" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "展开成果面板" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toHaveFocus(),
    );
  });
  it("hands focus from the result drawer to the composer without losing result edits", async () => {
    narrow = true;
    function Workbench() {
      const [request, setRequest] = useState<object | null>(null);
      return (
        <AgentWorkbenchShell
          {...props}
          conversationFocusRequest={request}
          result={
            <>
              <input aria-label="成果草稿" defaultValue="" />
              <button onClick={() => setRequest({ node: "1.1" })}>
                用 AI 修改
              </button>
            </>
          }
        />
      );
    }
    render(<Workbench />);
    fireEvent.click(screen.getByRole("button", { name: "查看成果" }));
    const resultDraft = screen.getByRole("textbox", { name: "成果草稿" });
    fireEvent.change(resultDraft, { target: { value: "保留成果修改" } });
    fireEvent.click(screen.getByRole("button", { name: "用 AI 修改" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "任务草稿" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看成果" }));
    expect(screen.getByRole("textbox", { name: "成果草稿" })).toBe(resultDraft);
    expect(resultDraft).toHaveValue("保留成果修改");
  });
  it("keeps a draft editor alive across breakpoints and drawer reopen", async () => {
    function Editor() {
      const [value, setValue] = useState("");
      return (
        <input
          aria-label="成果草稿"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    render(<AgentWorkbenchShell {...props} result={<Editor />} />);
    const editor = screen.getByRole("textbox", { name: "成果草稿" });
    fireEvent.change(editor, { target: { value: "不能丢失的修改" } });
    act(() => {
      narrow = true;
      change?.();
    });
    expect(
      screen.queryByRole("textbox", { name: "成果草稿" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看成果" }));
    expect(screen.getByRole("textbox", { name: "成果草稿" })).toBe(editor);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看成果" }));
    expect(screen.getByRole("textbox", { name: "成果草稿" })).toHaveValue(
      "不能丢失的修改",
    );
    act(() => {
      narrow = false;
      change?.();
    });
    expect(screen.getByRole("textbox", { name: "成果草稿" })).toBe(editor);
  });
  it("remains usable when preferences are blocked", () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AgentWorkbenchShell {...props} />);
    expect(
      screen.getByRole("region", { name: "品牌成果" }),
    ).toBeInTheDocument();
  });
});
