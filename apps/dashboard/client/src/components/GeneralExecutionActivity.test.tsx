import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneralExecutionActivity } from "./GeneralExecutionActivity";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";

describe("compact execution activity", () => {
  it("surfaces a current confirmation wait while folded and keeps its complete history available", () => {
    const base = {
      turnId: "turn",
      userSequence: 1,
      timestamp: 1_800_000_000_000,
      animate: false,
    };
    render(
      <GeneralExecutionActivity
        items={[
          {
            ...base,
            id: "analysis",
            rank: 0,
            kind: "status",
            status: "thinking",
            isCurrent: false,
          },
          {
            ...base,
            id: "wait",
            rank: 1,
            kind: "status",
            status: "waiting",
            isCurrent: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("等待确认")).toBeTruthy();
    expect(screen.queryByText("分析任务")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /执行过程/ }));
    expect(screen.getByText("分析任务")).toBeTruthy();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(base.timestamp).toISOString(),
    );
    expect(document.querySelector("time")?.textContent).toMatch(
      /\d{2}:\d{2}:\d{2}/,
    );
    fireEvent.click(screen.getByRole("button", { name: /执行过程/ }));
    expect(screen.queryByText("分析任务")).toBeNull();
    expect(screen.getByText("等待确认")).toBeTruthy();
  });
  it("shows a terminal summary after completion without reviving a historical error", () => {
    const base = {
      turnId: "turn",
      userSequence: 1,
      timestamp: 1_800_000_000_000,
      animate: false,
      isCurrent: false,
      kind: "status" as const,
    };
    render(
      <GeneralExecutionActivity
        items={[
          { ...base, id: "problem", rank: 0, status: "error" },
          { ...base, id: "end", rank: 1, status: "ended" },
        ]}
      />,
    );
    expect(screen.getByText("本轮已结束")).toBeTruthy();
    expect(screen.queryByText("执行遇到问题")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
  it("does not crash the conversation when an optional timestamp is invalid", () => {
    render(
      <GeneralExecutionActivity
        items={[
          {
            id: "bad-time",
            turnId: "turn",
            userSequence: 1,
            timestamp: Number.MAX_VALUE,
            rank: 0,
            kind: "status",
            status: "ended",
            animate: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("本轮已结束")).toBeTruthy();
    expect(document.querySelector("time")).toBeNull();
  });
  it("keeps a group expanded across polling updates and shows each actual result state", () => {
    const base = {
      turnId: "turn",
      userSequence: 0,
      timestamp: 1,
      kind: "tool" as const,
      label: "读取文件",
    };
    const items: ExecutionDisplayEntry[] = [
      { ...base, id: "use-1", rank: 1, status: "running" },
      { ...base, id: "use-2", rank: 2, status: "returned" },
    ];
    const view = render(<GeneralExecutionActivity items={items} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /执行过程/,
      }),
    );
    view.rerender(
      <GeneralExecutionActivity
        items={[
          { ...items[0]!, status: "failed" } as ExecutionDisplayEntry,
          items[1]!,
        ]}
      />,
    );
    expect(
      screen
        .getByRole("button", {
          name: /执行过程/,
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("读取文件 · 调用失败")).toBeTruthy();
    const details = document.getElementById(
      screen
        .getByRole("button", { name: /执行过程/ })
        .getAttribute("aria-controls")!,
    )!;
    expect(within(details).getByText("读取文件 · 已返回结果")).toBeTruthy();
  });

  it("shows elapsed time for finished tools and never animates historical activity", () => {
    const start = 1_800_000_000_000;
    render(
      <GeneralExecutionActivity
        items={[
          {
            id: "old-tool",
            turnId: "old-turn",
            userSequence: 1,
            timestamp: start,
            rank: 1,
            kind: "tool",
            label: "读取文件",
            status: "running",
            finishedAt: start + 4_000,
            animate: false,
          },
          {
            id: "done",
            turnId: "new-turn",
            userSequence: 2,
            timestamp: start,
            rank: 2,
            kind: "status",
            status: "ended",
            animate: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("读取文件 · 已记录执行")).toBeTruthy();
    expect(screen.getByText("4 秒")).toBeTruthy();
    expect(screen.getByText("本轮已结束")).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the current action visible while history is collapsed and exposes waiting and failed states when expanded", () => {
    const base = {
      turnId: "turn",
      userSequence: 0,
      timestamp: 1,
      kind: "tool" as const,
    };
    render(
      <GeneralExecutionActivity
        items={[
          {
            ...base,
            id: "wait",
            rank: 1,
            label: "读取文件",
            status: "waiting",
            animate: false,
          },
          {
            ...base,
            id: "fail",
            rank: 2,
            label: "搜索网页",
            status: "failed",
            animate: false,
          },
          {
            ...base,
            id: "now",
            rank: 3,
            label: "运行代码",
            status: "running",
            animate: true,
          },
        ]}
      />,
    );
    expect(
      screen.getAllByText("运行代码 · 执行中").length,
    ).toBeGreaterThanOrEqual(1);
    const toggle = screen.getByRole("button", {
      name: /执行过程/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("读取文件 · 等待确认")).toBeTruthy();
    expect(screen.getByText("搜索网页 · 调用失败")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
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
    expect(screen.getByText("搜索网页 · 已完成")).toBeTruthy();
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
      (_text, element) => element?.textContent === longText,
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
    expect(screen.getByText("分析任务")).toBeTruthy();
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

describe("workbench execution presentation", () => {
  it("uses only textual states and disclosure arrows, without statistics or decorative nodes", () => {
    const base = {
      turnId: "turn",
      userSequence: 1,
      timestamp: 1,
      animate: false,
      isCurrent: false,
    };
    const { container } = render(
      <GeneralExecutionActivity
        items={[
          {
            ...base,
            id: "failed",
            rank: 0,
            kind: "tool",
            label: "搜索网页",
            toolKind: "builtin",
            status: "failed",
          },
          {
            ...base,
            id: "returned",
            rank: 1,
            kind: "tool",
            label: "调用扩展工具",
            toolKind: "mcp",
            status: "returned",
          },
          {
            ...base,
            id: "unconfirmed",
            rank: 2,
            kind: "tool",
            label: "写入文件",
            status: "unconfirmed",
          },
        ]}
      />,
    );
    expect(screen.getByText("写入文件 · 结果未确认")).toBeTruthy();
    expect(screen.queryByText("搜索网页 · 调用失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /执行过程/ }));
    expect(screen.getByText("搜索网页 · 调用失败")).toBeTruthy();
    expect(screen.getByText("调用扩展工具 · 已返回结果")).toBeTruthy();
    expect(container.textContent).not.toMatch(
      /\d+\s*(条记录|次工具调用)|完成\s*\d+|失败\s*\d+/,
    );
    expect(
      container.querySelector(
        "img, circle, [class*='border-l'], [class*='rounded-full']",
      ),
    ).toBeNull();
    expect(
      [...container.querySelectorAll("svg")].every((icon) =>
        icon.classList.contains("lucide-chevron-right"),
      ),
    ).toBe(true);
  });

  it("keeps result-only activity separate and does not invent an earlier tool call", () => {
    const base = {
      turnId: "turn",
      userSequence: 1,
      timestamp: 1,
      animate: false,
      isCurrent: false,
    };
    const { container } = render(
      <GeneralExecutionActivity
        items={[
          { ...base, id: "start", rank: 0, kind: "status", status: "running" },
          {
            ...base,
            id: "result",
            rank: 1,
            kind: "tool",
            label: "工具结果",
            status: "returned",
            resultOnly: true,
          },
          { ...base, id: "end", rank: 2, kind: "status", status: "ended" },
        ]}
      />,
    );
    expect(screen.getByText("开始执行")).toBeTruthy();
    expect(screen.getByText("工具结果 · 已返回结果")).toBeTruthy();
    expect(screen.getByText("本轮已结束")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelectorAll(".general-execution__line")).toHaveLength(
      3,
    );
  });
});
