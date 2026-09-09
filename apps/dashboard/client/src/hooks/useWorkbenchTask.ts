import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  conversationBelongsToAgent,
  setWorkbenchTaskQuery,
  useConversation,
} from "@/contexts/ConversationContext";
import { trpc } from "@/lib/trpc";
import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "@/lib/delivery-project";
import type {
  WorkbenchAgentId,
  WorkbenchResourceRef,
  WorkbenchStatePatch,
  WorkbenchTaskState,
} from "@shared/workbench-task";

export type WorkbenchHandoffInput = {
  values?: Record<string, unknown>;
  targetAgentId: WorkbenchAgentId;
  title?: string;
  resources: WorkbenchResourceRef[];
  idempotencyKey: string;
};

/** Workflow state is a separate server projection; no synthetic chat messages. */
export function useWorkbenchTask(
  agentId: WorkbenchAgentId,
  options: { conversationId?: string; title?: string } = {},
) {
  const workspace = useConversation();
  const bindMutation = trpc.conversation.workbenchBind.useMutation();
  const saveMutation = trpc.conversation.workbenchSaveState.useMutation();
  const handoffMutation = trpc.conversation.workbenchHandoff.useMutation();
  const tasks = workspace.state.conversations
    .filter((item) => conversationBelongsToAgent(item, agentId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const scopeKey = `${workspace.workbenchScopeKey ?? "workspace"}:${agentId}`;
  const [selection, setSelection] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const queryId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("workbenchTask");
  const task =
    tasks.find((item) => item.id === options.conversationId) ??
    tasks.find(
      (item) =>
        item.id === (selection?.key === scopeKey ? selection.id : queryId),
    ) ??
    tasks.find((item) => item.id === workspace.activeConversation?.id) ??
    tasks[0] ??
    null;
  const taskId = options.conversationId ?? task?.id ?? null;
  const [cached, setCached] = useState<{
    key: string;
    id: string;
    state: WorkbenchTaskState;
  } | null>(null);
  const state =
    cached?.key === scopeKey &&
    cached.id === taskId &&
    cached.state.revision >= (task?.workbench?.revision ?? 0)
      ? cached.state
      : (task?.workbench ?? null);
  const latest = useRef({
    scopeKey,
    taskId,
    state,
    workspace,
    task,
    agentId,
    options,
  });
  latest.current = {
    scopeKey,
    taskId,
    state,
    workspace,
    task,
    agentId,
    options,
  };
  const [pendingOwner, setPendingOwner] = useState<{
    scopeKey: string;
    taskId: string | null;
  } | null>(null);
  const pending =
    pendingOwner?.scopeKey === scopeKey &&
    (!pendingOwner.taskId || pendingOwner.taskId === taskId);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    setError(null);
  }, [scopeKey, taskId]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingBind = useRef<{ key: string; promise: Promise<string> } | null>(
    null,
  );
  const scopeInput = () => {
    const projectAssignmentId =
      typeof sessionStorage === "undefined"
        ? undefined
        : sessionStorage
            .getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY)
            ?.trim();
    return projectAssignmentId ? { projectAssignmentId } : {};
  };
  const install = (key: string, id: string, next: WorkbenchTaskState) => {
    if (
      latest.current.scopeKey !== key ||
      (latest.current.taskId && latest.current.taskId !== id) ||
      (latest.current.taskId === id &&
        (latest.current.state?.revision ?? 0) > next.revision)
    )
      return;
    latest.current.state = next;
    latest.current.taskId = id;
    setCached({ key, id, state: next });
  };
  const newTask = useCallback((title?: string) => {
    const current = latest.current;
    const id = current.workspace.createConversation({
      title: title ?? current.options.title ?? "新任务",
      reuseEmpty: false,
      workbenchAgentId: current.agentId,
    });
    setSelection({ key: current.scopeKey, id });
    setWorkbenchTaskQuery(id);
    latest.current.taskId = id;
    latest.current.state = null;
    setCached(null);
    setError(null);
    return id;
  }, []);
  const ensureTask = useCallback(
    async (title?: string): Promise<string> => {
      const current = latest.current;
      if (!current.workspace.hydrated)
        throw new Error("任务仍在恢复，请稍后重试");
      const id = current.taskId ?? newTask(title);
      if (current.state?.agentId === current.agentId && current.taskId === id)
        return id;
      const key = `${current.scopeKey}:${id}`;
      if (pendingBind.current?.key === key) return pendingBind.current.promise;
      const promise = (async () => {
        // Drain any chat write first; bind also creates a truly empty business
        // task on its first operation, without persisting browsing-only drafts.
        const flushed = await current.workspace.flushConversation(id);
        if (!flushed) throw new Error("任务同步未完成，请重试");
        if (
          latest.current.scopeKey !== current.scopeKey ||
          latest.current.taskId !== id
        )
          throw new Error("任务已切换，请在当前任务继续");
        const next = await bindMutation.mutateAsync({
          conversationId: id,
          agentId: current.agentId,
          title: title ?? current.task?.title ?? current.options.title,
          ...scopeInput(),
        });
        if (
          latest.current.scopeKey !== current.scopeKey ||
          latest.current.taskId !== id
        )
          throw new Error("任务已切换，请在当前任务继续");
        install(current.scopeKey, id, next);
        await current.workspace.refreshConversations();
        if (
          latest.current.scopeKey !== current.scopeKey ||
          latest.current.taskId !== id
        )
          throw new Error("任务已切换，请在当前任务继续");
        return id;
      })();
      pendingBind.current = { key, promise };
      try {
        return await promise;
      } finally {
        if (pendingBind.current?.promise === promise)
          pendingBind.current = null;
      }
    },
    [bindMutation.mutateAsync, newTask],
  );
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const key = latest.current.scopeKey;
    const requestedTaskId = latest.current.taskId;
    const next = queue.current
      .catch(() => undefined)
      .then(async () => {
        if (
          latest.current.scopeKey !== key ||
          latest.current.taskId !== requestedTaskId
        )
          throw new Error("任务已切换，请在当前任务重试");
        const owner = { scopeKey: key, taskId: requestedTaskId };
        setPendingOwner(owner);
        setError(null);
        try {
          return await operation();
        } catch (cause) {
          if (
            latest.current.scopeKey === key &&
            (!requestedTaskId || latest.current.taskId === requestedTaskId)
          )
            setError(
              cause instanceof Error ? cause.message : "任务保存失败，请重试",
            );
          throw cause;
        } finally {
          setPendingOwner((current) => (current === owner ? null : current));
        }
      });
    queue.current = next;
    return next;
  };
  const saveState = (
    patch: WorkbenchStatePatch,
    owner?: { conversationId: string; scopeKey: string },
  ) =>
    run(async () => {
      if (
        owner &&
        (latest.current.taskId !== owner.conversationId ||
          latest.current.scopeKey !== owner.scopeKey)
      )
        throw new Error("业务已保存；请回到来源任务同步成果记录");
      const id = await ensureTask();
      const current = latest.current;
      if (current.taskId !== id)
        throw new Error("任务已切换，请在当前任务重试");
      if (!current.state) throw new Error("任务状态未就绪，请重试");
      const next = await saveMutation.mutateAsync({
        conversationId: id,
        agentId: current.agentId,
        expectedRevision: current.state.revision,
        patch,
        ...scopeInput(),
      });
      install(current.scopeKey, id, next);
      return next;
    });
  const handoff = (input: WorkbenchHandoffInput) =>
    run(async () => {
      const id = await ensureTask();
      const current = latest.current;
      if (current.taskId !== id)
        throw new Error("任务已切换，请在当前任务重试");
      const result = await handoffMutation.mutateAsync({
        conversationId: id,
        agentId: current.agentId,
        ...input,
        ...scopeInput(),
      });
      if (
        latest.current.scopeKey !== current.scopeKey ||
        latest.current.taskId !== id
      )
        throw new Error("交接已保存；任务已切换，请从原任务的历史记录继续");
      await current.workspace.refreshConversations();
      if (
        latest.current.scopeKey !== current.scopeKey ||
        latest.current.taskId !== id
      )
        throw new Error("交接已保存；任务已切换，请从原任务的历史记录继续");
      setCached(null);
      return result;
    });
  const selectTask = (id: string) => {
    if (!tasks.some((item) => item.id === id)) return;
    setSelection({ key: scopeKey, id });
    setWorkbenchTaskQuery(id);
    setCached(null);
    setError(null);
    workspace.setActive(id);
  };
  const retry = async () => {
    const current = latest.current;
    await workspace.refreshConversations();
    if (
      latest.current.scopeKey !== current.scopeKey ||
      latest.current.taskId !== current.taskId
    )
      return;
    if (current.taskId && current.state) {
      const next = await bindMutation.mutateAsync({
        conversationId: current.taskId,
        agentId: current.agentId,
        ...scopeInput(),
      });
      install(current.scopeKey, current.taskId, next);
    } else setCached(null);
    if (
      latest.current.scopeKey === current.scopeKey &&
      latest.current.taskId === current.taskId
    )
      setError(null);
  };
  return {
    scopeKey,
    taskId,
    task,
    tasks,
    state,
    revision: state?.revision ?? 0,
    hydrated: workspace.hydrated,
    pending,
    error,
    ensureTask,
    newTask,
    selectTask,
    saveState,
    handoff,
    retry,
  };
}
