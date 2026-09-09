import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { useWorkbenchTask } from "@/hooks/useWorkbenchTask";
import "./workflow/workflow.css";
export type BusinessWorkspaceOutput = {
  id: string;
  title: string;
  description?: string;
  type?: string;
  version?: string | number;
  status?: string;
  source?: string;
  pendingChanges?: boolean;
  onOpen?: () => void;
  onRevise?: () => void;
};
export type BusinessWorkspaceSummary = {
  title?: string;
  items: Array<{ label: string; value: string }>;
  status?: string;
  action?: { label: string; onClick: () => void };
  outputs?: BusinessWorkspaceOutput[];
  scope?: "task" | "project";
  canViewProject?: boolean;
  onScopeChange?: (scope: "task" | "project") => void;
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
    summary && { ...summary, action: summary.action?.label, outputs: summary.outputs?.map(({ onOpen, onRevise, ...item }) => ({ ...item, canOpen: !!onOpen, canRevise: !!onRevise })) },
  );
  useEffect(() => {
    const value = latest.current;
    setSummary(
      value
        ? {
            ...value,
            outputs: value.outputs?.map((output) => ({
              ...output,
              onOpen: output.onOpen ? () => latest.current?.outputs?.find((item) => item.id === output.id)?.onOpen?.() : undefined,
              onRevise: output.onRevise ? () => latest.current?.outputs?.find((item) => item.id === output.id)?.onRevise?.() : undefined,
            })),
            onScopeChange: value.onScopeChange ? (scope) => latest.current?.onScopeChange?.(scope) : undefined,
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
    <div className="business-workspace-inspector" aria-label="任务成果">
      {summary?.title && <h2>{summary.title}</h2>}
      {summary?.canViewProject && (
        <div className="workflow-scope" role="group" aria-label="成果范围">
          {(["task", "project"] as const).map((scope) => <button key={scope} type="button" aria-pressed={(summary.scope ?? "task") === scope} onClick={() => summary.onScopeChange?.(scope)}>{scope === "task" ? "本任务" : "项目已有"}</button>)}
        </div>
      )}
      {summary?.status && <p role="status">{summary.status}</p>}
      {summary?.outputs && <div className="workflow-results">
        {summary.outputs.map((output) => <article className="workflow-result" key={output.id} data-result-id={output.id}>
          <div className="workflow-result-meta">{output.type}{output.version !== undefined && <span>版本 {output.version}</span>}</div>
          <h3>{output.title}</h3>
          {output.description && <p>{output.description}</p>}
          {output.status && <p className="workflow-result-status">{output.status}</p>}
          {output.pendingChanges && <p role="status">当前有修改待确认</p>}
          {output.source && <small>{output.source}</small>}
          <div className="workflow-result-actions">
            {output.onOpen && <button type="button" onClick={output.onOpen}>查看 / 继续处理</button>}
            {output.onRevise && <button type="button" onClick={output.onRevise}>修改</button>}
          </div>
        </article>)}
        {!summary.outputs.length && <p className="workflow-note">{summary.scope === "project" ? "当前项目还没有可用成果。" : "确认后的成果会保留在这里。"}</p>}
      </div>}
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
