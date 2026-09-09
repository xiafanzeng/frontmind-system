import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import { useBusinessWorkspace } from "@/dashboard/BusinessWorkspaceContext";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import type { WorkbenchTaskState } from "@shared/workbench-task";
import {
  DEFAULT_MEDIA_FILTERS,
  readMediaRouteState,
  writeMediaRouteState,
} from "./queryState";

export type PublishingResource = {
  kind:
    | "article"
    | "article_version"
    | "publication_draft"
    | "publication_batch";
  id: string;
};
export type PublishingFlowSummary = {
  title: string;
  items: Array<{ label: string; value: string }>;
  note?: string;
};
export type PublishingFlow = {
  taskId?: string;
  ensureTask: () => Promise<string>;
  agentId: string;
  selections?: Record<string, unknown>;
  resources?: PublishingResource[];
  setSummary: (summary: PublishingFlowSummary | null) => void;
  record: (input: {
    id: string;
    label: string;
    detail?: string;
    resources?: PublishingResource[];
  }) => Promise<void>;
  saveSelections: (selections: Record<string, unknown>) => Promise<void>;
  handoff: (input: {
    targetAgentId: "publishing" | "media" | "articles";
    title: string;
    resources: PublishingResource[];
    idempotencyKey: string;
    route: string;
  }) => Promise<void>;
};
export const PublishingFlowContext = createContext<PublishingFlow | null>(null);
export function PublishingFlowProvider({
  value,
  children,
}: {
  value: PublishingFlow;
  children: ReactNode;
}) {
  return (
    <PublishingFlowContext.Provider value={value}>
      {children}
    </PublishingFlowContext.Provider>
  );
}
export const usePublishingFlow = () => useContext(PublishingFlowContext);

const selectedPublishingTasks = new Map<string, string>();
/** Recover a business resource from its task, never from the previous task's URL. */
export function publishingTaskResumePath(
  agentId: string,
  state?: Pick<WorkbenchTaskState, "resources" | "step" | "values"> | null,
) {
  const resource = (kind: string) =>
    state?.resources.find((item) => item.kind === kind)?.id;
  if (agentId === "media") {
    const params = new URLSearchParams();
    const saved = state?.values.mediaFilters;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const key of Object.keys(DEFAULT_MEDIA_FILTERS)) {
        const value = (saved as Record<string, unknown>)[key];
        if (typeof value === "string" || typeof value === "number")
          params.set(key, String(value));
      }
    }
    return writeMediaRouteState(
      "/publishing/media",
      readMediaRouteState(params.toString()).filters,
      resource("article_version"),
    );
  }
  if (agentId === "articles")
    return resource("article")
      ? `/publishing/articles/${encodeURIComponent(resource("article")!)}/edit`
      : "/publishing/articles";
  const batch = resource("publication_batch");
  if (batch) return `/publishing/publications/${encodeURIComponent(batch)}`;
  const draft = resource("publication_draft");
  if (draft)
    return `/publishing/drafts/${encodeURIComponent(draft)}/${state?.step === "titles" ? "review" : "titles"}`;
  return "/publishing";
}

export function PublishingFlowBridge({ children }: { children: ReactNode }) {
  const workspace = useBusinessWorkspace();
  const [, navigate] = useLocation();
  const task = workspace.task;
  const routeScope = projectWorkspaceUrl("/");
  const restoredTask = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!workspace.isWorkbench || !task?.hydrated || !task.taskId) return;
    const scope = `${routeScope}:${workspace.agentId}`;
    const key = `${scope}:${task.taskId}`;
    if (restoredTask.current === key) return;
    restoredTask.current = key;
    const previous = selectedPublishingTasks.get(scope);
    selectedPublishingTasks.set(scope, task.taskId);
    if (
      !task.state?.resources.length &&
      !task.state?.values.mediaFilters &&
      (!previous || previous === task.taskId)
    )
      return;
    const url = new URL(
      projectWorkspaceUrl(
        publishingTaskResumePath(workspace.agentId, task.state),
      ),
      window.location.origin,
    );
    url.searchParams.set("workbenchTask", task.taskId);
    if (
      `${url.pathname}${url.search}` !==
      `${window.location.pathname}${window.location.search}`
    )
      navigate(`${url.pathname}${url.search}`, { replace: true });
  }, [
    workspace.isWorkbench,
    workspace.agentId,
    task?.hydrated,
    task?.taskId,
    task?.state,
    routeScope,
    navigate,
  ]);
  const publishSummary = useCallback(
    (summary: PublishingFlowSummary | null) =>
      workspace.setSummary(
        summary ? { ...summary, status: summary.note } : null,
      ),
    [workspace.setSummary],
  );
  const value = useMemo<PublishingFlow | null>(
    () =>
      !workspace.isWorkbench || !task
        ? null
        : {
            taskId: task.taskId ?? undefined,
            agentId: workspace.agentId,
            ensureTask: () => task.ensureTask(),
            selections: task.state?.values,
            resources: task.state?.resources.filter(
              (resource): resource is PublishingResource =>
                [
                  "article",
                  "article_version",
                  "publication_draft",
                  "publication_batch",
                ].includes(resource.kind),
            ),
            setSummary: publishSummary,
            record: async (record) => {
              await task.saveState({
                step: record.id.split(":")[0],
                record: {
                  id: record.id,
                  label: record.label,
                  detail: record.detail,
                  status: "completed",
                },
                ...(record.resources ? { resources: record.resources } : {}),
              });
            },
            saveSelections: async (values) => {
              await task.saveState({
                step: "media-selection",
                values: values as Parameters<
                  typeof task.saveState
                >[0]["values"],
              });
            },
            handoff: async ({ route, ...input }) => {
              const next = await task.handoff(input);
              const url = new URL(
                projectWorkspaceUrl(route),
                window.location.origin,
              );
              url.searchParams.set("workbenchTask", next.conversationId);
              navigate(`${url.pathname}${url.search}`);
            },
          },
    [workspace.isWorkbench, workspace.agentId, publishSummary, task, navigate],
  );
  return (
    <PublishingFlowContext.Provider value={value}>
      {children}
    </PublishingFlowContext.Provider>
  );
}

export function publishingTaskUrl(path: string, taskId?: string) {
  const url = new URL(projectWorkspaceUrl(path), window.location.origin);
  if (taskId) url.searchParams.set("workbenchTask", taskId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An old request may finish after its page is gone. It must not update or
 * navigate whichever task the user opened while waiting. */
export function usePublishingOperationScope(resourceKey = "") {
  const flow = usePublishingFlow();
  const key = `${projectWorkspaceUrl("/")}:${flow?.taskId ?? "standalone"}:${resourceKey}`;
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => {
    const requested = current.current;
    return () => mounted.current && current.current === requested;
  }, []);
}

/** Summary changes follow business responses; they never initiate a paid action. */
export function usePublishingSummary(summary: PublishingFlowSummary) {
  const flow = usePublishingFlow();
  const key = JSON.stringify(summary);
  const setSummary = flow?.setSummary;
  useEffect(() => {
    setSummary?.(JSON.parse(key) as PublishingFlowSummary);
    return () => setSummary?.(null);
  }, [key, setSummary]);
}

/** Stable for one task and frozen selection, including refresh and lost replies. */
export async function publishingDraftRequestKey(
  taskId: string,
  versionId: string,
  mediaIds: string[],
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([taskId, versionId, [...mediaIds].sort()]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `publisher:draft:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
