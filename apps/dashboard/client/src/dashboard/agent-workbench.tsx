import { createContext, useContext, type ReactNode } from "react";
import { OPERATOR_MODULES, type OperatorView } from "./operator-navigation";

export type WorkbenchModuleId = (typeof OPERATOR_MODULES)[number]["id"];
export type WorkbenchAction = {
  id: string;
  label: string;
  kind: "open-panel" | "open-editor" | "start-task" | "navigate";
  run: () => void;
  disabled?: boolean;
  active?: boolean;
  color?: string;
  description?: string;
};
export type WorkbenchModuleDescriptor = {
  id: WorkbenchModuleId;
  label: string;
  primaryView: OperatorView;
  resultTitle: string;
  renderResult: () => ReactNode;
  actions: WorkbenchAction[];
};
const resultTitles: Record<WorkbenchModuleId, string> = {
  brand: "品牌知识与词库",
  intent: "优化问题与应答",
  progress: "监控与报告",
  content: "内容与稿件",
  publishing: "发布与媒体",
  extensions: "项目工具",
};
const subagents: Record<
  Exclude<OperatorView, "knowledge-display">,
  { color: string; description: string }
> = {
  knowledge: { color: "#16794f", description: "构建可信品牌知识" },
  keywords: { color: "#2867a5", description: "梳理品牌搜索词" },
  questions: { color: "#7545a0", description: "发现客户真实意图" },
  "response-logic": { color: "#2867a5", description: "设计有依据的回答" },
  monitoring: { color: "#2867a5", description: "跟踪品牌表现" },
  reports: { color: "#16794f", description: "解读变化与进展" },
  content: { color: "#8a6100", description: "从选题到稿件交付" },
  publishing: { color: "#b33467", description: "编排发布与跟进任务" },
  articles: { color: "#7545a0", description: "整理与编辑稿件" },
  media: { color: "#2867a5", description: "筛选适合的媒体" },
  "enterprise-qa": { color: "#16794f", description: "基于企业知识问答" },
  website: { color: "#2867a5", description: "建设与维护官网" },
  "content-insights": { color: "#7545a0", description: "分析内容与问答表现" },
};
export function workbenchModuleForView(view: OperatorView) {
  const canonical = view === "knowledge-display" ? "knowledge" : view;
  return (
    OPERATOR_MODULES.find((module) =>
      module.views.some((item) => item.id === canonical),
    ) ?? OPERATOR_MODULES[0]
  );
}
export function createWorkbenchModules(
  renderResult: (id: WorkbenchModuleId) => ReactNode,
  openView: (view: OperatorView) => void,
  currentView?: OperatorView,
): WorkbenchModuleDescriptor[] {
  const canonical =
    currentView === "knowledge-display" ? "knowledge" : currentView;
  return OPERATOR_MODULES.map((module) => ({
    id: module.id,
    label: module.label,
    primaryView: module.views[0].id,
    resultTitle: resultTitles[module.id],
    renderResult: () => renderResult(module.id),
    actions: module.views.map((view) => ({
      id: view.id,
      label: view.label,
      ...subagents[view.id],
      active: view.id === (canonical ?? module.views[0].id),
      kind: "open-panel",
      run: () => openView(view.id),
    })),
  }));
}
export const WorkbenchModuleContext =
  createContext<WorkbenchModuleDescriptor | null>(null);
export const useWorkbenchModule = () => useContext(WorkbenchModuleContext);
export function workbenchStatus(status?: string) {
  return (
    (
      {
        running: "执行中",
        pending: "正在准备",
        awaiting_input: "等待确认",
        completed: "已完成",
        failed: "执行失败",
        error: "执行失败",
        idle: "就绪",
      } as Record<string, string>
    )[status ?? "idle"] ?? "就绪"
  );
}
