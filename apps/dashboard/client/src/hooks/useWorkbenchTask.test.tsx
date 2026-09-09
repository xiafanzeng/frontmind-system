import { useState, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationContextProvider,
  type Conversation,
} from "@/contexts/ConversationContext";
import { initialWorkbenchTaskState } from "@shared/workbench-task";
import { useWorkbenchTask } from "./useWorkbenchTask";

const api = vi.hoisted(() => ({
  bind: vi.fn(),
  save: vi.fn(),
  handoff: vi.fn(),
  flush: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    conversation: {
      workbenchBind: { useMutation: () => ({ mutateAsync: api.bind }) },
      workbenchSaveState: { useMutation: () => ({ mutateAsync: api.save }) },
      workbenchHandoff: { useMutation: () => ({ mutateAsync: api.handoff }) },
    },
  },
}));
const task = (id: string): Conversation => ({
  id,
  title: id,
  workbenchAgentId: "media",
  workbench: initialWorkbenchTaskState("media"),
  messages: [],
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});
function wrapper(
  initial: Conversation[],
  scopeKey = () => "account-7:project-1",
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const [conversations, setConversations] = useState(initial);
    const [active, setActive] = useState(initial[0]?.id ?? null);
    const createConversation = (options: any) => {
      const id = `local-${conversations.length}`;
      setConversations((current) => [
        ...current,
        { ...task(id), ...options, workbench: undefined },
      ]);
      setActive(id);
      return id;
    };
    return (
      <ConversationContextProvider
        value={
          {
            state: { conversations, activeConversationId: active },
            activeConversation:
              conversations.find((item) => item.id === active) ?? null,
            workbenchScopeKey: scopeKey(),
            hydrated: true,
            createConversation,
            setActive,
            flushConversation: api.flush,
            refreshConversations: api.refresh,
          } as any
        }
      >
        {children}
      </ConversationContextProvider>
    );
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.flush.mockResolvedValue(true);
  api.refresh.mockResolvedValue(undefined);
  window.history.replaceState({}, "", "/");
});
afterEach(() => window.history.replaceState({}, "", "/"));

