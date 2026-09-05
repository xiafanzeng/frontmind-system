import { z } from "zod";
import { accountMarketEditionSchema } from "./account-edition";
import { ALL_CONTENT_ASSET_MEDIA_OPTIONS } from "./delivery-catalog";

export const deliveryTicketTypeSchema = z.enum([
  "content_asset",
  "website_operation",
  "knowledge_base",
]);
export type DeliveryTicketType = z.infer<typeof deliveryTicketTypeSchema>;

export const deliveryTicketQuotaPoolSchema = z.enum([
  "content_asset_publish",
  "website_content_publish",
]);
export type DeliveryTicketQuotaPool = z.infer<
  typeof deliveryTicketQuotaPoolSchema
>;

export const websiteOperationCategorySchema = z.enum([
  "domain_application",
  "icp_filing",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
  "knowledge_base_maintenance",
  // Legacy categories remain parseable for historical records. New ticket
  // creation is restricted by resolveDeliveryTicketQuotaPool below.
  "blog_update",
  "company_blog",
  "product_page_content",
  "case_study",
  "landing_page_content",
  "content_correction",
  "domain_https",
  "privacy_compliance",
  "metadata_tdk",
  "structured_data",
  "image_accessibility",
  "crawl_directives",
  "url_governance",
  "webmaster_indexing",
  "local_service",
  "multilingual_region",
  "verification_code",
  "bulk_redirect",
  "technical_diagnosis",
  "site_rebuild",
  "prelaunch_review",
  "llms_txt_experiment",
]);
export type WebsiteOperationCategory = z.infer<
  typeof websiteOperationCategorySchema
>;

/**
 * The only website-operation categories that may be created or completed as
 * quota-bearing content work. Domain/ICP prerequisites and legacy technical
 * checks deliberately do not belong to this schema.
 */
export const websiteContentCategorySchema = z.enum([
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
]);
export type WebsiteContentCategory = z.infer<
  typeof websiteContentCategorySchema
>;

export const deliveryTicketStatusSchema = z.enum([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
]);
export type DeliveryTicketStatus = z.infer<typeof deliveryTicketStatusSchema>;

export const deliveryTicketQuotaStateSchema = z.enum([
  "reserved",
  "consumed",
  "released",
]);
export type DeliveryTicketQuotaState = z.infer<
  typeof deliveryTicketQuotaStateSchema
>;

export const preferredContentMediaSchema = z.enum(
  ALL_CONTENT_ASSET_MEDIA_OPTIONS,
);
export type PreferredContentMedia = z.infer<typeof preferredContentMediaSchema>;

export const deliveryTicketAttachmentInputSchema = z
  .object({
    fileId: z.string().trim().min(1).max(255),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().max(255).optional(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024)
      .optional(),
    sha256: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    purpose: z.string().trim().max(160).optional(),
    authorization: z
      .enum(["owned", "licensed", "public", "authorization_pending"])
      .optional(),
    copyrightNote: z.string().trim().max(2_000).optional(),
  })
  .strict();
export type DeliveryTicketAttachmentInput = z.infer<
  typeof deliveryTicketAttachmentInputSchema
>;

const optionalTrimmedText = (maximum: number) =>
  z.string().trim().max(maximum).optional();

const httpUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "仅支持 http 或 https 链接");

const targetPageSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (value.startsWith("/") && !value.startsWith("//")) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "目标页面必须是站内路径或完整的 http/https 链接");

export const icpNonSensitiveDeclarationsSchema = z
  .object({
    icpNumber: z.string().trim().min(1, "请填写 ICP 主体备案号").max(128),
  })
  .strict();
export type IcpNonSensitiveDeclarations = z.infer<
  typeof icpNonSensitiveDeclarationsSchema
>;

