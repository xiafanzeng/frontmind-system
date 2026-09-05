import { describe, expect, it } from "vitest";

import {
  createDeliveryTicketSchema,
  deliveryOperationResultSchema,
  publicDeliveryTicketEventSchema,
  publicDeliveryTicketSummarySchema,
} from "../shared/delivery-ticket";

describe("delivery ticket URL boundaries", () => {
  it("accepts http links and explicit site-relative target paths", () => {
    expect(
      createDeliveryTicketSchema.safeParse({
        clientRequestId: "7a104066-7b97-49de-a2c8-93d5bb9cbc8d",
        type: "website_operation",
        category: "technical_diagnosis",
        topic: "检查产品页",
        targetPage: "/products/machine-a",
        materialUrls: ["https://example.com/reference"],
        attachments: [],
      }).success,
    ).toBe(true);
  });

  it("rejects executable or protocol-relative links", () => {
    for (const targetPage of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "//attacker.example/path",
    ]) {
      expect(
        createDeliveryTicketSchema.safeParse({
          clientRequestId: "7a104066-7b97-49de-a2c8-93d5bb9cbc8d",
          type: "website_operation",
          category: "technical_diagnosis",
          topic: "检查产品页",
          targetPage,
          materialUrls: [],
          attachments: [],
        }).success,
      ).toBe(false);
    }
    expect(
      createDeliveryTicketSchema.safeParse({
        clientRequestId: "7a104066-7b97-49de-a2c8-93d5bb9cbc8d",
        type: "content_asset",
        category: "A1",
        materialUrls: ["javascript:alert(1)"],
        attachments: [],
      }).success,
    ).toBe(false);
    expect(
      deliveryOperationResultSchema.safeParse({
        platform: "百度站长平台",
        targetUrl: "javascript:alert(1)",
        executedAt: Date.now(),
        resultStatus: "success",
      }).success,
    ).toBe(false);
  });
});

describe("public delivery ticket status boundary", () => {
  it("accepts only the two public states and rejects legacy stage fields", () => {
    const summary = {
      id: "7a104066-7b97-49de-a2c8-93d5bb9cbc8d",
      type: "website_operation",
      category: "company_news",
      categoryLabel: "企业新闻与动态",
      topic: "发布企业新闻",
      sourceQuestionId: null,
      publicStatus: "pending",
      publicStatusLabel: "待处理",
      publicSummary: null,
    } as const;
    expect(publicDeliveryTicketSummarySchema.safeParse(summary).success).toBe(
      true,
    );
    expect(
      publicDeliveryTicketSummarySchema.safeParse({
        ...summary,
        publicStage: "processing",
      }).success,
    ).toBe(false);
    expect(
      publicDeliveryTicketSummarySchema.safeParse({
        ...summary,
        publicStatusLabel: "待受理",
      }).success,
    ).toBe(false);
  });
});

describe("public delivery ticket event boundary", () => {
  it("accepts public events and rejects internal workflow fields", () => {
    const publicEvent = {
      id: "7a104066-7b97-49de-a2c8-93d5bb9cbc8d",
      actorRole: "delivery_member",
      actorLabel: "服务团队",
      message: "处理进度已更新。",
      createdAt: Date.now(),
    } as const;

    expect(publicDeliveryTicketEventSchema.safeParse(publicEvent).success).toBe(
      true,
    );

    for (const [field, value] of [
      ["fromStatus", "submitted"],
      ["toStatus", "in_progress"],
      ["eventType", "status_changed"],
      ["visibility", "internal"],
    ] as const) {
      expect(
        publicDeliveryTicketEventSchema.safeParse({
          ...publicEvent,
          [field]: value,
        }).success,
      ).toBe(false);
    }
  });
});
