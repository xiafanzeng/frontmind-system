import { useEffect, useRef, useState } from "react";
import { Menu, ArrowUp, Paperclip } from "lucide-react";
import {
  GeneralAgentWelcome,
  GENERAL_TASK_SUGGESTIONS,
} from "@/components/GeneralAgentWelcome";
import { PreviewBuildFlow } from "@/components/EmbeddedKnowledgeBasePanel";
import { previewKnowledgeProgress } from "@/lib/preview-data";
import ContentInsightsWorkspace from "@/dashboard/content-insights/ContentInsightsWorkspace";
import KnowledgeFrontendSettings from "@/dashboard/knowledge-frontend/KnowledgeFrontendSettings";
import {
  BusinessWorkspaceProvider,
  BusinessWorkspaceInspector,
  type BusinessWorkspaceSummary,
} from "@/dashboard/BusinessWorkspaceContext";
import {
  OperatorSidebar,
  type EnterpriseProjectView,
} from "@/dashboard/OperatorNavigation";
import { OperatorThemeProvider } from "@/components/ui/operator-theme";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import { WorkbenchTaskToolbar } from "@/dashboard/WorkbenchTaskToolbar";
import { businessPanelPolicy } from "@/dashboard/workbench-panel-policy";
import {
  WorkflowCompleted,
  WorkflowFeedback,
} from "@/dashboard/workflow/Workflow";
import { MessageBubble } from "@/components/ChatArea";
import {
  ConversationProvider,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import {
  createWorkbenchModules,
  workbenchModuleForView,
  WorkbenchModuleContext,
} from "@/dashboard/agent-workbench";
import type { OperatorView } from "@/dashboard/operator-navigation";
import type { useWorkbenchTask } from "@/hooks/useWorkbenchTask";
import {
  initialWorkbenchTaskState,
  type WorkbenchTaskState,
} from "@shared/workbench-task";
import {
  PreviewBusinessFlow,
  previewEmptyFlow,
  type PreviewAgent,
  type PreviewFlow,
} from "./operator-workspace-preview-flows";
import "@/dashboard/dashboard-styles.css";
import "./operator-workspace-preview.css";

export const PREVIEW_STORAGE_KEY = "frontmind.operator-workspace.preview.v4";
type PreviewTask = {
  flow: PreviewFlow;
  draft: string;
  attachments: string[];
  messages: LocalMessage[];
  state?: WorkbenchTaskState;
};
type PreviewData = {
  activeProject: string;
  agent: PreviewAgent;
  projects: EnterpriseProjectView[];
  selections: Record<string, number>;
  counts: Record<string, number>;
  tasks: Record<string, PreviewTask>;
};
const emptyTask = (): PreviewTask => ({
  flow: previewEmptyFlow(),
  draft: "",
  attachments: [],
  messages: [],
});
function readPreview(): PreviewData {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(PREVIEW_STORAGE_KEY) || "null",
    );
    if (
      saved &&
      Array.isArray(saved.projects) &&
      saved.tasks &&
      saved.selections &&
      saved.counts &&
      saved.activeProject &&
      saved.agent
    )
      return saved;
  } catch {
    /* A blocked or stale preview store starts a fresh local example. */
  }
  return {
    activeProject: "design-project",
    agent: "knowledge",
    projects: [
      { id: "design-project", name: "星辰科技", ownerUserId: 0, revision: 1 },
      { id: "design-project-2", name: "未来教育", ownerUserId: 0, revision: 1 },
    ],
    selections: {},
    counts: {},
    tasks: {},
  };
}

/** Local interaction fixtures share the real shell, KB, site, and insights components.
 * They never call business mutations. Real-route acceptance is performed separately. */