export const createDeliveryTicketSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    type: z.enum(["content_asset", "website_operation"]),
    category: optionalTrimmedText(64),
    topic: optionalTrimmedText(512),
    title: optionalTrimmedText(512),
    description: optionalTrimmedText(50_000),
    preferredMedia: preferredContentMediaSchema.optional(),
    icpProvince: optionalTrimmedText(64),
    icpDeclarations: icpNonSensitiveDeclarationsSchema.optional(),
    targetPage: targetPageSchema.optional(),
    materialUrls: z.array(httpUrlSchema).max(30).default([]),
    knowledgeSnapshotId: z.string().uuid().optional(),
    attachments: z
      .array(deliveryTicketAttachmentInputSchema)
      .max(30)
      .default([]),
  })
  .refine(
    (value) =>
      Boolean(
        value.category?.trim() || value.topic?.trim() || value.title?.trim(),
      ),
    {
      message: "请至少填写内容类型、话题方向或需求标题",
      path: ["topic"],
    },
  )
  .superRefine((value, context) => {
    if (value.category === "icp_filing" && !value.icpDeclarations) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["icpDeclarations"],
        message: "请在阿里云完成备案后填写 ICP 主体备案号",
      });
    }
    if (value.category === "icp_filing" && value.attachments.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message:
          "域名与 ICP 备案结果不接收附件，请仅填写已备案域名和 ICP 主体备案号",
      });
    }
    if (
      value.category === "knowledge_base_maintenance" &&
      !value.knowledgeSnapshotId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeSnapshotId"],
        message: "维护需求必须关联当前已发布知识库",
      });
    }
  });
export type CreateDeliveryTicketInput = z.infer<
  typeof createDeliveryTicketSchema
>;

export const deliveryTicketDetailInputSchema = z.object({
  ticketId: z.string().uuid(),
});

export const deleteDeliveryTicketInputSchema = z
  .object({
    userId: z.number().int().positive(),
    ticketId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    confirmation: z.literal("DELETE_TICKET"),
  })
  .strict();
export type DeleteDeliveryTicketInput = z.infer<
  typeof deleteDeliveryTicketInputSchema
>;

/**
 * Delivery-ticket lists use an opaque, server-issued keyset cursor. The
 * client can retain or discard the cursor, but must never need to interpret
 * the sort key embedded in it.
 */
const deliveryTicketListBaseSchema = z
  .object({
    type: deliveryTicketTypeSchema.optional(),
    publicStatus: z.enum(["pending", "completed"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).max(1_024).optional(),
    // tRPC's TanStack infinite-query adapter injects the fetch direction into
    // the serialized input. It is transport metadata only; list services keep
    // using the opaque cursor and deterministic server-side sort order.
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

export const deliveryTicketListInputSchema = deliveryTicketListBaseSchema
  .extend({
    surface: z
      .enum([
        "website_management",
        "question_management",
        "knowledge_management",
        "response_logic_management",
      ])
      .optional(),
  })
  .refine(
    (value) =>
      !value.surface ||
      (value.surface === "website_management" &&
        value.type === "website_operation") ||
      (value.surface === "question_management" &&
        value.type === "knowledge_base") ||
      (value.surface === "knowledge_management" && !value.type) ||
      (value.surface === "response_logic_management" &&
        value.type === "knowledge_base"),
    {
      path: ["surface"],
      message: "需求记录的页面范围与需求类型不匹配，请刷新页面后重试。",
    },
  );
export type DeliveryTicketListInput = z.infer<
  typeof deliveryTicketListInputSchema
>;

export const adminDeliveryTicketListInputSchema =
  deliveryTicketListBaseSchema.extend({
    userId: z.number().int().positive().optional(),
    assignedAdminId: z.number().int().positive().optional(),
    query: z.string().trim().max(100).optional(),
    status: deliveryTicketStatusSchema.optional(),
    quotaPeriodId: z.string().uuid().optional(),
    order: z.enum(["updated_desc", "created_asc"]).default("updated_desc"),
  });
export type AdminDeliveryTicketListInput = z.infer<
  typeof adminDeliveryTicketListInputSchema
>;

/**
 * Commercial quota changes are deliberately period-bound and revisioned.
 * `quotaPeriodId` is required at the API boundary so a stale administrator
 * screen cannot silently modify a newly-started service period.
 */
export const adjustDeliveryTicketQuotaSchema = z.object({
  userId: z.number().int().positive(),
  quotaPeriodId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  contentAssetPublishLimit: z.number().int().nonnegative().max(1_000_000),
  websiteContentPublishLimit: z.number().int().nonnegative().max(1_000_000),
  reason: z.string().trim().min(2).max(2_000),
});
export type AdjustDeliveryTicketQuotaInput = z.infer<
  typeof adjustDeliveryTicketQuotaSchema
>;

export const addDeliveryTicketMessageSchema = z.object({
  ticketId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  message: z.string().trim().min(1).max(50_000),
  attachments: z.array(deliveryTicketAttachmentInputSchema).max(30).default([]),
});
export type AddDeliveryTicketMessageInput = z.infer<
  typeof addDeliveryTicketMessageSchema
>;

export const updateDeliveryTicketSchema = z.object({
  ticketId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  status: z.literal("completed"),
  publicMessage: z.string().trim().max(50_000).optional(),
  publicSummary: z.string().trim().max(50_000).nullable().optional(),
  deliveryLinks: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(160),
        url: httpUrlSchema,
      }),
    )
    .max(30)
    .optional(),
  verifiedDomain: z.string().trim().max(255).optional(),
  internalNote: z.string().trim().max(50_000).nullable().optional(),
});
export type UpdateDeliveryTicketInput = z.infer<
  typeof updateDeliveryTicketSchema
