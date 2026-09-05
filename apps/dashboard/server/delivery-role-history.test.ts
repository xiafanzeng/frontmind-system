import { describe, expect, it } from "vitest";

import {
  assertDeliveryCompletionSummary,
  assertGenericDeliveryTicketTransition,
  deliveryExecutionActorRole,
  deriveDeliveryExecutionTransition,
  deliveryTicketActionRank,
  deliveryTicketDependencyState,
  deliveryHistoryTimestamp,
  deliveryTicketStatusGroup,
  getMyDeliveryTickets,
  MY_DELIVERY_TICKET_LIMIT,
} from "./delivery-role-service";

describe("delivery history timestamps", () => {
  it("accepts decoded dates and raw driver timestamp strings", () => {
    const date = new Date("2026-07-31T08:00:00.000Z");

    expect(deliveryHistoryTimestamp(date)).toBe(date.getTime());
    expect(deliveryHistoryTimestamp("2026-07-31T08:00:00.000Z")).toBe(
      date.getTime(),
    );
  });

  it("returns a controlled Chinese error for invalid driver values", () => {
    expect(() => deliveryHistoryTimestamp("not-a-date")).toThrow(
      "任务记录的时间数据无效，请稍后重试",
    );
  });
});

describe("my delivery ticket pool", () => {
  it("uses the two public status groups and a bounded result", () => {
    expect(deliveryTicketStatusGroup("submitted")).toBe("pending");
    expect(deliveryTicketStatusGroup("in_progress")).toBe("pending");
    expect(deliveryTicketStatusGroup("completed")).toBe("completed");
    expect(deliveryTicketStatusGroup("rejected")).toBe("completed");
    expect(deliveryTicketStatusGroup("unknown")).toBeNull();
    expect(MY_DELIVERY_TICKET_LIMIT).toBe(50);
    expect(
      [
        "in_progress",
        "submitted",
        "scheduled",
        "needs_information",
        "completed",
      ].map(deliveryTicketActionRank),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("makes the monitoring dependency an explicit server decision", () => {
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "submitted",
        hasCompletedQuestionCatalog: false,
      }),
    ).toMatchObject({
      dependencySatisfied: false,
      dependencyBlockReason: expect.stringContaining("品牌词库与问题目录"),
    });
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "submitted",
        hasCompletedQuestionCatalog: true,
      }),
    ).toEqual({
      dependencySatisfied: true,
      dependencyBlockReason: null,
    });
  });

  it("rejects non-engineers before attempting any database query", async () => {
    await expect(
      getMyDeliveryTickets({
        actor: { id: 9, role: "user" } as any,
      }),
    ).rejects.toThrow("该工单池仅对工程师或系统管理员开放");
  });
});

describe("delivery execution authorization and settlement", () => {
  it("allows engineers and system admins while excluding delivery admins", () => {
    expect(
      deliveryExecutionActorRole({
        role: "delivery_member",
        username: "engineer",
      } as any),
    ).toBe("delivery_member");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "root-admin",
        adminAccessLevel: "system_admin",
      } as any),
    ).toBe("admin");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "delivery-admin",
        adminAccessLevel: "delivery_admin",
      } as any),
    ).toBeNull();
  });

  it("consumes reserved quota on execution and records the first schedule", () => {
    const now = new Date("2026-08-04T08:00:00.000Z");

    expect(
      deriveDeliveryExecutionTransition({
        currentQuotaState: "reserved",
        scheduledAt: null,
        quotaReleasedAt: null,
        technicalDedupeKey: "ticket:42",
        nextStatus: "in_progress",
        now,
      }),
    ).toEqual({
      quotaState: "consumed",
      scheduledAt: now,
      quotaReleasedAt: null,
      technicalDedupeKey: "ticket:42",
      resolvedAt: null,
    });
  });

  it("releases an unused reservation and clears terminal dedupe state", () => {
    const now = new Date("2026-08-04T08:00:00.000Z");

    expect(
      deriveDeliveryExecutionTransition({
        currentQuotaState: "reserved",
        scheduledAt: null,
        quotaReleasedAt: null,
        technicalDedupeKey: "ticket:42",
        nextStatus: "cancelled",
        now,
      }),
    ).toEqual({
      quotaState: "released",
      scheduledAt: null,
      quotaReleasedAt: now,
      technicalDedupeKey: null,
      resolvedAt: now,
    });
  });

  it("reserves website style completion for customer sample selection", () => {
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "website_style_samples",
        nextStatus: "completed",
      }),
    ).toThrow("必须由客户通过专用选择操作确认");
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "website_style_samples",
        nextStatus: "in_progress",
      }),
    ).not.toThrow();
  });

  it("requires a non-empty customer result summary on completion", () => {
    expect(() =>
      assertDeliveryCompletionSummary({
        nextStatus: "completed",
        message: "   ",
      }),
    ).toThrow("客户可见的结果摘要");
    expect(() =>
      assertDeliveryCompletionSummary({
        nextStatus: "completed",
        message: "已完成交付并核验结果。",
      }),
    ).not.toThrow();
  });
});
