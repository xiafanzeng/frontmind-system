import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("读取文件 · 已返回结果")).toBeTruthy();
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
