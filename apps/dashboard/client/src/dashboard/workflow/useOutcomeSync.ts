import { useRef, useState } from "react";
import {
  mergeWorkbenchOutputRefs,
  workbenchStatePatchSchema,
  type WorkbenchStatePatch,
} from "@shared/workbench-task";
import { useBusinessWorkspace } from "../BusinessWorkspaceContext";

/** Save the domain result before its task association. Retrying this outbox
 * cannot call the domain mutation (create/freeze/publish/charge) again. */
export function useOutcomeSync() {
  const { task } = useBusinessWorkspace();
  const [, render] = useState(0);
  const memory = useRef(new Map<string, WorkbenchStatePatch>());
  const scopeKey = task?.scopeKey;
  const taskId = task?.taskId;
  const key = taskId ? `frontmind:outcome-sync:v1:${scopeKey}:${taskId}` : null;
  const selectedKey = useRef(key);
  selectedKey.current = key;
  const readPending = (targetKey: string) => {
    const receipt = memory.current.get(targetKey);
    if (receipt) return receipt;
    try {
      const parsed = workbenchStatePatchSchema.safeParse(
        JSON.parse(localStorage.getItem(targetKey) ?? "null"),
      );
      if (parsed.success) return parsed.data;
    } catch {
      /* Storage may be disabled; the in-memory receipt remains. */
    }
    return undefined;
  };
  const pending = key ? readPending(key) : undefined;
  const [error, setError] = useState<string | null>(null);
  const sync = async (patch: WorkbenchStatePatch, boundTaskId?: string) => {
    const targetKey =
      boundTaskId && task
        ? `frontmind:outcome-sync:v1:${scopeKey}:${boundTaskId}`
        : key;
    if (!task || !targetKey || !scopeKey)
      throw new Error("任务尚未绑定，请先恢复当前任务");
    const prior = readPending(targetKey);
    if (prior)
      patch = {
        ...prior,
        ...patch,
        values: { ...prior.values, ...patch.values },
        outputRefs: mergeWorkbenchOutputRefs(
          prior.outputRefs,
          patch.outputRefs,
        ),
        records: [
          ...new Map(
            [
              ...(prior.records ?? []),
              ...(prior.record ? [prior.record] : []),
              ...(patch.records ?? []),
            ].map((record) => [record.id, record]),
          ).values(),
        ],
      };
    memory.current.set(targetKey, patch);
    const serialized = JSON.stringify(patch);
    try {
      localStorage.setItem(targetKey, serialized);
    } catch {
      /* Keep memory receipt. */
    }
    render((value) => value + 1);
    try {
      await task.saveState(patch, {
        conversationId: boundTaskId ?? taskId!,
        scopeKey,
      });
      // A second confirmation may already have written a newer receipt while
      // this association was in flight. Acknowledge only this exact receipt.
      if (memory.current.get(targetKey) === patch)
        memory.current.delete(targetKey);
      try {
        if (localStorage.getItem(targetKey) === serialized)
          localStorage.removeItem(targetKey);
      } catch {
        /* Storage disabled. */
      }
      setError(null);
      render((value) => value + 1);
      return true;
    } catch {
      setError("业务已保存，任务记录待同步。重试只补充成果关联。");
      return false;
    }
  };
  return {
    pending,
    error: pending ? (error ?? "业务已保存，任务记录待同步。") : null,
    sync,
    retry: async () => {
      if (!key || selectedKey.current !== key || !readPending(key)) return;
      try {
        await task?.retry();
        if (selectedKey.current !== key) return;
        // Refresh can overlap another confirmation. Read the newest receipt,
        // or stop when it was acknowledged, rather than replay an old draft.
        const current = readPending(key);
        if (current) await sync(current);
      } catch {
        setError("成果已保存，暂时无法同步任务，请稍后重试。");
      }
    },
  };
}
