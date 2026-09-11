import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionDivider } from "./ExecutionDuration";

afterEach(() => vi.useRealTimers());
describe("execution elapsed time", () => {
  it("keeps counting from the saved start across remount and freezes at the recorded finish", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const startedAt = Date.now() - 257_000;
    const view = render(
      <ExecutionDivider timing={{ startedAt, active: true }} />,
    );
    expect(screen.getByText("用时 4分钟 17秒")).toBeInTheDocument();
    expect(view.container.querySelector("hr")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText("用时 4分钟 20秒")).toBeInTheDocument();
    view.unmount();
    act(() => vi.advanceTimersByTime(60000));
    const restored = render(
      <ExecutionDivider timing={{ startedAt, active: true }} />,
    );
    expect(screen.getByText("用时 5分钟 20秒")).toBeInTheDocument();
    restored.rerender(
      <ExecutionDivider
        timing={{ startedAt, completedAt: startedAt + 321000, active: false }}
      />,
    );
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByText("用时 5分钟 21秒")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
