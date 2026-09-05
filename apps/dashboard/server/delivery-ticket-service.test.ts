import { describe, expect, it } from "vitest";

import {
  adminDeliveryTicketListInputSchema,
  createDeliveryTicketSchema,
  deliveryTicketListInputSchema,
  deliveryTicketStatusSchema,
  publicContentAssetTicketDetailSchema,
  publicWebsiteTicketDetailSchema,
  resolveDeliveryTicketQuotaPool,
} from "../shared/delivery-ticket";
import {
  CONTENT_ASSET_CATALOG,
  contentAssetMediaOptionsForMarketEdition,
} from "../shared/delivery-catalog";
import {
  aggregateDeliveryTicketQuotaCapacity,
  assertManagedTicketCanBeExecutedByAdmin,
  assertExistingDeliveryTicketSettlementScope,
  assertDeliveryTicketServiceEligibility,
  assertDeliveryOperationPolicy,
  assertDeliveryTicketMessagePolicy,
  assertWebsiteTicketWorkflow,
  decodeDeliveryTicketCursor,
  deliveryLinksFromOperationResults,
  deliveryTicketStatusAfterCustomerMessage,
  deriveTicketQuotaTransition,
  encodeDeliveryTicketCursor,
  isDeliveryTicketAttachmentVisible,
  missingIcpCompletionRequirements,
  missingOwnedAttachmentIds,
  selectDeliveryTicketQuotaPeriod,
  technicalTicketDedupeKey,
  toPublicDeliveryTicketCreationResult,
  toPublicDeliveryTicketSummary,
  toPublicDeliveryTicketWorkspaceMetadata,
  withSerializedTicketCreation,
} from "./delivery-ticket-service";