>;

export const websiteContentTemplateRecordSchema = z
  .object({
    ticketId: z.string().uuid(),
    revision: z.number().int().positive(),
    category: websiteContentCategorySchema,
    topic: z.string().trim().max(512),
    publicSummary: z.string().trim().max(50_000),
    complete: z.boolean(),
  })
  .strict();
export type WebsiteContentTemplateRecord = z.infer<
  typeof websiteContentTemplateRecordSchema
>;

/**
 * Administrator current-content template for the five formal website content
 * categories. Every mutable row carries an optimistic revision and immutable
 * category/topic snapshots so a file cannot be moved between tickets.
 */
export const websiteContentTemplateSchema = z
  .object({
    format: z.literal("frontmind.website-content-template.v1"),
    workspaceUserId: z.number().int().positive(),
    exportedAt: z.string().datetime({ offset: true }),
    records: z.array(websiteContentTemplateRecordSchema).max(5_000),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.records.forEach((record, index) => {
      if (seen.has(record.ticketId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["records", index, "ticketId"],
          message: "同一需求在模板中只能出现一次",
        });
      }
      seen.add(record.ticketId);
    });
  });
export type WebsiteContentTemplate = z.infer<
  typeof websiteContentTemplateSchema
>;

export const adminAddDeliveryTicketMessageSchema =
  addDeliveryTicketMessageSchema.extend({
    userId: z.number().int().positive(),
    visibility: z.enum(["customer", "internal"]).default("customer"),
    attachmentKind: z.enum(["input", "deliverable"]).default("deliverable"),
  });

export const deliverySiteCheckStatusSchema = z.enum([
  "not_checked",
  "pending",
  "passed",
  "warning",
  "failed",
  "not_applicable",
]);
export type DeliverySiteCheckStatus = z.infer<
  typeof deliverySiteCheckStatusSchema
>;

export const updateWorkspaceSiteProfileSchema = z.object({
  userId: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
  domain: z.string().trim().max(255),
  siteMode: z.enum(["managed", "external", "unknown"]),
  domainStatus: z
    .enum(["not_started", "pending", "completed"])
    .default("not_started"),
  icpProvince: z.string().trim().max(64).nullable().optional(),
  icpNumber: z.string().trim().max(128).nullable().optional(),
  icpStatus: z.enum([
    "not_submitted",
    "preparing",
    "submitted",
    "approved",
    "rejected",
    "not_required",
  ]),
});

