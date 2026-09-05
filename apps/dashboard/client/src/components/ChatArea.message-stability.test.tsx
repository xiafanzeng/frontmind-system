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
