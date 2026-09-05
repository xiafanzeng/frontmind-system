import { describe, expect, it } from "vitest";

import {
  DELIVERY_OPERATION_ALLOWED_EVIDENCE,
  DELIVERY_OPERATION_SPECS,
  deliveryOperationAllowedEvidence,
  getDeliveryOperationSpec,
} from "@shared/delivery-operation-spec";
import {
  DELIVERY_ROLE_LABELS,
  deliveryWorkflowOperationSchema,
} from "@shared/delivery-roles";
import {
  DELIVERY_OPERATION_LABELS,
  DELIVERY_ROLE_ORDER,
  DELIVERY_ROLE_WORKFLOWS,
  deliveryTicketActionGuidance,
  deliveryTicketDependencyBlockReason,
  deliveryTicketDisplayDescription,
  sortDeliveryProjectTicketsByAction,
  sortDeliveryTicketsByAction,
} from "./delivery-workflow";

describe("delivery workflow presentation model", () => {
  it("keeps the three primary roles in the intended handoff order", () => {
    expect(DELIVERY_ROLE_ORDER).toEqual([
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ]);
    expect(
      DELIVERY_ROLE_ORDER.map(
        (roleType) => DELIVERY_ROLE_WORKFLOWS[roleType].sequence,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      DELIVERY_ROLE_WORKFLOWS.content_distribution_engineer.handoff,
    ).toContain("监控");
    expect(DELIVERY_OPERATION_LABELS.question_maintenance).toBe(
      "问题与应答逻辑维护",
    );
    expect(DELIVERY_OPERATION_LABELS.website_build).toBe("官网构建");
    expect(DELIVERY_ROLE_LABELS.content_distribution_engineer).toBe(
      "AI 内容制作工程师",
    );
  });

  it("keeps every executable operation plus the system record in one exhaustive spec", () => {
    expect(Object.keys(DELIVERY_OPERATION_SPECS)).toEqual([
      ...deliveryWorkflowOperationSchema.options,
      "knowledge_delivery",
    ]);
    expect(Object.keys(DELIVERY_OPERATION_SPECS)).toHaveLength(
      deliveryWorkflowOperationSchema.options.length + 1,
    );
    expect(Object.keys(DELIVERY_OPERATION_ALLOWED_EVIDENCE)).toEqual(
      Object.keys(DELIVERY_OPERATION_SPECS),
    );
    expect(getDeliveryOperationSpec("knowledge_delivery")).toMatchObject({
      ownerRole: "system",
      completion: { mode: "system_readonly" },
    });
    expect(getDeliveryOperationSpec("legacy_operation")).toBeNull();
  });

  it("limits URL and preview policies to their business-specific operations", () => {
    const specs = Object.values(DELIVERY_OPERATION_SPECS);
    expect(
      specs
        .filter((spec) => spec.completion.publicUrl === "required")
        .map((spec) => spec.operation),
    ).toEqual([
      "channel_distribution",
      "website_build",
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
    ]);
    expect(
      specs
        .filter((spec) => spec.completion.previewVerification === "required")
        .map((spec) => spec.operation),
    ).toEqual(["website_build"]);
    expect(
      getDeliveryOperationSpec("content_asset_publish")?.completion,
    ).toEqual({
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    });
    expect(
      getDeliveryOperationSpec("channel_distribution")?.completion.fields,
    ).toEqual(["channel_target_media"]);
    expect(getDeliveryOperationSpec("site_check")?.completion.fields).toEqual([
      "site_check",
      "site_check_source",
    ]);
    expect(deliveryOperationAllowedEvidence("content_asset_publish")).toEqual([
      "message",
      "handoff.contentAssetIds",
    ]);
    expect(deliveryOperationAllowedEvidence("channel_distribution")).toEqual([
      "message",
      "publicUrl",
      "handoff.targetMedia",
    ]);
    expect(deliveryOperationAllowedEvidence("legacy_operation")).toEqual([
      "message",
    ]);
  });

  it("renders the machine-bound question request as Chinese instead of raw JSON", () => {
    expect(
      deliveryTicketDisplayDescription({
        operation: "question_maintenance",
        category: "question_modify",
        topic: "截断问题",
        description: JSON.stringify({
          questionSnapshot: "完整原问题",
          proposedQuestion: "修改后问题",
          reason: "表达不准确",
        }),
      }),
    ).toBe("申请将问题“完整原问题”修改为“修改后问题”。\n申请说明：表达不准确");
  });

  it("prioritizes active execution before unclaimed and waiting work", () => {
    const tickets = sortDeliveryTicketsByAction([
      { id: "waiting", status: "needs_information" as const, updatedAt: 1 },
      { id: "scheduled", status: "scheduled" as const, updatedAt: 2 },
      { id: "submitted", status: "submitted" as const, updatedAt: 3 },
      { id: "active", status: "in_progress" as const, updatedAt: 4 },
    ]);

    expect(tickets.map((ticket) => ticket.id)).toEqual([
      "active",
      "submitted",
      "scheduled",
      "waiting",
    ]);
    expect(deliveryTicketActionGuidance("needs_information")).toMatchObject({
      label: "等待客户补充",
      waiting: true,
    });
  });

  it("blocks initial monitoring until the question catalog is completed", () => {
    const initialMonitoring = {
      operation: "initial_monitoring" as const,
      status: "submitted" as const,
    };
    expect(
      deliveryTicketDependencyBlockReason(initialMonitoring, [
        initialMonitoring,
        { operation: "question_catalog", status: "in_progress" },
      ]),
    ).toMatch(/先完成/);
    expect(
      deliveryTicketDependencyBlockReason(initialMonitoring, [
        initialMonitoring,
        { operation: "question_catalog", status: "completed" },
      ]),
    ).toBeNull();

    expect(
      sortDeliveryProjectTicketsByAction([
        { ...initialMonitoring, id: "monitoring", updatedAt: 1 },
        {
          id: "catalog",
          operation: "question_catalog",
          status: "submitted" as const,
          updatedAt: 2,
        },
      ]).map((ticket) => ticket.id),
    ).toEqual(["catalog", "monitoring"]);
  });
});