export const upsertWorkspaceSiteCheckSchema = z.object({
  userId: z.number().int().positive(),
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().trim().min(1).max(160),
  status: deliverySiteCheckStatusSchema,
  summary: z.string().trim().max(4_000).optional(),
  evidence: z.string().trim().max(8_000).optional(),
  source: z.string().trim().max(2_048).optional(),
  checkedAt: z.number().int().nonnegative().nullable().optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const DELIVERY_TICKET_LIMITS = Object.freeze({
  basic: Object.freeze({
    content_asset_publish: 1,
    website_content_publish: 0,
  }),
  knowledge: Object.freeze({
    content_asset_publish: 0,
    website_content_publish: 0,
  }),
  advanced: Object.freeze({
    content_asset_publish: 5,
    website_content_publish: 20,
  }),
  luxury: Object.freeze({
    content_asset_publish: 20,
    website_content_publish: 100,
  }),
});

const WEBSITE_OPERATION_CATEGORIES = new Set<string>(
  websiteOperationCategorySchema.options,
);
const WEBSITE_CONTENT_PUBLISH_CATEGORIES = new Set<string>([
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
]);
const WEBSITE_PREREQUISITE_CATEGORIES = new Set<string>([
  "domain_application",
  "icp_filing",
]);
export const ACTIVE_WEBSITE_OPERATION_CATEGORIES = Object.freeze([
  "domain_application",
  "icp_filing",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
] as const);

/**
 * Website-management history includes the internal website handoffs in
 * addition to customer-created prerequisite/content work. Monitoring and
 * knowledge operations deliberately remain outside this surface.
 */
export const WEBSITE_MANAGEMENT_HISTORY_CATEGORIES = Object.freeze([
  ...ACTIVE_WEBSITE_OPERATION_CATEGORIES,
  "website_style_samples",
  "website_build",
  "site_check",
  "site_rebuild",
] as const);

export const QUESTION_MANAGEMENT_HISTORY_CATEGORIES = Object.freeze([
  "question_review",
  "question_modify",
  "question_delete",
] as const);

/**
 * The client never chooses a quota pool directly. Known website categories
 * are authoritative; all other categories must agree with the submitted type.
 */
export function resolveDeliveryTicketQuotaPool(input: {
  type: DeliveryTicketType;
  category?: string | null;
}): DeliveryTicketQuotaPool | null {
  const category = input.category?.trim() || "";
  if (input.type === "knowledge_base") {
    throw new Error("知识库内部需求只能由专用流程创建");
  }
  if (input.type === "website_operation") {
    if (!WEBSITE_OPERATION_CATEGORIES.has(category)) {
      throw new Error("请选择有效的官网运营类别");
    }
    if (
      !WEBSITE_CONTENT_PUBLISH_CATEGORIES.has(category) &&
      !WEBSITE_PREREQUISITE_CATEGORIES.has(category) &&
      category !== "knowledge_base_maintenance"
    ) {
      throw new Error("该旧版官网技术类别已停止接受新需求");
    }
    if (category === "knowledge_base_maintenance") return null;
    if (WEBSITE_CONTENT_PUBLISH_CATEGORIES.has(category)) {
      return "website_content_publish";
    }
    return null;
  }
  if (WEBSITE_OPERATION_CATEGORIES.has(category)) {
    if (input.type === "content_asset") {
      throw new Error("官网运营类别不能使用内容资产额度");
    }
  }
  return "content_asset_publish";
}

export type DeliveryTicketQuota = {
  type: DeliveryTicketQuotaPool;
  allowed: boolean;
  used: number;
  reserved: number;
  consumed: number;
  limit: number;
  remaining: number;
  periodId: string | null;
  /** Present for database-backed periods; optional only for legacy fixtures. */
  revision?: number | null;
  validFrom: number | null;
  validUntil: number | null;
  reason: string | null;
};

export const DELIVERY_TICKET_STATUS_LABELS: Record<
  DeliveryTicketStatus,
  string
> = Object.freeze({
  submitted: "已提交",
  needs_information: "待补充资料",
  scheduled: "已排期",
  in_progress: "处理中",
  completed: "已完成",
  rejected: "未受理",
  cancelled: "已取消",
});

export type DeliveryTicketPublicStatus = "pending" | "completed";

export function deliveryTicketPublicStatus(
  status: DeliveryTicketStatus,
): DeliveryTicketPublicStatus {
  return status === "completed" ||
    status === "rejected" ||
    status === "cancelled"
    ? "completed"
    : "pending";
}

export const DELIVERY_TICKET_PUBLIC_STATUS_LABELS: Record<
  DeliveryTicketPublicStatus,
  string
> = Object.freeze({
  pending: "待处理",
  completed: "已完成",
});

export const publicDeliveryLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(160),
    url: httpUrlSchema,
  })
  .strict();
export type PublicDeliveryLink = z.infer<typeof publicDeliveryLinkSchema>;

const publicDeliveryTicketSummaryBaseSchema = z.object({
  id: z.string().uuid(),
  type: deliveryTicketTypeSchema,
  category: z.string().trim().max(64).nullable(),
  categoryLabel: z.string().trim().max(160).nullable(),
  topic: z.string().trim().max(512).nullable(),
  sourceQuestionId: z.string().trim().max(191).nullable(),
  publicStatus: z.enum(["pending", "completed"]),
  publicStatusLabel: z.enum(["待处理", "已完成"]),
  publicSummary: z.string().max(50_000).nullable(),
  knowledgeSnapshotId: z.string().uuid().nullable().optional(),
});

