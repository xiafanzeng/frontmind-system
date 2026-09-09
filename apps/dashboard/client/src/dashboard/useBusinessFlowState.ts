import { useReducer, useRef, type Dispatch, type SetStateAction } from "react";
import { useBusinessWorkspace } from "./BusinessWorkspaceContext";

/** UI drafts stay separate from model messages and domain facts. Optimistic
 * drafts survive task switches and the first empty task receiving its server ID. */
export function useBusinessFlowState<T>(
  key: string,
  initial: T,
  parse: (value: unknown) => T | undefined,
  serialize: (value: T) => unknown = (value) => value,
): [T, Dispatch<SetStateAction<T>>, (value: T) => void] {
  const workspace = useBusinessWorkspace();
  const scopePrefix = `${workspace.task?.scopeKey ?? workspace.agentId}:`;
  const scope = `${scopePrefix}${workspace.taskId ?? "new"}`;
  const drafts = useRef(new Map<string, T>());
  const previousScope = useRef(scope);
  const [, updateRender] = useReducer((value) => value + 1, 0);
  if (
    previousScope.current !== scope &&
    previousScope.current === `${scopePrefix}new` &&
    workspace.task?.pending &&
    drafts.current.has(previousScope.current)
  ) {
    drafts.current.set(scope, drafts.current.get(previousScope.current)!);
    drafts.current.delete(previousScope.current);
  }
  previousScope.current = scope;
  const saved = parse(workspace.task?.state?.values[key]);
  const value = drafts.current.has(scope)
    ? drafts.current.get(scope)!
    : saved === undefined
      ? initial
      : saved;
  const latest = useRef({ workspace, scope, value, serialize });
  latest.current = { workspace, scope, value, serialize };
  const update: Dispatch<SetStateAction<T>> = (next) => {
    const current = latest.current;
    // Late domain callbacks retain their task ownership across navigation.
    if (current.scope !== scope) return;
    const resolved =
      typeof next === "function"
        ? (next as (value: T) => T)(current.value)
        : next;
    latest.current.value = resolved;
    drafts.current.set(current.scope, resolved);
    updateRender();
    if (current.workspace.isWorkbench && current.workspace.task) {
      // Invoke while this task is selected. The adapter freezes ownership and
      // serializes writes; its error UI offers recovery without clearing input.
      void current.workspace.task
        .saveState({ values: { [key]: current.serialize(resolved) } })
        .catch(() => undefined);
    }
  };
  // Confirmations call this only after saveState acknowledges the snapshot.
  const acceptSaved = (confirmed: T) => {
    if (latest.current.scope !== scope) return;
    latest.current.value = confirmed;
    drafts.current.set(scope, confirmed);
    updateRender();
  };
  return [value, update, acceptSaved];
}
export const readFlowString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
export const readFlowBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;
export const readFlowStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
