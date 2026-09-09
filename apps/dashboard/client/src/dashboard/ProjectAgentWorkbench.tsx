import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileText } from "lucide-react";
import { operatorViewPath } from "./operator-navigation";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import {
  ConversationAgentProvider,
  ConversationContextProvider,
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import { useWorkbenchTask } from "@/hooks/useWorkbenchTask";
import type { WorkbenchAgentId } from "@shared/workbench-task";
import { useWorkbenchModule, workbenchStatus } from "./agent-workbench";
import {
  BusinessWorkspaceProvider,
  BusinessWorkspaceInspector,
  type BusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import { WorkbenchTaskToolbar } from "./WorkbenchTaskToolbar";
const Home = lazy(() => import("@/pages/Home"));
function taskUrl(projectId: string, agentId: string, conversationId: string) {
  const path = operatorViewPath(agentId);
  return projectWorkspaceUrl(
    `${path}${path.includes("?") ? "&" : "?"}workbenchTask=${encodeURIComponent(conversationId)}`,
    projectId,
  );
}
function ScopedWorkbench({
  projectId,
  agentId,
  purpose,
  children,
  originalWorkspace,
  taskNavigationTarget,
  onTaskNavigate,
}: {
  projectId: string;
  agentId: WorkbenchAgentId;
  purpose: "general" | "enterprise_qa";
  children?: ReactNode;
  originalWorkspace: ReturnType<typeof useConversation>;
  taskNavigationTarget?: HTMLElement | null;
  onTaskNavigate?: () => void;
}) {
  const module = useWorkbenchModule();
  const workspace = useConversation();
  const task = useWorkbenchTask(agentId);
  const [summary, setSummary] = useState<BusinessWorkspaceSummary | null>(null);
  const creating = useRef(false);
  const [panel, setPanel] = useState<"tasks" | "outputs">(
    agentId === "general" ? "tasks" : "outputs",
  );
  const outputFiles =
    workspace.activeConversation?.messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.outputFiles ?? []).map((file, index) => ({
            ...file,
            key: `${message.id}:${index}`,
          }))
        : [],
    ) ?? [];
  const native = agentId === "general" || purpose === "enterprise_qa";
  const label =
    purpose === "enterprise_qa"
      ? "企业问答"
      : (module?.actions.find((item) => item.id === agentId)?.label ??
        "通用智能体");
  useEffect(() => {
    if (
      workspace.hydrated &&
      !workspace.activeConversation &&
      !creating.current
    ) {
      creating.current = true;
      workspace.createConversation({
        title: purpose === "enterprise_qa" ? "企业问答" : "新任务",
        reuseEmpty: false,
        workbenchAgentId: agentId,
      });
    }
    if (workspace.activeConversation) creating.current = false;
  }, [
    native,
    workspace.hydrated,
    workspace.activeConversation,
    workspace.createConversation,
    agentId,
    purpose,
  ]);
  useLayoutEffect(() => {
    setSummary(null);
  }, [agentId, task.taskId]);
  const value = useMemo(
    () => ({
      isWorkbench: true,
      taskId: task.taskId,
      agentId,
      task,
      setSummary,
    }),
    [task, agentId],
  );
  const source = task.state?.source;
  const legacyTasks =
    agentId === "general"
      ? task.tasks.filter((item) => !item.workbenchAgentId)
      : [];
  const historyTasks =
    agentId === "general"
      ? task.tasks.filter((item) => Boolean(item.workbenchAgentId))
      : task.tasks;
  const body = native ? (
    <Suspense fallback={<div role="status">正在恢复任务…</div>}>
      <Home
        embedded
        hideSidebar
        operatorWorkspace
        hidePortalNavigation
        showKnowledgeBaseStarter={false}
        showAccountMenu={false}
        showSettings={false}
        purpose={purpose === "enterprise_qa" ? "enterprise_qa" : undefined}
        standardWelcomeVariant={
          purpose === "enterprise_qa" ? "enterprise_qa" : "simple"
        }
      />
    </Suspense>
  ) : (
    <BusinessWorkspaceProvider value={value}>
      <div
        className="workbench-flow"
        key={`${projectId}:${agentId}:${task.taskId ?? "new"}`}
      >
        {task.error && (
          <div className="workbench-flow-error" role="alert">
            <span>{task.error}</span>
            <button type="button" onClick={() => void task.retry()}>
              重新读取任务
            </button>
          </div>
        )}
        {source && (
          <p className="workbench-source">
            接续自{" "}
            <a href={taskUrl(projectId, source.agentId, source.conversationId)}>
              来源任务
            </a>
          </p>
        )}
        {Boolean(task.state?.records.length) && (
          <ol
            className="workbench-operation-records"
            aria-label="已完成的业务步骤"
          >
            {task.state?.records.map((record) => (
              <li key={record.id} data-reading-anchor={record.id}>
                {record.status === "completed"
                  ? "✓ "
                  : record.status === "failed"
                    ? "待重试 · "
                    : "进行中 · "}
                {record.label}
                {record.detail && <span> · {record.detail}</span>}
                {record.targetTask && (
                  <a
                    href={taskUrl(
                      projectId,
                      record.targetTask.agentId,
                      record.targetTask.conversationId,
                    )}
                  >
                    {" "}
                    打开接续任务
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
        <ConversationContextProvider value={originalWorkspace}>
          {children}
        </ConversationContextProvider>
      </div>
    </BusinessWorkspaceProvider>
  );
  const taskNavigation = (
    <WorkbenchTaskToolbar
      tasks={historyTasks}
      legacyTasks={legacyTasks}
      currentId={task.taskId}
      disabled={!task.hydrated}
      loading={workspace.loading}
      error={workspace.syncError}
      onRetry={() => void task.retry().catch(() => undefined)}
      presentation="panel"
      showNew
      onNew={() => {
        task.newTask("新任务");
      }}
      onSelect={task.selectTask}
      onDelete={workspace.deleteConversation}
      onNavigate={agentId === "general" ? onTaskNavigate : undefined}
    />
  );
  const panelContents = (
    <div className="workbench-task-panel">
      <div
        className="workbench-panel-tabs"
        role="tablist"
        aria-label="任务与成果"
      >
        <button
          type="button"
          role="tab"
          id={`tasks-tab-${agentId}`}
          aria-controls={`tasks-panel-${agentId}`}
          aria-selected={panel === "tasks"}
          onClick={() => setPanel("tasks")}
        >
          任务
        </button>
        <button
          type="button"
          role="tab"
          id={`outputs-tab-${agentId}`}
          aria-controls={`outputs-panel-${agentId}`}
          aria-selected={panel === "outputs"}
          onClick={() => setPanel("outputs")}
        >
          成果
        </button>
      </div>
      <div
        role="tabpanel"
        id={`${panel}-panel-${agentId}`}
        aria-labelledby={`${panel}-tab-${agentId}`}
      >
        {panel === "tasks" ? (
          taskNavigation
        ) : agentId === "general" ? (
          outputFiles.length ? (
            <ul className="workbench-output-list">
              {outputFiles.map((file) => (
                <li key={file.key}>
                  <button
                    type="button"
                    onClick={() => {
                      const card = Array.from(
                        document.querySelectorAll<HTMLElement>(
                          "[data-workbench-output-key]",
                        ),
                      ).find(
                        (node) => node.dataset.workbenchOutputKey === file.key,
                      );
                      if (card) {
                        card.scrollIntoView({
                          block: "center",
                          behavior: "smooth",
                        });
                        (
                          card.querySelector<HTMLElement>(
                            "[data-output-download]",
                          ) ?? card
                        ).click();
                      }
                    }}
                  >
                    <FileText size={18} />
                    <span>
                      {file.fileName}
                      <small>在对话中打开</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="workbench-panel-empty">
              任务生成的文件会显示在这里，也会保留在对应回复下。
            </p>
          )
        ) : purpose === "enterprise_qa" ? (
          children
        ) : (
          <BusinessWorkspaceInspector
            summary={summary ?? { title: "当前任务成果", items: [] }}
          />
        )}
      </div>
    </div>
  );
  return (
    <>
      <AgentWorkbenchShell
        projectId={projectId}
        moduleId={agentId}
        title={label}
        taskTitle={task.task?.title ?? "新任务"}
        taskKey={task.taskId ?? "new"}
        layout="workflow"
        main={body}
        scrollMain={!native}
        status={
          task.pending
            ? "正在保存"
            : native
              ? workbenchStatus(workspace.activeConversation?.status)
              : undefined
        }
        auxiliary={panelContents}
      />
    </>
  );
}
export default function ProjectAgentWorkbench({
  projectId,
  purpose = "general",
  children,
  taskNavigationTarget,
  onTaskNavigate,
}: {
  projectId: string;
  purpose?: "general" | "enterprise_qa";
  children?: ReactNode;
  taskNavigationTarget?: HTMLElement | null;
  onTaskNavigate?: () => void;
}) {
  const originalWorkspace = useConversation();
  const module = useWorkbenchModule();
  const agentId = (
    purpose === "enterprise_qa"
      ? "enterprise-qa"
      : (module?.actions.find((item) => item.active)?.id ?? "general")
  ) as WorkbenchAgentId;
  return (
    <ConversationPurposeProvider purpose={purpose}>
      <ConversationAgentProvider agentId={agentId}>
        <ScopedWorkbench
          projectId={projectId}
          agentId={agentId}
          purpose={purpose}
          originalWorkspace={originalWorkspace}
          taskNavigationTarget={taskNavigationTarget}
          onTaskNavigate={onTaskNavigate}
        >
          {children}
        </ScopedWorkbench>
      </ConversationAgentProvider>
    </ConversationPurposeProvider>
  );
}
