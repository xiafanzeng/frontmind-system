import { describe, expect, it } from "vitest";

import {
  DELIVERY_ROLE_ORDER,
  DELIVERY_ROLE_WORKFLOWS,
  deliveryTicketActionGuidance,
  deliveryTicketDependencyBlockReason,
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
