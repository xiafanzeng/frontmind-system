import { describe, expect, it } from "vitest";

import {
  ACTIVE_WEBSITE_OPERATION_CATEGORIES,
  QUESTION_MANAGEMENT_HISTORY_CATEGORIES,
  WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
  adminDeliveryTicketListInputSchema,
  createDeliveryTicketSchema,
  deleteDeliveryTicketInputSchema,
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
  assertManagedLegacySummaryClose,
  assertExistingDeliveryTicketSettlementScope,
  assertDeliveryTicketServiceEligibility,
  assertDeliveryOperationPolicy,
  assertDeliveryTicketMessagePolicy,
  assertWebsiteTicketWorkflow,
  decodeDeliveryTicketCursor,
  deleteManagedDeliveryTicket,
  deliveryLinksFromOperationResults,
  deliveryTicketStatusAfterCustomerMessage,
  deriveTicketQuotaTransition,
  encodeDeliveryTicketCursor,
  isDeliveryTicketAttachmentVisible,
  isCustomerVisibleDeliveryTicket,
  missingIcpCompletionRequirements,
  missingOwnedAttachmentIds,
  planWorkflowCustomerSupplement,
  resolveManagedDomainApplicationCompletion,
  resolveWebsiteBuildStatus,
  selectWorkflowCustomerSupplementChild,
  selectDeliveryTicketQuotaPeriod,
  technicalTicketDedupeKey,
  toPublicDeliveryTicketCreationResult,
  toPublicDeliveryTicketSummary,
  toPublicDeliveryTicketWorkspaceMetadata,
  withSerializedTicketCreation,
  workflowCustomerSupplementInternalMessage,
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

function websiteProfileExecutor(profile: Record<string, unknown> | null) {
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
                      return profile ? [profile] : [];
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
  it("shows customer roots and legacy tickets while hiding workflow children", () => {
    expect(
      isCustomerVisibleDeliveryTicket({
        parentTicketId: null,
        rootTicketId: null,
        isWorkflowContainer: true,
      } as any),
    ).toBe(true);
    expect(
      isCustomerVisibleDeliveryTicket({
        parentTicketId: null,
        rootTicketId: null,
        isWorkflowContainer: false,
      } as any),
    ).toBe(true);
    expect(
      isCustomerVisibleDeliveryTicket({
        parentTicketId: "parent-1",
        rootTicketId: "root-1",
        isWorkflowContainer: false,
      } as any),
    ).toBe(false);
  });

  it("keeps the website-management surface limited to website work", () => {
    expect(ACTIVE_WEBSITE_OPERATION_CATEGORIES).toEqual([
      "domain_application",
      "icp_filing",
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
    ]);
    expect(ACTIVE_WEBSITE_OPERATION_CATEGORIES).not.toContain(
      "question_catalog" as any,
    );
    expect(ACTIVE_WEBSITE_OPERATION_CATEGORIES).not.toContain(
      "initial_monitoring" as any,
    );
    expect(ACTIVE_WEBSITE_OPERATION_CATEGORIES).not.toContain(
      "monitoring_retest" as any,
    );
    expect(ACTIVE_WEBSITE_OPERATION_CATEGORIES).not.toContain(
      "knowledge_base_maintenance" as any,
    );
    expect(WEBSITE_MANAGEMENT_HISTORY_CATEGORIES).toEqual([
      ...ACTIVE_WEBSITE_OPERATION_CATEGORIES,
      "website_style_samples",
      "website_build",
      "site_check",
      "site_rebuild",
    ]);
    expect(WEBSITE_MANAGEMENT_HISTORY_CATEGORIES).not.toContain(
      "question_catalog" as any,
    );
    expect(WEBSITE_MANAGEMENT_HISTORY_CATEGORIES).not.toContain(
      "initial_monitoring" as any,
    );
    expect(QUESTION_MANAGEMENT_HISTORY_CATEGORIES).toEqual([
      "question_review",
      "question_modify",
      "question_delete",
    ]);
    expect(WEBSITE_MANAGEMENT_HISTORY_CATEGORIES).not.toContain(
      "question_review" as any,
    );
  });

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
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: {
          isWorkflowContainer: true,
          workflowDomain: null,
          operation: null,
        },
      }),
    ).toThrow(/客户根需求只能由内部子步骤自动汇总状态/);
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: {
          isWorkflowContainer: false,
          workflowDomain: null,
          operation: "knowledge_delivery",
        },
      }),
    ).toThrow(/知识库交付记录由系统发布流程生成和关闭/);
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: {
          workflowDomain: null,
          operation: null,
          category: "domain_application",
        },
      }),
    ).toThrow(/正式交付需求必须在系统管理员完整处理工作台/);
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

  it("forces explicitly linked credential tickets through unified credential management", () => {
    expect(() =>
      assertManagedTicketCanBeExecutedByAdmin({
        actor: {
          role: "admin",
          username: "system.admin",
          adminAccessLevel: "system_admin",
        },
        ticket: {
          workflowDomain: null,
          operation: "legacy_jenova_api_setup",
          category: "credential_exception",
          credentialTargetUserId: 42,
        },
      }),
    ).toThrow("统一 API Key 管理入口");
  });

  it("allows historical tickets to close with a non-sensitive summary only", () => {
    expect(() =>
      assertManagedLegacySummaryClose({
        publicSummary: "历史事项已核对并处理。",
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedLegacySummaryClose({
        publicSummary: "历史事项已处理。",
        deliveryLinks: [
          { label: "不应接收", url: "https://example.com/result" },
        ],
      }),
    ).toThrow(/只能填写非敏感处理摘要/);
    expect(() =>
      assertManagedLegacySummaryClose({
        publicSummary: "API Key 为 sk_live_12345678901234567890",
      }),
    ).toThrow(/疑似包含密钥或令牌/);
  });

  it("rejects physical deletion from a delivery administrator before database access", async () => {
    await expect(
      deleteManagedDeliveryTicket({
        actor: {
          id: 7,
          role: "admin",
          username: "delivery.admin",
          adminAccessLevel: "delivery_admin",
        } as any,
        userId: 42,
        ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_TICKET_DELETE_FORBIDDEN",
      statusCode: 403,
    });
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
    expect(contentAssetMediaOptionsForMarketEdition("domestic")).toContain(
      "知乎",
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
      "官网需求不回传",
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

  it("routes a root supplement only to the unique waiting workflow child", () => {
    const scheduledChild = {
      id: "scheduled-child",
      status: "scheduled",
      scheduledAt: null,
      assignedProjectAssignmentId: "project-1",
      assignedMemberId: 11,
      workflowDomain: "content_distribution_engineer",
    } as const;
    const waitingChild = {
      id: "waiting-child",
      status: "needs_information",
      scheduledAt: new Date("2026-08-09T05:00:00.000Z"),
      assignedProjectAssignmentId: "project-1",
      assignedMemberId: 11,
      workflowDomain: "content_distribution_engineer",
    } as const;

    expect(
      selectWorkflowCustomerSupplementChild([scheduledChild, waitingChild]),
    ).toBe(waitingChild);
  });

  it("blocks a workflow supplement instead of guessing between waiting children", () => {
    const waitingChild = {
      id: "waiting-child-1",
      status: "needs_information",
      scheduledAt: null,
      assignedProjectAssignmentId: "project-1",
      assignedMemberId: 11,
      workflowDomain: "content_distribution_engineer",
    } as const;

    expect(() =>
      selectWorkflowCustomerSupplementChild([
        waitingChild,
        { ...waitingChild, id: "waiting-child-2" },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "WORKFLOW_SUPPLEMENT_TARGET_AMBIGUOUS",
        statusCode: 409,
      }),
    );
    expect(() =>
      selectWorkflowCustomerSupplementChild([
        { ...waitingChild, status: "in_progress" },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "WORKFLOW_SUPPLEMENT_TARGET_NOT_FOUND",
        statusCode: 409,
      }),
    );
  });

  it("rejects an unassigned workflow supplement target", () => {
    expect(() =>
      selectWorkflowCustomerSupplementChild([
        {
          id: "waiting-child",
          status: "needs_information",
          scheduledAt: null,
          assignedProjectAssignmentId: null,
          assignedMemberId: null,
          workflowDomain: "content_distribution_engineer",
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "WORKFLOW_SUPPLEMENT_TARGET_UNASSIGNED",
        statusCode: 409,
      }),
    );
  });

  it("resumes the child queue and consumes a root reservation at most once", () => {
    const child = {
      id: "waiting-child",
      status: "needs_information",
      scheduledAt: null,
      assignedProjectAssignmentId: "project-1",
      assignedMemberId: 11,
      workflowDomain: "content_distribution_engineer",
    } as const;
    const first = planWorkflowCustomerSupplement({
      rootScheduledAt: null,
      rootQuotaState: "reserved",
      children: [child],
      message: "补充了正式产品资料。",
      attachments: [{ filename: "产品资料.pdf", purpose: "产品事实" }],
    });
    const resumed = planWorkflowCustomerSupplement({
      rootScheduledAt: new Date("2026-08-09T05:00:00.000Z"),
      rootQuotaState: "consumed",
      children: [child],
      message: "补充了正式产品资料。",
      attachments: [],
    });

    expect(first).toMatchObject({
      child,
      childStatus: "scheduled",
      rootStatus: "scheduled",
      rootQuotaState: "consumed",
    });
    expect(resumed).toMatchObject({
      childStatus: "scheduled",
      rootStatus: "in_progress",
      rootQuotaState: "consumed",
    });
  });

  it("records customer message and attachment names in the internal child event", () => {
    const message = workflowCustomerSupplementInternalMessage({
      message: "补充了发布日期和正式口径。",
      attachments: [
        { filename: "品牌事实.pdf", purpose: "事实依据" },
        { filename: "发布时间表.xlsx" },
      ],
    });

    expect(message).toContain("补充了发布日期和正式口径");
    expect(message).toContain("品牌事实.pdf（事实依据）");
    expect(message).toContain("发布时间表.xlsx");
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
      type: "website_operation",
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

  it("requires a completed domain profile before accepting an ICP result", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "icp_filing",
      topic: "https://Example.com/path",
      icpDeclarations: {
        icpNumber: "浙ICP备12345678号",
      },
    });

    await expect(
      assertWebsiteTicketWorkflow(websiteProfileExecutor(null), 42, value),
    ).rejects.toMatchObject({
      code: "DOMAIN_PREREQUISITE_REQUIRED",
      statusCode: 409,
    });
    await expect(
      assertWebsiteTicketWorkflow(
        websiteProfileExecutor({
          domain: "example.com",
          domainStatus: "pending",
          icpStatus: "not_submitted",
        }),
        42,
        value,
      ),
    ).rejects.toMatchObject({
      code: "DOMAIN_PREREQUISITE_REQUIRED",
      statusCode: 409,
    });
  });

  it("accepts an ICP result only when its normalized domain matches the verified domain", async () => {
    const profile = {
      domain: "EXAMPLE.COM.",
      domainStatus: "completed",
      icpStatus: "not_submitted",
    };
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "47a80679-2d3e-42d5-a625-e30ba61c3488",
      type: "website_operation",
      category: "icp_filing",
      topic: "https://Example.com/path",
      icpDeclarations: {
        icpNumber: "浙ICP备12345678号",
      },
    });

    await expect(
      assertWebsiteTicketWorkflow(websiteProfileExecutor(profile), 42, value),
    ).resolves.toEqual({
      profile,
      domain: "example.com",
    });
  });

  it("rejects an ICP result for a domain other than the verified domain", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "8a91d409-7c58-4e3e-9604-f487527077aa",
      type: "website_operation",
      category: "icp_filing",
      topic: "other.example.com",
      icpDeclarations: {
        icpNumber: "浙ICP备12345678号",
      },
    });

    await expect(
      assertWebsiteTicketWorkflow(
        websiteProfileExecutor({
          domain: "example.com",
          domainStatus: "completed",
          icpStatus: "not_submitted",
        }),
        42,
        value,
      ),
    ).rejects.toMatchObject({
      code: "ICP_DOMAIN_MISMATCH",
      statusCode: 400,
    });
  });

  it("keeps an overseas not-required profile closed to ICP resubmission", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "be1021b1-dd58-45f8-a3c5-81b5fab48ef3",
      type: "website_operation",
      category: "icp_filing",
      topic: "other.example.com",
      icpDeclarations: {
        icpNumber: "浙ICP备12345678号",
      },
    });

    await expect(
      assertWebsiteTicketWorkflow(
        websiteProfileExecutor({
          domain: "example.com",
          domainStatus: "completed",
          icpStatus: "not_required",
        }),
        42,
        value,
      ),
    ).rejects.toMatchObject({
      code: "ICP_ALREADY_VERIFIED",
      statusCode: 409,
    });
  });

  it("leaves domain applications unchanged when no site profile exists", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "41cf89a4-a77a-456a-b83c-9b7d9f3d8189",
      type: "website_operation",
      category: "domain_application",
      topic: "https://Example.com/path",
    });

    await expect(
      assertWebsiteTicketWorkflow(websiteProfileExecutor(null), 42, value),
    ).resolves.toEqual({
      profile: null,
      domain: "example.com",
    });
  });

  it("validates bounded user and administrator list filters", () => {
    expect(
      deliveryTicketListInputSchema.parse({
        type: "website_operation",
        surface: "website_management",
        publicStatus: "pending",
        direction: "forward",
      }),
    ).toMatchObject({
      type: "website_operation",
      surface: "website_management",
      publicStatus: "pending",
      direction: "forward",
      limit: 20,
    });
    expect(
      deliveryTicketListInputSchema.parse({
        type: "knowledge_base",
        surface: "question_management",
      }),
    ).toMatchObject({
      type: "knowledge_base",
      surface: "question_management",
    });
    expect(
      deliveryTicketListInputSchema.parse({
        surface: "knowledge_management",
      }),
    ).toMatchObject({ surface: "knowledge_management" });
    expect(
      deliveryTicketListInputSchema.parse({
        type: "knowledge_base",
        surface: "response_logic_management",
      }),
    ).toMatchObject({
      type: "knowledge_base",
      surface: "response_logic_management",
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
      deliveryTicketListInputSchema.parse({ surface: "monitoring" }),
    ).toThrow();
    expect(() =>
      deliveryTicketListInputSchema.parse({
        type: "content_asset",
        surface: "website_management",
      }),
    ).toThrow("需求记录的页面范围与需求类型不匹配");
    expect(() =>
      deliveryTicketListInputSchema.parse({
        type: "content_asset",
        surface: "question_management",
      }),
    ).toThrow("需求记录的页面范围与需求类型不匹配");
    expect(() =>
      deliveryTicketListInputSchema.parse({
        type: "website_operation",
        surface: "knowledge_management",
      }),
    ).toThrow("需求记录的页面范围与需求类型不匹配");
    expect(() =>
      adminDeliveryTicketListInputSchema.parse({
        type: "website_operation",
        surface: "website_management",
      }),
    ).toThrow();
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

  it("requires an exact demand target, revision, and destructive confirmation", () => {
    const input = {
      userId: 42,
      ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
      expectedRevision: 3,
      confirmation: "DELETE_TICKET" as const,
    };
    expect(deleteDeliveryTicketInputSchema.parse(input)).toEqual(input);
    expect(() =>
      deleteDeliveryTicketInputSchema.parse({
        ...input,
        confirmation: "DELETE",
      }),
    ).toThrow();
    expect(() =>
      deleteDeliveryTicketInputSchema.parse({
        ...input,
        expectedRevision: 0,
      }),
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
      "需求列表游标无效",
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
    ).toThrow("需求列表游标无效");
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

  it("exposes only the two-state public delivery contract", () => {
    const value = toPublicDeliveryTicketSummary(internalTicket as any);

    expect(value).toEqual({
      id: internalTicket.id,
      type: "content_asset",
      category: "D1",
      categoryLabel: "知乎问答",
      topic: "如何核验品牌事实",
      sourceQuestionId: null,
      publicStatus: "completed",
      publicStatusLabel: "已完成",
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
      sourceQuestionId: null,
      publicStatus: "completed",
      publicStatusLabel: "已完成",
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
      publicStatus: "pending",
      publicStatusLabel: "待处理",
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

  it("labels a customer-authored question review without exposing the enum", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "knowledge_base",
      category: "question_review",
      operation: "question_maintenance",
    } as any);

    expect(value).toMatchObject({
      type: "knowledge_base",
      category: "question_review",
      categoryLabel: "问题审核",
    });
  });

  it("labels the internal question catalog as keyword configuration only", () => {
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
      categoryLabel: "配置品牌词库",
    });
  });

  it("uses a Chinese category fallback for unknown historical codes", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "website_operation",
      category: "legacy_website_job",
      operation: "legacy_website_job",
    } as any);

    expect(value.categoryLabel).toBe("官网运营需求");
    expect(value.categoryLabel).not.toContain("legacy_website_job");
  });

  it("exposes sourceQuestionId for problem-level customer records", () => {
    const value = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "website_operation",
      category: "question_modify",
      operation: "question_modify",
      sourceQuestionId: "question-7",
      status: "submitted",
      publicSummary: "申请修改为：品牌的新目标问题",
    } as any);

    expect(value).toMatchObject({
      categoryLabel: "问题修改",
      sourceQuestionId: "question-7",
      publicStatus: "pending",
      publicSummary: "申请修改为：品牌的新目标问题",
    });
    expect(value).not.toHaveProperty("assignedMemberId");
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
    const internalMetadata = {
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
        websiteBuildStatus: "completed",
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
    } as any;
    const metadata = toPublicDeliveryTicketWorkspaceMetadata(internalMetadata);

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
      websiteBuildStatus: "completed",
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

    const readyForIcp = toPublicDeliveryTicketWorkspaceMetadata({
      ...internalMetadata,
      siteProfile: {
        ...internalMetadata.siteProfile,
        icpStatus: "not_submitted",
      },
      websiteWorkflow: {
        ...internalMetadata.websiteWorkflow,
        icpStatus: "not_submitted",
        icpCompleted: false,
      },
    });
    expect(readyForIcp.websiteWorkflow.canSubmitIcp).toBe(true);
    expect(readyForIcp.websiteWorkflow.canSubmitContent).toBe(false);
    expect(readyForIcp.websiteWorkflow.icpLockReason).toBeNull();

    const overseasReadyForStyle = toPublicDeliveryTicketWorkspaceMetadata({
      ...internalMetadata,
      marketEdition: "overseas",
      siteProfile: {
        ...internalMetadata.siteProfile,
        domainStatus: "completed",
        icpStatus: "not_required",
      },
      websiteWorkflow: {
        ...internalMetadata.websiteWorkflow,
        domainStatus: "completed",
        icpStatus: "not_required",
        domainCompleted: true,
        icpCompleted: true,
        styleState: "waiting_samples",
        styleRevision: 1,
        styleConfirmed: false,
        websiteBuildStatus: "locked",
        canSelectStyle: false,
        canRequestStyleRevision: false,
        canSubmitContent: false,
        contentLockReason: "正在等待工程师提供三张官网图片风格样例。",
      },
    });
    expect(overseasReadyForStyle.marketEdition).toBe("overseas");
    expect(overseasReadyForStyle.websiteWorkflow).toMatchObject({
      domainCompleted: true,
      icpCompleted: true,
      canSubmitDomain: false,
      canSubmitIcp: false,
      canSubmitContent: false,
      styleState: "waiting_samples",
      contentLockReason: "正在等待工程师提供三张官网图片风格样例。",
    });

    const overseasWaitingForDomain = toPublicDeliveryTicketWorkspaceMetadata({
      ...internalMetadata,
      marketEdition: "overseas",
      siteProfile: null,
      websiteWorkflow: {
        ...internalMetadata.websiteWorkflow,
        domainStatus: "not_started",
        icpStatus: "not_required",
        domainCompleted: false,
        icpCompleted: true,
        styleState: "locked",
        styleRevision: 0,
        styleConfirmed: false,
        websiteBuildStatus: "locked",
        canSelectStyle: false,
        canRequestStyleRevision: false,
        canSubmitContent: false,
      },
    });
    expect(overseasWaitingForDomain.websiteWorkflow).toMatchObject({
      canSubmitDomain: true,
      canSubmitIcp: false,
      icpLockReason: null,
      contentLockReason: "请先完成企业域名注册与确认。",
    });
    expect(
      overseasWaitingForDomain.websiteWorkflow.contentLockReason,
    ).not.toContain("ICP");

    const knowledgeLocked = toPublicDeliveryTicketWorkspaceMetadata({
      ...internalMetadata,
      quotas: {
        ...internalMetadata.quotas,
        website_content_publish: {
          ...internalMetadata.quotas.website_content_publish,
          allowed: false,
          reason:
            "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
        },
      },
    });
    expect(knowledgeLocked.websiteWorkflow).toMatchObject({
      canSubmitDomain: false,
      canSubmitIcp: false,
      canSubmitContent: false,
      contentLockReason: expect.stringContaining("认证知识库"),
    });
  });

  it("requires a canonical public service code only for domestic domain completion", () => {
    expect(
      resolveManagedDomainApplicationCompletion({
        marketEdition: "domestic",
        publicSummary: "备案服务码：SERVICE-123",
      }),
    ).toEqual({
      overseas: false,
      icpServiceCode: "SERVICE-123",
    });
    expect(() =>
      resolveManagedDomainApplicationCompletion({
        marketEdition: "domestic",
        publicSummary: "域名已经核验完成",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ICP_SERVICE_CODE_REQUIRED",
        statusCode: 400,
      }),
    );
    expect(
      resolveManagedDomainApplicationCompletion({
        marketEdition: "overseas",
        publicSummary: "海外版域名已经核验完成",
      }),
    ).toEqual({
      overseas: true,
      icpServiceCode: null,
    });
  });

  it("keeps website content locked until build completion or strong legacy evidence", () => {
    expect(
      resolveWebsiteBuildStatus({
        styleState: "awaiting_selection",
        ticketStatuses: [],
        hasCompletionMilestone: false,
      }),
    ).toBe("locked");
    for (const styleState of ["confirmed", "legacy_confirmed"] as const) {
      expect(
        resolveWebsiteBuildStatus({
          styleState,
          ticketStatuses: [],
          hasCompletionMilestone: false,
        }),
      ).toBe("pending");
      expect(
        resolveWebsiteBuildStatus({
          styleState,
          ticketStatuses: ["rejected", "cancelled"],
          hasCompletionMilestone: false,
        }),
      ).toBe("pending");
    }
    expect(
      resolveWebsiteBuildStatus({
        styleState: "confirmed",
        ticketStatuses: ["completed"],
        hasCompletionMilestone: false,
      }),
    ).toBe("completed");
    expect(
      resolveWebsiteBuildStatus({
        styleState: "legacy_confirmed",
        ticketStatuses: [],
        hasCompletionMilestone: false,
        hasLegacyCompletionEvidence: true,
      }),
    ).toBe("completed");
    expect(
      resolveWebsiteBuildStatus({
        styleState: "legacy_confirmed",
        ticketStatuses: ["submitted"],
        hasCompletionMilestone: false,
        hasLegacyCompletionEvidence: true,
      }),
    ).toBe("pending");
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
          knowledge: {
            status: "display_ready",
            authenticatedForCurrentService: false,
          },
          workflowSteps: [{ id: "knowledge", status: "complete" }],
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
    ).toThrow("普通版不包含AI友好官网管理");
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

  it("requires the plan-specific knowledge publication before asset tickets", () => {
    const basic = {
      service: {
        status: "active",
        planCode: "basic",
        contractId: "contract-basic",
      },
      quotas: { periodId: "period-basic" },
      quotaPeriods: [],
      knowledge: {
        status: "missing",
        authenticatedForCurrentService: false,
      },
      workflowSteps: [{ id: "knowledge", status: "ready" }],
    } as any;
    expect(() =>
      assertDeliveryTicketServiceEligibility(basic, "content_asset"),
    ).toThrow("Website 流程自动同步或服务团队补录知识库");

    const advanced = {
      ...basic,
      service: {
        status: "active",
        planCode: "advanced",
        contractId: "contract-advanced",
      },
      quotas: { periodId: "period-advanced" },
      knowledge: {
        status: "display_ready",
        authenticatedForCurrentService: false,
      },
    } as any;
    expect(() =>
      assertDeliveryTicketServiceEligibility(advanced, "website_operation"),
    ).toThrow("当前服务的认证知识库");
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
    ).toThrow("仅可查看历史需求");
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
