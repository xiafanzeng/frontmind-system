import { z } from "zod";

export const deliveryRoleTypeSchema = z.enum([
  "ai_operations_engineer",
  "monitoring_optimization_engineer",
  "content_distribution_engineer",
]);
export type DeliveryRoleType = z.infer<typeof deliveryRoleTypeSchema>;

export const DELIVERY_ROLE_LABELS: Record<DeliveryRoleType, string> = {
  ai_operations_engineer: "AI 运维工程师",
  monitoring_optimization_engineer: "AI 监控与优化工程师",
  content_distribution_engineer: "AI 内容分发工程师",
};

export const deliveryWorkflowOperationSchema = z.enum([
  "build_exception",
  "knowledge_maintenance",
  "knowledge_reset",
  "question_catalog",
  "initial_monitoring",
  "monitoring_import",
  "monitoring_retest",
  "stage_report",
  "response_logic",
  "content_asset_publish",
  "channel_distribution",
  "domain_application",
  "icp_filing",
  "website_style_samples",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
  "site_check",
]);
export type DeliveryWorkflowOperation = z.infer<
  typeof deliveryWorkflowOperationSchema
>;

const OPERATIONS_BY_ROLE: Record<
  DeliveryRoleType,
  readonly DeliveryWorkflowOperation[]
> = {
  ai_operations_engineer: [
    "build_exception",
    "knowledge_maintenance",
    "knowledge_reset",
    "domain_application",
    "icp_filing",
    "website_style_samples",
    "company_facts",
    "product_case_docs",
    "industry_news",
    "company_news",
    "faq_content",
    "site_check",
  ],
  monitoring_optimization_engineer: [
    "question_catalog",
    "initial_monitoring",
    "monitoring_import",
    "monitoring_retest",
    "stage_report",
  ],
  content_distribution_engineer: [
    "response_logic",
    "content_asset_publish",
    "channel_distribution",
  ],
};

export function deliveryRoleOwnsOperation(
  roleType: DeliveryRoleType,
  operation: DeliveryWorkflowOperation,
) {
  return OPERATIONS_BY_ROLE[roleType].includes(operation);
}

/**
 * Monitoring starts only after the public distribution path is actually
 * ready for observation. Internal asset publication and website page writes
 * still have downstream distribution/site-check work and must not trigger an
 * early retest.
 */
export function deliveryOperationTriggersMonitoringRetest(
  operation: DeliveryWorkflowOperation,
) {
  return operation === "channel_distribution" || operation === "site_check";
}

export const knowledgeResetReasonSchema = z.enum([
  "stuck",
  "upload_error",
  "build_error",
  "enterprise_materials",
  "other",
]);
export type KnowledgeResetReason = z.infer<typeof knowledgeResetReasonSchema>;

export const DELIVERY_ROLE_EXTERNAL_LINKS: Partial<
  Record<DeliveryRoleType, "issue_monitor" | "channel_distribution">
> = {
  monitoring_optimization_engineer: "issue_monitor",
  content_distribution_engineer: "channel_distribution",
};