function settlementExecutor(
  periods: Array<{ id: string; userId: number; contractId: string }>,
) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return {
                    async for() {
                      return periods.slice(0, 1);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("delivery ticket contract", () => {
  it("routes system administrators through the role workbench while delivery administrators stay coordination-only", () => {
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: { workflowDomain: "ai_operations_engineer" },
      }),
    ).toThrow(/系统管理员完整处理工作台/);
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: { workflowDomain: null },
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "delivery.admin",
          adminAccessLevel: "delivery_admin",
        },
        ticket: { workflowDomain: "ai_operations_engineer" },
      }),
    ).toThrow(/交付管理员仅负责查看、沟通与协调/);
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "delivery.admin",
          adminAccessLevel: "delivery_admin",
        },
        ticket: { workflowDomain: null },
      }),
    ).toThrow(/交付管理员仅负责查看、沟通与协调/);
  });

  it("publishes six explained content types without the retired media type", () => {
    expect(CONTENT_ASSET_CATALOG).toHaveLength(6);
    expect(
      CONTENT_ASSET_CATALOG.some((item) => item.label === "媒体稿件与权威信源"),
    ).toBe(false);
    expect(
      CONTENT_ASSET_CATALOG.every((item) => item.description.length > 0),
    ).toBe(true);
  });

  it("isolates domestic and overseas content media options", () => {
    expect(contentAssetMediaOptionsForMarketEdition("domestic")).toContain(
      "搜狐",
    );
    expect(contentAssetMediaOptionsForMarketEdition("domestic")).not.toContain(
      "美联社",
    );
    expect(contentAssetMediaOptionsForMarketEdition("overseas")).toEqual([
      "美联社",
      "今日美国",
      "雅虎",
      "Business Insider",
      "Barchart",
    ]);
  });

  it("derives public media links only from successful structured delivery records", () => {
    expect(
      deliveryLinksFromOperationResults([
        {
          platform: "搜狐",
          targetUrl: "https://example.com/published",
          executedAt: 1_774_700_000_000,
          resultStatus: "success",
        },
        {
          platform: "失败平台",
          targetUrl: "https://example.com/failed",
          executedAt: 1_774_700_000_001,
          resultStatus: "failed",
        },
        {
          platform: "重复记录",
          targetUrl: "https://example.com/published",
          executedAt: 1_774_700_000_002,
          resultStatus: "success",
        },
        { platform: "无效记录", targetUrl: "javascript:alert(1)" },
      ]),
    ).toEqual([
      {
        label: "搜狐",
        url: "https://example.com/published",
      },
    ]);
  });

  it("allows website dialogue while keeping sensitive website attachments out", () => {
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        ticketCategory: "domain_application",
        actorRole: "user",
        visibility: "customer",
        attachmentCount: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        ticketCategory: "icp_filing",
        actorRole: "user",
        visibility: "customer",
        attachmentCount: 1,
      }),
    ).toThrow("只接收文字补充");
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        ticketCategory: "company_news",
        actorRole: "user",
        visibility: "customer",
        attachmentCount: 1,
      }),
    ).not.toThrow();
    expect(() => assertDeliveryOperationPolicy("website_operation")).toThrow(
      "官网工单不回传",
    );
    expect(() => assertDeliveryOperationPolicy("content_asset")).not.toThrow();
  });

  it("returns a customer reply to the assigned engineer queue", () => {
    expect(
      deliveryTicketStatusAfterCustomerMessage({
        actorRole: "user",
        currentStatus: "needs_information",
      }),
    ).toBe("submitted");
    expect(
      deliveryTicketStatusAfterCustomerMessage({
        actorRole: "user",
        currentStatus: "in_progress",
      }),
    ).toBe("in_progress");
    expect(
      deliveryTicketStatusAfterCustomerMessage({
        actorRole: "delivery_member",
        currentStatus: "needs_information",
      }),
    ).toBe("needs_information");
  });

  it("keeps the canonical status set stable", () => {
    expect(deliveryTicketStatusSchema.options).toEqual([
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
    ]);
  });

  it("chooses quota pools from server-owned website categories", () => {
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "content_asset",
        category: "A1",
      }),
    ).toBe("content_asset_publish");
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "company_facts",
      }),
    ).toBe("website_content_publish");
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "domain_application",
      }),
    ).toBeNull();
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "knowledge_base_maintenance",
      }),
    ).toBeNull();
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "blog_update",
      }),
    ).toThrow("旧版官网技术类别");
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "made_up_free_category",
      }),
    ).toThrow("有效的官网运营类别");
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "content_asset",
        category: "company_facts",
      }),
    ).toThrow("不能使用内容资产额度");
  });

  it("accepts a category-only request but not a content-free request", () => {
    expect(
      createDeliveryTicketSchema.parse({
        clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        type: "content_asset",
        category: "A1",
      }).category,
    ).toBe("A1");
    expect(() =>
      createDeliveryTicketSchema.parse({
        clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        type: "content_asset",
      }),
    ).toThrow();
  });

  it("requires a published snapshot for knowledge-base maintenance", () => {
    const base = {
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "knowledge_base_maintenance",
      description: "更新产品参数",
    } as const;
    expect(() => createDeliveryTicketSchema.parse(base)).toThrow(
      "必须关联当前已发布知识库",
    );
    expect(
      createDeliveryTicketSchema.parse({
        ...base,
        knowledgeSnapshotId: "970b87d8-d4f4-45db-8f11-44c45f52ade9",
      }).knowledgeSnapshotId,
    ).toBe("970b87d8-d4f4-45db-8f11-44c45f52ade9");
  });

  it("keeps attachment rights metadata in the validated contract", () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "content_asset",
      category: "A1",
      attachments: [
        {
          fileId: "file-1",
          filename: "brand-photo.jpg",
          purpose: "文章头图",
          authorization: "licensed",
          copyrightNote: "已取得摄影师书面授权",
        },
      ],
    });
    expect(value.attachments[0]).toMatchObject({
      purpose: "文章头图",
      authorization: "licensed",
    });
  });

  it("requires the ICP subject number on a completed filing result", () => {
    const common = {
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "icp_filing",
      topic: "企业网站备案",
    } as const;
    expect(() => createDeliveryTicketSchema.parse(common)).toThrow(
      "ICP 主体备案号",
    );
    expect(
      createDeliveryTicketSchema.parse({
        ...common,
        icpDeclarations: {
          icpNumber: "粤ICP备12345678号",
        },
      }).icpDeclarations,
    ).toMatchObject({ icpNumber: "粤ICP备12345678号" });
    expect(() =>
      createDeliveryTicketSchema.parse({
        ...common,
        icpDeclarations: {
          icpNumber: "粤ICP备12345678号",
        },
        attachments: [
          {
            fileId: "should-not-upload",
            filename: "营业执照.pdf",
          },
        ],
      }),
    ).toThrow("不接收附件");
  });

  it("rejects the retired protected ICP attachment protocol", () => {
    expect(() =>
      createDeliveryTicketSchema.parse({
        clientRequestId: "837f5ac0-5a0e-4dc4-a42e-73509a7ca2e4",
        type: "website_operation",
        category: "icp_filing",
        topic: "example.com",
        icpDeclarations: { icpNumber: "京ICP备12345678号" },
        attachments: [
          {
            storageKind: "icp_protected",
            protectedMaterialId: "d589416d-ee19-4998-ac2c-b760448f80a3",
            sensitiveCategory: "business_license",
            filename: "营业执照",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts one completed domain and ICP result before a site profile exists", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "icp_filing",
      topic: "https://Example.com/path",
      icpDeclarations: {
        icpNumber: "浙ICP备12345678号",
      },
    });
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [],
            }),
          }),
        }),
      }),
    };

    await expect(
      assertWebsiteTicketWorkflow(executor, 42, value),
    ).resolves.toEqual({
      profile: null,
      domain: "example.com",
    });
  });

  it("validates bounded user and administrator list filters", () => {
    expect(
      deliveryTicketListInputSchema.parse({
        type: "content_asset",
        publicStatus: "pending",
        direction: "forward",
      }),
    ).toMatchObject({
      type: "content_asset",
      publicStatus: "pending",
      direction: "forward",
      limit: 20,
    });
    expect(
      adminDeliveryTicketListInputSchema.parse({
        userId: 42,
        assignedAdminId: 7,
        query: " 验收企业 ",
        type: "website_operation",
        quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
        limit: 100,
      }),
    ).toMatchObject({
      userId: 42,
      assignedAdminId: 7,
      query: "验收企业",
      type: "website_operation",
      limit: 100,
    });
    expect(() => deliveryTicketListInputSchema.parse({ limit: 101 })).toThrow();
    expect(() =>
      deliveryTicketListInputSchema.parse({ status: "in_progress" }),
    ).toThrow();
    expect(() =>
      deliveryTicketListInputSchema.parse({
        quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
      }),
    ).toThrow();
    expect(() =>
      adminDeliveryTicketListInputSchema.parse({ userId: 0 }),
    ).toThrow();
    expect(() =>
      adminDeliveryTicketListInputSchema.parse({ query: "x".repeat(101) }),
    ).toThrow();
  });

  it("round-trips an opaque keyset cursor and rejects tampering", () => {
    const updatedAt = new Date("2026-07-27T02:03:04.000Z");
    const id = "970b87d8-d4f4-45db-8f11-44c45f52ade9";
    const cursor = encodeDeliveryTicketCursor({ updatedAt, id });

    expect(cursor).not.toContain(id);
    expect(decodeDeliveryTicketCursor(cursor)).toEqual({
      version: 1,
      updatedAt: updatedAt.getTime(),
      id,
    });
    expect(() => decodeDeliveryTicketCursor(`${cursor}!`)).toThrow(
      "工单列表游标无效",
    );
    expect(() =>
      decodeDeliveryTicketCursor(
        Buffer.from(
          JSON.stringify({
            version: 2,
            updatedAt: updatedAt.getTime(),
            id,
          }),
        ).toString("base64url"),
      ),
    ).toThrow("工单列表游标无效");
  });

  it("binds an oldest-first cursor to the created-time ordering", () => {
    const createdAt = new Date("2026-07-27T02:03:04.000Z");
    const id = "970b87d8-d4f4-45db-8f11-44c45f52ade9";
    const cursor = encodeDeliveryTicketCursor({
      updatedAt: createdAt,
      id,
      order: "created_asc",
    });

    expect(decodeDeliveryTicketCursor(cursor)).toEqual({
      version: 1,
      updatedAt: createdAt.getTime(),
      id,
      order: "created_asc",
    });
  });
});

