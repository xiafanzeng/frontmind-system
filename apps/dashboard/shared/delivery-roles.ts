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
  content_distribution_engineer: "AI 内容制作工程师",
};

export const DELIVERY_ROLE_EXTERNAL_LINKS: Partial<
  Record<DeliveryRoleType, "issue_monitor" | "channel_distribution">
> = {
  monitoring_optimization_engineer: "issue_monitor",
  content_distribution_engineer: "channel_distribution",
};
