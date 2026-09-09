import { useLayoutEffect, useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatReadingPosition } from "./useChatReadingPosition";

let height = 2400;
let viewportHeight = 600;
let anchorTop = 600;
const observers = new Set<() => void>();
function Harness({
  taskKey,
  contentKey = "initial",
}: {
  taskKey: string;
  contentKey?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = viewport.current!;
    if (!Object.getOwnPropertyDescriptor(node, "scrollTop")) {
      let top = 0;
      Object.defineProperties(node, {
        scrollHeight: { get: () => height },
        clientHeight: { get: () => viewportHeight },
        scrollTop: {
          get: () => top,
          set: (value) => {
            top = Math.max(0, Math.min(Number(value), height - viewportHeight));
          },
        },
      });
      node.getBoundingClientRect = () =>
        ({ top: 0, bottom: viewportHeight }) as DOMRect;
    }
    node.querySelector<HTMLElement>(
      "[data-reading-anchor]",
    )!.getBoundingClientRect = () =>
      ({
        top: anchorTop - node.scrollTop,
        bottom: anchorTop + 1000 - node.scrollTop,
      }) as DOMRect;
  });
  const { showLatest, returnToLatest } = useChatReadingPosition(
    viewport,
    taskKey,
    contentKey,
  );
  return (
    <>
      <div ref={viewport} data-testid="viewport">
        <div>
          <div data-reading-anchor="message">内容</div>
        </div>
      </div>
      {showLatest && <button onClick={returnToLatest}>回到最新</button>}
    </>
  );
}
function resize() {
  act(() => {
    for (const callback of observers) callback();
  });
}
function readAt(top: number) {
  const node = screen.getByTestId("viewport");
  node.scrollTop = top;
  fireEvent.scroll(node);
  return node;
}
beforeEach(() => {
  height = 2400;
  viewportHeight = 600;
  anchorTop = 600;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  observers.clear();
  vi.unstubAllGlobals();
});

describe("task reading positions", () => {
  it("follows new content only until the reader scrolls upward, with explicit return to latest", () => {
    const { rerender } = render(<Harness taskKey="stream-task" />);
    const node = screen.getByTestId("viewport");
    expect(node.scrollTop).toBe(1800);
    height = 2800;
    rerender(<Harness taskKey="stream-task" contentKey="stream-1" />);
    expect(node.scrollTop).toBe(2200);
    readAt(640);
    height = 3200;
    rerender(<Harness taskKey="stream-task" contentKey="stream-2" />);
    expect(node.scrollTop).toBe(640);
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(node.scrollTop).toBe(2600);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("restores task reading positions after task switches and Agent route remounts", () => {
    const { rerender, unmount } = render(
      <Harness taskKey="project-a:task-a" />,
    );
    readAt(740);
    rerender(<Harness taskKey="project-a:task-b" />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(1800);
    rerender(<Harness taskKey="project-a:task-a" />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(740);
    unmount();
    render(<Harness taskKey="project-a:task-a" />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(740);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeVisible();
  });

  it("keeps the visible message at the same offset as images or expanded process records grow above it", () => {
    render(<Harness taskKey="image-growth" />);
    const node = readAt(700);
    anchorTop += 320;
    height += 320;
    resize();
    expect(node.scrollTop).toBe(1020);
    expect(
      node.querySelector("[data-reading-anchor]")!.getBoundingClientRect().top,
    ).toBe(-100);
    viewportHeight = 360;
    resize();
    expect(node.scrollTop).toBe(1020);
  });

  it("does not leak a remembered position into another project", () => {
    const { rerender } = render(<Harness taskKey="scope-1:shared-id" />);
    readAt(800);
    rerender(<Harness taskKey="scope-2:shared-id" />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(1800);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