export default function OperatorWorkspacePreview() {
  return (
    <ConversationProvider>
      <OperatorWorkspacePreviewContent />
    </ConversationProvider>
  );
}
function OperatorWorkspacePreviewContent() {
  const [data, setData] = useState(readPreview);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [knowledge, setKnowledge] = useState(() =>
    structuredClone(previewKnowledgeProgress),
  );
  const [summary, setSummary] = useState<BusinessWorkspaceSummary | null>(null);
  const [panel, setPanel] = useState<"tasks" | "outputs">(
    data.agent === "general" ? "tasks" : "outputs",
  );
  const [running, setRunning] = useState(false);
  const projectedStates = useRef(new Map<string, WorkbenchTaskState>());
  const { activeProject: activeId, agent } = data;
  const general = agent === "general";
  const view: OperatorView = general ? "knowledge" : agent;
  const scope = `${activeId}:${agent}`;
  const taskNumber = data.selections[scope] ?? 1;
  const taskKey = `${scope}:${taskNumber}`;
  const task = data.tasks[taskKey] ?? emptyTask();
  const flow = task.flow;
  const activeProject = data.projects.find(
    (project) => project.id === activeId,
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* Preview works without browser storage. */
    }
  }, [data]);
  const patchTask = (patch: Partial<PreviewTask>, key = taskKey) =>
    setData((current) => ({
      ...current,
      tasks: {
        ...current.tasks,
        [key]: { ...(current.tasks[key] ?? emptyTask()), ...patch },
      },
    }));
  const updateFlow = (patch: Partial<PreviewFlow>) =>
    patchTask({ flow: { ...flow, ...patch } });
  const openAgent = (next: PreviewAgent) => {
    setData((current) => ({ ...current, agent: next }));
    setMobileOpen(false);
    setSummary(null);
    setPanel(next === "general" ? "tasks" : "outputs");
    setRunning(false);
  };
  const openView = (next: OperatorView) =>
    openAgent(next === "knowledge-display" ? "knowledge" : next);
  const modules = createWorkbenchModules(() => null, openView, view);
  const module = modules.find(
    (item) => item.id === workbenchModuleForView(view).id,
  )!;
  const label = general
    ? "通用智能体"
    : (module.actions.find((action) => action.id === view)?.label ??
      "智能知识库");
  const businessPanel = businessPanelPolicy[agent];
  const dedicatedPanel =
    agent === "enterprise-qa"
      ? {
          history: "会话",
          output: "知识来源",
          newAction: "新会话",
          records: "会话历史",
          noun: "会话",
        }
      : agent === "response-logic"
        ? {
            history: "问题",
            output: "应答版本",
            newAction: "选择问题",
            records: "已有应答问题",
            noun: "问题",
          }
        : agent === "content"
          ? {
              history: "制作任务",
              output: "交付文件",
              newAction: "新建制作",
              records: "制作记录",
              noun: "制作任务",
            }
          : {
              history: "任务",
              output: "文件",
              newAction: "新任务",
              records: "任务历史",
              noun: "任务",
            };
  const selectTask = (id: string) => {
    setData((current) => ({
      ...current,
      selections: { ...current.selections, [scope]: Number(id) },
    }));
    setSummary(null);
  };
  const newTask = () => {
    const next = (data.counts[scope] ?? 1) + 1;
    setData((current) => ({
      ...current,
      counts: { ...current.counts, [scope]: next },
      selections: { ...current.selections, [scope]: next },
    }));
    setSummary(null);
    return `${scope}:${next}`;
  };
  const handoff = (target: PreviewAgent, seed: Partial<PreviewFlow>) => {
    const targetScope = `${activeId}:${target}`;
    const handoffIdentity = `${target}:${JSON.stringify(seed)}`;
    const known = flow.handoffs?.[handoffIdentity];
    const next = known
      ? Number(known.split(":").at(-1))
      : (data.counts[targetScope] ?? 1) + 1;
    const destination = `${targetScope}:${next}`;
    setData((current) => ({
      ...current,
      agent: target,
      counts: {
        ...current.counts,
        [targetScope]: Math.max(current.counts[targetScope] ?? 1, next),
      },
      selections: { ...current.selections, [targetScope]: next },
      tasks: {
        ...current.tasks,
        [taskKey]: {
          ...task,
          flow: {
            ...flow,
            handoffs: { ...flow.handoffs, [handoffIdentity]: destination },
          },
        },
        ...(known
          ? {}
          : {
              [destination]: {
                ...emptyTask(),
                flow: {
                  ...previewEmptyFlow(),
                  ...seed,
                  source: { taskKey, agent },
                },
              },
            }),
      },
    }));
    setSummary(null);
    setPanel("outputs");
  };
  const returnToSource = () => {
    const source = flow.source;
    if (!source) return;
    const number = Number(source.taskKey.split(":").at(-1));
    setData((current) => ({
      ...current,
      agent: source.agent,
      selections: {
        ...current.selections,
        [`${activeId}:${source.agent}`]: number,
      },
    }));
    setSummary(null);
  };
  const nativeChat =
    general ||
    (agent === "enterprise-qa" && flow.step > 0) ||
    (agent === "response-logic" && !!flow.branch) ||
    (agent === "content" && flow.step > 0);
  const send = () => {
    const content = task.draft.trim();
    if (!content) return;
    patchTask({
      draft: "",
      messages: [
        ...task.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          content,
          timestamp: Date.now(),
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "已保留本次预览输入。这里用于检查对话与业务步骤的排版，真实工作区会由当前智能体处理任务。",
          timestamp: Date.now() + 1,
        },
      ],
    });
  };
  const composer = (
    <form
      className="workbench-preview-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="继续对话"
        placeholder={
          general ? "描述你的任务，或添加文件…" : `继续与${label}协作…`
        }
        value={task.draft}
        onChange={(event) => patchTask({ draft: event.target.value })}
      />
      {task.attachments.length > 0 && (
        <p className="workbench-preview-files">
          {task.attachments.join(" · ")}
        </p>
      )}
      <div>
        <label className="workbench-preview-attachment">
          <Paperclip size={17} />
          <span>附件</span>
          <input
            type="file"
            multiple
            aria-label="添加预览附件"
            onChange={(event) =>
              patchTask({
                attachments: Array.from(event.target.files ?? []).map(
                  (file) => file.name,
                ),
              })
            }
          />
        </label>
        <span>本地交互预览</span>
        <button
          type="submit"
          aria-label="发送预览消息"
          disabled={!task.draft.trim()}
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </form>
  );
  const dialogue = (
    <div className="preview-dialogue">
      {task.messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isRunning={running && message.role === "assistant"}
        />
      ))}
    </div>
  );
  const sharedFlow = (
    <PreviewBusinessFlow
      agent={agent}
      flow={flow}
      update={updateFlow}
      handoff={handoff}
      dialogue={dialogue}
      onOpenKnowledge={() => openAgent("knowledge")}
    />
  );
  const adapter: ReturnType<typeof useWorkbenchTask> = {
    scopeKey: scope,
    taskId: taskKey,
    task: {
      id: taskKey,
      title: `任务 ${taskNumber}`,
      messages: task.messages,
      status: "idle",
      createdAt: 1788912000000,
      updatedAt: 1788912000000,
      workbenchAgentId: agent,
    },
    tasks: [],
    state: task.state ?? initialWorkbenchTaskState(agent),
    revision: task.state?.revision ?? 1,
    hydrated: true,
    pending: false,
    error: null,
    ensureTask: async () => taskKey,
    newTask,
    selectTask,
    retry: async () => undefined,
    saveState: async (patch) => {
      const previous =
        projectedStates.current.get(taskKey) ??
        task.state ??
        initialWorkbenchTaskState(agent);
      const state: WorkbenchTaskState = {
        ...previous,
        step: patch.step ?? previous.step,
        resources: patch.resources ?? previous.resources,
        outputRefs: patch.outputRefs ?? previous.outputRefs,
        records: [
          ...previous.records,
          ...(patch.record ? [{ ...patch.record, timestamp: Date.now() }] : []),
          ...(patch.records ?? []).map((record) => ({
            ...record,
            timestamp: Date.now(),
          })),
        ],
        values: { ...previous.values, ...patch.values },
        revision: previous.revision + 1,
        updatedAt: Date.now(),
      };
      projectedStates.current.set(taskKey, state);
      patchTask({ state });
      return state;
    },
    handoff: async () => {
      throw new Error("此预览组件不执行真实业务交接。");
    },
  };
  const business = general ? (
    task.messages.length ? (
      dialogue
    ) : (
      <div className="workbench-preview-welcome">
        <GeneralAgentWelcome />
        {composer}
        <div className="general-task-suggestions" aria-label="快捷任务建议">
          {GENERAL_TASK_SUGGESTIONS.map((item) => (
            <button
              type="button"
              key={item.label}
              onClick={() => patchTask({ draft: item.prompt })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    )
  ) : agent === "website" ? (
    <KnowledgeFrontendSettings
      demo
      ownerId="preview"
      projectId={activeId}
      legacyWorkflow={sharedFlow}
      publishedContent={
        <WorkflowFeedback>
          本地预览没有项目发布数据。真实工作区在这里读取当前项目已发布内容。
        </WorkflowFeedback>
      }
    />
  ) : agent === "content-insights" ? (
    <ContentInsightsWorkspace />
  ) : (
    sharedFlow
  );
  const fallbackSummary: BusinessWorkspaceSummary = {
    items: [
      { label: "当前任务", value: `${label} · 任务 ${taskNumber}` },
      ...(agent === "media" && flow.selected.length
        ? [{ label: "待确认媒体", value: flow.selected.join("、") }]
        : []),
      { label: "数据范围", value: "本地交互样例" },
    ],
    outputs: flow.outputs.map((item) => ({
      ...item,
      onOpen: () => updateFlow({ step: Math.max(1, flow.step) }),
      onRevise: () => updateFlow({ step: 1 }),
    })),
  };
  const taskNavigation = (
    <WorkbenchTaskToolbar
      presentation="panel"
      tasks={Array.from({ length: data.counts[scope] ?? 1 }, (_, index) => ({
        id: String(index + 1),
        title: `任务 ${index + 1}`,
        updatedAt: 1788912000000 + index * 60000,
      })).reverse()}
      currentId={String(taskNumber)}
      onNew={newTask}
      onSelect={selectTask}
      showNew={!businessPanel || Boolean(businessPanel.newAction)}
      labels={
        businessPanel
          ? {
              newAction: businessPanel.newAction,
              history: businessPanel.history,
              noun: "记录",
            }
          : {
              newAction: dedicatedPanel.newAction,
              history: dedicatedPanel.records,
              noun: dedicatedPanel.noun,
            }
      }
    />
  );
  return (
    <OperatorThemeProvider enabled>
      <div
        className={`user-brand-dashboard operator-mode ${collapsed ? "operator-collapsed" : ""}`}
      >
        <div
          className={`app-shell knowledge-build-app-shell ${mobileOpen ? "nav-open" : ""}`}
        >
          <button
            className="mobile-menu-btn"
            aria-label="打开项目导航"
            onClick={() => setMobileOpen((value) => !value)}
          >
            <Menu size={20} />
          </button>
          {mobileOpen && (
            <div
              className="mobile-nav-overlay"
              onClick={() => setMobileOpen(false)}
            />
          )}
          <OperatorSidebar
            projects={data.projects}
            activeProject={activeProject}
            activeEntry="project"
            view={view}
            onSelectView={openView}
            collapsed={collapsed && !mobileOpen}
            accountName="设计验收账号"
            onCollapse={() => setCollapsed((value) => !value)}
            mobileOpen={mobileOpen}
            onCloseMobile={() => setMobileOpen(false)}
            onNavigate={() => undefined}
            onSelectProject={(id) => {
              setData((current) => ({ ...current, activeProject: id }));
              setKnowledge(structuredClone(previewKnowledgeProgress));
              setSummary(null);
            }}
            onCreateProject={async (name) => {
              const id = crypto.randomUUID();
              setData((current) => ({
                ...current,
                activeProject: id,
                projects: [
                  ...current.projects,
                  { id, name, ownerUserId: 0, revision: 1 },
                ],
              }));
            }}
            onRenameProject={async (name, target) =>
              setData((current) => ({
                ...current,
                projects: current.projects.map((item) =>
                  item.id === target.id
                    ? { ...item, name, revision: item.revision + 1 }
                    : item,
                ),
              }))
            }
            onDeleteProject={async (target) =>
              setData((current) => ({
                ...current,
                projects: current.projects.filter(
                  (item) => item.id !== target.id,
                ),
                activeProject:
                  current.activeProject === target.id
                    ? (current.projects.find((item) => item.id !== target.id)
                        ?.id ?? "")
                    : current.activeProject,
              }))
            }
          />
          <main className="dashboard-main workbench-main">
            <WorkbenchModuleContext.Provider value={general ? null : module}>
              {agent === "knowledge" ? (
                <PreviewBuildFlow
                  key={activeId}
                  progress={knowledge}
                  onProgressChange={setKnowledge}
                  mode="workspace"
                  workbench
                  projectId={activeId}
                />
              ) : (
                <AgentWorkbenchShell
                  projectId={activeId}
                  moduleId={agent}
                  title={label}
                  taskTitle={`任务 ${taskNumber}`}
                  taskKey={taskKey}
                  layout="workflow"
                  resultTitle={
                    agent === "keywords"
                      ? "项目词库"
                      : (businessPanel?.title ??
                        `${dedicatedPanel.history}与${dedicatedPanel.output}`)
                  }
                  main={
                    <BusinessWorkspaceProvider
                      value={{
                        isWorkbench: true,
                        agentId: agent,
                        taskId: taskKey,
                        task: adapter,
                        setSummary,
                      }}
                    >
                      <div className="workbench-preview-main" key={taskKey}>
                        {flow.source && (
                          <WorkflowCompleted
                            id="preview-source"
                            summary="此任务由另一个 Agent 交接而来"
                          >
                            <button
                              type="button"
                              className="workflow-text-action"
                              onClick={returnToSource}
                            >
                              返回来源任务
                            </button>
                          </WorkflowCompleted>
                        )}
                        {business}
                      </div>
                    </BusinessWorkspaceProvider>
                  }
                  auxiliary={
                    agent === "keywords" ? (
                      <BusinessWorkspaceInspector
                        summary={{
                          ...(summary ?? fallbackSummary),
                          title: "项目词库",
                          scope: "project",
                          canViewProject: false,
                        }}
                      />
                    ) : businessPanel ? (
                      <div className="workbench-business-panel">
                        <BusinessWorkspaceInspector
                          summary={{
                            ...(summary ?? fallbackSummary),
                            title: businessPanel.title,
                          }}
                        />
                        <details
                          className="workbench-business-records"
                          key={scope}
                        >
                          <summary>{businessPanel.history}</summary>
                          {taskNavigation}
                        </details>
                        <p className="preview-local-note">
                          设计预览 · 数据与操作仅保存在当前浏览器。
                        </p>
                      </div>
                    ) : (
                      <div className="workbench-task-panel">
                        <div
                          className="workbench-panel-tabs"
                          role="tablist"
                          aria-label={`${dedicatedPanel.history}与${dedicatedPanel.output}`}
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={panel === "tasks"}
                            onClick={() => setPanel("tasks")}
                          >
                            {dedicatedPanel.history}
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={panel === "outputs"}
                            onClick={() => setPanel("outputs")}
                          >
                            {dedicatedPanel.output}
                          </button>
                        </div>
                        {panel === "tasks" ? (
                          <>
                            {taskNavigation}
                            {nativeChat && (
                              <button
                                type="button"
                                className="workflow-text-action"
                                onClick={() => setRunning((value) => !value)}
                              >
                                {running ? "结束长任务演示" : "演示长任务"}
                              </button>
                            )}
                          </>
                        ) : (
                          <BusinessWorkspaceInspector
                            summary={summary ?? fallbackSummary}
                          />
                        )}
                        <p className="preview-local-note">
                          设计预览 · 数据与操作仅保存在当前浏览器。
                        </p>
                      </div>
                    )
                  }
                  composer={
                    nativeChat && !(general && !task.messages.length)
                      ? composer
                      : undefined
                  }
                />
              )}
            </WorkbenchModuleContext.Provider>
          </main>
        </div>
      </div>
    </OperatorThemeProvider>
  );
}