describe("customer delivery-ticket DTO boundary", () => {
  const internalTicket = {
    id: "970b87d8-d4f4-45db-8f11-44c45f52ade9",
    userId: 42,
    contractId: "contract-internal",
    quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
    ordinal: 3,
    enterpriseName: "内部企业名称",
    type: "content_asset",
    quotaPool: "content_asset_publish",
    quotaState: "consumed",
    category: "D1",
    topic: "如何核验品牌事实",
    title: "不应单独暴露的内部标题",
    description: "包含内部材料说明",
    preferredMedia: "知乎",
    icpProvince: null,
    targetPage: "https://example.com/internal-target",
    materialUrls: ["https://example.com/internal-source"],
    status: "completed",
    statusLabel: "已完成",
    publicStatus: "completed",
    publicStatusLabel: "已完成",
    publicSummary: "已完成问答内容整理。",
    deliveryLinks: [
      {
        label: "知乎",
        url: "https://www.zhihu.com/question/example",
      },
    ],
    revision: 4,
    submittedAt: 1_774_560_000_000,
    createdAt: 1_774_560_000_000,
    updatedAt: 1_774_646_400_000,
    resolvedAt: 1_774_646_400_000,
    scheduledAt: 1_774_603_200_000,
    attachmentCount: 2,
    latestPublicMessage: "列表不应返回过程消息。",
    assignedAdmins: [{ id: 7, name: "内部管理员" }],
    assignedAdminId: 7,
    assignedAdminName: "内部管理员",
    workflowDomain: "content_distribution_engineer",
    operation: "content_asset_publish",
    assignedProjectAssignmentId: "61c5ea73-ab85-44a2-bbd6-bfc90a6251b0",
    assignedMemberId: 19,
    assignedMemberName: "内部工程师",
    priority: "urgent",
  } as const;

  it("keeps the compatible two-state filter while exposing a useful customer stage", () => {
    const value = toPublicDeliveryTicketSummary(internalTicket as any);

    expect(value).toEqual({
      id: internalTicket.id,
      type: "content_asset",
      category: "D1",
      categoryLabel: "知乎问答",
      topic: "如何核验品牌事实",
      publicStatus: "completed",
      publicStatusLabel: "已完成",
      publicStage: "completed",
      publicStageLabel: "已完成",
      publicSummary: "已完成问答内容整理。",
      deliveryLinks: [
        {
          label: "知乎",
          url: "https://www.zhihu.com/question/example",
        },
      ],
    });
    for (const forbidden of [
      "contractId",
      "quotaPeriodId",
      "quotaState",
      "assignedAdminName",
      "materialUrls",
      "submittedAt",
      "updatedAt",
      "resolvedAt",
      "attachmentCount",
      "workflowDomain",
      "operation",
      "assignedProjectAssignmentId",
      "assignedMemberId",
      "assignedMemberName",
      "priority",
    ]) {
      expect(value).not.toHaveProperty(forbidden);
    }
  });

  it("never returns delivery links from website history or create results", () => {
    const ticket = {
      ...internalTicket,
      type: "website_operation",
      category: "company_news",
    } as any;
    const value = toPublicDeliveryTicketSummary(ticket);
    const created = toPublicDeliveryTicketCreationResult({
      ticket,
      idempotent: false,
    });

    expect(value).toEqual({
      id: internalTicket.id,
      type: "website_operation",
      category: "company_news",
      categoryLabel: "企业新闻与动态",
      topic: "如何核验品牌事实",
      publicStatus: "completed",
      publicStatusLabel: "已完成",
      publicStage: "completed",
      publicStageLabel: "已完成",
      publicSummary: "已完成问答内容整理。",
    });
    expect(value).not.toHaveProperty("deliveryLinks");
    expect(created.ticket).toEqual(value);
    expect(created).not.toHaveProperty("contractId");
  });

  it("does not present a rejected request to the customer as delivered", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      status: "rejected",
      statusLabel: "未受理",
      publicSummary: "当前资料不足，本次需求未受理。",
    } as any);

    expect(value).toMatchObject({
      publicStatus: "completed",
      publicStage: "closed",
      publicStageLabel: "已结束",
      publicSummary: "当前资料不足，本次需求未受理。",
    });
  });

  it("exposes the engineer supplement request only while customer action is required", () => {
    const actionRequired = toPublicDeliveryTicketSummary({
      ...internalTicket,
      status: "needs_information",
      publicSummary: "请补充产品参数生效日期。",
    } as any);
    const processing = toPublicDeliveryTicketSummary({
      ...internalTicket,
      status: "submitted",
      publicSummary: "旧的补充要求不应继续展示。",
    } as any);

    expect(actionRequired).toMatchObject({
      publicStage: "action_required",
      publicStageLabel: "待您补充",
      publicSummary: "请补充产品参数生效日期。",
    });
    expect(processing.publicSummary).toBeNull();
  });

  it("labels the automatic brand knowledge delivery record precisely", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "knowledge_base",
      category: "knowledge_delivery",
      knowledgeSnapshotId: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
    } as any);

    expect(value).toMatchObject({
      type: "knowledge_base",
      category: "knowledge_delivery",
      categoryLabel: "品牌全域知识库",
      knowledgeSnapshotId: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
    });
    expect(value).not.toHaveProperty("deliveryLinks");
  });

  it("labels the monitoring engineer's question catalog ticket in Chinese", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "website_operation",
      category: "question_catalog",
      operation: "question_catalog",
      workflowDomain: "monitoring_optimization_engineer",
    } as any);

    expect(value).toMatchObject({
      type: "website_operation",
      category: "question_catalog",
      categoryLabel: "品牌词库与问题目录",
    });
  });

  it("validates public dialogue details for website and content tickets", () => {
    const websiteTicket = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "website_operation",
      category: "company_news",
    } as any);
    expect(
      publicWebsiteTicketDetailSchema.safeParse({
        ticket: {
          ...websiteTicket,
          revision: 4,
          canReply: true,
          canAttach: true,
        },
        events: [
          {
            id: "7e39705a-ae06-4e7b-8d45-6284903ee86f",
            actorRole: "delivery_member",
            actorLabel: "服务团队",
            message: "请补充新闻发布时间。",
            createdAt: 1_774_646_400_000,
          },
        ],
        attachments: [
          {
            id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
            filename: "新闻资料.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            purpose: "新闻资料",
            kind: "input",
            createdAt: 1_774_646_400_000,
            downloadUrl:
              "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      publicWebsiteTicketDetailSchema.safeParse({
        ticket: {
          ...websiteTicket,
          revision: 4,
          canReply: true,
          canAttach: true,
        },
        events: [],
        attachments: [
          {
            id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
            filename: "内部文件.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            purpose: null,
            kind: "input",
            createdAt: 1_774_646_400_000,
            downloadUrl: "/api/private",
          },
        ],
      }).success,
    ).toBe(false);

    const contentTicket = toPublicDeliveryTicketSummary(internalTicket as any);
    const publicDetail = {
      ticket: {
        ...contentTicket,
        preferredMedia: null,
        revision: 4,
        canReply: false,
      },
      events: [
        {
          id: "7e39705a-ae06-4e7b-8d45-6284903ee86f",
          actorRole: "admin",
          actorLabel: "服务团队",
          message: "公开回复",
          createdAt: 1_774_646_400_000,
        },
      ],
      attachments: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
          filename: "客户授权书.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          purpose: "客户案例授权",
          kind: "input",
          createdAt: 1_774_646_400_000,
          downloadUrl:
            "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
        },
      ],
    };
    expect(
      publicContentAssetTicketDetailSchema.safeParse(publicDetail).success,
    ).toBe(true);
    expect(
      publicContentAssetTicketDetailSchema.safeParse({
        ...publicDetail,
        attachments: [
          {
            ...publicDetail.attachments[0],
            downloadUrl: "/api/private",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      publicContentAssetTicketDetailSchema.safeParse({
        ...publicDetail,
        events: [
          {
            ...publicDetail.events[0],
            visibility: "internal",
            operationResult: { targetUrl: "https://internal.example" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("removes site identity, ICP verification and internal quota allocation", () => {
    const metadata = toPublicDeliveryTicketWorkspaceMetadata({
      siteProfile: {
        domain: "private.example.com",
        domainStatus: "completed",
        domainVerifiedAt: 1_774_560_000_000,
        icpProvince: "广东",
        icpNumber: "粤ICP备内部号",
        icpStatus: "approved",
        icpVerifiedAt: 1_774_646_400_000,
        revision: 9,
        updatedAt: 1_774_646_400_000,
      },
      quotas: {
        content_asset_publish: {
          type: "content_asset_publish",
          allowed: true,
          used: 2,
          reserved: 1,
          consumed: 1,
          limit: 5,
          remaining: 3,
          periodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
          revision: 4,
          validFrom: 1_774_560_000_000,
          validUntil: 1_782_336_000_000,
          reason: null,
        },
        website_content_publish: {
          type: "website_content_publish",
          allowed: true,
          used: 1,
          reserved: 1,
          consumed: 0,
          limit: 20,
          remaining: 19,
          periodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
          revision: 4,
          validFrom: 1_774_560_000_000,
          validUntil: 1_782_336_000_000,
          reason: null,
        },
      },
      pendingCount: 1,
      contentAssetCatalog: [
        {
          id: "D1",
          code: "D1",
          group: "D",
          type: "问答内容",
          label: "知乎问答",
        },
      ],
      websiteContentCatalog: [
        { value: "company_facts", label: "企业资料与品牌事实" },
      ],
      marketEdition: "domestic",
      preferredMediaOptions: ["微博"],
      websiteWorkflow: {
        domainStatus: "completed",
        icpStatus: "approved",
        domainCompleted: true,
        icpCompleted: true,
        styleState: "confirmed",
        styleRevision: 2,
        styleBatch: null,
        selectedStyleSampleId: null,
        styleConfirmed: true,
        canSelectStyle: false,
        canRequestStyleRevision: false,
        canSubmitDomain: false,
        canSubmitIcp: false,
        canSubmitContent: true,
        icpProvince: "广东",
        icpProvinceOptions: ["广东"],
        icpLockReason: null,
        contentLockReason: null,
      },
    } as any);

    expect(metadata).not.toHaveProperty("siteProfile");
    expect(metadata).not.toHaveProperty("pendingCount");
    expect(metadata.websiteWorkflow).toEqual({
      domainCompleted: true,
      icpCompleted: true,
      styleState: "confirmed",
      styleRevision: 2,
      styleBatch: null,
      selectedStyleSampleId: null,
      styleConfirmed: true,
      canSelectStyle: false,
      canRequestStyleRevision: false,
      canSubmitDomain: false,
      canSubmitIcp: false,
      canSubmitContent: true,
      domainLockReason: null,
      icpLockReason: null,
      contentLockReason: null,
      icpProvinceOptions: ["广东"],
    });
    expect(metadata.websiteWorkflow).not.toHaveProperty("icpProvince");
    expect(metadata.quotas.content_asset_publish).toEqual({
      type: "content_asset_publish",
      allowed: true,
      used: 2,
      limit: 5,
      remaining: 3,
      reason: null,
    });
    expect(metadata.quotas.content_asset_publish).not.toHaveProperty(
      "periodId",
    );
    expect(metadata.quotas.content_asset_publish).not.toHaveProperty(
      "reserved",
    );
  });
});

describe("delivery ticket quota lifecycle", () => {
  it("allows Basic content assets but rejects Basic website operations", () => {
    expect(
      assertDeliveryTicketServiceEligibility(
        {
          service: {
            status: "active",
            planCode: "basic",
            contractId: "contract-basic",
          },
          quotas: { periodId: "basic-aggregate:contract-basic" },
          quotaPeriods: [
            {
              periodId: "period-basic-1",
              contractId: "contract-basic-1",
            },
            {
              periodId: "period-basic-2",
              contractId: "contract-basic-2",
            },
          ],
        } as any,
        "content_asset",
      ),
    ).toMatchObject({
      quotaPeriodIds: ["period-basic-1", "period-basic-2"],
    });
    expect(() =>
      assertDeliveryTicketServiceEligibility(
        {
          service: {
            status: "active",
            planCode: "basic",
            contractId: "contract-basic",
          },
          quotas: { periodId: "period-basic" },
          quotaPeriods: [],
        } as any,
        "website_operation",
      ),
    ).toThrow("普通版不包含 AI 友好官网管理");
    expect(
      assertDeliveryTicketServiceEligibility(
        {
          service: {
            status: "active",
            planCode: "basic",
            contractId: "contract-basic",
          },
          quotas: { periodId: "period-basic" },
          quotaPeriods: [],
        } as any,
        "website_operation",
        "knowledge_base_maintenance",
      ),
    ).toMatchObject({ quotaPeriodId: "period-basic" });
  });

  it("rejects expired services on the server", () => {
    expect(() =>
      assertDeliveryTicketServiceEligibility({
        service: {
          status: "expired",
          planCode: "luxury",
          contractId: "contract-luxury",
        },
        quotas: { periodId: "period-luxury" },
      } as any),
    ).toThrow("仅可查看历史工单");
  });

  it("allocates concurrent Basic purchases to the next real period", () => {
    const periods = [
      {
        id: "period-expiring-first",
        contractId: "contract-1",
        contentAssetPublishLimit: 1,
        websiteContentPublishLimit: 0,
      },
      {
        id: "period-expiring-second",
        contractId: "contract-2",
        contentAssetPublishLimit: 1,
        websiteContentPublishLimit: 0,
      },
    ];
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "content_asset_publish",
        activeCounts: new Map([["period-expiring-first", 1]]),
      }),
    ).toMatchObject({ id: "period-expiring-second" });
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "content_asset_publish",
        activeCounts: new Map([
          ["period-expiring-first", 1],
          ["period-expiring-second", 1],
        ]),
      }),
    ).toBeNull();
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "website_content_publish",
        activeCounts: new Map(),
      }),
    ).toBeNull();
  });

  it("aggregates content quota across every concurrent Basic period", () => {
    const capacity = aggregateDeliveryTicketQuotaCapacity({
      periods: [
        {
          id: "period-1",
          contractId: "contract-1",
          contentAssetPublishLimit: 1,
          websiteContentPublishLimit: 0,
        },
        {
          id: "period-2",
          contractId: "contract-2",
          contentAssetPublishLimit: 1,
          websiteContentPublishLimit: 0,
        },
      ],
      quotaPool: "content_asset_publish",
      activeRows: [
        {
          quotaPool: "content_asset_publish",
          quotaState: "consumed",
          value: 1,
        },
      ],
    });
    expect(capacity).toEqual({
      limit: 2,
      reserved: 0,
      consumed: 1,
      used: 1,
      remaining: 1,
    });
  });

  it("keeps consumed quota exhausted after its verbose ticket is archived", () => {
    const archivedPeriod = {
      id: "period-archived",
      contractId: "contract-archived",
      contentAssetPublishLimit: 1,
      websiteContentPublishLimit: 1,
      archivedContentAssetPublishUsed: 1,
      archivedWebsiteContentPublishUsed: 1,
    };

    expect(
      selectDeliveryTicketQuotaPeriod({
        periods: [archivedPeriod],
        quotaPool: "content_asset_publish",
        activeCounts: new Map(),
      }),
    ).toBeNull();
    expect(
      aggregateDeliveryTicketQuotaCapacity({
        periods: [archivedPeriod],
        quotaPool: "website_content_publish",
        activeRows: [],
      }),
    ).toEqual({
      limit: 1,
      reserved: 0,
      consumed: 1,
      used: 1,
      remaining: 0,
    });
  });

  it("detects attachment ownership gaps without trusting descriptors", () => {
    expect(
      missingOwnedAttachmentIds(
        ["file-owned", "file-other", "file-other"],
        ["file-owned"],
      ),
    ).toEqual(["file-other"]);
  });

  it("never exposes internal or unscoped attachments to customers", () => {
    expect(isDeliveryTicketAttachmentVisible(false, "customer")).toBe(true);
    expect(isDeliveryTicketAttachmentVisible(false, "internal")).toBe(false);
    expect(isDeliveryTicketAttachmentVisible(false, null)).toBe(false);
    expect(isDeliveryTicketAttachmentVisible(true, "internal")).toBe(true);
    expect(isDeliveryTicketAttachmentVisible(true, null)).toBe(true);
  });

  it("blocks ICP completion when the subject filing number is missing", () => {
    expect(
      missingIcpCompletionRequirements({
        declarations: { icpNumber: "粤ICP备12345678号" },
      }),
    ).toEqual([]);
    expect(
      missingIcpCompletionRequirements({
        declarations: null,
      }),
    ).toEqual(["icp_number"]);
  });

  it("reserves at submission and consumes only when scheduled", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "scheduled",
      }),
    ).toBe("consumed");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "in_progress",
      }),
    ).toBe("consumed");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "completed",
      }),
    ).toBe("consumed");
  });

  it("settles a submitted ticket against its original service period after a later expiry or downgrade", async () => {
    const ticket = {
      userId: 42,
      contractId: "contract-original",
      quotaPeriodId: "period-original",
      quotaPool: "website_content_publish",
      quotaState: "reserved",
    } as const;

    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([
          {
            id: "period-original",
            userId: 42,
            contractId: "contract-original",
          },
        ]),
        userId: 42,
        ticket,
      }),
    ).resolves.toEqual({
      id: "period-original",
      userId: 42,
      contractId: "contract-original",
    });
  });

  it("rejects completion when the original quota binding is invalid or already released", async () => {
    const ticket = {
      userId: 42,
      contractId: "contract-original",
      quotaPeriodId: "period-original",
      quotaPool: "content_asset_publish",
      quotaState: "reserved",
    } as const;

    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([]),
        userId: 42,
        ticket,
      }),
    ).rejects.toMatchObject({ code: "TICKET_QUOTA_SCOPE_INVALID" });
    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([
          {
            id: "period-original",
            userId: 42,
            contractId: "contract-original",
          },
        ]),
        userId: 42,
        ticket: { ...ticket, quotaState: "released" },
      }),
    ).rejects.toMatchObject({ code: "TICKET_QUOTA_ALREADY_RELEASED" });
  });

  it("releases a reserved slot before scheduling", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "rejected",
      }),
    ).toBe("released");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "cancelled",
      }),
    ).toBe("released");
  });

  it("does not refund an already scheduled slot", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "consumed",
        scheduledAt: new Date("2026-07-27T00:00:00Z"),
        nextStatus: "cancelled",
      }),
    ).toBe("consumed");
  });

  it("normalizes technical target pages into the same dedupe key", () => {
    expect(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "https://example.com/docs/",
      }),
    ).toBe(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/docs",
      }),
    );
    expect(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/other",
      }),
    ).not.toBe(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/docs",
      }),
    );
  });

  it("serializes duplicate submissions before the idempotency lookup", async () => {
    let queue = Promise.resolve();
    let stored: { id: string } | null = null;
    let creates = 0;
    const withLock = async <T>(
      criticalSection: (scope: { periodId: string }) => Promise<T>,
    ) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await criticalSection({ periodId: "period-1" });
      } finally {
        release();
      }
    };
    const submit = () =>
      withSerializedTicketCreation({
        withLock,
        findDuplicate: async () => stored,
        onDuplicate: (existing) => ({
          id: existing.id,
          idempotent: true,
        }),
        create: async () => {
          creates += 1;
          await Promise.resolve();
          stored = { id: "ticket-1" };
          return { id: stored.id, idempotent: false };
        },
      });

    const results = await Promise.all([submit(), submit()]);
    expect(creates).toBe(1);
    expect(results).toEqual([
      { id: "ticket-1", idempotent: false },
      { id: "ticket-1", idempotent: true },
    ]);
  });
});
