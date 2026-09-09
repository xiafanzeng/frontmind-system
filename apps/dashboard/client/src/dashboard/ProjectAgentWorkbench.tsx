import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
}: {
  projectId: string;
  agentId: WorkbenchAgentId;
  purpose: "general" | "enterprise_qa";
  children?: ReactNode;
  originalWorkspace: ReturnType<typeof useConversation>;
}) {
  const module = useWorkbenchModule();
  const workspace = useConversation();
  const task = useWorkbenchTask(agentId);
  const [summary, setSummary] = useState<BusinessWorkspaceSummary | null>(null);
  const creating = useRef(false);
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
  useEffect(() => {
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
  return (
    <AgentWorkbenchShell
      projectId={projectId}
      moduleId={agentId}
      title={label}
      taskTitle={task.task?.title ?? "新任务"}
      taskKey={task.taskId ?? "new"}
      layout={agentId === "general" ? "single" : "workflow"}
      main={body}
      scrollMain={!native}
      status={
        task.pending
          ? "正在保存"
          : native
            ? workbenchStatus(workspace.activeConversation?.status)
            : undefined
      }
      toolbar={
        <WorkbenchTaskToolbar
          tasks={historyTasks}
          legacyTasks={legacyTasks}
          currentId={task.taskId}
          disabled={!task.hydrated}
          onNew={() => {
            task.newTask("新任务");
          }}
          onSelect={task.selectTask}
          onDelete={workspace.deleteConversation}
        />
      }
      auxiliary={
        purpose === "enterprise_qa" ? (
          children
        ) : (
          <BusinessWorkspaceInspector
            summary={
              summary ?? {
                title: "当前任务",
                items: [
                  { label: "任务", value: task.task?.title ?? "尚未开始" },
                ],
              }
            }
          />
        )
      }
    />
  );
}
export default function ProjectAgentWorkbench({
  projectId,
  purpose = "general",
  children,
}: {
  projectId: string;
  purpose?: "general" | "enterprise_qa";
  children?: ReactNode;
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
        >
          {children}
        </ScopedWorkbench>
      </ConversationAgentProvider>
    </ConversationPurposeProvider>
  );
}
