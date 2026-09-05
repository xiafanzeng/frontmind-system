import { describe, expect, it } from "vitest";

import {
  createDeliveryTicketSchema,
  deliveryOperationResultSchema,
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
