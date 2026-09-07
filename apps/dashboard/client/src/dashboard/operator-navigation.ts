export type OperatorView = "knowledge" | "knowledge-display" | "keywords" | "questions" | "response-logic" | "monitoring" | "reports" | "content" | "publishing" | "articles" | "media" | "enterprise-qa" | "website" | "content-insights";
export const OPERATOR_MODULES = [
  { id: "brand", label: "品牌建设", color: "#16794f", views: [{ id: "knowledge", label: "智能知识库" }, { id: "keywords", label: "品牌全域词库" }] },
  { id: "intent", label: "意图优化", color: "#7545a0", views: [{ id: "questions", label: "优化问题" }, { id: "response-logic", label: "应答逻辑" }] },
  { id: "progress", label: "进度监控", color: "#2867a5", views: [{ id: "monitoring", label: "问题监控" }, { id: "reports", label: "进度报告" }] },
  { id: "content", label: "内容制作", color: "#a97712", views: [{ id: "content", label: "内容工作台" }] },
  { id: "publishing", label: "媒体发布", color: "#b33467", views: [{ id: "publishing", label: "发布工作台" }, { id: "articles", label: "稿件" }, { id: "media", label: "媒体库" }] },
  { id: "extensions", label: "扩展应用", color: "#60758d", views: [{ id: "enterprise-qa", label: "企业问答" }, { id: "website", label: "网站管理" }, { id: "content-insights", label: "内容分析与 AI 部件" }] },
] as const;

export function operatorViewPath(view: string): string {
  return ({ monitoring: "/monitoring-system", content: "/content-production", publishing: "/publishing", articles: "/publishing/articles", media: "/publishing/media", "enterprise-qa": "/enterprise-qa" } as Record<string, string>)[view] || `/?view=${encodeURIComponent(view)}`;
}

export function operatorViewFromRoute(route: { section: string; sub?: string | null }): OperatorView {
  if (route.section === "knowledge-agent") return route.sub === "display" ? "knowledge-display" : "knowledge";
  if (route.section === "brand") return "keywords";
  if (route.section === "intent") return "questions";
  if (route.section === "response-logic") return "response-logic";
  if (route.section === "historical-results") return "questions";
  if (route.section === "progress") return route.sub === "monitor" ? "monitoring" : "reports";
  if (route.section === "monitoring-module") return "monitoring";
  if (route.section === "content-production") return "content";
  if (route.section === "publishing-module") return route.sub?.includes("/articles") ? "articles" : route.sub?.includes("/media") ? "media" : "publishing";
  if (route.section === "enterprise-qa") return "enterprise-qa";
  if (route.section === "semantic") return route.sub === "content-insights" ? "content-insights" : "website";
  return "knowledge";
}

export function operatorRouteForView(view: string | null, questionId: string | null = null) {
  if (view === "historical-results") return { section: "historical-results", sub: questionId || "" };
  return ({
    knowledge: { section: "knowledge-agent", sub: "build" },
    "knowledge-display": { section: "knowledge-agent", sub: "display" },
    keywords: { section: "brand", sub: "global-keywords" },
    questions: { section: "intent", sub: "question-optimization" },
    "response-logic": { section: "response-logic", sub: "agent" },
    reports: { section: "progress", sub: "optimization" },
    website: { section: "semantic", sub: "website-management" },
    "content-insights": { section: "semantic", sub: "content-insights" },
  } as Record<string, { section: string; sub: string }>)[view || "knowledge"] || { section: "knowledge-agent", sub: "build" };
}
