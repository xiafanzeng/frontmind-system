import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adminTicketEventPublicMessage,
  adminTicketEventTransitionLabel,
  dispatchWorkflowScopeLabel,
  filterDispatchTickets,
  groupDispatchTicketEvents,
  hasAuthoritativeProjectOwner,
  toAdminTicketStatus,
} from "./AdminDeliveryDispatch";

describe("delivery administration ticket view", () => {
  it("maps every historical status into the two public states", () => {
    for (const status of [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
    ] as const) {
      expect(toAdminTicketStatus(status)).toBe("pending");
    }
    for (const status of ["completed", "rejected", "cancelled"] as const) {
      expect(toAdminTicketStatus(status)).toBe("completed");
    }
  });

  it("treats the project assignment and member identifiers as one authority", () => {
    expect(
      hasAuthoritativeProjectOwner({
        workflowDomain: "ai_operations_engineer",
        assignedProjectAssignmentId: "assignment-1",
        assignedMemberId: 12,
      }),
    ).toBe(true);
    expect(
      hasAuthoritativeProjectOwner({
        workflowDomain: "ai_operations_engineer",
        assignedProjectAssignmentId: null,
        assignedMemberId: 12,
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeProjectOwner({
        workflowDomain: "ai_operations_engineer",
        assignedProjectAssignmentId: "assignment-1",
        assignedMemberId: null,
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeProjectOwner({
        workflowDomain: null,
        assignedProjectAssignmentId: null,
        assignedMemberId: null,
      }),
    ).toBe(true);
  });

  it("distinguishes customer roots, internal steps, and standalone history", () => {
    expect(
      dispatchWorkflowScopeLabel({
        isWorkflowContainer: true,
        rootTicketId: null,
        workflowDomain: null,
      }),
    ).toBe("客户原始需求（流程汇总）");
    expect(
      dispatchWorkflowScopeLabel({
        isWorkflowContainer: false,
        rootTicketId: "root-1",
        workflowDomain: "content_distribution_engineer",
      }),
    ).toBe("内部执行步骤");
    expect(
      dispatchWorkflowScopeLabel({
        isWorkflowContainer: false,
        rootTicketId: null,
        workflowDomain: null,
      }),
    ).toBe("历史技术需求（只读）");
  });

  it("filters by the public state, customer, type, role, and manager", () => {
    const tickets = [
      {
        id: "1",
        userId: 42,
        type: "knowledge_base",
        title: "知识库复核",
        status: "rejected",
        workflowDomain: "ai_operations_engineer",
        assignedProjectAssignmentId: "assignment-1",
        assignedMemberId: 9,
      },
      {
        id: "2",
        userId: 43,
        type: "content_asset",
        title: "FAQ 发布",
        status: "in_progress",
        workflowDomain: "content_distribution_engineer",
        assignedProjectAssignmentId: "assignment-2",
        assignedMemberId: 10,
      },
    ] as any;
    const projects = [
      {
        id: 42,
        username: "alpha",
        displayName: "甲公司",
        managerId: 7,
      },
      { id: 43, username: "beta", displayName: "乙公司", managerId: 8 },
    ];

    expect(
      filterDispatchTickets(tickets, projects, {
        query: "甲公司",
        type: "knowledge_base",
        status: "completed",
        role: "ai_operations_engineer",
        customerId: "42",
        managerId: "7",
      }).map((ticket) => ticket.id),
    ).toEqual(["1"]);
  });

  it("groups events in one pass and presents exact internal transitions in Chinese", () => {
    const events = [
      {
        id: "event-1",
        ticketId: "ticket-1",
        actorRole: "admin",
        message: null,
        fromStatus: "submitted",
        toStatus: "in_progress",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "event-2",
        ticketId: "ticket-2",
        actorRole: "admin",
        message: "  已补充处理说明。  ",
        fromStatus: null,
        toStatus: null,
        createdAt: "2026-08-02T00:01:00.000Z",
      },
    ];

    const grouped = groupDispatchTicketEvents(events);
    expect(grouped.get("ticket-1")?.map((event) => event.id)).toEqual([
      "event-1",
    ]);
    expect(grouped.get("ticket-2")?.map((event) => event.id)).toEqual([
      "event-2",
    ]);
    expect(adminTicketEventPublicMessage(events[0])).toBe("已提交 → 处理中");
    expect(adminTicketEventPublicMessage(events[0])).not.toContain(
      "in_progress",
    );
    expect(adminTicketEventPublicMessage(events[1])).toBe("已补充处理说明。");
    expect(
      adminTicketEventTransitionLabel({
        ...events[1]!,
        message: "已开始处理。",
        fromStatus: "submitted",
        toStatus: "in_progress",
      }),
    ).toBe("已提交 → 处理中");
  });

  it("exposes only read-only detail and grouped filters", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryDispatch.tsx"),
      "utf8",
    );

    expect(source).toContain('title="需求"');
    expect(source).toContain('<option value="pending">待处理</option>');
    expect(source).toContain('<option value="completed">已结束</option>');
    expect(source).toContain('aria-label="筛选客户"');
    expect(source).toContain('aria-label="筛选执行岗位"');
    expect(source).toContain("查看需求详情");
    expect(source).not.toContain("dispatchTicket.useMutation");
    expect(source).not.toContain("urgeTicket.useMutation");
    expect(source).not.toContain("保存优先级");
    expect(source).not.toContain("配置项目岗位");
    expect(source).not.toContain("待分配");
    expect(source).not.toContain("overview.ticketEvents.filter");
    expect(source).not.toContain("`${event.fromStatus} → ${event.toStatus}`");
  });
});
