import type { WorkbenchAgentId } from "@shared/workbench-task";

/** Display policy only; business resources and conversation bindings keep their original owners. */
export const businessPanelPolicy: Partial<
  Record<
    WorkbenchAgentId,
    { title: string; history: string; newAction?: string }
  >
> = {
  questions: { title: "优化问题", history: "选题工作记录" },
  articles: { title: "稿件与版本", history: "编辑工作记录" },
  media: {
    title: "投放选择",
    history: "选媒工作记录",
    newAction: "开始新的选媒",
  },
  publishing: { title: "发布进度", history: "投放工作记录" },
  monitoring: {
    title: "监控项目与运行",
    history: "监控工作记录",
  },
  reports: {
    title: "分析范围与报告",
    history: "分析记录",
  },
  website: { title: "站点与版本", history: "建站与配置记录" },
  "content-insights": { title: "分析与部件配置", history: "预览配置记录" },
};
