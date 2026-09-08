import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneralExecutionActivity } from "./GeneralExecutionActivity";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";

describe("compact execution activity", () => {
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
        name: "2 项工具调用 · 已完成 0 · 失败 0 · 正在读取文件",
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
        .getByRole("button", { name: "2 项工具调用 · 已完成 0 · 失败 1" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("读取文件 · 调用失败")).toBeTruthy();
    expect(screen.getByText("读取文件 · 已返回结果")).toBeTruthy();
  });
});
