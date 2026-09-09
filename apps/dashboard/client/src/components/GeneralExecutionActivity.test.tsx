import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneralExecutionActivity } from "./GeneralExecutionActivity";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";

const base = {
  turnId: "turn",
  userSequence: 1,
  timestamp: 1_800_000_000_000,
  animate: false,
  isCurrent: false,
};
const command = (
  id: string,
  extra: Record<string, unknown> = {},
): ExecutionDisplayEntry =>
  ({
    ...base,
    id,
    rank: 1,
    kind: "tool",
    label: "执行命令",
    status: "completed",
    finishedAt: base.timestamp + 1000,
    ...extra,
  }) as ExecutionDisplayEntry;
const phase = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): ExecutionDisplayEntry =>
  ({
    ...base,
    id,
    rank: 0,
    kind: "status",
    status,
    ...extra,
  }) as ExecutionDisplayEntry;

describe("compact execution activity", () => {
  it("folds generic analysis and actual calls into a non-expandable count without timestamps or the ended marker", () => {
    const { container } = render(
      <GeneralExecutionActivity
        items={[
          phase("analysis", "thinking"),
          command("first"),
          command("second"),
          phase("ended", "ended"),
        ]}
      />,
    );
    expect(screen.getByText("执行了 2 个命令")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toMatch(
      /分析任务|执行命令|本轮已结束|1 秒|\d{2}:\d{2}/,
    );
    expect(container.querySelector("time")).toBeNull();
  });
  it("keeps confirmation, failed, and unconfirmed results visible without an empty disclosure", () => {
    render(
      <GeneralExecutionActivity
        items={[
          command("failed", { label: "搜索网页", status: "failed" }),
          command("uncertain", { label: "写入文件", status: "unconfirmed" }),
          phase("wait", "waiting", { isCurrent: true }),
        ]}
      />,
    );
    expect(screen.getByText("等待确认")).toBeInTheDocument();
    expect(screen.getByText("搜索网页 · 调用失败")).toBeInTheDocument();
    expect(screen.getByText("写入文件 · 结果未确认")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps a historical error as historical evidence without reviving it as current or showing an ended marker", () => {
    const { container } = render(
      <GeneralExecutionActivity
        items={[phase("problem", "error"), phase("end", "ended")]}
      />,
    );
    expect(screen.getByText("过程记录：执行曾遇到问题")).toBeInTheDocument();
    expect(screen.queryByText("本轮已结束")).toBeNull();
    expect(container.querySelector('[data-live="true"]')).toBeNull();
  });
  it("renders nothing for an ended-only record, even when its timestamp is invalid", () => {
    const { container } = render(
      <GeneralExecutionActivity
        items={[phase("end", "ended", { timestamp: Number.MAX_VALUE })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it("uses the same compact row as an invocation settles and leaves its failure visible", () => {
    const view = render(
      <GeneralExecutionActivity
        placement="after"
        items={[
          command("one", {
            status: "running",
            finishedAt: undefined,
            animate: true,
            isCurrent: true,
          }),
        ]}
      />,
    );
    const row = screen
      .getByText("正在执行… · 1 个命令")
      .closest(".general-execution__line");
    const surface = view.container.querySelector(".general-execution");
    view.rerender(
      <GeneralExecutionActivity
        placement="after"
        items={[command("one", { status: "failed" }), phase("end", "ended")]}
      />,
    );
    expect(
      screen.getByText("执行了 1 个命令").closest(".general-execution__line"),
    ).toBe(row);
    expect(view.container.querySelector(".general-execution")).toBe(surface);
    expect(surface).toHaveAttribute("data-placement", "after");
    expect(screen.getByText("执行命令 · 调用失败")).toBeInTheDocument();
  });
  it("does not invent a call from result-only evidence or reveal an untrusted command label", () => {
    const view = render(
      <GeneralExecutionActivity
        items={[
          phase("start", "running"),
          command("result", { resultOnly: true, status: "returned" }),
          phase("end", "ended"),
        ]}
      />,
    );
    expect(screen.getByText("工具结果 · 已返回结果")).toBeInTheDocument();
    expect(screen.queryByText(/执行了/)).toBeNull();
    view.rerender(
      <GeneralExecutionActivity
        items={[
          command("raw", {
            label: "bash -lc 'cat /internal/secret'",
            status: "failed",
          }),
        ]}
      />,
    );
    expect(screen.getByText("调用工具 · 调用失败")).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/bash|internal|secret/);
  });
  it("never merges calls from separate turns", () => {
    render(
      <GeneralExecutionActivity
        items={[command("first"), command("second", { turnId: "other" })]}
      />,
    );
    expect(screen.getAllByText("执行了 1 个命令")).toHaveLength(2);
  });
  it("retains useful safe operation categories instead of counting searches as shell commands", () => {
    render(
      <GeneralExecutionActivity
        items={[
          command("bash"),
          command("search-a", { label: "搜索网页" }),
          command("search-b", { label: "搜索网页" }),
          command("read", { label: "读取文件" }),
        ]}
      />,
    );
    expect(
      screen.getByText("执行 1 个命令 · 搜索 2 次 · 读取文件 1 次"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("preserves the same start row and height contract when a simple reply finishes without tools", () => {
    const view = render(
      <GeneralExecutionActivity
        placement="after"
        items={[phase("start", "running", { animate: true, isCurrent: true })]}
      />,
    );
    const row = screen
      .getByText("正在执行…")
      .closest(".general-execution__line");
    view.rerender(
      <GeneralExecutionActivity
        placement="after"
        items={[phase("start", "running"), phase("end", "ended")]}
      />,
    );
    expect(
      screen.getByText("开始执行").closest(".general-execution__line"),
    ).toBe(row);
    expect(screen.queryByText("本轮已结束")).toBeNull();
    expect(
      view.container.querySelectorAll(".general-execution__line"),
    ).toHaveLength(1);
  });
});

describe("thinking text activity", () => {
  const thinking = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "thinking-1",
      turnId: "turn",
      userSequence: 1,
      timestamp: 1_800_000_000_000,
      rank: 1,
      kind: "status",
      status: "thinking",
      thinkingText: "先检查任务目标。\n再决定调用哪个工具。",
      thinkingComplete: true,
      animate: false,
      ...overrides,
    }) as unknown as ExecutionDisplayEntry;

  it("shows a folded thinking summary and keeps provider text outside the tool group", () => {
    render(
      <GeneralExecutionActivity
        items={[
          thinking(),
          {
            id: "tool",
            turnId: "turn",
            userSequence: 1,
            timestamp: 1_800_000_000_100,
            rank: 2,
            kind: "tool",
            label: "搜索网页",
            status: "completed",
            animate: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("思考过程")).toBeTruthy();
    expect(screen.queryByText(/先检查任务目标。/)).toBeNull();
    expect(screen.getByText("搜索 1 次")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "思考过程" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.getByText(/先检查任务目标。/)).toBeTruthy();
    expect(screen.queryByText(/条记录|次工具调用/)).toBeNull();
  });

  it("can fold and unfold the complete thinking text", () => {
    render(<GeneralExecutionActivity items={[thinking()]} />);
    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/先检查任务目标。/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/再决定调用哪个工具。/)).toBeNull();
  });

  it("renders hostile markup as plain text without interpreting links", () => {
    const hostile =
      '<img src=x onerror="alert(1)"> [不要点我](https://evil.example)';
    render(
      <GeneralExecutionActivity
        items={[thinking({ thinkingText: hostile })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('a[href="https://evil.example"]')).toBeNull();
  });

  it("does not truncate long thinking text", () => {
    const longText = Array.from(
      { length: 240 },
      (_, index) => `步骤 ${index + 1}`,
    ).join("\n");
    render(
      <GeneralExecutionActivity
        items={[thinking({ thinkingText: longText })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    const content = screen.getByText(
      (_text, element) =>
        element?.tagName === "P" && element.textContent === longText,
    );
    expect(content).toBeTruthy();
    expect(content.textContent).toContain("步骤 1");
    expect(content.textContent).toContain("步骤 240");
  });

  it("keeps older thinking entries as the compact status line", () => {
    render(
      <GeneralExecutionActivity
        items={[
          thinking({ thinkingText: undefined, thinkingComplete: undefined }),
        ]}
      />,
    );
    expect(screen.queryByText("分析任务")).toBeNull();
    expect(screen.queryByRole("button", { name: "思考过程" })).toBeNull();
  });

  it("keeps complete and partial provider text unchanged as polling updates arrive", () => {
    const view = render(
      <GeneralExecutionActivity
        items={[
          thinking({
            thinkingText: "先检查目标（包含限制条件）。",
            thinkingComplete: false,
            animate: true,
            isCurrent: true,
          }),
        ]}
      />,
    );
    expect(screen.getByText("思考中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    view.rerender(
      <GeneralExecutionActivity
        items={[
          thinking({
            thinkingText:
              "先检查目标（包含限制条件）。\n结果为 f(x) = (x + 1) / 2。",
            thinkingComplete: true,
            animate: false,
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "思考过程" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText(/先检查目标/).textContent).toBe(
      "先检查目标（包含限制条件）。\n结果为 f(x) = (x + 1) / 2。",
    );
    view.rerender(
      <GeneralExecutionActivity
        items={[
          thinking({
            thinkingText: "先检查目标（包含限制条件）。",
            thinkingComplete: false,
            animate: false,
            isCurrent: false,
          }),
        ]}
      />,
    );
    expect(screen.getByText("过程记录")).toBeTruthy();
    expect(screen.queryByText("思考中")).toBeNull();
  });

  it("retains caller-owned expansion when the surrounding message anchor remounts", () => {
    const opened = new Set(["thinking-1"]);
    const view = render(
      <GeneralExecutionActivity
        key="before"
        items={[thinking()]}
        expandedGroups={opened}
      />,
    );
    expect(screen.getByText(/先检查任务目标。/)).toBeTruthy();
    view.rerender(
      <GeneralExecutionActivity
        key="after"
        items={[thinking()]}
        expandedGroups={opened}
      />,
    );
    expect(screen.getByRole("button", { name: "思考过程" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText(/先检查任务目标。/)).toBeTruthy();
  });
});
