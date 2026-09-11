import type { WorkbenchAgentId } from "@shared/workbench-task";

/**
 * Presentation policy for the operator workbench: resource views render as a
 * full-width browsing workspace (no auxiliary task panel, business sub
 * navigation lives in the shell top bar), while collaboration views keep the
 * guided task layout. This is deliberately independent from the workbench task
 * machinery: `isWorkbench` stays true for both presentations so flow state,
 * task persistence and handoffs keep working.
 */
export type WorkbenchPresentation = "resource" | "collaborate";

const RESOURCE_VIEWS: ReadonlySet<string> = new Set([
  "keywords",
  "questions",
  "monitoring",
  "reports",
  "publishing",
  "articles",
  "media",
  "website",
  "content-insights",
]);

/** Fixed auxiliary widths for collaboration views (V2.3 canvas spec). */
export const WORKBENCH_AUX_WIDTHS: Partial<Record<string, number>> = {
  knowledge: 348,
  "response-logic": 400,
  "content-production": 380,
  "enterprise-qa": 340,
};

export function workbenchPresentationForAgent(
  agentId: WorkbenchAgentId | string,
): WorkbenchPresentation {
  return RESOURCE_VIEWS.has(agentId) ? "resource" : "collaborate";
}
