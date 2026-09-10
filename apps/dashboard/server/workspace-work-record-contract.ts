/** A small allowlist of actual completed business events. Adding an event here
 * never turns a task's accepted/submitted status into a completed result. */
export const WORK_RECORD_EVENTS = {
  "workspace.monitoring.template_imported": {
    module: "monitoring",
    title: "问题监控数据已更新",
    summary: "监控结果已同步到当前工作区",
    status: "updated",
  },
  "workspace.monitoring_batch.replaced": {
    module: "monitoring",
    title: "监控批次已更新",
    summary: "可查看当前监控回答与引用",
    status: "updated",
  },
  "workspace.questions.template_imported": {
    module: "questions",
    title: "优化问题已更新",
    summary: "问题内容已同步到当前工作区",
    status: "updated",
  },
  "workspace.question.updated": {
    module: "questions",
    title: "优化问题已更新",
    summary: "可查看最新问题内容",
    status: "updated",
  },
  "workspace.question.selection_confirmed": {
    module: "questions",
    title: "问题选择已确认",
    summary: "所选问题已进入当前工作区",
    status: "completed",
  },
  "workspace.response_logic.imported": {
    module: "response-logic",
    title: "应答逻辑已更新",
    summary: "可查看最新应答逻辑",
    status: "updated",
  },
  "workspace.knowledge.published": {
    module: "knowledge",
    title: "品牌资料包已更新",
    summary: "可查看当前知识库内容",
    status: "completed",
  },
  "workspace.dashboard.module_imported": {
    module: null,
    title: "业务内容已更新",
    summary: "最新内容已同步到当前工作区",
    status: "updated",
  },
} as const;
export const WORK_RECORD_MODULES = [
  "monitoring",
  "reports",
  "questions",
  "response-logic",
  "knowledge",
  "keywords",
  "content",
  "publishing",
  "articles",
  "media",
  "website",
  "enterprise-qa",
  "content-insights",
] as const;
const IMPORT_MODULE_MAP: Record<string, string> = {
  keywords: "keywords",
  "optimization-report": "reports",
  "content-assets": "content",
};
export function workRecordModule(
  action: string,
  metadata: Record<string, unknown>,
) {
  const event = WORK_RECORD_EVENTS[action as keyof typeof WORK_RECORD_EVENTS];
  if (!event) return null;
  return event.module || IMPORT_MODULE_MAP[String(metadata.module)] || null;
}
export function workRecordResourceRef(
  module: string,
  enterpriseProjectId: string,
  supplied?: unknown,
) {
  const query = new URLSearchParams({ enterpriseProjectId });
  if (module === "monitoring") {
    query.set("monitoringData", "1");
    if (typeof supplied === "string") {
      try {
        const candidate = new URL(supplied, "https://frontmind.invalid");
        if (
          candidate.origin === "https://frontmind.invalid" &&
          candidate.pathname === "/monitoring-system" &&
          candidate.searchParams.get("enterpriseProjectId") ===
            enterpriseProjectId
        ) {
          const key = candidate.searchParams.get("monitoringBatchKey");
          const revision = candidate.searchParams.get(
            "monitoringBatchRevision",
          );
          if (key && key.length <= 191) query.set("monitoringBatchKey", key);
          if (revision && /^\d+$/.test(revision))
            query.set("monitoringBatchRevision", revision);
        }
      } catch {
        /* Invalid refs are replaced with the permitted module landing. */
      }
    }
    return `/monitoring-system?${query}`;
  }
  if (module === "content") return `/content-production?${query}`;
  if (module === "publishing") return `/publishing?${query}`;
  if (module === "enterprise-qa") return `/enterprise-qa?${query}`;
  query.set("view", module);
  return `/?${query}`;
}