describe("useWorkbenchTask persistence", () => {
  it("ignores historical URL and active-task preferences for a project resource without writing on browse", () => {
    window.history.replaceState({}, "", "/?workbenchTask=old");
    const old = {
      ...task("old"),
      workbenchAgentId: "keywords" as const,
      workbench: initialWorkbenchTaskState("keywords"),
    };
    const current = { ...old, id: "current", updatedAt: 2 };
    const view = renderHook(
      () => useWorkbenchTask("keywords", { ignoreTaskQuery: true }),
      {
        wrapper: wrapper([old, current]),
      },
    );
    expect(view.result.current.taskId).toBe("current");
    expect(view.result.current.tasks).toHaveLength(2);
    view.unmount();
    const empty = renderHook(
      () => useWorkbenchTask("keywords", { ignoreTaskQuery: true }),
      {
        wrapper: wrapper([task("old")]),
      },
    );
    expect(empty.result.current.taskId).toBeNull();
    expect(api.bind).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.flush).not.toHaveBeenCalled();
  });
  it.each(["project", "task", "agent"] as const)(
    "clears the previous task error when the %s changes through route restoration",
    async (change) => {
      let project = "account-7:project-1";
      let currentId = "a";
      let agentId: "media" | "publishing" = "media";
      api.save.mockRejectedValueOnce(new Error("旧媒体任务保存冲突"));
      const view = renderHook(
        () => useWorkbenchTask(agentId, { conversationId: currentId }),
        { wrapper: wrapper([task("a"), task("b")], () => project) },
      );
      await act(async () => {
        await expect(
          view.result.current.saveState({ values: { query: "draft" } }),
        ).rejects.toThrow("旧媒体任务保存冲突");
      });
      expect(view.result.current.error).toBe("旧媒体任务保存冲突");
      if (change === "project") project = "account-7:project-2";
      if (change === "task") currentId = "b";
      if (change === "agent") agentId = "publishing";
      view.rerender();
      expect(view.result.current.error).toBeNull();
    },
  );
  it("stops showing a previous project's in-flight save as pending in the selected project", async () => {
    let finish!: (value: ReturnType<typeof initialWorkbenchTaskState>) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let scopeKey = "account-7:project-1";
    const view = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a")], () => scopeKey),
    });
    let request!: Promise<unknown>;
    act(() => {
      request = view.result.current.saveState({ values: { query: "old" } });
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(view.result.current.pending).toBe(true);
    scopeKey = "account-7:project-2";
    view.rerender();
    expect(view.result.current.pending).toBe(false);
    await act(async () => {
      finish({ ...initialWorkbenchTaskState("media"), revision: 2 });
      await request;
    });
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.revision).toBe(1);
  });
  it("does not let an old recovery discard a newly saved task state", async () => {
    let refresh!: () => void;
    api.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          refresh = resolve;
        }),
    );
    api.save.mockResolvedValue({
      ...initialWorkbenchTaskState("media"),
      revision: 2,
      values: { query: "new task" },
    });
    const view = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a"), task("b")]),
    });
    let recovery!: Promise<void>;
    act(() => {
      recovery = view.result.current.retry();
    });
    act(() => {
      view.result.current.selectTask("b");
    });
    await act(() =>
      view.result.current.saveState({ values: { query: "new task" } }),
    );
    await act(async () => {
      refresh();
      await recovery;
    });
    expect(view.result.current.taskId).toBe("b");
    expect(view.result.current.revision).toBe(2);
    expect(view.result.current.state?.values).toEqual({ query: "new task" });
    expect(api.bind).not.toHaveBeenCalled();
  });
  it("does not regress a newer saved revision when recovery returns an older projection", async () => {
    let finishBind!: (
      value: ReturnType<typeof initialWorkbenchTaskState>,
    ) => void;
    api.bind.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBind = resolve;
        }),
    );
    api.save.mockResolvedValue({
      ...initialWorkbenchTaskState("media"),
      revision: 2,
      values: { query: "confirmed" },
    });
    const view = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a")]),
    });
    let recovery!: Promise<void>;
    act(() => {
      recovery = view.result.current.retry();
    });
    await waitFor(() => expect(api.bind).toHaveBeenCalledTimes(1));
    await act(() =>
      view.result.current.saveState({ values: { query: "confirmed" } }),
    );
    await act(async () => {
      finishBind(initialWorkbenchTaskState("media"));
      await recovery;
    });
    expect(view.result.current.revision).toBe(2);
    expect(view.result.current.state?.values).toEqual({ query: "confirmed" });
  });
  it("keeps browsing and new tasks local until the first operation binds them", async () => {
    api.bind.mockResolvedValue(initialWorkbenchTaskState("media"));
    const { result } = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([]),
    });
    expect(result.current.taskId).toBeNull();
    expect(api.bind).not.toHaveBeenCalled();
    act(() => {
      result.current.newTask("选媒体");
    });
    expect(result.current.taskId).toBe("local-0");
    expect(api.bind).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.ensureTask()).toBe("local-0");
    });
    expect(api.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "local-0",
        agentId: "media",
        title: "选媒体",
      }),
    );
    expect(result.current.state?.revision).toBe(1);
    expect(result.current.task?.messages).toEqual([]);
  });
  it("does not bind an old draft in a new project after its initial flush completes", async () => {
    let finishFlush!: (value: boolean) => void;
    api.flush.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFlush = resolve;
        }),
    );
    let scopeKey = "account-7:project-1";
    const { result, rerender } = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper(
        [{ ...task("a"), workbench: undefined }],
        () => scopeKey,
      ),
    });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.ensureTask();
    });
    await waitFor(() => expect(api.flush).toHaveBeenCalledTimes(1));
    scopeKey = "account-7:project-2";
    rerender();
    await act(async () => {
      finishFlush(true);
      await expect(request).rejects.toThrow("任务已切换");
    });
    expect(api.bind).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
  it("never writes a queued old-task patch into another task of the same agent", async () => {
    let finish!: (value: ReturnType<typeof initialWorkbenchTaskState>) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a"), task("b")]),
    });
    let first!: Promise<unknown>;
    let queued!: Promise<unknown>;
    act(() => {
      first = result.current.saveState({ values: { query: "first" } });
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    act(() => {
      queued = result.current.saveState({ values: { query: "old queued" } });
      result.current.selectTask("b");
    });
    let results!: PromiseSettledResult<unknown>[];
    await act(async () => {
      finish({
        ...initialWorkbenchTaskState("media"),
        revision: 2,
        values: { query: "first" },
      });
      results = await Promise.allSettled([first, queued]);
    });
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0][0].conversationId).toBe("a");
    expect(result.current.taskId).toBe("b");
    expect(result.current.state?.values).toEqual({});
  });
  it("serializes same-task saves with the revision returned by the preceding write", async () => {
    api.save.mockImplementation(async ({ expectedRevision, patch }: any) => ({
      ...initialWorkbenchTaskState("media"),
      revision: expectedRevision + 1,
      values: patch.values,
    }));
    const { result } = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a")]),
    });
    await act(async () => {
      await Promise.all([
        result.current.saveState({ values: { query: "one" } }),
        result.current.saveState({ values: { query: "two" } }),
      ]);
    });
    expect(
      api.save.mock.calls.map(([input]) => input.expectedRevision),
    ).toEqual([1, 2]);
    expect(result.current.state?.revision).toBe(3);
  });
  it("does not return a late handoff navigation target after the user selects another task", async () => {
    let finish!: (value: unknown) => void;
    api.handoff.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useWorkbenchTask("media"), {
      wrapper: wrapper([task("a"), task("b")]),
    });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.handoff({
        targetAgentId: "publishing",
        resources: [],
        idempotencyKey: "same-intent",
      });
    });
    await waitFor(() => expect(api.handoff).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.selectTask("b");
    });
    await act(async () => {
      finish({
        conversationId: "target",
        state: initialWorkbenchTaskState("publishing"),
      });
      await expect(request).rejects.toThrow("任务已切换");
    });
    expect(result.current.taskId).toBe("b");
  });
});
