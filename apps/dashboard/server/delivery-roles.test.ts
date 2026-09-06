import { describe, expect, it } from "vitest";
import {
  DELIVERY_ROLE_LABELS,
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
});
