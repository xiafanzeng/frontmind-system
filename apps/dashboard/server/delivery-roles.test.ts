import { describe, expect, it } from "vitest";

import {
  DELIVERY_ROLE_LABELS,
  deliveryOperationTriggersMonitoringRetest,
  deliveryRoleOwnsOperation,
  deliveryRoleTypeSchema,
} from "../shared/delivery-roles";

describe("delivery engineer roles", () => {
  it("exposes exactly three active engineer roles", () => {
    expect(deliveryRoleTypeSchema.options).toEqual([
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ]);
    expect(DELIVERY_ROLE_LABELS.ai_operations_engineer).toBe("AI 运维工程师");
    expect(() =>
      deliveryRoleTypeSchema.parse("knowledge_base_engineer"),
    ).toThrow();
    expect(() =>
      deliveryRoleTypeSchema.parse("website_operations_engineer"),
    ).toThrow();
  });

  it("assigns knowledge-base and website operations only to AI operations", () => {
    for (const operation of [
      "build_exception",
      "knowledge_maintenance",
      "knowledge_reset",
      "domain_application",
      "icp_filing",
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
      "site_check",
    ] as const) {
      expect(
        deliveryRoleOwnsOperation("ai_operations_engineer", operation),
      ).toBe(true);
      expect(
        deliveryRoleOwnsOperation(
          "monitoring_optimization_engineer",
          operation,
        ),
      ).toBe(false);
      expect(
        deliveryRoleOwnsOperation("content_distribution_engineer", operation),
      ).toBe(false);
    }
  });

  it("starts monitoring only after public distribution or site verification", () => {
    expect(
      deliveryOperationTriggersMonitoringRetest("content_asset_publish"),
    ).toBe(false);
    expect(deliveryOperationTriggersMonitoringRetest("company_facts")).toBe(
      false,
    );
    expect(
      deliveryOperationTriggersMonitoringRetest("channel_distribution"),
    ).toBe(true);
    expect(deliveryOperationTriggersMonitoringRetest("site_check")).toBe(true);
  });
});
