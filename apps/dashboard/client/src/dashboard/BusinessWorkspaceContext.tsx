import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { useWorkbenchTask } from "@/hooks/useWorkbenchTask";
export type BusinessWorkspaceSummary = {
  title?: string;
  items: Array<{ label: string; value: string }>;
  status?: string;
  action?: { label: string; onClick: () => void };
};
export type BusinessWorkspaceValue = {
  isWorkbench: boolean;
  taskId: string | null;
  agentId: string;
  task?: ReturnType<typeof useWorkbenchTask>;
  setSummary: (summary: BusinessWorkspaceSummary | null) => void;
};
const Context = createContext<BusinessWorkspaceValue>({
  isWorkbench: false,
  taskId: null,
  agentId: "general",
  setSummary: () => undefined,
});
export const BusinessWorkspaceProvider = Context.Provider;
export function useBusinessWorkspace() {
  return useContext(Context);
}
export function useBusinessWorkspaceSummary(
  summary: BusinessWorkspaceSummary | null,
) {
  const { setSummary } = useBusinessWorkspace();
  const latest = useRef(summary);
  latest.current = summary;
  const signature = JSON.stringify(
    summary && { ...summary, action: summary.action?.label },
  );
  useEffect(() => {
    const value = latest.current;
    setSummary(
      value
        ? {
            ...value,
            action: value.action
              ? {
                  label: value.action.label,
                  onClick: () => latest.current?.action?.onClick(),
                }
              : undefined,
          }
        : null,
    );
    return () => setSummary(null);
  }, [signature, setSummary]);
}
export function BusinessWorkspaceInspector({
  summary,
  children,
}: {
  summary: BusinessWorkspaceSummary | null;
  children?: ReactNode;
}) {
  return (
    <div className="business-workspace-inspector" aria-label="任务辅助信息">
      {summary?.title && <h2>{summary.title}</h2>}
      {summary?.status && <p role="status">{summary.status}</p>}
      {summary && (
        <dl>
          {summary.items.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
      {summary?.action && (
        <button
          className="business-inspector-action"
          type="button"
          onClick={summary.action.onClick}
        >
          {summary.action.label}
        </button>
      )}
      {children}
    </div>
  );
}
