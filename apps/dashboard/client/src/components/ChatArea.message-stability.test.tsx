import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeaderExecutionDuration, MessageBubble } from "./ChatArea";

describe("ordinary-chat elapsed presentation", () => {
  afterEach(() => vi.useRealTimers());

  it("updates the isolated header clock while keeping running message footers stable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T06:58:48.000Z"));
    const startedAt = Date.now() - 48_000;

    render(
      <>
        <HeaderExecutionDuration startedAt={startedAt} active />
        <MessageBubble
          isRunning
          message={{
            id: "assistant-running",
            role: "assistant",
            content: "处理中消息",
            timestamp: startedAt,
            responseStartedAt: startedAt,
          }}
        />
      </>,
    );

    const header = screen.getByTestId("header-execution-duration");
    expect(header).toHaveTextContent("48.0s");
    expect(screen.getByText("处理中消息").parentElement).not.toHaveTextContent(
      "48.0s",
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(header).toHaveTextContent("50.0s");
    expect(screen.getByText("处理中消息").parentElement).not.toHaveTextContent(
      "50.0s",
    );
  });

  it("shows only the fixed completed duration in the final message footer", () => {
    render(
      <MessageBubble
        fixedElapsedTime={48.3}
        message={{
          id: "assistant-completed",
          role: "assistant",
          content: "已完成修改",
          timestamp: 1_725_000_000_000,
        }}
      />,
    );

    expect(screen.getByText("48.3s")).toBeInTheDocument();
  });
});

describe("workbench message presentation", () => {
  it("preserves model parentheses and formulas without assistant avatars or tool totals", () => {
    const content = "计算结果为 f(x) = (x + 1) / 2（适用于 x ≥ 0）。";
    const { container } = render(<MessageBubble message={{
      id: "model-math", role: "assistant", content, timestamp: 0,
      stepGroups: [{ id: "steps", title: "校验资料", steps: Array.from({ length: 4 }, (_, index) => ({ id: String(index), type: "function_call", label: "读取资料" })) }],
    }} />);
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(container.querySelector(".lucide-bot")).toBeNull();
    expect(container.textContent).not.toMatch(/4\s*次工具调用|完成\s*4|已完成\s*4\s*项/);
  });
});
