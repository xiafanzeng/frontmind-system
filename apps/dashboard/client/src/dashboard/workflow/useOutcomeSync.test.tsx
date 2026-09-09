import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { BusinessWorkspaceProvider } from "../BusinessWorkspaceContext";
import { useOutcomeSync } from "./useOutcomeSync";

describe("business result association outbox", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
      },
    });
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  const ref = (id: string) => ({
    resource: { kind: "article_version" as const, id },
    sourceStepId: `freeze-${id}`,
  });
  function setup() {
    const saveState = vi.fn().mockRejectedValue(new Error("offline"));
    const retry = vi.fn().mockResolvedValue(undefined);
    const task = {
      scopeKey: "user7:projectA:articles",
      taskId: "one",
      saveState,
      retry,
    };
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <BusinessWorkspaceProvider
          value={{
            isWorkbench: true,
            agentId: "articles",
            taskId: task.taskId,
            task: task as any,
            setSummary: () => undefined,
          }}
        >
          {children}
        </BusinessWorkspaceProvider>
      );
    }
    return { task, saveState, retry, Wrapper };
  }
  it("recovers a real entity reference after reload and retries only task association", async () => {
    const { Wrapper, saveState, retry } = setup();
    const first = renderHook(useOutcomeSync, { wrapper: Wrapper });
    await act(() =>
      first.result.current.sync({
        outputRefs: [ref("v1")],
        record: { id: "freeze-v1", label: "已冻结稿件", status: "completed" },
      }),
    );
    expect(first.result.current.error).toMatch(/业务已保存/);
    first.unmount();
    const second = renderHook(useOutcomeSync, { wrapper: Wrapper });
    expect(second.result.current.pending?.outputRefs).toEqual([ref("v1")]);
    saveState.mockResolvedValue({});
    await act(() => second.result.current.retry());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputRefs: [ref("v1")] }),
      { conversationId: "one", scopeKey: "user7:projectA:articles" },
    );
    expect(second.result.current.pending).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });
  it("preserves earlier output references and operation receipts when another save fails", async () => {
    const { Wrapper } = setup();
    const { result } = renderHook(useOutcomeSync, { wrapper: Wrapper });
    await act(() =>
      result.current.sync({
        outputRefs: [ref("v1")],
        record: { id: "a", label: "冻结一", status: "completed" },
      }),
    );
    await act(() =>
      result.current.sync({
        outputRefs: [ref("v2")],
        record: { id: "b", label: "冻结二", status: "completed" },
      }),
    );
    expect(result.current.pending?.outputRefs).toEqual([ref("v1"), ref("v2")]);
    expect(result.current.pending?.records?.map((record) => record.id)).toEqual(
      ["a"],
    );
    expect(result.current.pending?.record?.id).toBe("b");
  });
  it("keeps a late result in its original task outbox instead of the selected project", async () => {
    const { task, Wrapper, saveState } = setup();
    const view = renderHook(useOutcomeSync, { wrapper: Wrapper });
    const oldSync = view.result.current.sync;
    // A different task adapter is supplied after a route change in the real app.
    const oldScope = task.scopeKey;
    task.scopeKey = "user7:projectB:articles";
    task.taskId = "two";
    view.rerender();
    await act(() => oldSync({ outputRefs: [ref("old-result")] }, "one"));
    expect(view.result.current.pending).toBeUndefined();
    expect(saveState).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "one",
      scopeKey: oldScope,
    });
    expect(
      localStorage.getItem(`frontmind:outcome-sync:v1:${oldScope}:one`),
    ).toContain("old-result");
  });
  it("does not let an earlier successful association erase a newer failed receipt", async () => {
    const { Wrapper, saveState } = setup();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    saveState
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = renderHook(useOutcomeSync, { wrapper: Wrapper });
    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = view.result.current.sync({
        values: { selected: "v1" },
        outputRefs: [ref("v1")],
        record: { id: "a", label: "冻结一", status: "completed" },
      });
    });
    act(() => {
      two = view.result.current.sync({
        values: { selected: "v2" },
        outputRefs: [ref("v2")],
        record: { id: "b", label: "冻结二", status: "completed" },
      });
    });
    await act(async () => {
      first.resolve({});
      expect(await one).toBe(true);
    });
    expect(view.result.current.pending?.values).toEqual({ selected: "v2" });
    await act(async () => {
      second.reject(new Error("offline"));
      expect(await two).toBe(false);
    });
    view.unmount();
    const restored = renderHook(useOutcomeSync, { wrapper: Wrapper });
    expect(restored.result.current.pending).toEqual(
      expect.objectContaining({
        values: { selected: "v2" },
        outputRefs: [ref("v1"), ref("v2")],
        records: [expect.objectContaining({ id: "a" })],
        record: expect.objectContaining({ id: "b" }),
      }),
    );
    saveState.mockResolvedValue({});
    await act(() => restored.result.current.retry());
    expect(restored.result.current.pending).toBeUndefined();
  });
  it("retries the latest receipt when another confirmation arrives during recovery", async () => {
    const { Wrapper, saveState, retry } = setup();
    const refresh = deferred<void>();
    retry.mockImplementationOnce(() => refresh.promise);
    const view = renderHook(useOutcomeSync, { wrapper: Wrapper });
    await act(() =>
      view.result.current.sync({
        values: { selected: "v1" },
        resources: [ref("v1").resource],
        outputRefs: [ref("v1")],
      }),
    );
    let recovery!: Promise<void>;
    act(() => {
      recovery = view.result.current.retry();
    });
    await act(() =>
      view.result.current.sync({
        values: { selected: "v2" },
        resources: [ref("v2").resource],
        outputRefs: [ref("v2")],
      }),
    );
    saveState.mockResolvedValue({});
    await act(async () => {
      refresh.resolve();
      await recovery;
    });
    expect(saveState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: { selected: "v2" },
        resources: [ref("v2").resource],
        outputRefs: [ref("v1"), ref("v2")],
      }),
      expect.anything(),
    );
    expect(view.result.current.pending).toBeUndefined();
  });
  it("does not recreate an acknowledged receipt when an earlier recovery finishes", async () => {
    const { Wrapper, saveState, retry } = setup();
    const refresh = deferred<void>();
    retry.mockImplementationOnce(() => refresh.promise);
    const view = renderHook(useOutcomeSync, { wrapper: Wrapper });
    await act(() => view.result.current.sync({ outputRefs: [ref("v1")] }));
    let recovery!: Promise<void>;
    act(() => {
      recovery = view.result.current.retry();
    });
    saveState.mockResolvedValue({});
    await act(() => view.result.current.sync({ outputRefs: [ref("v2")] }));
    await act(async () => {
      refresh.resolve();
      await recovery;
    });
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(view.result.current.pending).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });
  it("leaves recovery in the source outbox when the project changes during refresh", async () => {
    const { task, Wrapper, saveState, retry } = setup();
    const refresh = deferred<void>();
    retry.mockImplementationOnce(() => refresh.promise);
    const view = renderHook(useOutcomeSync, { wrapper: Wrapper });
    await act(() => view.result.current.sync({ outputRefs: [ref("v1")] }));
    let recovery!: Promise<void>;
    act(() => {
      recovery = view.result.current.retry();
    });
    const sourceScope = task.scopeKey;
    task.scopeKey = "user7:projectB:articles";
    task.taskId = "two";
    view.rerender();
    await act(async () => {
      refresh.resolve();
      await recovery;
    });
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending).toBeUndefined();
    expect(
      localStorage.getItem(`frontmind:outcome-sync:v1:${sourceScope}:one`),
    ).toContain("v1");
  });
});