export const publicContentAssetTicketSummarySchema =
  publicDeliveryTicketSummaryBaseSchema
    .extend({
      type: z.literal("content_asset"),
      deliveryLinks: z.array(publicDeliveryLinkSchema).max(30),
    })
    .strict();

export const publicWebsiteTicketSummarySchema =
  publicDeliveryTicketSummaryBaseSchema
    .extend({
      type: z.literal("website_operation"),
    })
    .strict();

export const publicKnowledgeBaseTicketSummarySchema =
  publicDeliveryTicketSummaryBaseSchema
    .extend({
      type: z.literal("knowledge_base"),
    })
    .strict();

/**
 * Customer lists deliberately expose only the request type/topic, the two
 * public states and completed public delivery data. Commercial allocation,
 * raw workflow states, assignees and timestamps remain administrator-only.
 */
export const publicDeliveryTicketSummarySchema = z.discriminatedUnion("type", [
  publicContentAssetTicketSummarySchema,
  publicWebsiteTicketSummarySchema,
  publicKnowledgeBaseTicketSummarySchema,
]);
export type PublicDeliveryTicketSummary = z.infer<
  typeof publicDeliveryTicketSummarySchema
>;

export const publicDeliveryTicketEventSchema = z
  .object({
    id: z.string().uuid(),
    actorRole: z.enum(["user", "admin", "delivery_member", "system"]),
    actorLabel: z.enum(["用户", "服务团队"]),
    message: z.string().max(50_000).nullable(),
    createdAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PublicDeliveryTicketEvent = z.infer<
  typeof publicDeliveryTicketEventSchema
>;

export const publicDeliveryTicketAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().max(255).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    purpose: z.string().trim().max(160).nullable(),
    kind: z.enum(["input", "deliverable"]).nullable(),
    createdAt: z.number().int().nonnegative().nullable(),
    downloadUrl: z
      .string()
      .regex(/^\/api\/delivery-ticket-attachments\/[0-9a-f-]{36}\/content$/),
  })
  .strict();
export type PublicDeliveryTicketAttachment = z.infer<
  typeof publicDeliveryTicketAttachmentSchema
>;

export const publicContentAssetTicketDetailSchema = z
  .object({
    ticket: publicContentAssetTicketSummarySchema
      .extend({
        preferredMedia: preferredContentMediaSchema.nullable(),
        revision: z.number().int().positive(),
        canReply: z.boolean(),
      })
      .strict(),
    events: z.array(publicDeliveryTicketEventSchema),
    attachments: z.array(publicDeliveryTicketAttachmentSchema).max(100),
  })
  .strict();

export const publicWebsiteTicketDetailSchema = z
  .object({
    ticket: publicWebsiteTicketSummarySchema
      .extend({
        revision: z.number().int().positive(),
        canReply: z.boolean(),
        canAttach: z.boolean(),
      })
      .strict(),
    events: z.array(publicDeliveryTicketEventSchema),
    attachments: z.array(publicDeliveryTicketAttachmentSchema).max(100),
  })
  .strict();

export const publicKnowledgeBaseTicketDetailSchema = z
  .object({
    ticket: publicKnowledgeBaseTicketSummarySchema,
    events: z.array(publicDeliveryTicketEventSchema),
  })
  .strict();

export const publicDeliveryTicketDetailSchema = z.union([
  publicContentAssetTicketDetailSchema,
  publicWebsiteTicketDetailSchema,
  publicKnowledgeBaseTicketDetailSchema,
]);
export type PublicDeliveryTicketDetail = z.infer<
  typeof publicDeliveryTicketDetailSchema
>;

export const publicDeliveryTicketQuotaSchema = z
  .object({
    type: deliveryTicketQuotaPoolSchema,
    allowed: z.boolean(),
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    reason: z.string().nullable(),
  })
  .strict();
export type PublicDeliveryTicketQuota = z.infer<
  typeof publicDeliveryTicketQuotaSchema
>;

const publicContentAssetCatalogItemSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    code: z.string().trim().min(1).max(64),
    group: z.string().trim().min(1).max(64),
    type: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const publicWebsiteContentCatalogItemSchema = z
  .object({
    value: z.enum([
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
    ]),
    label: z.string().trim().min(1).max(160),
  })
  .strict();

export const publicDeliveryTicketWorkspaceMetadataSchema = z
  .object({
    quotas: z
      .object({
        content_asset_publish: publicDeliveryTicketQuotaSchema,
        website_content_publish: publicDeliveryTicketQuotaSchema,
      })
      .strict(),
    contentAssetCatalog: z.array(publicContentAssetCatalogItemSchema),
    websiteContentCatalog: z.array(publicWebsiteContentCatalogItemSchema),
    marketEdition: accountMarketEditionSchema,
    preferredMediaOptions: z.array(preferredContentMediaSchema),
    siteOpsProjectActive: z.boolean().default(false),
    deliveryOwners: z
      .object({
        aiOperations: z.boolean(),
        monitoringOptimization: z.boolean(),
        contentDistribution: z.boolean(),
      })
      .strict(),
    websiteWorkflow: z
      .object({
        domainCompleted: z.boolean(),
        icpCompleted: z.boolean(),
        styleState: z.enum([
          "locked",
          "waiting_samples",
          "awaiting_selection",
          "revision_requested",
          "confirmed",
          "legacy_confirmed",
        ]),
        styleRevision: z.number().int().nonnegative(),
        styleBatch: z
          .object({
            id: z.string().uuid(),
            ordinal: z.number().int().positive(),
            status: z.enum([
              "published",
              "revision_requested",
              "selected",
              "superseded",
            ]),
            engineerNote: z.string().nullable(),
            publishedAt: z.number().int().nonnegative().nullable(),
            samples: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    label: z.string().trim().min(1).max(160),
                    note: z.string().nullable(),
                    sortOrder: z.number().int().positive(),
                    attachmentId: z.string().uuid(),
                    filename: z.string().trim().min(1).max(512),
                    mimeType: z.string().nullable(),
                    imageUrl: z.string().trim().min(1),
                  })
                  .strict(),
              )
              .length(3),
          })
          .strict()
          .nullable(),
        selectedStyleSampleId: z.string().uuid().nullable(),
        styleConfirmed: z.boolean(),
        websiteBuildStatus: z.enum(["locked", "pending", "completed"]),
        canSelectStyle: z.boolean(),
        canRequestStyleRevision: z.boolean(),
        canSubmitDomain: z.boolean(),
        canSubmitIcp: z.boolean(),
        canSubmitContent: z.boolean(),
        domainLockReason: z.string().nullable(),
        icpLockReason: z.string().nullable(),
        contentLockReason: z.string().nullable(),
        icpProvinceOptions: z.array(z.string().trim().min(1).max(64)),
      })
      .strict(),
  })
  .strict();
export type PublicDeliveryTicketWorkspaceMetadata = z.infer<
  typeof publicDeliveryTicketWorkspaceMetadataSchema
>;

export const deliveryOperationResultSchema = z.object({
  platform: z.string().trim().min(1).max(160),
  targetUrl: httpUrlSchema,
  executedAt: z.number().int().nonnegative(),
  resultStatus: z.enum(["success", "failed", "pending_confirmation"]),
  platformMessage: z.string().trim().max(8_000).optional(),
  screenshotFileId: z.string().trim().min(1).max(255).optional(),
});
export type DeliveryOperationResult = z.infer<
  typeof deliveryOperationResultSchema
>;

export const recordDeliveryOperationSchema = z.object({
  userId: z.number().int().positive(),
  ticketId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  clientRequestId: z.string().uuid(),
  result: deliveryOperationResultSchema,
  attachments: z.array(deliveryTicketAttachmentInputSchema).max(20).default([]),
});

export const redirectPreviewRowSchema = z.object({
  row: z.number().int().positive(),
  sourceUrl: z.string(),
  targetUrl: z.string(),
  statusCode: z.number().int(),
});

export const previewRedirectWorkbookSchema = z.object({
  userId: z.number().int().positive(),
  fileId: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(512),
});

export const confirmRedirectWorkbookSchema = z.object({
  userId: z.number().int().positive(),
  ticketId: z.string().uuid(),
  previewId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
