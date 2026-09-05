import { describe, expect, it } from "vitest";

import { DELIVERY_OPERATION_SPECS } from "@shared/delivery-operation-spec";

import {
  adminDeliveryEventActorLabel,
  adminDeliveryEventPublicStatusLabel,
  adminDeliveryTicketPublicStatusLabel,
  buildAdminTicketListInput,
  buildSystemAdminTicketWorkbenchHref,
  deliveryTicketPublicStatus,
  flattenAdminTicketPages,
  formatAdminTicketDate,
  isCustomerVisibleEvent,
  mergeAdminTicketPages,
  normalizeAdminTicketList,
  normalizeTicketDetail,
  safeAdminDeliveryUrl,
  ticketTypeLabel,
} from "./AdminDeliveryTicketWorkspace";

describe("administrator delivery ticket workspace contract", () => {
  it("labels all three delivery ticket families precisely", () => {
    expect(ticketTypeLabel("knowledge_base")).toBe("品牌知识库");
    expect(ticketTypeLabel("website_operation")).toBe("官网运营");
    expect(ticketTypeLabel("content_asset")).toBe("内容资产");
    expect(ticketTypeLabel("knowledge_base", "question_catalog")).toBe(
      "配置品牌词库",
    );
    expect(ticketTypeLabel("knowledge_base", "response_logic")).toBe(
      "应答逻辑",
    );
    expect(ticketTypeLabel("content_asset", "D1")).toBe("知乎问答");
    expect(ticketTypeLabel("website_operation", "legacy_operation")).toBe(
      "历史交付任务",
    );
    for (const spec of Object.values(DELIVERY_OPERATION_SPECS)) {
      expect(ticketTypeLabel("website_operation", spec.operation)).toBe(
        spec.label,
      );
    }
  });

  it("builds an exact focused system-administrator workbench route", () => {
    expect(
      buildSystemAdminTicketWorkbenchHref({
        id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
        operation: "question_maintenance",
        assignedProjectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
      }),
    ).toBe(
      "/admin/delivery-workbench?projectAssignmentId=1e9f33bc-40e2-4a8e-9bda-40d92a94b11f&section=questions&ticketId=4a67e445-37bb-45ed-9268-4ca9437e4d71&focus=1",
    );
    expect(
      buildSystemAdminTicketWorkbenchHref({
        id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
        operation: "site_check",
        assignedProjectAssignmentId: null,
      }),
    ).toBeNull();
  });

  it("builds only canonical server-side list filters", () => {
    expect(
      buildAdminTicketListInput({
        userId: 42,
        assignedAdminId: "7",
        query: "  验收企业  ",
        type: "website_operation",
        publicStatus: "pending",
        limit: 20,
      }),
    ).toEqual({
      userId: 42,
      assignedAdminId: 7,
      query: "验收企业",
      type: "website_operation",
      publicStatus: "pending",
      limit: 20,
    });

    expect(
      buildAdminTicketListInput({
        assignedAdminId: "all",
        type: "all",
        status: "all",
      }),
    ).toEqual({ limit: 20 });
  });

  it("keeps grouped filtering while presenting exact Chinese internal states", () => {
    expect(
      deliveryTicketPublicStatus({
        status: "needs_information",
        publicStatus: null,
      }),
    ).toBe("pending");
    expect(
      deliveryTicketPublicStatus({
        status: "rejected",
        publicStatus: null,
      }),
    ).toBe("completed");
    expect(
      deliveryTicketPublicStatus({
        status: "in_progress",
        publicStatus: "completed",
      }),
    ).toBe("completed");
    for (const [status, label] of [
      ["submitted", "已提交"],
      ["needs_information", "待补充资料"],
      ["scheduled", "已排期"],
      ["in_progress", "处理中"],
      ["completed", "已完成"],
      ["rejected", "未受理"],
      ["cancelled", "已取消"],
    ] as const) {
      expect(adminDeliveryTicketPublicStatusLabel({ status })).toBe(label);
    }
    expect(adminDeliveryTicketPublicStatusLabel({ status: "unknown" })).toBe(
      "未知状态",
    );
    expect(adminDeliveryEventPublicStatusLabel("scheduled")).toBe("已排期");
    expect(adminDeliveryEventPublicStatusLabel("cancelled")).toBe("已取消");
    expect(adminDeliveryEventPublicStatusLabel("legacy_unknown")).toBeNull();
    expect(adminDeliveryEventActorLabel({ actorRole: "delivery_member" })).toBe(
      "工程师",
    );
    expect(adminDeliveryEventActorLabel({ actorRole: "future_role" })).toBe(
      "相关人员",
    );
    for (const actorLabel of [
      "delivery_member",
      "Delivery Member",
      "Engineer",
      "future-role",
    ]) {
      expect(adminDeliveryEventActorLabel({ actorLabel })).toBe("相关人员");
    }
    expect(adminDeliveryEventActorLabel({ actorLabel: "王工程师" })).toBe(
      "王工程师",
    );
  });

  it("flattens cursor pages while retaining first-page workspace metadata", () => {
    const pages = [
      {
        tickets: [
          {
            id: "ticket-1",
            type: "content_asset",
            status: "submitted",
            revision: 1,
          },
        ],
        nextCursor: "opaque-cursor",
        quotas: { contentAssetPublish: { limit: 5 } },
        siteProfile: { domain: "example.com" },
      },
      {
        tickets: [
          {
            id: "ticket-1",
            type: "content_asset",
            status: "submitted",
            revision: 1,
          },
          {
            id: "ticket-2",
            type: "website_operation",
            status: "scheduled",
            revision: 2,
          },
        ],
        nextCursor: null,
      },
    ];

    expect(flattenAdminTicketPages(pages).map((ticket) => ticket.id)).toEqual([
      "ticket-1",
      "ticket-2",
    ]);
    expect(mergeAdminTicketPages(pages)).toMatchObject({
      tickets: [
        expect.objectContaining({ id: "ticket-1" }),
        expect.objectContaining({ id: "ticket-2" }),
      ],
      quotas: { contentAssetPublish: { limit: 5 } },
      siteProfile: { domain: "example.com" },
    });
  });

  it("normalizes either tickets or items without inventing customer data", () => {
    expect(
      normalizeAdminTicketList({
        tickets: [
          {
            id: "ticket-1",
            type: "website_operation",
            status: "scheduled",
            revision: 4,
            enterpriseName: "验收企业",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "ticket-1",
        type: "website_operation",
        status: "scheduled",
        revision: 4,
        enterpriseName: "验收企业",
      }),
    ]);

    expect(normalizeAdminTicketList({ tickets: [] })).toEqual([]);

    const unknownStatusTicket = normalizeAdminTicketList({
      tickets: [
        {
          id: "legacy-ticket",
          type: "content_asset",
          status: "legacy_pending",
          revision: 1,
        },
      ],
    })[0];
    expect(unknownStatusTicket?.status).toBe("unknown");
    expect(deliveryTicketPublicStatus(unknownStatusTicket)).toBe("pending");

    expect(
      normalizeAdminTicketList({
        tickets: [
          {
            id: "knowledge-ticket",
            type: "knowledge_base",
            category: "knowledge_delivery",
            status: "completed",
            revision: 1,
          },
        ],
      })[0],
    ).toMatchObject({
      type: "knowledge_base",
      category: "knowledge_delivery",
    });
  });

  it("keeps public customer events strictly separate from internal notes", () => {
    const detail = normalizeTicketDetail({
      ticket: {
        id: "ticket-1",
        type: "content_asset",
        status: "needs_information",
        revision: 2,
      },
      events: [
        {
          id: "public-1",
          visibility: "customer",
          message: "请补充图片授权。",
        },
        {
          id: "internal-1",
          visibility: "internal",
          message: "先核验授权主体。",
        },
      ],
    });

    expect(detail?.events.filter(isCustomerVisibleEvent)).toHaveLength(1);
    expect(
      detail?.events.filter((event) => event.visibility === "internal"),
    ).toHaveLength(1);
  });

  it("preserves structured delivery records from either supported response key", () => {
    const detail = normalizeTicketDetail({
      ticket: {
        id: "ticket-2",
        type: "website_operation",
        status: "completed",
        revision: 5,
      },
      deliveries: [
        {
          id: "delivery-1",
          platform: "百度站长平台",
          resultStatus: "pending_confirmation",
        },
      ],
    });

    expect(detail?.deliveryRecords).toEqual([
      expect.objectContaining({
        id: "delivery-1",
        platform: "百度站长平台",
        resultStatus: "pending_confirmation",
      }),
    ]);

    const eventBackedDetail = normalizeTicketDetail({
      ticket: {
        id: "ticket-3",
        type: "website_operation",
        status: "in_progress",
        revision: 3,
      },
      events: [
        {
          id: "event-operation-1",
          visibility: "customer",
          createdAt: "2026-07-27T10:00:00+08:00",
          operationResult: {
            platform: "必应站长平台",
            targetUrl: "https://example.com/news/1",
            resultStatus: "success",
          },
        },
      ],
    });

    expect(eventBackedDetail?.deliveryRecords).toEqual([
      expect.objectContaining({
        id: "event-operation-1",
        platform: "必应站长平台",
        resultStatus: "success",
      }),
    ]);
  });

  it("formats administrator timestamps in Beijing time", () => {
    expect(formatAdminTicketDate("2026-07-27T02:00:00Z")).toContain(
      "2026/07/27",
    );
    expect(formatAdminTicketDate("not-a-date")).toBe("时间未记录");
  });

  it("only turns http(s) and same-origin attachment paths into links", () => {
    expect(
      safeAdminDeliveryUrl(
        "/api/delivery-ticket-attachments/opaque-id/content",
        "https://dashboard.frontmind.net",
      ),
    ).toBe("/api/delivery-ticket-attachments/opaque-id/content");
    expect(
      safeAdminDeliveryUrl(
        "https://example.com/result",
        "https://dashboard.frontmind.net",
      ),
    ).toBe("https://example.com/result");
    expect(
      safeAdminDeliveryUrl(
        "javascript:alert(1)",
        "https://dashboard.frontmind.net",
      ),
    ).toBeNull();
  });
});
