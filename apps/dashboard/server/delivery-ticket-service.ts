import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  deliveryTicketAttachments,
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  deliveryWorkflowMilestones,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  serviceContracts,
  serviceQuotaPeriods,
  siteProjects,
  upstreamResources,
  userAdminAssignments,
  users,
  workspaceSiteChecks,
  workspaceSiteProfiles,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteStyleWorkflows,
} from "../drizzle/schema";
import {
  QUESTION_MANAGEMENT_HISTORY_CATEGORIES,
  WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
  DELIVERY_TICKET_PUBLIC_STATUS_LABELS,
  DELIVERY_TICKET_STATUS_LABELS,
  deliveryOperationResultSchema,
  deliveryTicketPublicStatus,
  icpNonSensitiveDeclarationsSchema,
  publicContentAssetTicketDetailSchema,
  publicKnowledgeBaseTicketDetailSchema,
  publicDeliveryTicketSummarySchema,
  publicDeliveryTicketWorkspaceMetadataSchema,
  publicWebsiteTicketDetailSchema,
  resolveDeliveryTicketQuotaPool,
  type AddDeliveryTicketMessageInput,
  type AdminDeliveryTicketListInput,
  type CreateDeliveryTicketInput,
  type DeliveryTicketAttachmentInput,
  type DeliveryTicketListInput,
  type DeliveryTicketQuota,
  type DeliveryTicketQuotaPool,
  type DeliveryTicketStatus,
  type DeliveryTicketType,
  type DeliveryOperationResult,
  type PublicDeliveryTicketSummary,
  type PublicDeliveryTicketWorkspaceMetadata,
  type UpdateDeliveryTicketInput,
} from "../shared/delivery-ticket";
import {
  ALL_CONTENT_ASSET_MEDIA_OPTIONS,
  CONTENT_ASSET_CATALOG,
  ICP_PROVINCES,
  WEBSITE_CONTENT_CATALOG,
  contentAssetMediaOptionsForMarketEdition,
} from "../shared/delivery-catalog";
import {
  deliveryWorkflowOperationSchema,
  type DeliveryRoleType,
} from "../shared/delivery-roles";
import {
  deliveryActorRoleLabel,
  deliveryCategoryLabel,
  deliveryEventDisplayMessage,
} from "../shared/delivery-ticket-presentation";
import { deliverySummaryLooksLikeCredentialSecret } from "../shared/delivery-ticket-security";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "../shared/siteops-branding";
import type { AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import {
  loadUnifiedDeliveryQuotaUsageRows,
  unifiedActiveQuotaCountsByPeriod,
} from "./delivery-quota-usage";
import { assertWorkspaceAccess, isSystemAdmin } from "./dashboard-service";
import {
  getServicePortal,
  servicePortalHasRequiredKnowledge,
} from "./service-entitlement";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import { DeliveryTicketError } from "./delivery-ticket-error";
import {
  deleteDeliveryTicketImmediately,
  DeliveryTicketImmediateDeleteConflictError,
} from "./delivery-ticket-retention";
export { DeliveryTicketError } from "./delivery-ticket-error";

export function assertManagedTicketCanBeExecutedByAdmin(input: {
  actor: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">;
  ticket: {
    isWorkflowContainer?: boolean | null;
    workflowDomain?: DeliveryRoleType | null;
    operation?: string | null;
    category?: string | null;
    credentialTargetUserId?: number | null;
  };
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new DeliveryTicketError(
      "DELIVERY_ADMIN_TICKET_EXECUTION_FORBIDDEN",
      "只有系统管理员或对应岗位工程师可以处理需求；交付管理员仅负责查看、沟通与协调。",
      403,
    );
  }
  if (input.ticket.credentialTargetUserId) {
    throw new DeliveryTicketError(
      "CREDENTIAL_TICKET_REQUIRES_UNIFIED_MANAGEMENT",
      "凭据异常需求只能在统一 API Key 管理入口配置并验证成功后自动关闭。",
      409,
    );
  }
  if (input.ticket.isWorkflowContainer) {
    throw new DeliveryTicketError(
      "WORKFLOW_CONTAINER_REQUIRES_AUTOMATIC_AGGREGATION",
      "客户根需求只能由内部子步骤自动汇总状态，不能人工提前完成。",
      409,
    );
  }
  if (input.ticket.operation === "knowledge_delivery") {
    throw new DeliveryTicketError(
      "SYSTEM_DELIVERY_RECORD_READ_ONLY",
      "知识库交付记录由系统发布流程生成和关闭，不能人工处理。",
      409,
    );
  }
  const formalWorkflow =
    Boolean(input.ticket.workflowDomain) ||
    deliveryWorkflowOperationSchema.safeParse(input.ticket.operation).success ||
    ["domain_application", "icp_filing"].includes(input.ticket.category ?? "");
  if (!formalWorkflow) return;
  throw new DeliveryTicketError(
    "ROLE_OWNED_TICKET_REQUIRES_WORKBENCH",
    "正式交付需求必须在系统管理员完整处理工作台中按对应岗位规则执行。",
    409,
  );
}

export function assertManagedLegacySummaryClose(input: {
  publicSummary: string;
  publicMessage?: string | null;
  deliveryLinks?: Array<{ label: string; url: string }> | null;
  verifiedDomain?: string | null;
  internalNote?: string | null;
}) {
  if (
    nonEmpty(input.publicMessage) ||
    (input.deliveryLinks?.length ?? 0) > 0 ||
    nonEmpty(input.verifiedDomain) ||
    nonEmpty(input.internalNote)
  ) {
    throw new DeliveryTicketError(
      "LEGACY_TICKET_SUMMARY_ONLY",
      "历史需求只能填写非敏感处理摘要后关闭，不能提交链接、交付消息或专用字段。",
      409,
    );
  }
  if (deliverySummaryLooksLikeCredentialSecret(input.publicSummary)) {
    throw new DeliveryTicketError(
      "DELIVERY_SUMMARY_CONTAINS_CREDENTIAL",
      "结果摘要疑似包含密钥或令牌，请仅填写已配置、已验证等非敏感结论。",
      409,
    );
  }
}

export async function deleteManagedDeliveryTicket(input: {
  actor: AuthenticatedUser;
  userId: number;
  ticketId: string;
  expectedRevision: number;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_DELETE_FORBIDDEN",
      "只有系统管理员可以永久删除需求。",
      403,
    );
  }
  let result: Awaited<ReturnType<typeof deleteDeliveryTicketImmediately>>;
  try {
    result = await deleteDeliveryTicketImmediately({
      userId: input.userId,
      ticketId: input.ticketId,
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    if (error instanceof DeliveryTicketImmediateDeleteConflictError) {
      throw new DeliveryTicketError(
        "DELIVERY_TICKET_REVISION_CONFLICT",
        "需求已更新，请刷新后再删除。",
        409,
      );
    }
    throw error;
  }
  if (result.outcome === "not_found") {
    throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
  }
  if (result.outcome === "revision_conflict") {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_REVISION_CONFLICT",
      "需求已更新，请刷新后再删除。",
      409,
    );
  }
  if (result.outcome === "workflow_child_forbidden") {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_WORKFLOW_CHILD_DELETE_FORBIDDEN",
      "内部工作流子步骤不能单独永久删除；如需移除整条业务流程，请删除客户根需求。",
      409,
    );
  }
  if (result.outcome !== "deleted" || result.tickets !== 1) {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_DELETE_FAILED",
      "需求删除失败，请刷新后重试。",
      409,
    );
  }
  return {
    success: true as const,
    ticketId: input.ticketId,
  };
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new DeliveryTicketError(
      "DATABASE_UNAVAILABLE",
      "数据库暂时不可用。",
      503,
    );
  }
  return db;
}

function epoch(value: Date | null | undefined) {
  return value?.getTime() ?? null;
}

type DeliveryTicketCursor = {
  version: 1;
  updatedAt: number;
  id: string;
  order?: "created_asc";
};

const DELIVERY_TICKET_CURSOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Cursor payloads intentionally expose no contract or account identifiers.
 * They are opaque to clients and only encode the deterministic sort boundary.
 */
export function encodeDeliveryTicketCursor(input: {
  updatedAt: Date;
  id: string;
  order?: "created_asc";
}) {
  const value: DeliveryTicketCursor = {
    version: 1,
    updatedAt: input.updatedAt.getTime(),
    id: input.id,
    ...(input.order ? { order: input.order } : {}),
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeDeliveryTicketCursor(
  cursor: string,
): DeliveryTicketCursor {
  try {
    const normalized = cursor.trim();
    if (
      !normalized ||
      normalized.length > 1_024 ||
      !/^[A-Za-z0-9_-]+$/.test(normalized)
    ) {
      throw new Error("invalid encoding");
    }
    const value = JSON.parse(
      Buffer.from(normalized, "base64url").toString("utf8"),
    ) as Partial<DeliveryTicketCursor>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.updatedAt) ||
      Number(value.updatedAt) < 0 ||
      !value.id ||
      !DELIVERY_TICKET_CURSOR_ID_PATTERN.test(value.id) ||
      (value.order !== undefined && value.order !== "created_asc") ||
      Number.isNaN(new Date(Number(value.updatedAt)).getTime())
    ) {
      throw new Error("invalid payload");
    }
    return {
      version: 1,
      updatedAt: Number(value.updatedAt),
      id: value.id,
      ...(value.order ? { order: value.order } : {}),
    };
  } catch {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_CURSOR_INVALID",
      "需求列表游标无效，请刷新后重试。",
      400,
    );
  }
}

function nonEmpty(value: string | null | undefined) {
  return value?.trim() || null;
}

function deliveryTicketSearchPattern(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
}

function normalizeTargetPage(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return "/";
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(raw)
        ? raw
        : `https://frontmind.invalid${raw.startsWith("/") ? "" : "/"}${raw}`,
    );
    const pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
    return `${pathname || "/"}${parsed.search}`;
  } catch {
    return raw.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  }
}

function normalizeDomain(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function domainServiceCodeFromPublicSummary(value: string | null | undefined) {
  const match = value?.trim().match(/^备案服务码：\s*([^\r\n]+)$/u);
  const code = match?.[1]?.trim() || null;
  return code && code.length <= 512 ? code : null;
}

export function resolveManagedDomainApplicationCompletion(input: {
  marketEdition: "domestic" | "overseas";
  publicSummary: string | null | undefined;
}) {
  const overseas = input.marketEdition === "overseas";
  const icpServiceCode = domainServiceCodeFromPublicSummary(
    input.publicSummary,
  );
  if (!overseas && !icpServiceCode) {
    throw new DeliveryTicketError(
      "ICP_SERVICE_CODE_REQUIRED",
      "完成国内域名需求前必须按“备案服务码：...”格式填写要返回给客户的备案服务码。",
      400,
    );
  }
  return { overseas, icpServiceCode };
}

const WEBSITE_CONTENT_CATEGORIES = new Set<string>(
  WEBSITE_CONTENT_CATALOG.map((item) => item.value),
);

export function websiteTicketAllowsPublicAttachments(
  category: string | null | undefined,
) {
  return Boolean(category && WEBSITE_CONTENT_CATEGORIES.has(category));
}

export function deliveryTicketStatusAfterCustomerMessage(input: {
  actorRole: AuthenticatedUser["role"];
  currentStatus: DeliveryTicketStatus;
}) {
  return input.actorRole === "user" &&
    input.currentStatus === "needs_information"
    ? ("submitted" as const)
    : input.currentStatus;
}

type WorkflowCustomerSupplementChild = Pick<
  typeof deliveryTickets.$inferSelect,
  | "id"
  | "status"
  | "scheduledAt"
  | "assignedProjectAssignmentId"
  | "assignedMemberId"
  | "workflowDomain"
>;

/**
 * A workflow container can expose only one customer conversation while one
 * internal execution step is waiting for that customer's reply. Never infer
 * the destination from operation names or from another merely-active step.
 */
export function selectWorkflowCustomerSupplementChild(
  children: readonly WorkflowCustomerSupplementChild[],
) {
  const waiting = children.filter(
    (child) => child.status === "needs_information",
  );
  if (!waiting.length) {
    throw new DeliveryTicketError(
      "WORKFLOW_SUPPLEMENT_TARGET_NOT_FOUND",
      "当前需求的待补充执行步骤不存在，请刷新后重试或联系交付管理员。",
      409,
    );
  }
  if (waiting.length > 1) {
    throw new DeliveryTicketError(
      "WORKFLOW_SUPPLEMENT_TARGET_AMBIGUOUS",
      "当前需求存在多个待补充执行步骤，系统无法安全判断回复目标，请联系交付管理员处理。",
      409,
    );
  }
  const child = waiting[0]!;
  if (
    !child.assignedProjectAssignmentId ||
    !child.assignedMemberId ||
    !child.workflowDomain
  ) {
    throw new DeliveryTicketError(
      "WORKFLOW_SUPPLEMENT_TARGET_UNASSIGNED",
      "当前待补充执行步骤尚未完整分配负责人，请联系交付管理员后重试。",
      409,
    );
  }
  return child;
}

export function workflowCustomerSupplementInternalMessage(input: {
  message: string;
  attachments: readonly Pick<
    DeliveryTicketAttachmentInput,
    "filename" | "purpose"
  >[];
}) {
  const attachmentContext = input.attachments.length
    ? `\n\n客户新增附件：\n${input.attachments
        .map(
          (attachment, index) =>
            `${index + 1}. ${attachment.filename}${
              attachment.purpose?.trim()
                ? `（${attachment.purpose.trim()}）`
                : ""
            }`,
        )
        .join("\n")}`
    : "\n\n客户本次未新增附件。";
  return `客户已在原始需求中补充资料：\n${input.message.trim()}${attachmentContext}`;
}

export function planWorkflowCustomerSupplement(input: {
  rootScheduledAt: Date | null;
  rootQuotaState: "reserved" | "consumed" | "released";
  children: readonly WorkflowCustomerSupplementChild[];
  message: string;
  attachments: readonly Pick<
    DeliveryTicketAttachmentInput,
    "filename" | "purpose"
  >[];
}) {
  const child = selectWorkflowCustomerSupplementChild(input.children);
  const rootStatus = input.rootScheduledAt
    ? ("in_progress" as const)
    : ("scheduled" as const);
  return {
    child,
    childStatus: "scheduled" as const,
    rootStatus,
    rootQuotaState: deriveTicketQuotaTransition({
      currentState: input.rootQuotaState,
      scheduledAt: input.rootScheduledAt,
      nextStatus: rootStatus,
    }),
    internalMessage: workflowCustomerSupplementInternalMessage({
      message: input.message,
      attachments: input.attachments,
    }),
  };
}
export type WebsiteBuildStatus = "locked" | "pending" | "completed";

const WEBSITE_BUILD_LEGACY_EVIDENCE_OPERATIONS = [
  "site_check",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
] as const;

/**
 * A newly confirmed style always has a website-build ticket and only an
 * explicit completion can open content submission. Historical confirmed
 * states with no website-build ticket are accepted only when an
 * already-completed site/content operation proves that a real website was
 * delivered. Once any website-build ticket exists, that explicit workflow is
 * authoritative. Retained completion milestones survive ticket cleanup and
 * are equivalent to completed tickets.
 */
export function resolveWebsiteBuildStatus(input: {
  styleState:
    | "locked"
    | "waiting_samples"
    | "awaiting_selection"
    | "revision_requested"
    | "confirmed"
    | "legacy_confirmed";
  ticketStatuses: string[];
  hasCompletionMilestone: boolean;
  hasLegacyCompletionEvidence?: boolean;
}): WebsiteBuildStatus {
  if (
    input.styleState !== "confirmed" &&
    input.styleState !== "legacy_confirmed"
  ) {
    return "locked";
  }
  if (
    input.hasCompletionMilestone ||
    input.ticketStatuses.includes("completed")
  ) {
    return "completed";
  }
  if (input.ticketStatuses.length > 0) return "pending";
  if (input.hasLegacyCompletionEvidence === true) return "completed";
  return "pending";
}

async function loadWebsiteBuildStatus(
  executor: any,
  userId: number,
  styleState: Parameters<typeof resolveWebsiteBuildStatus>[0]["styleState"],
) {
  const [ticketRows, milestoneRows, evidenceTicketRows, evidenceMilestoneRows] =
    await Promise.all([
      executor
        .select({ status: deliveryTickets.status })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, userId),
            eq(deliveryTickets.operation, "website_build"),
          ),
        ),
      executor
        .select({ id: deliveryWorkflowMilestones.id })
        .from(deliveryWorkflowMilestones)
        .where(
          and(
            eq(deliveryWorkflowMilestones.userId, userId),
            eq(deliveryWorkflowMilestones.operation, "website_build"),
          ),
        )
        .limit(1),
      executor
        .select({ id: deliveryTickets.id })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, userId),
            eq(deliveryTickets.status, "completed"),
            inArray(deliveryTickets.operation, [
              ...WEBSITE_BUILD_LEGACY_EVIDENCE_OPERATIONS,
            ]),
          ),
        )
        .limit(1),
      executor
        .select({ id: deliveryWorkflowMilestones.id })
        .from(deliveryWorkflowMilestones)
        .where(
          and(
            eq(deliveryWorkflowMilestones.userId, userId),
            inArray(deliveryWorkflowMilestones.operation, [
              ...WEBSITE_BUILD_LEGACY_EVIDENCE_OPERATIONS,
            ]),
          ),
        )
        .limit(1),
    ]);
  return resolveWebsiteBuildStatus({
    styleState,
    ticketStatuses: ticketRows.map((row: { status: string }) => row.status),
    hasCompletionMilestone: Boolean(milestoneRows[0]),
    hasLegacyCompletionEvidence: Boolean(
      evidenceTicketRows[0] || evidenceMilestoneRows[0],
    ),
  });
}

export async function assertWebsiteTicketWorkflow(
  executor: any,
  userId: number,
  value: CreateDeliveryTicketInput,
) {
  if (value.type !== "website_operation") {
    return { profile: null, domain: null };
  }
  const category = value.category?.trim() ?? "";
  if (category === "knowledge_base_maintenance") {
    return { profile: null, domain: null };
  }
  const profiles = await executor
    .select()
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, userId))
    .limit(1)
    .for("update");
  const profile = profiles[0] ?? null;
  if (category === "domain_application") {
    const domain = normalizeDomain(value.topic || value.title);
    if (!domain) {
      throw new DeliveryTicketError(
        "DOMAIN_REQUIRED",
        "请填写需要申请或核验的域名。",
        400,
      );
    }
    if (profile?.domainStatus === "completed") {
      throw new DeliveryTicketError(
        "DOMAIN_ALREADY_VERIFIED",
        "当前企业域名已由 AI 运维工程师核验，无需重复申请。",
      );
    }
    return { profile, domain };
  }
  if (category === "icp_filing") {
    if (profile?.domainStatus !== "completed") {
      throw new DeliveryTicketError(
        "DOMAIN_PREREQUISITE_REQUIRED",
        "必须先完成域名需求并核验域名，才能提交 ICP 备案结果。",
        409,
      );
    }
    const verifiedDomain = normalizeDomain(profile.domain);
    if (!verifiedDomain) {
      throw new DeliveryTicketError(
        "DOMAIN_PREREQUISITE_REQUIRED",
        "必须先完成域名需求并核验域名，才能提交 ICP 备案结果。",
        409,
      );
    }
    if (
      profile.icpStatus === "approved" ||
      profile.icpStatus === "not_required"
    ) {
      throw new DeliveryTicketError(
        "ICP_ALREADY_VERIFIED",
        "当前企业 ICP 前置阶段已完成，无需重复提交。",
      );
    }
    const submittedDomain = normalizeDomain(value.topic || value.title);
    if (!submittedDomain) {
      throw new DeliveryTicketError(
        "DOMAIN_REQUIRED",
        "请填写本次已完成备案的域名。",
        400,
      );
    }
    if (submittedDomain !== verifiedDomain) {
      throw new DeliveryTicketError(
        "ICP_DOMAIN_MISMATCH",
        "已备案域名必须与域名需求核验通过的域名一致。",
        400,
      );
    }
    return { profile, domain: verifiedDomain };
  }
  if (WEBSITE_CONTENT_CATEGORIES.has(category)) {
    if (
      profile?.domainStatus !== "completed" ||
      (profile.icpStatus !== "approved" && profile.icpStatus !== "not_required")
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_PREREQUISITES_REQUIRED",
        "请先在阿里云完成域名注册与 ICP 备案，并提交备案结果。",
        403,
      );
    }
    const styleRows = await executor
      .select({ status: websiteStyleWorkflows.status })
      .from(websiteStyleWorkflows)
      .where(eq(websiteStyleWorkflows.userId, userId))
      .limit(1)
      .for("update");
    if (
      !styleRows[0] ||
      !["confirmed", "legacy_confirmed"].includes(styleRows[0].status)
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_REQUIRED",
        "请先等待工程师提供官网图片风格样例，并确认其中一种风格。",
        403,
      );
    }
    const websiteBuildStatus = await loadWebsiteBuildStatus(
      executor,
      userId,
      styleRows[0].status,
    );
    if (websiteBuildStatus !== "completed") {
      throw new DeliveryTicketError(
        "WEBSITE_BUILD_REQUIRED",
        "官网风格已确认，正在等待 AI 运维工程师或系统管理员完成官网构建并登记公开链接。",
        403,
      );
    }
    return { profile, domain: null };
  }
  throw new DeliveryTicketError(
    "WEBSITE_CATEGORY_DISABLED",
    "该官网技术类别已停止接受新需求。",
    400,
  );
}

export function technicalTicketDedupeKey(input: {
  category?: string | null;
  targetPage?: string | null;
}) {
  return createHash("sha256")
    .update(
      `${nonEmpty(input.category) ?? "general_request"}\0${normalizeTargetPage(input.targetPage)}`,
    )
    .digest("hex");
}

export function assertDeliveryTicketServiceEligibility(
  portal: Awaited<ReturnType<typeof getServicePortal>>,
  ticketType?: DeliveryTicketType,
  category?: string | null,
) {
  if (portal.service.status !== "active") {
    throw new DeliveryTicketError(
      "SERVICE_NOT_WRITABLE",
      portal.service.status === "expired" ||
      portal.service.status === "cancelled"
        ? "当前服务已到期，仅可查看历史需求。"
        : "当前服务尚不可提交新需求。",
      403,
    );
  }
  const planAllowsTicket =
    category === "knowledge_base_maintenance" ||
    portal.service.planCode === "advanced" ||
    portal.service.planCode === "luxury" ||
    (portal.service.planCode === "basic" &&
      (ticketType === undefined || ticketType === "content_asset"));
  if (!planAllowsTicket) {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_UPGRADE_REQUIRED",
      ticketType === "website_operation"
        ? `普通版不包含${SITEOPS_CUSTOMER_DISPLAY_NAME}，请升级进阶版或豪华版。`
        : "当前套餐不包含此需求服务，请升级进阶版或豪华版。",
      403,
    );
  }
  if (
    category !== "knowledge_base_maintenance" &&
    (ticketType === "content_asset" || ticketType === "website_operation") &&
    !servicePortalHasRequiredKnowledge(portal)
  ) {
    throw new DeliveryTicketError(
      "KNOWLEDGE_DISPLAY_REQUIRED",
      portal.service.planCode === "basic"
        ? "请先等待 Website 流程自动同步或服务团队补录知识库；知识库展示完成后解锁 AI 友好内容资产。"
        : "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
      409,
    );
  }
  if (!portal.quotas || !portal.service.contractId) {
    throw new DeliveryTicketError(
      "QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期尚未建立，请联系管理员。",
      409,
    );
  }
  const quotaPeriodIds = [
    ...new Set(
      [
        ...(portal.quotaPeriods ?? []).map((period) => period.periodId),
        ...(!portal.quotas.periodId.startsWith("basic-aggregate:")
          ? [portal.quotas.periodId]
          : []),
      ].filter(Boolean),
    ),
  ];
  if (!quotaPeriodIds.length) {
    throw new DeliveryTicketError(
      "QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期尚未建立，请联系管理员。",
      409,
    );
  }
  return {
    contractId: portal.service.contractId,
    quotaPeriodId: quotaPeriodIds[0],
    quotaPeriodIds,
  };
}

type DeliveryTicketQuotaCapacityPeriod = Pick<
  typeof serviceQuotaPeriods.$inferSelect,
  | "id"
  | "contractId"
  | "contentAssetPublishLimit"
  | "websiteContentPublishLimit"
> &
  Partial<
    Pick<
      typeof serviceQuotaPeriods.$inferSelect,
      "archivedContentAssetPublishUsed" | "archivedWebsiteContentPublishUsed"
    >
  >;

function archivedDeliveryTicketQuotaUsage(
  period: DeliveryTicketQuotaCapacityPeriod,
  quotaPool: DeliveryTicketQuotaPool,
) {
  return Number(
    quotaPool === "content_asset_publish"
      ? (period.archivedContentAssetPublishUsed ?? 0)
      : (period.archivedWebsiteContentPublishUsed ?? 0),
  );
}

/**
 * Selects the first real quota period with remaining capacity. Callers sort
 * periods by expiry and lock every candidate period before invoking this
 * helper, so concurrent Basic purchases cannot allocate the same final slot.
 */
export function selectDeliveryTicketQuotaPeriod(input: {
  periods: DeliveryTicketQuotaCapacityPeriod[];
  quotaPool: DeliveryTicketQuotaPool;
  activeCounts: ReadonlyMap<string, number>;
}) {
  return (
    input.periods.find((period) => {
      const limit =
        input.quotaPool === "content_asset_publish"
          ? period.contentAssetPublishLimit
          : period.websiteContentPublishLimit;
      return (
        (input.activeCounts.get(period.id) ?? 0) +
          archivedDeliveryTicketQuotaUsage(period, input.quotaPool) <
        limit
      );
    }) ?? null
  );
}

export function aggregateDeliveryTicketQuotaCapacity(input: {
  periods: DeliveryTicketQuotaCapacityPeriod[];
  quotaPool: DeliveryTicketQuotaPool;
  activeRows: Array<{
    quotaPool: DeliveryTicketQuotaPool | null;
    quotaState: "reserved" | "consumed" | "released";
    value: number | string | bigint;
  }>;
}) {
  const limit = input.periods.reduce((sum, period) => {
    const periodLimit =
      input.quotaPool === "content_asset_publish"
        ? period.contentAssetPublishLimit
        : period.websiteContentPublishLimit;
    return sum + Number(periodLimit);
  }, 0);
  const countState = (quotaState: "reserved" | "consumed") =>
    input.activeRows
      .filter(
        (row) =>
          row.quotaPool === input.quotaPool && row.quotaState === quotaState,
      )
      .reduce((sum, row) => sum + Number(row.value), 0);
  const reserved = countState("reserved");
  const consumed =
    countState("consumed") +
    input.periods.reduce(
      (sum, period) =>
        sum + archivedDeliveryTicketQuotaUsage(period, input.quotaPool),
      0,
    );
  const used = reserved + consumed;
  return {
    limit,
    reserved,
    consumed,
    used,
    remaining: Math.max(0, limit - used),
  };
}

export function missingOwnedAttachmentIds(
  requestedFileIds: string[],
  ownedFileIds: string[],
) {
  const owned = new Set(ownedFileIds);
  return [...new Set(requestedFileIds)].filter((fileId) => !owned.has(fileId));
}

async function verifyOwnedAttachments(
  executor: any,
  ownerUserId: number,
  attachments: DeliveryTicketAttachmentInput[],
) {
  const fileIds = [...new Set(attachments.map((item) => item.fileId))];
  if (fileIds.length) {
    const rows = await executor
      .select({ upstreamId: upstreamResources.upstreamId })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.userId, ownerUserId),
          eq(upstreamResources.kind, "file"),
          inArray(upstreamResources.upstreamId, fileIds),
        ),
      );
    const owned = rows.map((row: { upstreamId: string }) => row.upstreamId);
    const missing = missingOwnedAttachmentIds(fileIds, owned);
    if (missing.length) {
      throw new DeliveryTicketError(
        "ATTACHMENT_FORBIDDEN",
        `附件不属于当前账号：${missing.slice(0, 3).join("、")}`,
        403,
      );
    }
  }
}

function attachmentRows(input: {
  ticketId: string;
  eventId: string;
  workspaceUserId: number;
  ownerUserId: number;
  kind: "input" | "deliverable";
  attachments: DeliveryTicketAttachmentInput[];
  now: Date;
}) {
  return input.attachments.map((attachment) => ({
    id: randomUUID(),
    ticketId: input.ticketId,
    eventId: input.eventId,
    workspaceUserId: input.workspaceUserId,
    ownerUserId: input.ownerUserId,
    kind: input.kind,
    upstreamFileId: attachment.fileId,
    filename: attachment.filename,
    mimeType: nonEmpty(attachment.mimeType),
    sizeBytes: attachment.sizeBytes ?? null,
    sha256: attachment.sha256?.toLowerCase() ?? null,
    purpose: nonEmpty(attachment.purpose),
    authorization: attachment.authorization ?? null,
    copyrightNote: nonEmpty(attachment.copyrightNote),
    createdAt: input.now,
  }));
}

export function missingIcpCompletionRequirements(input: {
  declarations: unknown;
}) {
  return icpNonSensitiveDeclarationsSchema.safeParse(input.declarations).success
    ? []
    : ["icp_number"];
}

async function assertIcpTicketReadyForCompletion(input: {
  ticket: typeof deliveryTickets.$inferSelect;
}) {
  const missing = missingIcpCompletionRequirements({
    declarations: input.ticket.icpDeclarations,
  });
  if (missing.length) {
    throw new DeliveryTicketError(
      "ICP_RESULT_INCOMPLETE",
      "缺少 ICP 主体备案号，请让用户在阿里云备案通过后补充。",
      400,
    );
  }
}

export function isCustomerVisibleDeliveryTicket(
  ticket: Pick<
    typeof deliveryTickets.$inferSelect,
    "parentTicketId" | "rootTicketId" | "isWorkflowContainer"
  >,
) {
  return (
    ticket.isWorkflowContainer ||
    (!ticket.parentTicketId && !ticket.rootTicketId)
  );
}

function ticketDto(
  row: typeof deliveryTickets.$inferSelect,
  extra?: {
    enterpriseName?: string | null;
    attachmentCount?: number;
    latestPublicMessage?: string | null;
    assignedAdmins?: Array<{ id: number; name: string }>;
    assignedMemberName?: string | null;
  },
) {
  const assignedAdmins = extra?.assignedAdmins ?? [];
  return {
    id: row.id,
    parentTicketId: row.parentTicketId,
    rootTicketId: row.rootTicketId,
    isWorkflowContainer: row.isWorkflowContainer,
    userId: row.userId,
    contractId: row.contractId,
    quotaPeriodId: row.quotaPeriodId,
    ordinal: row.ordinal,
    enterpriseName: extra?.enterpriseName ?? null,
    type: row.type,
    quotaPool: row.quotaPool,
    quotaState: row.quotaState,
    category: row.category,
    workflowDomain: row.workflowDomain,
    operation: row.operation,
    sourceQuestionId: row.sourceQuestionId,
    assignedProjectAssignmentId: row.assignedProjectAssignmentId,
    assignedMemberId: row.assignedMemberId,
    credentialTargetUserId: row.credentialTargetUserId,
    credentialRequestKind: row.credentialRequestKind,
    assignedMemberName: extra?.assignedMemberName ?? null,
    priority: row.priority,
    topic: row.topic,
    title: row.title,
    description: row.description,
    preferredMedia: row.preferredMedia,
    icpProvince: row.icpProvince,
    icpDeclarations: row.icpDeclarations,
    targetPage: row.targetPage,
    knowledgeSnapshotId: row.knowledgeSnapshotId,
    materialUrls: row.materialUrls,
    status: row.status,
    statusLabel: DELIVERY_TICKET_STATUS_LABELS[row.status],
    publicStatus: deliveryTicketPublicStatus(row.status),
    publicStatusLabel:
      DELIVERY_TICKET_PUBLIC_STATUS_LABELS[
        deliveryTicketPublicStatus(row.status)
      ],
    publicSummary: row.publicSummary,
    deliveryLinks: row.deliveryLinks,
    revision: row.revision,
    submittedAt: epoch(row.createdAt),
    createdAt: epoch(row.createdAt),
    updatedAt: epoch(row.updatedAt),
    resolvedAt: epoch(row.resolvedAt),
    scheduledAt: epoch(row.scheduledAt),
    attachmentCount: extra?.attachmentCount ?? 0,
    latestPublicMessage: extra?.latestPublicMessage ?? null,
    assignedAdmins,
    assignedAdminId: assignedAdmins[0]?.id ?? null,
    assignedAdminName: assignedAdmins[0]?.name ?? null,
  };
}

type InternalDeliveryTicketDto = ReturnType<typeof ticketDto>;

function publicDeliveryLinks(
  value: InternalDeliveryTicketDto["deliveryLinks"],
) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    const label = link?.label?.trim();
    const candidate = link?.url?.trim();
    if (!label || !candidate) return [];
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      return [{ label, url: url.toString() }];
    } catch {
      return [];
    }
  });
}

export function deliveryLinksFromOperationResults(values: unknown[]) {
  const links = new Map<string, { label: string; url: string }>();
  for (const value of values) {
    const parsed = deliveryOperationResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.resultStatus !== "success") continue;
    const url = new URL(parsed.data.targetUrl).toString();
    if (!links.has(url)) {
      links.set(url, {
        label: parsed.data.platform,
        url,
      });
    }
  }
  return [...links.values()];
}

function publicDeliveryCategoryLabel(ticket: InternalDeliveryTicketDto) {
  return deliveryCategoryLabel({
    type: ticket.type,
    category: ticket.category,
  });
}

/**
 * This is the only delivery-ticket list projection allowed across the
 * customer workspace boundary. Keep the administrator DTO above intact:
 * contracts, quota allocation, assignees and raw workflow state are internal.
 */
export function toPublicDeliveryTicketSummary(
  ticket: InternalDeliveryTicketDto,
): PublicDeliveryTicketSummary {
  const publicStatus = deliveryTicketPublicStatus(ticket.status);
  const isQuestionWorkflowTicket = [
    "question_review",
    "question_modify",
    "question_delete",
  ].includes(ticket.category ?? ticket.operation ?? "");
  const base = {
    id: ticket.id,
    type: ticket.type,
    category: nonEmpty(ticket.category),
    categoryLabel: publicDeliveryCategoryLabel(ticket),
    topic:
      nonEmpty(ticket.topic) ??
      nonEmpty(ticket.title) ??
      nonEmpty(ticket.category),
    sourceQuestionId: nonEmpty(ticket.sourceQuestionId),
    publicStatus,
    publicStatusLabel: DELIVERY_TICKET_PUBLIC_STATUS_LABELS[publicStatus],
    publicSummary:
      publicStatus === "completed" ||
      ticket.status === "needs_information" ||
      isQuestionWorkflowTicket
        ? nonEmpty(ticket.publicSummary)
        : null,
    ...(ticket.knowledgeSnapshotId
      ? { knowledgeSnapshotId: ticket.knowledgeSnapshotId }
      : {}),
  };
  return publicDeliveryTicketSummarySchema.parse(
    ticket.type === "content_asset"
      ? {
          ...base,
          type: "content_asset",
          deliveryLinks:
            publicStatus === "completed"
              ? publicDeliveryLinks(ticket.deliveryLinks)
              : [],
        }
      : ticket.type === "website_operation"
        ? {
            ...base,
            type: "website_operation",
          }
        : {
            ...base,
            type: "knowledge_base",
          },
  );
}

export function toPublicDeliveryTicketCreationResult(input: {
  ticket: InternalDeliveryTicketDto;
  idempotent: boolean;
}) {
  return {
    ticket: toPublicDeliveryTicketSummary(input.ticket),
    idempotent: input.idempotent,
  };
}

function siteProfileDto(row: typeof workspaceSiteProfiles.$inferSelect) {
  return {
    domain: row.domain,
    siteMode: row.siteMode,
    domainStatus: row.domainStatus,
    domainVerifiedAt: epoch(row.domainVerifiedAt),
    icpProvince: row.icpProvince,
    icpNumber: row.icpNumber,
    icpStatus: row.icpStatus,
    icpVerifiedAt: epoch(row.icpVerifiedAt),
    revision: row.revision,
    updatedAt: epoch(row.updatedAt),
  };
}

function siteCheckDto(row: typeof workspaceSiteChecks.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    status: row.status,
    summary: row.summary,
    evidence: row.evidence,
    source: row.source,
    checkedAt: epoch(row.checkedAt),
    revision: row.revision,
    updatedAt: epoch(row.updatedAt),
  };
}

function domainFromWebsite(value: string | null | undefined) {
  const candidate = value
    ?.split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!candidate) return null;
  try {
    return new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function loadSiteProfile(db: any, userId: number) {
  const rows = await db
    .select()
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, userId))
    .limit(1);
  if (rows[0]) return siteProfileDto(rows[0]);
  const builds = await db
    .select({ companyWebsite: knowledgeBaseBuilds.companyWebsite })
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.userId, userId))
    .orderBy(desc(knowledgeBaseBuilds.updatedAt))
    .limit(1);
  const domain = domainFromWebsite(builds[0]?.companyWebsite);
  return domain
    ? {
        domain,
        siteMode: "unknown" as const,
        domainStatus: "not_started" as const,
        domainVerifiedAt: null,
        icpProvince: null,
        icpNumber: null,
        icpStatus: "not_submitted" as const,
        icpVerifiedAt: null,
        revision: 0,
        updatedAt: null,
      }
    : null;
}

async function loadWebsiteStyleWorkflow(db: any, userId: number) {
  const workflowRows = await db
    .select()
    .from(websiteStyleWorkflows)
    .where(eq(websiteStyleWorkflows.userId, userId))
    .limit(1);
  const workflow = workflowRows[0];
  if (!workflow) return null;
  if (!workflow.currentBatchId) {
    return {
      status: workflow.status,
      revision: workflow.revision,
      selectedSampleId: workflow.selectedSampleId,
      selectedAt: epoch(workflow.selectedAt),
      currentBatch: null,
    };
  }
  const [batchRows, sampleRows] = await Promise.all([
    db
      .select()
      .from(websiteStyleSampleBatches)
      .where(eq(websiteStyleSampleBatches.id, workflow.currentBatchId))
      .limit(1),
    db
      .select({
        sample: websiteStyleSamples,
        attachment: deliveryTicketAttachments,
      })
      .from(websiteStyleSamples)
      .innerJoin(
        deliveryTicketAttachments,
        eq(deliveryTicketAttachments.id, websiteStyleSamples.attachmentId),
      )
      .where(eq(websiteStyleSamples.batchId, workflow.currentBatchId))
      .orderBy(asc(websiteStyleSamples.sortOrder)),
  ]);
  const batch = batchRows[0];
  return {
    status: workflow.status,
    revision: workflow.revision,
    selectedSampleId: workflow.selectedSampleId,
    selectedAt: epoch(workflow.selectedAt),
    currentBatch: batch
      ? {
          id: batch.id,
          ordinal: batch.ordinal,
          status: batch.status,
          engineerNote: batch.engineerNote,
          publishedAt: epoch(batch.publishedAt),
          samples: sampleRows.map(
            ({
              sample,
              attachment,
            }: {
              sample: typeof websiteStyleSamples.$inferSelect;
              attachment: typeof deliveryTicketAttachments.$inferSelect;
            }) => ({
              id: sample.id,
              label: sample.label,
              note: sample.note,
              sortOrder: sample.sortOrder,
              attachmentId: attachment.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              imageUrl: `/api/delivery-ticket-attachments/${attachment.id}/content`,
            }),
          ),
        }
      : null,
  };
}

async function currentQuota(
  db: any,
  userId: number,
  portal: Awaited<ReturnType<typeof getServicePortal>>,
) {
  const periodIds = [
    ...new Set(
      [
        ...(portal.quotaPeriods ?? []).map((period) => period.periodId),
        ...(portal.quotas &&
        !portal.quotas.periodId.startsWith("basic-aggregate:")
          ? [portal.quotas.periodId]
          : []),
      ].filter(Boolean),
    ),
  ];
  const { periods, activeRows } = periodIds.length
    ? await db.transaction(async (tx: any) => {
        const periods = await tx
          .select()
          .from(serviceQuotaPeriods)
          .where(
            and(
              inArray(serviceQuotaPeriods.id, periodIds),
              eq(serviceQuotaPeriods.userId, userId),
            ),
          )
          .orderBy(
            asc(serviceQuotaPeriods.endsAt),
            asc(serviceQuotaPeriods.startsAt),
            asc(serviceQuotaPeriods.id),
          );
        const activeRows = periods.length
          ? await loadUnifiedDeliveryQuotaUsageRows(tx, {
              userId,
              quotaPeriodIds: periods.map((period: any) => period.id),
            })
          : [];
        return { periods, activeRows };
      })
    : { periods: [], activeRows: [] };
  const periodId =
    periods.length === 1
      ? periods[0].id
      : periods.length > 1
        ? (portal.quotas?.periodId ?? null)
        : null;
  const revision = periods.length
    ? Math.max(...periods.map((period: any) => period.revision))
    : null;
  const validFrom = periods.length
    ? Math.min(...periods.map((period: any) => epoch(period.startsAt) ?? 0))
    : null;
  const validUntil = periods.length
    ? Math.max(...periods.map((period: any) => epoch(period.endsAt) ?? 0))
    : null;
  const quotaFor = (pool: DeliveryTicketQuotaPool): DeliveryTicketQuota => {
    const capacity = aggregateDeliveryTicketQuotaCapacity({
      periods,
      quotaPool: pool,
      activeRows,
    });
    const planAllowsPool =
      portal.service.planCode === "advanced" ||
      portal.service.planCode === "luxury" ||
      (portal.service.planCode === "basic" && pool === "content_asset_publish");
    const knowledgeReady = servicePortalHasRequiredKnowledge(portal);
    const active =
      portal.service.status === "active" && planAllowsPool && knowledgeReady;
    return {
      type: pool,
      allowed: active && capacity.limit > 0,
      used: capacity.used,
      reserved: capacity.reserved,
      consumed: capacity.consumed,
      limit: capacity.limit,
      remaining: capacity.remaining,
      periodId,
      revision,
      validFrom,
      validUntil,
      reason: active
        ? capacity.limit > 0
          ? null
          : "当前套餐不包含此发布额度。"
        : portal.service.status === "active" &&
            planAllowsPool &&
            !knowledgeReady
          ? portal.service.planCode === "basic"
            ? "请先等待 Website 流程自动同步或服务团队补录知识库；知识库展示完成后解锁 AI 友好内容资产。"
            : "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。"
          : portal.service.status === "active" &&
              portal.service.planCode === "basic" &&
              pool === "website_content_publish"
            ? `普通版不包含${SITEOPS_CUSTOMER_DISPLAY_NAME}。`
            : portal.service.status === "expired" ||
                portal.service.status === "cancelled"
              ? "当前服务已到期，仅可查看历史需求。"
              : "当前服务尚不可提交新需求。",
    };
  };
  return {
    content_asset_publish: quotaFor("content_asset_publish"),
    website_content_publish: quotaFor("website_content_publish"),
  };
}

type TicketSummaryRow = {
  ticket: typeof deliveryTickets.$inferSelect;
  enterpriseName: string | null;
};

async function hydrateTicketSummaries(
  db: any,
  rows: TicketSummaryRow[],
): Promise<Array<ReturnType<typeof ticketDto>>> {
  if (!rows.length) return [] as Array<ReturnType<typeof ticketDto>>;
  const ids = rows.map((row: any) => row.ticket.id);
  const userIds = [...new Set(rows.map((row) => row.ticket.userId))];
  const assignedMemberIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.ticket.assignedMemberId ? [row.ticket.assignedMemberId] : [],
      ),
    ),
  ];
  const [attachments, events, assignedMembers] = await Promise.all([
    db
      .select({ ticketId: deliveryTicketAttachments.ticketId, value: count() })
      .from(deliveryTicketAttachments)
      .where(inArray(deliveryTicketAttachments.ticketId, ids))
      .groupBy(deliveryTicketAttachments.ticketId),
    db
      .select({
        ticketId: deliveryTicketEvents.ticketId,
        message: deliveryTicketEvents.message,
        createdAt: deliveryTicketEvents.createdAt,
      })
      .from(deliveryTicketEvents)
      .where(
        and(
          inArray(deliveryTicketEvents.ticketId, ids),
          eq(deliveryTicketEvents.visibility, "customer"),
        ),
      )
      .orderBy(desc(deliveryTicketEvents.createdAt)),
    assignedMemberIds.length
      ? db
          .select({
            id: users.id,
            displayName: users.displayName,
            username: users.username,
          })
          .from(users)
          .where(inArray(users.id, assignedMemberIds))
      : [],
  ]);
  const assignments = await db
    .select({
      userId: userAdminAssignments.userId,
      adminId: userAdminAssignments.adminId,
      displayName: users.displayName,
      username: users.username,
    })
    .from(userAdminAssignments)
    .innerJoin(users, eq(users.id, userAdminAssignments.adminId))
    .where(inArray(userAdminAssignments.userId, userIds));
  const assignedByUser = new Map<number, Array<{ id: number; name: string }>>();
  for (const assignment of assignments) {
    const current = assignedByUser.get(assignment.userId) ?? [];
    current.push({
      id: assignment.adminId,
      name:
        assignment.displayName?.trim() ||
        assignment.username?.trim() ||
        `管理员 ${assignment.adminId}`,
    });
    assignedByUser.set(assignment.userId, current);
  }
  const counts = new Map<string, number>(
    attachments.map((row: any) => [row.ticketId, Number(row.value)]),
  );
  const memberNames = new Map<number, string>(
    (
      assignedMembers as Array<{
        id: number;
        displayName: string | null;
        username: string | null;
      }>
    ).map((member) => [
      member.id,
      member.displayName?.trim() ||
        member.username?.trim() ||
        `工程师 ${member.id}`,
    ]),
  );
  const latest = new Map<string, string | null>();
  for (const event of events) {
    if (!latest.has(event.ticketId) && event.message) {
      latest.set(event.ticketId, event.message);
    }
  }
  return rows.map(
    (row: any): ReturnType<typeof ticketDto> =>
      ticketDto(row.ticket, {
        enterpriseName: row.enterpriseName,
        attachmentCount: counts.get(row.ticket.id) ?? 0,
        latestPublicMessage: latest.get(row.ticket.id) ?? null,
        assignedAdmins: assignedByUser.get(row.ticket.userId) ?? [],
        assignedMemberName: row.ticket.assignedMemberId
          ? (memberNames.get(row.ticket.assignedMemberId) ?? null)
          : null,
      }),
  );
}

type TicketSummaryPageInput = {
  userIds: number[];
  type?: AdminDeliveryTicketListInput["type"];
  status?: AdminDeliveryTicketListInput["status"];
  publicStatus?: AdminDeliveryTicketListInput["publicStatus"];
  surface?: DeliveryTicketListInput["surface"];
  quotaPeriodId?: string;
  query?: string;
  limit: number;
  cursor?: string;
  order?: AdminDeliveryTicketListInput["order"];
  hideWorkflowChildren?: boolean;
};

async function loadTicketSummaryPage(db: any, input: TicketSummaryPageInput) {
  if (!input.userIds.length) {
    return {
      tickets: [] as Array<ReturnType<typeof ticketDto>>,
      nextCursor: null as string | null,
      hasMore: false,
    };
  }
  const cursor = input.cursor ? decodeDeliveryTicketCursor(input.cursor) : null;
  const order = input.order ?? "updated_desc";
  if (cursor && (cursor.order ?? "updated_desc") !== order) {
    throw new DeliveryTicketError(
      "DELIVERY_TICKET_CURSOR_INVALID",
      "需求列表排序已变化，请刷新后重试。",
      400,
    );
  }
  const queryPattern = deliveryTicketSearchPattern(input.query);
  const publicStatuses: DeliveryTicketStatus[] | null =
    input.publicStatus === "pending"
      ? ["submitted", "needs_information", "scheduled", "in_progress"]
      : input.publicStatus === "completed"
        ? ["completed", "rejected", "cancelled"]
        : null;
  const conditions = [
    inArray(deliveryTickets.userId, input.userIds),
    ...(input.hideWorkflowChildren
      ? [
          or(
            eq(deliveryTickets.isWorkflowContainer, true),
            and(
              isNull(deliveryTickets.parentTicketId),
              isNull(deliveryTickets.rootTicketId),
            ),
          )!,
        ]
      : []),
    ...(input.type ? [eq(deliveryTickets.type, input.type)] : []),
    ...(input.surface === "website_management"
      ? [
          or(
            inArray(deliveryTickets.operation, [
              ...WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
            ]),
            and(
              isNull(deliveryTickets.operation),
              inArray(deliveryTickets.category, [
                ...WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
              ]),
            ),
          )!,
        ]
      : input.surface === "question_management"
        ? [
            inArray(deliveryTickets.category, [
              ...QUESTION_MANAGEMENT_HISTORY_CATEGORIES,
            ]),
          ]
        : input.surface === "knowledge_management"
          ? [
              or(
                and(
                  eq(deliveryTickets.type, "knowledge_base"),
                  eq(deliveryTickets.category, "knowledge_reset"),
                ),
                and(
                  eq(deliveryTickets.type, "website_operation"),
                  eq(deliveryTickets.category, "knowledge_base_maintenance"),
                ),
              )!,
            ]
          : input.surface === "response_logic_management"
            ? [
                and(
                  eq(deliveryTickets.type, "knowledge_base"),
                  eq(deliveryTickets.category, "response_logic_reset"),
                )!,
              ]
            : []),
    ...(input.status ? [eq(deliveryTickets.status, input.status)] : []),
    ...(publicStatuses
      ? [inArray(deliveryTickets.status, publicStatuses)]
      : []),
    ...(input.quotaPeriodId
      ? [eq(deliveryTickets.quotaPeriodId, input.quotaPeriodId)]
      : []),
    ...(queryPattern
      ? [
          or(
            like(users.displayName, queryPattern),
            like(deliveryTickets.title, queryPattern),
            like(deliveryTickets.topic, queryPattern),
            like(deliveryTickets.category, queryPattern),
          )!,
        ]
      : []),
    ...(cursor
      ? order === "created_asc"
        ? [
            or(
              gt(deliveryTickets.createdAt, new Date(cursor.updatedAt)),
              and(
                eq(deliveryTickets.createdAt, new Date(cursor.updatedAt)),
                gt(deliveryTickets.id, cursor.id),
              ),
            )!,
          ]
        : [
            or(
              lt(deliveryTickets.updatedAt, new Date(cursor.updatedAt)),
              and(
                eq(deliveryTickets.updatedAt, new Date(cursor.updatedAt)),
                lt(deliveryTickets.id, cursor.id),
              ),
            )!,
          ]
      : []),
  ];
  const baseQuery = db
    .select({
      ticket: deliveryTickets,
      enterpriseName: users.displayName,
    })
    .from(deliveryTickets)
    .innerJoin(users, eq(users.id, deliveryTickets.userId))
    .where(and(...conditions));
  const rows = (await (
    order === "created_asc"
      ? baseQuery.orderBy(
          asc(deliveryTickets.createdAt),
          asc(deliveryTickets.id),
        )
      : baseQuery.orderBy(
          desc(deliveryTickets.updatedAt),
          desc(deliveryTickets.id),
        )
  ).limit(input.limit + 1)) as TicketSummaryRow[];
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const tickets = await hydrateTicketSummaries(db, pageRows);
  const boundary = hasMore ? pageRows.at(-1)?.ticket : null;
  return {
    tickets,
    nextCursor: boundary
      ? encodeDeliveryTicketCursor({
          updatedAt:
            order === "created_asc" ? boundary.createdAt : boundary.updatedAt,
          id: boundary.id,
          ...(order === "created_asc" ? { order } : {}),
        })
      : null,
    hasMore,
  };
}

export async function listWorkspaceDeliveryTickets(input: {
  userId: number;
  value?: Partial<DeliveryTicketListInput>;
}) {
  const db = await requireDb();
  const limit = Math.min(100, Math.max(1, input.value?.limit ?? 20));
  const page = await loadTicketSummaryPage(db, {
    userIds: [input.userId],
    hideWorkflowChildren: true,
    type: input.value?.type,
    surface: input.value?.surface,
    publicStatus: input.value?.publicStatus,
    limit,
    cursor: input.value?.cursor,
  });
  return {
    ...page,
    tickets: page.tickets.map(toPublicDeliveryTicketSummary),
  };
}

export async function getDeliveryTicketWorkspace(userId: number) {
  const db = await requireDb();
  const [page, metadata] = await Promise.all([
    loadTicketSummaryPage(db, {
      userIds: [userId],
      hideWorkflowChildren: true,
      limit: 20,
    }),
    getPublicDeliveryTicketWorkspaceMetadata(userId),
  ]);
  return {
    ...metadata,
    ...page,
    tickets: page.tickets.map(toPublicDeliveryTicketSummary),
  };
}

export async function getDeliveryTicketWorkspaceMetadata(userId: number) {
  const db = await requireDb();
  const portal = await getServicePortal(userId);
  const [
    accountRows,
    siteProfile,
    styleWorkflow,
    quotas,
    pendingRows,
    ownerRows,
    websiteBuildTicketRows,
    websiteBuildMilestoneRows,
    websiteLegacyEvidenceTicketRows,
    websiteLegacyEvidenceMilestoneRows,
    siteOpsProjectRows,
  ] = await Promise.all([
    db
      .select({ marketEdition: users.marketEdition })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    loadSiteProfile(db, userId),
    loadWebsiteStyleWorkflow(db, userId),
    currentQuota(db, userId, portal),
    db
      .select({ value: count() })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, userId),
          or(
            eq(deliveryTickets.isWorkflowContainer, true),
            and(
              isNull(deliveryTickets.parentTicketId),
              isNull(deliveryTickets.rootTicketId),
            ),
          ),
          inArray(deliveryTickets.status, [
            "submitted",
            "needs_information",
            "scheduled",
            "in_progress",
          ]),
        ),
      ),
    db
      .select({ roleType: deliveryProjectAssignments.roleType })
      .from(deliveryProjectAssignments)
      .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
      .where(
        and(
          eq(deliveryProjectAssignments.customerUserId, userId),
          eq(users.role, "delivery_member"),
          eq(users.engineerRoleType, deliveryProjectAssignments.roleType),
          eq(users.isActive, true),
        ),
      ),
    db
      .select({ status: deliveryTickets.status })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, userId),
          eq(deliveryTickets.operation, "website_build"),
        ),
      ),
    db
      .select({ id: deliveryWorkflowMilestones.id })
      .from(deliveryWorkflowMilestones)
      .where(
        and(
          eq(deliveryWorkflowMilestones.userId, userId),
          eq(deliveryWorkflowMilestones.operation, "website_build"),
        ),
      )
      .limit(1),
    db
      .select({ id: deliveryTickets.id })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, userId),
          eq(deliveryTickets.status, "completed"),
          inArray(deliveryTickets.operation, [
            ...WEBSITE_BUILD_LEGACY_EVIDENCE_OPERATIONS,
          ]),
        ),
      )
      .limit(1),
    db
      .select({ id: deliveryWorkflowMilestones.id })
      .from(deliveryWorkflowMilestones)
      .where(
        and(
          eq(deliveryWorkflowMilestones.userId, userId),
          inArray(deliveryWorkflowMilestones.operation, [
            ...WEBSITE_BUILD_LEGACY_EVIDENCE_OPERATIONS,
          ]),
        ),
      )
      .limit(1),
    db
      .select({ id: siteProjects.id })
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.userId, userId),
          inArray(siteProjects.status, [
            "draft",
            "collecting_brief",
            "visual_searching",
            "awaiting_visual_selection",
            "building",
            "preview_ready",
            "approved",
            "live",
            "attention_required",
            "failed",
          ]),
        ),
      )
      .limit(1),
  ]);
  const ownerTypes = new Set(ownerRows.map((row) => row.roleType));
  const domainCompleted = siteProfile?.domainStatus === "completed";
  const icpCompleted =
    siteProfile?.icpStatus === "approved" ||
    siteProfile?.icpStatus === "not_required";
  const styleState =
    styleWorkflow?.status ?? (icpCompleted ? "waiting_samples" : "locked");
  const styleConfirmed =
    styleState === "confirmed" || styleState === "legacy_confirmed";
  const websiteBuildStatus = resolveWebsiteBuildStatus({
    styleState,
    ticketStatuses: websiteBuildTicketRows.map((row) => row.status),
    hasCompletionMilestone: Boolean(websiteBuildMilestoneRows[0]),
    hasLegacyCompletionEvidence: Boolean(
      websiteLegacyEvidenceTicketRows[0] ||
        websiteLegacyEvidenceMilestoneRows[0],
    ),
  });
  const marketEdition = accountRows[0]?.marketEdition ?? "domestic";
  return {
    siteProfile,
    quotas,
    pendingCount: Number(pendingRows[0]?.value ?? 0),
    contentAssetCatalog: CONTENT_ASSET_CATALOG,
    websiteContentCatalog: WEBSITE_CONTENT_CATALOG,
    marketEdition,
    preferredMediaOptions:
      contentAssetMediaOptionsForMarketEdition(marketEdition),
    siteOpsProjectActive: siteOpsProjectRows.length > 0,
    deliveryOwners: {
      aiOperations: ownerTypes.has("ai_operations_engineer"),
      monitoringOptimization: ownerTypes.has(
        "monitoring_optimization_engineer",
      ),
      contentDistribution: ownerTypes.has("content_distribution_engineer"),
    },
    websiteWorkflow: {
      domainStatus: siteProfile?.domainStatus ?? "not_started",
      icpStatus: siteProfile?.icpStatus ?? "not_submitted",
      domainCompleted,
      icpCompleted,
      styleState,
      styleRevision: styleWorkflow?.revision ?? 0,
      styleBatch: styleWorkflow?.currentBatch ?? null,
      selectedStyleSampleId: styleWorkflow?.selectedSampleId ?? null,
      styleConfirmed,
      websiteBuildStatus,
      canSelectStyle: styleState === "awaiting_selection",
      canRequestStyleRevision: styleState === "awaiting_selection",
      canSubmitDomain: !domainCompleted,
      canSubmitIcp:
        marketEdition !== "overseas" && domainCompleted && !icpCompleted,
      canSubmitContent:
        domainCompleted &&
        icpCompleted &&
        styleConfirmed &&
        websiteBuildStatus === "completed",
      icpProvince: siteProfile?.icpProvince ?? null,
      icpProvinceOptions: ICP_PROVINCES,
      icpLockReason: null,
      contentLockReason: !domainCompleted
        ? marketEdition === "overseas"
          ? "请先完成企业域名注册与确认。"
          : "请先在阿里云完成域名注册与 ICP 备案，并提交备案结果。"
        : !icpCompleted
          ? marketEdition === "overseas"
            ? "请先完成企业域名确认。"
            : "请先提交并确认域名与 ICP 主体备案号。"
          : !styleConfirmed
            ? styleState === "awaiting_selection"
              ? "请先选择一种官网图片风格，或填写原因退回工程师重做。"
              : styleState === "revision_requested"
                ? "已退回工程师重做，正在等待新一批图片风格样例。"
                : "正在等待工程师提供三张官网图片风格样例。"
            : websiteBuildStatus !== "completed"
              ? "官网风格已确认，正在等待 AI 运维工程师或系统管理员完成官网构建并登记公开链接。"
              : null,
    },
  };
}

export function toPublicDeliveryTicketWorkspaceMetadata(
  metadata: Awaited<ReturnType<typeof getDeliveryTicketWorkspaceMetadata>>,
): PublicDeliveryTicketWorkspaceMetadata {
  const overseasAccount = metadata.marketEdition === "overseas";
  const deliveryOwners = metadata.deliveryOwners ?? {
    aiOperations: true,
    monitoringOptimization: true,
    contentDistribution: true,
  };
  const domainPending = metadata.siteProfile?.domainStatus === "pending";
  const icpPending =
    metadata.siteProfile?.icpStatus === "preparing" ||
    metadata.siteProfile?.icpStatus === "submitted";
  const domainCompleted = metadata.websiteWorkflow.domainCompleted;
  const icpCompleted = metadata.websiteWorkflow.icpCompleted;
  const styleConfirmed = metadata.websiteWorkflow.styleConfirmed;
  const websiteBuildStatus = metadata.websiteWorkflow.websiteBuildStatus;
  const websiteServiceAllowed =
    deliveryOwners.aiOperations &&
    metadata.quotas.website_content_publish.allowed;
  const aiOperationsUnavailableReason =
    metadata.quotas.website_content_publish.reason ||
    "尚未分配 AI 运维工程师，请联系交付管理员。";
  const quota = (value: DeliveryTicketQuota, hasOwner: boolean) => ({
    type: value.type,
    allowed: value.allowed && hasOwner,
    used: value.used,
    limit: value.limit,
    remaining: value.remaining,
    reason:
      value.reason ||
      (hasOwner ? null : "该业务尚未配置负责人，请联系交付管理员。"),
  });
  return publicDeliveryTicketWorkspaceMetadataSchema.parse({
    quotas: {
      content_asset_publish: quota(
        metadata.quotas.content_asset_publish,
        deliveryOwners.contentDistribution,
      ),
      website_content_publish: quota(
        metadata.quotas.website_content_publish,
        deliveryOwners.aiOperations,
      ),
    },
    contentAssetCatalog: metadata.contentAssetCatalog,
    websiteContentCatalog: metadata.websiteContentCatalog,
    marketEdition: metadata.marketEdition,
    preferredMediaOptions: metadata.preferredMediaOptions,
    siteOpsProjectActive: metadata.siteOpsProjectActive,
    deliveryOwners,
    websiteWorkflow: {
      domainCompleted,
      icpCompleted,
      canSubmitDomain:
        websiteServiceAllowed && !domainCompleted && !domainPending,
      canSubmitIcp:
        websiteServiceAllowed &&
        !overseasAccount &&
        domainCompleted &&
        !icpCompleted &&
        !domainPending &&
        !icpPending,
      canSubmitContent:
        websiteServiceAllowed &&
        domainCompleted &&
        icpCompleted &&
        styleConfirmed &&
        websiteBuildStatus === "completed",
      styleState: metadata.websiteWorkflow.styleState,
      styleRevision: metadata.websiteWorkflow.styleRevision,
      styleBatch: metadata.websiteWorkflow.styleBatch,
      selectedStyleSampleId: metadata.websiteWorkflow.selectedStyleSampleId,
      styleConfirmed,
      websiteBuildStatus,
      canSelectStyle:
        websiteServiceAllowed && metadata.websiteWorkflow.canSelectStyle,
      canRequestStyleRevision:
        websiteServiceAllowed &&
        metadata.websiteWorkflow.canRequestStyleRevision,
      domainLockReason: domainPending
        ? "域名核验需求正在等待 AI 运维工程师处理。"
        : !websiteServiceAllowed
          ? aiOperationsUnavailableReason
          : domainCompleted
            ? null
            : null,
      icpLockReason: overseasAccount
        ? null
        : !websiteServiceAllowed
          ? aiOperationsUnavailableReason
          : !domainCompleted
            ? domainPending
              ? "域名需求正在处理；需求完成后才可提交 ICP 备案结果。"
              : "请先购买域名并提交 AI 运维需求，需求完成后再提交 ICP 备案结果。"
            : icpPending
              ? "ICP 备案结果待 AI 运维工程师核验。"
              : null,
      contentLockReason: !websiteServiceAllowed
        ? aiOperationsUnavailableReason
        : !domainCompleted
          ? overseasAccount
            ? "请先完成企业域名注册与确认。"
            : "请先完成域名需求与 ICP 备案。"
          : !icpCompleted
            ? overseasAccount
              ? "请先完成企业域名确认。"
              : "请先提交并确认域名与 ICP 主体备案号。"
            : metadata.websiteWorkflow.contentLockReason,
      icpProvinceOptions: metadata.websiteWorkflow.icpProvinceOptions,
    },
  });
}

export async function getPublicDeliveryTicketWorkspaceMetadata(userId: number) {
  return toPublicDeliveryTicketWorkspaceMetadata(
    await getDeliveryTicketWorkspaceMetadata(userId),
  );
}

async function ensureWebsiteBuildTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
}) {
  const existingRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.operation, "website_build"),
        inArray(deliveryTickets.status, [
          "submitted",
          "needs_information",
          "scheduled",
          "in_progress",
          "completed",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  if (existingRows[0]) {
    return { id: existingRows[0].id, created: false as const };
  }

  const ownerRows = await input.executor
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      memberId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(
          deliveryProjectAssignments.customerUserId,
          input.sourceTicket.userId,
        ),
        eq(deliveryProjectAssignments.roleType, "ai_operations_engineer"),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, "ai_operations_engineer"),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  const owner = ownerRows[0];
  if (!owner) {
    throw new DeliveryTicketError(
      "DELIVERY_OWNER_NOT_ASSIGNED",
      "尚未分配 AI 运维工程师，无法创建官网构建工单。",
      409,
    );
  }

  const now = new Date();
  const ticketId = randomUUID();
  await input.executor.insert(deliveryTickets).values({
    id: ticketId,
    userId: input.sourceTicket.userId,
    contractId: input.sourceTicket.contractId,
    quotaPeriodId: input.sourceTicket.quotaPeriodId,
    type: "website_operation",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: "website_build",
    title: "构建 AI 专用官网",
    description:
      "客户已确认官网图片风格，请完成官网构建、发布并登记公开链接；完成后系统才开放后续内容提交。",
    workflowDomain: "ai_operations_engineer",
    operation: "website_build",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.memberId,
    technicalDedupeKey: `website-build:${input.sourceTicket.userId}`,
    quotaState: "consumed",
    status: "submitted",
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    kind: "created",
    visibility: "customer",
    message:
      "官网图片风格已确认，官网构建工单已创建；工程师完成构建并登记公开链接后开放内容运营。",
    toStatus: "submitted",
    createdAt: now,
  });
  return { id: ticketId, created: true as const };
}

export async function selectWebsiteStyleSample(input: {
  actor: AuthenticatedUser;
  sampleId: string;
  expectedRevision: number;
}) {
  if (input.actor.role !== "user") {
    throw new DeliveryTicketError(
      "WEBSITE_STYLE_USER_REQUIRED",
      "只有当前客户可以确认官网图片风格。",
      403,
    );
  }
  assertDeliveryTicketServiceEligibility(
    await getServicePortal(input.actor.id),
    "website_operation",
  );
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const workflowRows = await tx
      .select()
      .from(websiteStyleWorkflows)
      .where(eq(websiteStyleWorkflows.userId, input.actor.id))
      .limit(1)
      .for("update");
    const workflow = workflowRows[0];
    if (
      !workflow ||
      workflow.status !== "awaiting_selection" ||
      workflow.revision !== input.expectedRevision ||
      !workflow.currentBatchId
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_STATE_CHANGED",
        "官网风格样例状态已变化，请刷新后重试。",
        409,
      );
    }
    const sampleRows = await tx
      .select({
        sample: websiteStyleSamples,
        batch: websiteStyleSampleBatches,
      })
      .from(websiteStyleSamples)
      .innerJoin(
        websiteStyleSampleBatches,
        eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
      )
      .where(
        and(
          eq(websiteStyleSamples.id, input.sampleId),
          eq(websiteStyleSamples.batchId, workflow.currentBatchId),
          eq(websiteStyleSampleBatches.userId, input.actor.id),
        ),
      )
      .limit(1);
    const selected = sampleRows[0];
    if (
      !selected ||
      selected.batch.sourceKind !== "legacy_manual_three" ||
      !selected.batch.ticketId
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_SAMPLE_NOT_FOUND",
        "官网风格样例不存在。",
        404,
      );
    }
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, selected.batch.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (!ticket || ticket.userId !== input.actor.id) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_SAMPLE_NOT_FOUND",
        "官网风格样例不存在。",
        404,
      );
    }
    const now = new Date();
    const websiteBuildTicket = await ensureWebsiteBuildTicket({
      executor: tx,
      sourceTicket: ticket,
      actorUserId: input.actor.id,
    });
    await tx
      .update(websiteStyleWorkflows)
      .set({
        status: "confirmed",
        selectedSampleId: selected.sample.id,
        selectedByUserId: input.actor.id,
        selectedAt: now,
        revision: workflow.revision + 1,
        updatedAt: now,
      })
      .where(eq(websiteStyleWorkflows.userId, input.actor.id));
    await tx
      .update(websiteStyleSampleBatches)
      .set({ status: "selected", updatedAt: now })
      .where(eq(websiteStyleSampleBatches.id, selected.batch.id));
    await tx
      .update(deliveryTickets)
      .set({
        status: "completed",
        publicSummary: `客户已确认官网图片风格：${selected.sample.label}`,
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: input.actor.id,
      actorUserId: input.actor.id,
      actorRole: "user",
      kind: "status_change",
      visibility: "customer",
      message: `客户已确认官网图片风格：${selected.sample.label}。官网构建工单已创建，完成构建并登记公开链接后开放内容运营。`,
      fromStatus: ticket.status,
      toStatus: "completed",
      createdAt: now,
    });
    return {
      success: true as const,
      selectedSampleId: selected.sample.id,
      workflowRevision: workflow.revision + 1,
      websiteBuildTicketId: websiteBuildTicket.id,
    };
  });
}

export async function requestWebsiteStyleRevision(input: {
  actor: AuthenticatedUser;
  reason: string;
  expectedRevision: number;
}) {
  if (input.actor.role !== "user") {
    throw new DeliveryTicketError(
      "WEBSITE_STYLE_USER_REQUIRED",
      "只有当前客户可以退回官网图片风格样例。",
      403,
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new DeliveryTicketError(
      "WEBSITE_STYLE_REVISION_REASON_REQUIRED",
      "请填写需要调整的风格方向。",
      400,
    );
  }
  assertDeliveryTicketServiceEligibility(
    await getServicePortal(input.actor.id),
    "website_operation",
  );
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const workflowRows = await tx
      .select()
      .from(websiteStyleWorkflows)
      .where(eq(websiteStyleWorkflows.userId, input.actor.id))
      .limit(1)
      .for("update");
    const workflow = workflowRows[0];
    if (
      !workflow ||
      workflow.status !== "awaiting_selection" ||
      workflow.revision !== input.expectedRevision ||
      !workflow.currentBatchId
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_STATE_CHANGED",
        "官网风格样例状态已变化，请刷新后重试。",
        409,
      );
    }
    const batchRows = await tx
      .select()
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.id, workflow.currentBatchId),
          eq(websiteStyleSampleBatches.userId, input.actor.id),
        ),
      )
      .limit(1);
    const batch = batchRows[0];
    if (
      !batch ||
      batch.sourceKind !== "legacy_manual_three" ||
      !batch.ticketId
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_BATCH_NOT_FOUND",
        "官网风格样例批次不存在。",
        404,
      );
    }
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, batch.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (!ticket || ticket.userId !== input.actor.id) {
      throw new DeliveryTicketError(
        "WEBSITE_STYLE_BATCH_NOT_FOUND",
        "官网风格样例批次不存在。",
        404,
      );
    }
    const now = new Date();
    await tx
      .update(websiteStyleWorkflows)
      .set({
        status: "revision_requested",
        revision: workflow.revision + 1,
        updatedAt: now,
      })
      .where(eq(websiteStyleWorkflows.userId, input.actor.id));
    await tx
      .update(websiteStyleSampleBatches)
      .set({ status: "revision_requested", updatedAt: now })
      .where(eq(websiteStyleSampleBatches.id, batch.id));
    await tx
      .update(deliveryTickets)
      .set({
        status: "in_progress",
        publicSummary: "客户已退回本批风格样例，等待工程师重新提供。",
        resolvedAt: null,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: input.actor.id,
      actorUserId: input.actor.id,
      actorRole: "user",
      kind: "status_change",
      visibility: "customer",
      message: `客户要求调整官网图片风格：${reason}`,
      fromStatus: ticket.status,
      toStatus: "in_progress",
      createdAt: now,
    });
    return {
      success: true as const,
      workflowRevision: workflow.revision + 1,
    };
  });
}

/**
 * The idempotency lookup must run inside the same period lock as quota
 * allocation. This makes concurrent double-clicks observe the first insert
 * after waiting, rather than surfacing a database unique-key error.
 */
export async function withSerializedTicketCreation<
  TScope,
  TExisting,
  TResult,
>(input: {
  withLock: (
    criticalSection: (scope: TScope) => Promise<TResult>,
  ) => Promise<TResult>;
  findDuplicate: (scope: TScope) => Promise<TExisting | null>;
  onDuplicate: (existing: TExisting) => Promise<TResult> | TResult;
  create: (scope: TScope) => Promise<TResult>;
}) {
  return input.withLock(async (scope) => {
    const duplicate = await input.findDuplicate(scope);
    if (duplicate) return input.onDuplicate(duplicate);
    return input.create(scope);
  });
}

export async function createDeliveryTicket(input: {
  userId: number;
  value: CreateDeliveryTicketInput;
}) {
  const db = await requireDb();
  if (input.value.type === "content_asset" && input.value.preferredMedia) {
    const accountRows = await db
      .select({ marketEdition: users.marketEdition })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const allowedMedia = new Set<string>(
      contentAssetMediaOptionsForMarketEdition(
        accountRows[0]?.marketEdition ?? "domestic",
      ),
    );
    if (!allowedMedia.has(input.value.preferredMedia)) {
      throw new DeliveryTicketError(
        "PREFERRED_MEDIA_EDITION_INVALID",
        "所选媒体不属于当前账号版本，请刷新后重新选择。",
        400,
      );
    }
  }
  const portal = await getServicePortal(input.userId);
  let quotaPool: DeliveryTicketQuotaPool | null;
  try {
    quotaPool = resolveDeliveryTicketQuotaPool(input.value);
  } catch (error) {
    throw new DeliveryTicketError(
      "QUOTA_POOL_MISMATCH",
      error instanceof Error ? error.message : "需求类别与服务类型不一致。",
      400,
    );
  }
  const scope = assertDeliveryTicketServiceEligibility(
    portal,
    input.value.type,
    input.value.category,
  );
  return db.transaction(async (tx) =>
    withSerializedTicketCreation({
      withLock: async (criticalSection) => {
        const lockedPeriods = await tx
          .select()
          .from(serviceQuotaPeriods)
          .where(
            and(
              inArray(serviceQuotaPeriods.id, scope.quotaPeriodIds),
              eq(serviceQuotaPeriods.userId, input.userId),
            ),
          )
          .orderBy(asc(serviceQuotaPeriods.id))
          .for("update");
        if (!lockedPeriods.length) {
          throw new DeliveryTicketError(
            "QUOTA_PERIOD_NOT_FOUND",
            "当前服务周期已变化，请刷新后重试。",
          );
        }
        const periods = [...lockedPeriods].sort(
          (left, right) =>
            left.endsAt.getTime() - right.endsAt.getTime() ||
            left.startsAt.getTime() - right.startsAt.getTime() ||
            left.id.localeCompare(right.id),
        );
        return criticalSection(periods);
      },
      findDuplicate: async () => {
        const rows = await tx
          .select()
          .from(deliveryTickets)
          .where(
            and(
              eq(deliveryTickets.userId, input.userId),
              eq(deliveryTickets.clientRequestId, input.value.clientRequestId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      },
      onDuplicate: (duplicate) => ({
        ticket: ticketDto(duplicate),
        idempotent: true,
      }),
      create: async (
        periods: Array<typeof serviceQuotaPeriods.$inferSelect>,
      ) => {
        if (
          input.value.type === "content_asset" &&
          !CONTENT_ASSET_CATALOG.some(
            (item) => item.id === input.value.category?.trim(),
          )
        ) {
          throw new DeliveryTicketError(
            "CONTENT_ASSET_CATEGORY_INVALID",
            "请选择服务端当前开放的内容类型。",
            400,
          );
        }
        if (
          input.value.type !== "content_asset" &&
          input.value.preferredMedia
        ) {
          throw new DeliveryTicketError(
            "PREFERRED_MEDIA_SCOPE_INVALID",
            "意向媒体只能用于内容资产需求。",
            400,
          );
        }
        const websiteWorkflow = await assertWebsiteTicketWorkflow(
          tx,
          input.userId,
          input.value,
        );
        if (input.value.category === "knowledge_base_maintenance") {
          const snapshots = await tx
            .select({ id: knowledgeBaseSnapshots.id })
            .from(knowledgeBaseSnapshots)
            .where(
              and(
                eq(knowledgeBaseSnapshots.id, input.value.knowledgeSnapshotId!),
                eq(knowledgeBaseSnapshots.userId, input.userId),
                eq(knowledgeBaseSnapshots.status, "active"),
              ),
            )
            .limit(1)
            .for("update");
          if (!snapshots[0]) {
            throw new DeliveryTicketError(
              "KNOWLEDGE_SNAPSHOT_NOT_CURRENT",
              "关联知识库已变化，请刷新后重新提交维护需求。",
              409,
            );
          }
        }
        await verifyOwnedAttachments(tx, input.userId, input.value.attachments);
        let period = periods[0];
        let ordinal = 1;
        if (quotaPool) {
          const active = await loadUnifiedDeliveryQuotaUsageRows(tx, {
            userId: input.userId,
            quotaPeriodIds: periods.map((candidate) => candidate.id),
          });
          const selectedPeriod = selectDeliveryTicketQuotaPeriod({
            periods,
            quotaPool,
            activeCounts: unifiedActiveQuotaCountsByPeriod({
              rows: active,
              quotaPool,
            }),
          });
          if (!selectedPeriod) {
            throw new DeliveryTicketError(
              "DELIVERY_TICKET_QUOTA_EXHAUSTED",
              "本服务周期的发布需求额度已用完。",
            );
          }
          period = periods.find(
            (candidate) => candidate.id === selectedPeriod.id,
          )!;
          const allRows = await tx
            .select({ maximum: max(deliveryTickets.ordinal) })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.quotaPeriodId, period.id),
                eq(deliveryTickets.quotaPool, quotaPool),
              ),
            );
          ordinal = Number(allRows[0]?.maximum ?? 0) + 1;
        }
        const technicalDedupe =
          quotaPool === null
            ? technicalTicketDedupeKey({
                category: input.value.category,
                targetPage:
                  input.value.category === "knowledge_base_maintenance"
                    ? `snapshot:${input.value.knowledgeSnapshotId}`
                    : input.value.targetPage,
              })
            : null;
        if (technicalDedupe) {
          const open = await tx
            .select({ id: deliveryTickets.id })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, input.userId),
                eq(deliveryTickets.technicalDedupeKey, technicalDedupe),
              ),
            )
            .limit(1)
            .for("update");
          if (open[0]) {
            throw new DeliveryTicketError(
              "TECHNICAL_TICKET_ALREADY_OPEN",
              "该页面已有同类技术需求，请在原需求中继续补充。",
            );
          }
        }
        const now = new Date();
        const ticketId = randomUUID();
        const eventId = randomUUID();
        const isWorkflowContainer = quotaPool !== null;
        const workflowDomain =
          isWorkflowContainer || input.value.type === "content_asset"
            ? ("content_distribution_engineer" as const)
            : ("ai_operations_engineer" as const);
        const operation =
          isWorkflowContainer || input.value.type === "content_asset"
            ? "content_asset_publish"
            : input.value.category === "knowledge_base_maintenance"
              ? "knowledge_maintenance"
              : input.value.category;
        const ownerRows = await tx
          .select({
            projectAssignmentId: deliveryProjectAssignments.id,
            memberId: deliveryProjectAssignments.engineerUserId,
          })
          .from(deliveryProjectAssignments)
          .innerJoin(
            users,
            eq(users.id, deliveryProjectAssignments.engineerUserId),
          )
          .where(
            and(
              eq(deliveryProjectAssignments.customerUserId, input.userId),
              eq(deliveryProjectAssignments.roleType, workflowDomain),
              eq(users.role, "delivery_member"),
              eq(users.engineerRoleType, workflowDomain),
              eq(users.isActive, true),
            ),
          )
          .limit(1)
          .for("update");
        const owner = ownerRows[0];
        if (!owner) {
          throw new DeliveryTicketError(
            "DELIVERY_OWNER_NOT_ASSIGNED",
            `该业务尚未配置负责人，请联系交付管理员后再提交。`,
            409,
          );
        }
        await tx.insert(deliveryTickets).values({
          id: ticketId,
          isWorkflowContainer,
          userId: input.userId,
          contractId: period.contractId,
          quotaPeriodId: period.id,
          type: input.value.type,
          quotaPool,
          quotaState: quotaPool ? "reserved" : "consumed",
          ordinal,
          clientRequestId: input.value.clientRequestId,
          category: nonEmpty(input.value.category),
          topic: nonEmpty(input.value.topic),
          title: nonEmpty(input.value.title),
          description: nonEmpty(input.value.description),
          preferredMedia: input.value.preferredMedia ?? null,
          icpProvince: nonEmpty(input.value.icpProvince),
          icpDeclarations: input.value.icpDeclarations ?? null,
          targetPage: nonEmpty(input.value.targetPage),
          knowledgeSnapshotId: input.value.knowledgeSnapshotId ?? null,
          workflowDomain: isWorkflowContainer ? null : workflowDomain,
          operation: isWorkflowContainer ? null : operation,
          assignedProjectAssignmentId: isWorkflowContainer
            ? null
            : owner.projectAssignmentId,
          assignedMemberId: isWorkflowContainer ? null : owner.memberId,
          technicalDedupeKey: technicalDedupe,
          materialUrls: input.value.materialUrls,
          status: "submitted",
          createdByUserId: input.userId,
          updatedByUserId: input.userId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(deliveryTicketEvents).values({
          id: eventId,
          ticketId,
          userId: input.userId,
          actorUserId: input.userId,
          actorRole: "user",
          kind: "created",
          visibility: "customer",
          clientRequestId: input.value.clientRequestId,
          message: nonEmpty(input.value.description),
          toStatus: "submitted",
          createdAt: now,
        });
        let workflowChildTicketId: string | null = null;
        let workflowChildEventId: string | null = null;
        if (isWorkflowContainer) {
          const childTicketId = randomUUID();
          const childEventId = randomUUID();
          workflowChildTicketId = childTicketId;
          workflowChildEventId = childEventId;
          const websiteDirect = input.value.type === "website_operation";
          await tx.insert(deliveryTickets).values({
            id: childTicketId,
            parentTicketId: ticketId,
            rootTicketId: ticketId,
            workflowStageKey: "content_asset_publish:initial",
            isWorkflowContainer: false,
            userId: input.userId,
            contractId: period.contractId,
            quotaPeriodId: period.id,
            type: "content_asset",
            quotaPool: null,
            quotaState: "consumed",
            ordinal: 0,
            clientRequestId: randomUUID(),
            category: "content_asset_publish",
            topic: nonEmpty(input.value.topic),
            title: websiteDirect
              ? "制作官网发布所需内容资产"
              : "制作并发布 AI 友好内容资产",
            description: websiteDirect
              ? "客户已提交官网内容需求，请先制作、校验并发布对应内容资产；完成后系统将创建官网发布子任务。"
              : "客户已提交内容资产需求，请制作、校验并发布正式内容资产；完成后系统将创建渠道分发子任务。",
            preferredMedia: input.value.preferredMedia ?? null,
            targetPage: nonEmpty(input.value.targetPage),
            workflowDomain,
            operation,
            assignedProjectAssignmentId: owner.projectAssignmentId,
            assignedMemberId: owner.memberId,
            materialUrls: input.value.materialUrls,
            status: "submitted",
            createdByUserId: input.userId,
            updatedByUserId: input.userId,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(deliveryTicketEvents).values({
            id: childEventId,
            ticketId: childTicketId,
            userId: input.userId,
            actorUserId: input.userId,
            actorRole: "system",
            kind: "created",
            visibility: "internal",
            message: websiteDirect
              ? "客户官网内容根需求已受理，系统创建内容资产发布子任务。"
              : "客户内容资产根需求已受理，系统创建内容资产发布子任务。",
            toStatus: "submitted",
            actorContext: {
              projectAssignmentId: owner.projectAssignmentId,
              customerUserId: input.userId,
              roleType: workflowDomain,
              sourceTicketId: ticketId,
              assignedProjectAssignmentId: owner.projectAssignmentId,
              ...(owner.memberId ? { assignedMemberId: owner.memberId } : {}),
            },
            createdAt: now,
          });
        }
        const files = attachmentRows({
          ticketId,
          eventId,
          workspaceUserId: input.userId,
          ownerUserId: input.userId,
          kind: "input",
          attachments: input.value.attachments,
          now,
        });
        if (files.length)
          await tx.insert(deliveryTicketAttachments).values(files);
        if (
          workflowChildTicketId &&
          workflowChildEventId &&
          input.value.attachments.length
        ) {
          await tx.insert(deliveryTicketAttachments).values(
            attachmentRows({
              ticketId: workflowChildTicketId,
              eventId: workflowChildEventId,
              workspaceUserId: input.userId,
              ownerUserId: input.userId,
              kind: "input",
              attachments: input.value.attachments,
              now,
            }),
          );
        }
        if (input.value.type === "website_operation") {
          const category = input.value.category?.trim();
          if (category === "domain_application") {
            if (websiteWorkflow.profile) {
              await tx
                .update(workspaceSiteProfiles)
                .set({
                  domain: websiteWorkflow.domain,
                  domainStatus: "pending",
                  domainVerifiedAt: null,
                  revision: websiteWorkflow.profile.revision + 1,
                  updatedByUserId: input.userId,
                  updatedAt: now,
                })
                .where(eq(workspaceSiteProfiles.userId, input.userId));
            } else {
              await tx.insert(workspaceSiteProfiles).values({
                userId: input.userId,
                domain: websiteWorkflow.domain,
                siteMode: "unknown",
                domainStatus: "pending",
                icpStatus: "not_submitted",
                revision: 1,
                updatedByUserId: input.userId,
                createdAt: now,
                updatedAt: now,
              });
            }
          } else if (category === "icp_filing") {
            if (websiteWorkflow.profile) {
              await tx
                .update(workspaceSiteProfiles)
                .set({
                  domain:
                    websiteWorkflow.domain || websiteWorkflow.profile.domain,
                  domainStatus:
                    websiteWorkflow.profile.domainStatus === "completed"
                      ? "completed"
                      : "pending",
                  domainVerifiedAt:
                    websiteWorkflow.profile.domainStatus === "completed"
                      ? websiteWorkflow.profile.domainVerifiedAt
                      : null,
                  icpNumber: input.value.icpDeclarations?.icpNumber || null,
                  icpStatus: "submitted",
                  icpVerifiedAt: null,
                  revision: websiteWorkflow.profile.revision + 1,
                  updatedByUserId: input.userId,
                  updatedAt: now,
                })
                .where(eq(workspaceSiteProfiles.userId, input.userId));
            } else {
              await tx.insert(workspaceSiteProfiles).values({
                userId: input.userId,
                domain: websiteWorkflow.domain,
                siteMode: "unknown",
                domainStatus: "pending",
                icpNumber: input.value.icpDeclarations?.icpNumber || null,
                icpStatus: "submitted",
                revision: 1,
                updatedByUserId: input.userId,
                createdAt: now,
                updatedAt: now,
              });
            }
          }
        }
        const created = await tx
          .select()
          .from(deliveryTickets)
          .where(eq(deliveryTickets.id, ticketId))
          .limit(1);
        return { ticket: ticketDto(created[0]), idempotent: false };
      },
    }),
  );
}

export async function assertKnowledgeMaintenanceTicketForUpload(input: {
  userId: number;
  ticketId: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, input.ticketId),
        eq(deliveryTickets.userId, input.userId),
      ),
    )
    .limit(1);
  const ticket = rows[0];
  if (
    !ticket ||
    ticket.type !== "website_operation" ||
    ticket.category !== "knowledge_base_maintenance"
  ) {
    throw new DeliveryTicketError(
      "KNOWLEDGE_MAINTENANCE_TICKET_INVALID",
      "该需求不是当前客户的知识库维护需求。",
      400,
    );
  }
  if (TERMINAL_STATUSES.has(ticket.status)) {
    throw new DeliveryTicketError(
      "TICKET_CLOSED",
      "已结束的维护需求不能再上传知识库。",
      409,
    );
  }
  return ticket;
}

async function requireOwnedTicket(
  executor: any,
  userId: number,
  ticketId: string,
  lock = false,
) {
  let query = executor
    .select()
    .from(deliveryTickets)
    .where(
      and(eq(deliveryTickets.id, ticketId), eq(deliveryTickets.userId, userId)),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  if (!rows[0]) {
    throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
  }
  return rows[0];
}

/**
 * Existing tickets settle against the immutable contract/quota period captured
 * when the customer submitted them. Current plan status must not strand a
 * reserved slot after expiry or downgrade, but the historical binding still
 * has to belong to the same workspace and contract.
 */
export async function assertExistingDeliveryTicketSettlementScope(input: {
  executor: any;
  userId: number;
  ticket: Pick<
    typeof deliveryTickets.$inferSelect,
    "userId" | "contractId" | "quotaPeriodId" | "quotaPool" | "quotaState"
  >;
}) {
  if (input.ticket.userId !== input.userId) {
    throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
  }
  const periods = await input.executor
    .select({
      id: serviceQuotaPeriods.id,
      userId: serviceQuotaPeriods.userId,
      contractId: serviceQuotaPeriods.contractId,
    })
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.id, input.ticket.quotaPeriodId),
        eq(serviceQuotaPeriods.userId, input.userId),
        eq(serviceQuotaPeriods.contractId, input.ticket.contractId),
      ),
    )
    .limit(1)
    .for("update");
  if (!periods[0]) {
    throw new DeliveryTicketError(
      "TICKET_QUOTA_SCOPE_INVALID",
      "需求绑定的历史服务周期不属于当前企业，不能结算。",
      409,
    );
  }
  if (input.ticket.quotaPool && input.ticket.quotaState === "released") {
    throw new DeliveryTicketError(
      "TICKET_QUOTA_ALREADY_RELEASED",
      "该需求预留的发布额度已经释放，不能再完成。",
      409,
    );
  }
  return periods[0];
}

export async function getDeliveryTicketDetail(input: {
  userId: number;
  ticketId: string;
  includeInternal?: boolean;
}) {
  const db = await requireDb();
  const ticket = await requireOwnedTicket(db, input.userId, input.ticketId);
  const workflowRootId = ticket.isWorkflowContainer
    ? ticket.id
    : ticket.rootTicketId;
  const [events, attachmentRows, assignedMemberRows, workflowRelationRows] =
    await Promise.all([
      db
        .select()
        .from(deliveryTicketEvents)
        .where(
          and(
            eq(deliveryTicketEvents.ticketId, ticket.id),
            ...(input.includeInternal
              ? []
              : [eq(deliveryTicketEvents.visibility, "customer")]),
          ),
        )
        .orderBy(asc(deliveryTicketEvents.createdAt)),
      db
        .select({
          attachment: deliveryTicketAttachments,
          eventVisibility: deliveryTicketEvents.visibility,
        })
        .from(deliveryTicketAttachments)
        .leftJoin(
          deliveryTicketEvents,
          and(
            eq(deliveryTicketEvents.id, deliveryTicketAttachments.eventId),
            eq(
              deliveryTicketEvents.ticketId,
              deliveryTicketAttachments.ticketId,
            ),
          ),
        )
        .where(eq(deliveryTicketAttachments.ticketId, ticket.id))
        .orderBy(asc(deliveryTicketAttachments.createdAt)),
      input.includeInternal && ticket.assignedMemberId
        ? db
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
            })
            .from(users)
            .where(eq(users.id, ticket.assignedMemberId))
            .limit(1)
        : [],
      input.includeInternal && workflowRootId
        ? db
            .select({
              id: deliveryTickets.id,
              parentTicketId: deliveryTickets.parentTicketId,
              rootTicketId: deliveryTickets.rootTicketId,
              isWorkflowContainer: deliveryTickets.isWorkflowContainer,
              operation: deliveryTickets.operation,
              status: deliveryTickets.status,
              workflowDomain: deliveryTickets.workflowDomain,
              assignedMemberId: deliveryTickets.assignedMemberId,
              createdAt: deliveryTickets.createdAt,
            })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, ticket.userId),
                or(
                  eq(deliveryTickets.id, workflowRootId),
                  eq(deliveryTickets.rootTicketId, workflowRootId),
                ),
              ),
            )
            .orderBy(asc(deliveryTickets.createdAt), asc(deliveryTickets.id))
        : [],
    ]);
  const workflowMemberIds = Array.from(
    new Set(
      workflowRelationRows.flatMap((relation) =>
        relation.assignedMemberId ? [relation.assignedMemberId] : [],
      ),
    ),
  );
  const workflowMemberRows = workflowMemberIds.length
    ? await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
        })
        .from(users)
        .where(inArray(users.id, workflowMemberIds))
    : [];
  const workflowMemberNames = new Map(
    workflowMemberRows.map((member) => [
      member.id,
      member.displayName?.trim() ||
        member.username?.trim() ||
        `工程师 ${member.id}`,
    ]),
  );
  const workflowRelationDto = (
    relation: (typeof workflowRelationRows)[number],
  ) => ({
    id: relation.id,
    parentTicketId: relation.parentTicketId,
    rootTicketId: relation.rootTicketId,
    operation: relation.operation,
    status: relation.status,
    workflowDomain: relation.workflowDomain,
    assignedMemberId: relation.assignedMemberId,
    assignedMemberName: relation.assignedMemberId
      ? (workflowMemberNames.get(relation.assignedMemberId) ?? null)
      : null,
  });
  const attachments = attachmentRows
    .filter((row) =>
      isDeliveryTicketAttachmentVisible(
        Boolean(input.includeInternal),
        row.eventVisibility,
      ),
    )
    .map((row) => row.attachment);
  return {
    ticket: ticketDto(ticket, {
      attachmentCount: attachments.length,
      assignedMemberName: assignedMemberRows[0]
        ? assignedMemberRows[0].displayName?.trim() ||
          assignedMemberRows[0].username?.trim() ||
          `工程师 ${assignedMemberRows[0].id}`
        : null,
    }),
    events: events.map((event) => ({
      id: event.id,
      eventType: event.kind,
      visibility: event.visibility,
      actorRole: event.actorRole,
      actorLabel: deliveryActorRoleLabel(event.actorRole, "internal"),
      ...(input.includeInternal
        ? { actorContext: event.actorContext ?? null }
        : {}),
      message: deliveryEventDisplayMessage(event, "internal"),
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      operationResult: event.operationResult,
      createdAt: epoch(event.createdAt),
    })),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      fileId: attachment.upstreamFileId ?? "",
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      purpose: attachment.purpose,
      authorization: attachment.authorization,
      copyrightNote: attachment.copyrightNote,
      kind: attachment.kind,
      createdAt: epoch(attachment.createdAt),
      downloadUrl: `/api/delivery-ticket-attachments/${attachment.id}/content`,
    })),
    ...(input.includeInternal
      ? {
          workflowRelations: {
            root: workflowRelationRows.find(
              (relation) => relation.id === workflowRootId,
            )
              ? workflowRelationDto(
                  workflowRelationRows.find(
                    (relation) => relation.id === workflowRootId,
                  )!,
                )
              : null,
            children: workflowRelationRows
              .filter((relation) => !relation.isWorkflowContainer)
              .map(workflowRelationDto),
          },
        }
      : {}),
  };
}

export async function getPublicDeliveryTicketDetail(input: {
  userId: number;
  ticketId: string;
}) {
  const db = await requireDb();
  const ticket = await requireOwnedTicket(db, input.userId, input.ticketId);
  if (!isCustomerVisibleDeliveryTicket(ticket)) {
    throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
  }
  const summary = toPublicDeliveryTicketSummary(ticketDto(ticket));
  if (summary.type === "website_operation") {
    const [events, attachments] = await Promise.all([
      db
        .select({
          id: deliveryTicketEvents.id,
          actorRole: deliveryTicketEvents.actorRole,
          kind: deliveryTicketEvents.kind,
          message: deliveryTicketEvents.message,
          fromStatus: deliveryTicketEvents.fromStatus,
          toStatus: deliveryTicketEvents.toStatus,
          createdAt: deliveryTicketEvents.createdAt,
        })
        .from(deliveryTicketEvents)
        .where(
          and(
            eq(deliveryTicketEvents.ticketId, ticket.id),
            eq(deliveryTicketEvents.visibility, "customer"),
          ),
        )
        .orderBy(asc(deliveryTicketEvents.createdAt)),
      db
        .select({
          id: deliveryTicketAttachments.id,
          filename: deliveryTicketAttachments.filename,
          mimeType: deliveryTicketAttachments.mimeType,
          sizeBytes: deliveryTicketAttachments.sizeBytes,
          purpose: deliveryTicketAttachments.purpose,
          kind: deliveryTicketAttachments.kind,
          createdAt: deliveryTicketAttachments.createdAt,
        })
        .from(deliveryTicketAttachments)
        .innerJoin(
          deliveryTicketEvents,
          and(
            eq(deliveryTicketEvents.id, deliveryTicketAttachments.eventId),
            eq(
              deliveryTicketEvents.ticketId,
              deliveryTicketAttachments.ticketId,
            ),
            eq(deliveryTicketEvents.visibility, "customer"),
          ),
        )
        .where(eq(deliveryTicketAttachments.ticketId, ticket.id))
        .orderBy(asc(deliveryTicketAttachments.createdAt)),
    ]);
    return publicWebsiteTicketDetailSchema.parse({
      ticket: {
        ...summary,
        revision: ticket.revision,
        canReply: !TERMINAL_STATUSES.has(ticket.status),
        canAttach: websiteTicketAllowsPublicAttachments(ticket.category),
      },
      events: events.map((event) => ({
        id: event.id,
        actorRole: event.actorRole,
        actorLabel: deliveryActorRoleLabel(event.actorRole, "customer"),
        message: deliveryEventDisplayMessage(event, "customer"),
        createdAt: epoch(event.createdAt),
      })),
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        purpose: attachment.purpose,
        kind: attachment.kind,
        createdAt: epoch(attachment.createdAt),
        downloadUrl: `/api/delivery-ticket-attachments/${attachment.id}/content`,
      })),
    });
  }

  if (summary.type === "knowledge_base") {
    const events = await db
      .select({
        id: deliveryTicketEvents.id,
        actorRole: deliveryTicketEvents.actorRole,
        kind: deliveryTicketEvents.kind,
        message: deliveryTicketEvents.message,
        fromStatus: deliveryTicketEvents.fromStatus,
        toStatus: deliveryTicketEvents.toStatus,
        createdAt: deliveryTicketEvents.createdAt,
      })
      .from(deliveryTicketEvents)
      .where(
        and(
          eq(deliveryTicketEvents.ticketId, ticket.id),
          eq(deliveryTicketEvents.visibility, "customer"),
        ),
      )
      .orderBy(asc(deliveryTicketEvents.createdAt));
    return publicKnowledgeBaseTicketDetailSchema.parse({
      ticket: summary,
      events: events.map((event) => ({
        id: event.id,
        actorRole: event.actorRole,
        actorLabel: deliveryActorRoleLabel(event.actorRole, "customer"),
        message: deliveryEventDisplayMessage(event, "customer"),
        createdAt: epoch(event.createdAt),
      })),
    });
  }

  const [events, attachments] = await Promise.all([
    db
      .select({
        id: deliveryTicketEvents.id,
        actorRole: deliveryTicketEvents.actorRole,
        kind: deliveryTicketEvents.kind,
        message: deliveryTicketEvents.message,
        fromStatus: deliveryTicketEvents.fromStatus,
        toStatus: deliveryTicketEvents.toStatus,
        createdAt: deliveryTicketEvents.createdAt,
      })
      .from(deliveryTicketEvents)
      .where(
        and(
          eq(deliveryTicketEvents.ticketId, ticket.id),
          eq(deliveryTicketEvents.visibility, "customer"),
        ),
      )
      .orderBy(asc(deliveryTicketEvents.createdAt)),
    db
      .select({
        id: deliveryTicketAttachments.id,
        filename: deliveryTicketAttachments.filename,
        mimeType: deliveryTicketAttachments.mimeType,
        sizeBytes: deliveryTicketAttachments.sizeBytes,
        purpose: deliveryTicketAttachments.purpose,
        kind: deliveryTicketAttachments.kind,
        createdAt: deliveryTicketAttachments.createdAt,
      })
      .from(deliveryTicketAttachments)
      .innerJoin(
        deliveryTicketEvents,
        and(
          eq(deliveryTicketEvents.id, deliveryTicketAttachments.eventId),
          eq(deliveryTicketEvents.ticketId, deliveryTicketAttachments.ticketId),
          eq(deliveryTicketEvents.visibility, "customer"),
        ),
      )
      .where(eq(deliveryTicketAttachments.ticketId, ticket.id))
      .orderBy(asc(deliveryTicketAttachments.createdAt)),
  ]);
  const preferredMedia =
    ticket.preferredMedia &&
    ALL_CONTENT_ASSET_MEDIA_OPTIONS.includes(
      ticket.preferredMedia as (typeof ALL_CONTENT_ASSET_MEDIA_OPTIONS)[number],
    )
      ? (ticket.preferredMedia as (typeof ALL_CONTENT_ASSET_MEDIA_OPTIONS)[number])
      : null;
  return publicContentAssetTicketDetailSchema.parse({
    ticket: {
      ...summary,
      preferredMedia,
      revision: ticket.revision,
      canReply: !TERMINAL_STATUSES.has(ticket.status),
    },
    events: events.map((event) => ({
      id: event.id,
      actorRole: event.actorRole,
      actorLabel: deliveryActorRoleLabel(event.actorRole, "customer"),
      message: deliveryEventDisplayMessage(event, "customer"),
      createdAt: epoch(event.createdAt),
    })),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      purpose: attachment.purpose,
      kind: attachment.kind,
      createdAt: epoch(attachment.createdAt),
      downloadUrl: `/api/delivery-ticket-attachments/${attachment.id}/content`,
    })),
  });
}

export function isDeliveryTicketAttachmentVisible(
  includeInternal: boolean,
  eventVisibility: "customer" | "internal" | null,
) {
  return includeInternal || eventVisibility === "customer";
}

export function assertDeliveryTicketMessagePolicy(input: {
  ticketType: DeliveryTicketType;
  ticketCategory?: string | null;
  actorRole: AuthenticatedUser["role"];
  visibility: "customer" | "internal";
  attachmentCount?: number;
}) {
  if (
    input.ticketType === "website_operation" &&
    input.visibility === "customer" &&
    (input.attachmentCount ?? 0) > 0 &&
    !websiteTicketAllowsPublicAttachments(input.ticketCategory)
  ) {
    throw new DeliveryTicketError(
      "WEBSITE_PUBLIC_ATTACHMENTS_NOT_ALLOWED",
      "该官网需求只接收文字补充；请勿上传证件、密码、负责人照片或其他备案材料。",
      400,
    );
  }
}

export function assertDeliveryOperationPolicy(ticketType: DeliveryTicketType) {
  if (ticketType === "website_operation") {
    throw new DeliveryTicketError(
      "WEBSITE_DELIVERY_OPERATION_NOT_ALLOWED",
      "官网需求不回传发布页面、外部链接或交付文件。",
      400,
    );
  }
}

const TERMINAL_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

export async function addDeliveryTicketMessage(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
  value: AddDeliveryTicketMessageInput;
  visibility?: "customer" | "internal";
  attachmentKind?: "input" | "deliverable";
}) {
  const db = await requireDb();
  const portal = await getServicePortal(input.workspaceUserId);
  if (input.actor.role === "user") {
    if (input.actor.id !== input.workspaceUserId) {
      throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
    }
    assertDeliveryTicketServiceEligibility(portal);
  } else {
    await assertWorkspaceAccess(input.actor, input.workspaceUserId);
    assertDeliveryTicketServiceEligibility(portal);
  }
  return db.transaction(async (tx) => {
    const initialTicket = await requireOwnedTicket(
      tx,
      input.workspaceUserId,
      input.value.ticketId,
      false,
    );
    if (
      input.actor.role === "user" &&
      !isCustomerVisibleDeliveryTicket(initialTicket)
    ) {
      throw new DeliveryTicketError("TICKET_NOT_FOUND", "需求不存在。", 404);
    }
    assertDeliveryTicketServiceEligibility(portal, initialTicket.type);
    const visibility = input.visibility ?? "customer";
    assertDeliveryTicketMessagePolicy({
      ticketType: initialTicket.type,
      ticketCategory: initialTicket.category,
      actorRole: input.actor.role,
      visibility,
      attachmentCount: input.value.attachments.length,
    });
    const existing = await tx
      .select()
      .from(deliveryTicketEvents)
      .where(
        and(
          eq(deliveryTicketEvents.actorUserId, input.actor.id),
          eq(deliveryTicketEvents.clientRequestId, input.value.clientRequestId),
        ),
      )
      .limit(1);
    if (existing[0]) return { eventId: existing[0].id, idempotent: true };

    const initiallyNeedsWorkflowPropagation =
      input.actor.role === "user" &&
      initialTicket.isWorkflowContainer &&
      initialTicket.status === "needs_information";
    const workflowChildRows = initiallyNeedsWorkflowPropagation
      ? await tx
          .select()
          .from(deliveryTickets)
          .where(
            and(
              eq(deliveryTickets.userId, input.workspaceUserId),
              eq(deliveryTickets.rootTicketId, initialTicket.id),
              eq(deliveryTickets.isWorkflowContainer, false),
              eq(deliveryTickets.status, "needs_information"),
            ),
          )
          .orderBy(asc(deliveryTickets.createdAt), asc(deliveryTickets.id))
          .limit(2)
          .for("update")
      : [];
    const workflowChild = initiallyNeedsWorkflowPropagation
      ? selectWorkflowCustomerSupplementChild(workflowChildRows)
      : null;

    // Execution transitions lock child -> root. Preserve the same lock order
    // for customer supplements, then re-read the root under lock.
    const ticket = await requireOwnedTicket(
      tx,
      input.workspaceUserId,
      input.value.ticketId,
      true,
    );
    const existingAfterLock = await tx
      .select()
      .from(deliveryTicketEvents)
      .where(
        and(
          eq(deliveryTicketEvents.actorUserId, input.actor.id),
          eq(deliveryTicketEvents.clientRequestId, input.value.clientRequestId),
        ),
      )
      .limit(1);
    if (existingAfterLock[0]) {
      return { eventId: existingAfterLock[0].id, idempotent: true };
    }
    const lockedNeedsWorkflowPropagation =
      input.actor.role === "user" &&
      ticket.isWorkflowContainer &&
      ticket.status === "needs_information";
    if (
      lockedNeedsWorkflowPropagation !== initiallyNeedsWorkflowPropagation ||
      lockedNeedsWorkflowPropagation !== Boolean(workflowChild)
    ) {
      throw new DeliveryTicketError(
        "WORKFLOW_SUPPLEMENT_STATE_CHANGED",
        "需求处理状态刚刚发生变化，请刷新后重新提交补充资料。",
        409,
      );
    }
    if (TERMINAL_STATUSES.has(ticket.status)) {
      throw new DeliveryTicketError(
        "TICKET_CLOSED",
        "该需求已结束，不能继续补充消息。",
      );
    }
    await verifyOwnedAttachments(tx, input.actor.id, input.value.attachments);
    const now = new Date();
    const eventId = randomUUID();
    const workflowPlan = workflowChild
      ? planWorkflowCustomerSupplement({
          rootScheduledAt: ticket.scheduledAt,
          rootQuotaState: ticket.quotaState,
          children: [workflowChild],
          message: input.value.message,
          attachments: input.value.attachments,
        })
      : null;
    const nextStatus =
      workflowPlan?.rootStatus ??
      deliveryTicketStatusAfterCustomerMessage({
        actorRole: input.actor.role,
        currentStatus: ticket.status,
      });
    const returnsToServiceQueue = nextStatus !== ticket.status;
    await tx.insert(deliveryTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      userId: input.workspaceUserId,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      kind: "message",
      visibility,
      clientRequestId: input.value.clientRequestId,
      message: input.value.message,
      fromStatus: returnsToServiceQueue ? ticket.status : null,
      toStatus: returnsToServiceQueue ? nextStatus : null,
      createdAt: now,
    });
    const files = attachmentRows({
      ticketId: ticket.id,
      eventId,
      workspaceUserId: input.workspaceUserId,
      ownerUserId: input.actor.id,
      kind:
        input.attachmentKind ??
        (input.actor.role === "admin" ? "deliverable" : "input"),
      attachments: input.value.attachments,
      now,
    });
    if (files.length) await tx.insert(deliveryTicketAttachments).values(files);
    if (workflowPlan) {
      const childEventId = randomUUID();
      const child = workflowPlan.child;
      await tx.insert(deliveryTicketEvents).values({
        id: childEventId,
        ticketId: child.id,
        userId: input.workspaceUserId,
        actorUserId: input.actor.id,
        actorRole: "user",
        kind: "message",
        visibility: "internal",
        message: workflowPlan.internalMessage,
        fromStatus: "needs_information",
        toStatus: workflowPlan.childStatus,
        actorContext: {
          projectAssignmentId: child.assignedProjectAssignmentId!,
          customerUserId: input.workspaceUserId,
          roleType: child.workflowDomain!,
          sourceTicketId: ticket.id,
          assignedProjectAssignmentId: child.assignedProjectAssignmentId!,
          assignedMemberId: child.assignedMemberId!,
        },
        createdAt: now,
      });
      const childAttachmentReferences = attachmentRows({
        ticketId: child.id,
        eventId: childEventId,
        workspaceUserId: input.workspaceUserId,
        ownerUserId: input.actor.id,
        kind: "input",
        attachments: input.value.attachments,
        now,
      });
      // These are ticket-scoped metadata references to the same upstream file
      // ids; no file bytes or upstream blobs are copied.
      if (childAttachmentReferences.length) {
        await tx
          .insert(deliveryTicketAttachments)
          .values(childAttachmentReferences);
      }
      await tx
        .update(deliveryTickets)
        .set({
          status: workflowPlan.childStatus,
          publicSummary: null,
          scheduledAt: child.scheduledAt ?? now,
          resolvedAt: null,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(deliveryTickets.id, child.id));
    }
    await tx
      .update(deliveryTickets)
      .set({
        ...(returnsToServiceQueue
          ? {
              status: nextStatus,
              ...(workflowPlan
                ? {
                    quotaState: workflowPlan.rootQuotaState,
                    publicSummary: null,
                    scheduledAt: ticket.scheduledAt ?? now,
                    resolvedAt: null,
                  }
                : {}),
              revision: sql`${deliveryTickets.revision} + 1`,
            }
          : {}),
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    return { eventId, idempotent: false };
  });
}

export function deriveTicketQuotaTransition(input: {
  currentState: "reserved" | "consumed" | "released";
  scheduledAt: Date | null;
  nextStatus: DeliveryTicketStatus;
}) {
  if (
    (input.nextStatus === "scheduled" ||
      input.nextStatus === "in_progress" ||
      input.nextStatus === "completed") &&
    input.currentState === "reserved"
  ) {
    return "consumed" as const;
  }
  if (
    (input.nextStatus === "rejected" || input.nextStatus === "cancelled") &&
    !input.scheduledAt &&
    input.currentState === "reserved"
  ) {
    return "released" as const;
  }
  return input.currentState;
}

async function resolveManagedDeliveryTicketUserIds(input: {
  db: any;
  actor: AuthenticatedUser;
  userId?: number;
  assignedAdminId?: number;
}) {
  const { db, actor, userId, assignedAdminId } = input;
  let authorizedUserIds: number[];
  if (userId) {
    await assertWorkspaceAccess(actor, userId);
    authorizedUserIds = [userId];
  } else if (isSystemAdmin(actor)) {
    authorizedUserIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "user"))
    ).map((row: { id: number }) => row.id);
  } else {
    authorizedUserIds = (
      await db
        .select({ id: userAdminAssignments.userId })
        .from(userAdminAssignments)
        .where(eq(userAdminAssignments.adminId, actor.id))
    ).map((row: { id: number }) => row.id);
  }
  if (!assignedAdminId || !authorizedUserIds.length) {
    return authorizedUserIds;
  }
  const assignedIds = new Set(
    (
      await db
        .select({ id: userAdminAssignments.userId })
        .from(userAdminAssignments)
        .where(
          and(
            eq(userAdminAssignments.adminId, assignedAdminId),
            inArray(userAdminAssignments.userId, authorizedUserIds),
          ),
        )
    ).map((row: { id: number }) => row.id),
  );
  return authorizedUserIds.filter((id) => assignedIds.has(id));
}

async function countManagedDeliveryTickets(input: {
  db: any;
  userIds: number[];
  type?: AdminDeliveryTicketListInput["type"];
  quotaPeriodId?: string;
  query?: string;
}) {
  const empty = {
    pending: 0,
    completedPublic: 0,
    submitted: 0,
    needsInformation: 0,
    scheduled: 0,
    inProgress: 0,
    completed: 0,
  };
  if (!input.userIds.length) return empty;
  const queryPattern = deliveryTicketSearchPattern(input.query);
  const rows = await input.db
    .select({
      status: deliveryTickets.status,
      value: count(),
    })
    .from(deliveryTickets)
    .innerJoin(users, eq(users.id, deliveryTickets.userId))
    .where(
      and(
        inArray(deliveryTickets.userId, input.userIds),
        ...(input.type ? [eq(deliveryTickets.type, input.type)] : []),
        ...(input.quotaPeriodId
          ? [eq(deliveryTickets.quotaPeriodId, input.quotaPeriodId)]
          : []),
        ...(queryPattern
          ? [
              or(
                like(users.displayName, queryPattern),
                like(deliveryTickets.title, queryPattern),
                like(deliveryTickets.topic, queryPattern),
                like(deliveryTickets.category, queryPattern),
              )!,
            ]
          : []),
      ),
    )
    .groupBy(deliveryTickets.status);
  const values = new Map<DeliveryTicketStatus, number>(
    rows.map((row: { status: DeliveryTicketStatus; value: number }) => [
      row.status,
      Number(row.value),
    ]),
  );
  return {
    pending:
      (values.get("submitted") ?? 0) +
      (values.get("needs_information") ?? 0) +
      (values.get("scheduled") ?? 0) +
      (values.get("in_progress") ?? 0),
    completedPublic:
      (values.get("completed") ?? 0) +
      (values.get("rejected") ?? 0) +
      (values.get("cancelled") ?? 0),
    submitted: values.get("submitted") ?? 0,
    needsInformation: values.get("needs_information") ?? 0,
    scheduled: values.get("scheduled") ?? 0,
    inProgress: values.get("in_progress") ?? 0,
    completed: values.get("completed") ?? 0,
  };
}

export async function listManagedDeliveryTickets(input: {
  actor: AuthenticatedUser;
  userId?: number;
  type?: AdminDeliveryTicketListInput["type"];
  status?: AdminDeliveryTicketListInput["status"];
  publicStatus?: AdminDeliveryTicketListInput["publicStatus"];
  quotaPeriodId?: string;
  assignedAdminId?: number;
  query?: string;
  limit?: number;
  cursor?: string;
  order?: AdminDeliveryTicketListInput["order"];
}) {
  const db = await requireDb();
  const userIds = await resolveManagedDeliveryTicketUserIds({
    db,
    actor: input.actor,
    userId: input.userId,
    assignedAdminId: input.assignedAdminId,
  });
  const [page, counts] = await Promise.all([
    loadTicketSummaryPage(db, {
      userIds,
      type: input.type,
      status: input.status,
      publicStatus: input.publicStatus,
      quotaPeriodId: input.quotaPeriodId,
      query: input.query,
      limit: Math.min(100, Math.max(1, input.limit ?? 20)),
      cursor: input.cursor,
      order: input.order,
    }),
    countManagedDeliveryTickets({
      db,
      userIds,
      type: input.type,
      quotaPeriodId: input.quotaPeriodId,
      query: input.query,
    }),
  ]);
  return {
    ...page,
    counts,
  };
}

export async function updateManagedDeliveryTicket(input: {
  actor: AuthenticatedUser;
  userId: number;
  value: UpdateDeliveryTicketInput;
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticket = await requireOwnedTicket(
      tx,
      input.userId,
      input.value.ticketId,
      true,
    );
    assertManagedTicketCanBeExecutedByAdmin({
      actor: input.actor,
      ticket,
    });
    await assertExistingDeliveryTicketSettlementScope({
      executor: tx,
      userId: input.userId,
      ticket,
    });
    if (ticket.revision !== input.value.expectedRevision) {
      throw new DeliveryTicketError(
        "TICKET_REVISION_CONFLICT",
        "需求已被其他管理员更新，请刷新后重试。",
      );
    }
    if (TERMINAL_STATUSES.has(ticket.status)) {
      throw new DeliveryTicketError(
        "TICKET_CLOSED",
        "已结束需求不能再次变更。",
      );
    }
    if (input.value.status !== "completed") {
      throw new DeliveryTicketError(
        "PUBLIC_STATUS_TRANSITION_INVALID",
        "需求只支持从待处理直接更新为已完成；过程沟通请写入需求详情。",
        400,
      );
    }
    const publicSummary = nonEmpty(input.value.publicSummary);
    if (!publicSummary) {
      throw new DeliveryTicketError(
        "PUBLIC_SUMMARY_REQUIRED",
        "完成需求前必须填写用户可见的内容总结。",
        400,
      );
    }
    assertManagedLegacySummaryClose({
      publicSummary,
      publicMessage: input.value.publicMessage,
      deliveryLinks: input.value.deliveryLinks,
      verifiedDomain: input.value.verifiedDomain,
      internalNote: input.value.internalNote,
    });
    if (
      ticket.type === "website_operation" &&
      (input.value.deliveryLinks?.length ?? 0) > 0
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_DELIVERY_LINKS_NOT_ALLOWED",
        "官网需求完成结果直接体现在网站中，不在看板回传发布链接。",
        400,
      );
    }
    if (
      ticket.type === "website_operation" &&
      nonEmpty(input.value.publicMessage)
    ) {
      throw new DeliveryTicketError(
        "WEBSITE_PUBLIC_MESSAGE_NOT_ALLOWED",
        "官网需求的完成结果请写入内容总结，无需额外添加完成消息。",
        400,
      );
    }
    let verifiedDomain: string | null = null;
    let domainApplicationOverseas = false;
    if (
      ticket.type === "website_operation" &&
      ticket.category === "domain_application"
    ) {
      const accountRows = await tx
        .select({ marketEdition: users.marketEdition })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      const domainCompletion = resolveManagedDomainApplicationCompletion({
        marketEdition:
          accountRows[0]?.marketEdition === "overseas"
            ? "overseas"
            : "domestic",
        publicSummary,
      });
      domainApplicationOverseas = domainCompletion.overseas;
      verifiedDomain = normalizeDomain(
        input.value.verifiedDomain || ticket.topic || ticket.title,
      );
      if (!verifiedDomain) {
        throw new DeliveryTicketError(
          "VERIFIED_DOMAIN_REQUIRED",
          "完成域名核验前必须填写并核验实际域名。",
          400,
        );
      }
    }
    if (
      ticket.type === "website_operation" &&
      ticket.category === "icp_filing"
    ) {
      await assertIcpTicketReadyForCompletion({
        ticket,
      });
    }
    if (
      ticket.type === "website_operation" &&
      ticket.category === "knowledge_base_maintenance"
    ) {
      const replacementSnapshots = await tx
        .select({ id: knowledgeBaseSnapshots.id })
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.userId, input.userId),
            eq(knowledgeBaseSnapshots.status, "active"),
            eq(knowledgeBaseSnapshots.maintenanceTicketId, ticket.id),
            ticket.knowledgeSnapshotId
              ? ne(knowledgeBaseSnapshots.id, ticket.knowledgeSnapshotId)
              : undefined,
          ),
        )
        .limit(1)
        .for("update");
      if (!replacementSnapshots[0]) {
        throw new DeliveryTicketError(
          "KNOWLEDGE_MAINTENANCE_NOT_PUBLISHED",
          "完成维护需求前，必须先上传并发布通过校验的新知识库版本。",
          409,
        );
      }
    }
    const nextQuotaState = deriveTicketQuotaTransition({
      currentState: ticket.quotaState,
      scheduledAt: ticket.scheduledAt,
      nextStatus: input.value.status,
    });
    const now = new Date();
    const terminal = true;
    const hasEnteredExecution = true;
    let contentDeliveryLinks = ticket.deliveryLinks;
    if (ticket.type === "content_asset") {
      if (input.value.deliveryLinks !== undefined) {
        contentDeliveryLinks = input.value.deliveryLinks;
      } else {
        const deliveryResultRows = await tx
          .select({
            operationResult: deliveryTicketEvents.operationResult,
          })
          .from(deliveryTicketEvents)
          .where(
            and(
              eq(deliveryTicketEvents.ticketId, ticket.id),
              eq(deliveryTicketEvents.kind, "delivery_result"),
              eq(deliveryTicketEvents.visibility, "customer"),
            ),
          )
          .orderBy(asc(deliveryTicketEvents.createdAt));
        const derivedLinks = deliveryLinksFromOperationResults(
          deliveryResultRows.map((row) => row.operationResult),
        );
        if (derivedLinks.length > 0) {
          contentDeliveryLinks = derivedLinks;
        }
      }
    }
    await tx
      .update(deliveryTickets)
      .set({
        status: input.value.status,
        quotaState: nextQuotaState,
        internalNote:
          input.value.internalNote === undefined
            ? ticket.internalNote
            : nonEmpty(input.value.internalNote),
        topic:
          ticket.type === "website_operation" &&
          ticket.category === "domain_application"
            ? verifiedDomain
            : ticket.topic,
        publicSummary,
        deliveryLinks:
          ticket.type === "content_asset" ? contentDeliveryLinks : [],
        scheduledAt:
          hasEnteredExecution && !ticket.scheduledAt ? now : ticket.scheduledAt,
        quotaReleasedAt:
          nextQuotaState === "released" && ticket.quotaState !== "released"
            ? now
            : ticket.quotaReleasedAt,
        resolvedAt: terminal ? now : null,
        technicalDedupeKey: terminal ? null : ticket.technicalDedupeKey,
        revision: ticket.revision + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    if (
      ticket.type === "website_operation" &&
      ticket.category === "domain_application"
    ) {
      const profiles = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.userId))
        .limit(1)
        .for("update");
      const profile = profiles[0];
      if (!profile) {
        throw new DeliveryTicketError(
          "SITE_PROFILE_NOT_FOUND",
          "域名资料不存在，请刷新后重试。",
        );
      }
      await tx
        .update(workspaceSiteProfiles)
        .set({
          domain: verifiedDomain,
          domainStatus: "completed",
          domainVerifiedAt: now,
          ...(domainApplicationOverseas
            ? {
                icpNumber: null,
                icpStatus: "not_required" as const,
                icpVerifiedAt: profile.icpVerifiedAt ?? now,
              }
            : {}),
          revision: profile.revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(workspaceSiteProfiles.userId, input.userId));
    }
    if (
      ticket.type === "website_operation" &&
      ticket.category === "icp_filing"
    ) {
      const profiles = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.userId))
        .limit(1)
        .for("update");
      const profile = profiles[0];
      if (!profile) {
        throw new DeliveryTicketError(
          "SITE_PROFILE_NOT_FOUND",
          "域名与备案结果不存在，请刷新后重试。",
        );
      }
      const resolvedDomain =
        profile.domainStatus === "completed"
          ? normalizeDomain(profile.domain)
          : normalizeDomain(
              input.value.verifiedDomain || ticket.topic || ticket.title,
            );
      if (!resolvedDomain) {
        throw new DeliveryTicketError(
          "VERIFIED_DOMAIN_REQUIRED",
          "完成需求前必须填写并核验实际域名。",
          400,
        );
      }
      await tx
        .update(workspaceSiteProfiles)
        .set({
          domain: resolvedDomain,
          domainStatus: "completed",
          domainVerifiedAt: profile.domainVerifiedAt ?? now,
          icpNumber:
            ticket.icpDeclarations && "icpNumber" in ticket.icpDeclarations
              ? ticket.icpDeclarations.icpNumber
              : profile.icpNumber,
          icpStatus: "approved",
          icpDomainRevision: profile.domainRevision,
          icpVerifiedAt: now,
          revision: profile.revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(workspaceSiteProfiles.userId, input.userId));
    }
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: input.userId,
      actorUserId: input.actor.id,
      actorRole: "admin",
      kind: "status_change",
      visibility: "customer",
      message: nonEmpty(input.value.publicMessage),
      fromStatus: ticket.status,
      toStatus: input.value.status,
      createdAt: now,
    });
    if (input.value.internalNote !== undefined) {
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: ticket.id,
        userId: input.userId,
        actorUserId: input.actor.id,
        actorRole: "admin",
        kind: "message",
        visibility: "internal",
        message: nonEmpty(input.value.internalNote),
        createdAt: now,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "delivery_ticket.status_updated",
        targetType: "delivery_ticket",
        targetId: ticket.id,
        workspaceUserId: input.userId,
        metadata: {
          fromStatus: ticket.status,
          toStatus: input.value.status,
          fromQuotaState: ticket.quotaState,
          toQuotaState: nextQuotaState,
          revision: ticket.revision + 1,
          publicSummaryUpdated: true,
        },
      },
      tx,
    );
    return { success: true, revision: ticket.revision + 1 };
  });
}

export async function recordManagedDeliveryOperation(input: {
  actor: AuthenticatedUser;
  userId: number;
  ticketId: string;
  expectedRevision: number;
  clientRequestId: string;
  result: DeliveryOperationResult;
  attachments: DeliveryTicketAttachmentInput[];
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  const portal = await getServicePortal(input.userId);
  assertDeliveryTicketServiceEligibility(portal);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticket = await requireOwnedTicket(
      tx,
      input.userId,
      input.ticketId,
      true,
    );
    assertManagedTicketCanBeExecutedByAdmin({
      actor: input.actor,
      ticket,
    });
    assertDeliveryTicketServiceEligibility(portal, ticket.type);
    const duplicate = await tx
      .select({ id: deliveryTicketEvents.id })
      .from(deliveryTicketEvents)
      .where(
        and(
          eq(deliveryTicketEvents.actorUserId, input.actor.id),
          eq(deliveryTicketEvents.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (duplicate[0]) {
      return {
        eventId: duplicate[0].id,
        revision: ticket.revision,
        idempotent: true,
      };
    }
    if (ticket.revision !== input.expectedRevision) {
      throw new DeliveryTicketError(
        "TICKET_REVISION_CONFLICT",
        "需求已被其他管理员更新，请刷新后重试。",
      );
    }
    if (TERMINAL_STATUSES.has(ticket.status)) {
      throw new DeliveryTicketError(
        "TICKET_CLOSED",
        "已结束需求不能新增交付记录。",
      );
    }
    assertDeliveryOperationPolicy(ticket.type);
    await verifyOwnedAttachments(tx, input.actor.id, input.attachments);
    const operationAttachments = [...input.attachments];
    if (
      input.result.screenshotFileId &&
      !input.attachments.some(
        (attachment) => attachment.fileId === input.result.screenshotFileId,
      )
    ) {
      await verifyOwnedAttachments(tx, input.actor.id, [
        {
          fileId: input.result.screenshotFileId,
          filename: "执行截图",
          purpose: "执行结果凭证",
        },
      ]);
      operationAttachments.push({
        fileId: input.result.screenshotFileId,
        filename: "执行截图",
        purpose: "执行结果凭证",
      });
    }
    const now = new Date();
    const eventId = randomUUID();
    await tx.insert(deliveryTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      userId: input.userId,
      actorUserId: input.actor.id,
      actorRole: "admin",
      kind: "delivery_result",
      visibility: "customer",
      clientRequestId: input.clientRequestId,
      message: nonEmpty(input.result.platformMessage),
      operationResult: input.result,
      createdAt: now,
    });
    const files = attachmentRows({
      ticketId: ticket.id,
      eventId,
      workspaceUserId: input.userId,
      ownerUserId: input.actor.id,
      kind: "deliverable",
      attachments: operationAttachments,
      now,
    });
    if (files.length) await tx.insert(deliveryTicketAttachments).values(files);
    await tx
      .update(deliveryTickets)
      .set({
        revision: ticket.revision + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "delivery_ticket.operation_recorded",
        targetType: "delivery_ticket",
        targetId: ticket.id,
        workspaceUserId: input.userId,
        metadata: {
          platform: input.result.platform,
          targetUrl: input.result.targetUrl,
          resultStatus: input.result.resultStatus,
          revision: ticket.revision + 1,
        },
      },
      tx,
    );
    return {
      eventId,
      revision: ticket.revision + 1,
      idempotent: false,
    };
  });
}

export async function updateWorkspaceSiteProfile(input: {
  actor: AuthenticatedUser;
  userId: number;
  expectedRevision: number;
  domain: string;
  siteMode: "managed" | "external" | "unknown";
  domainStatus: "not_started" | "pending" | "completed";
  icpProvince?: string | null;
  icpNumber?: string | null;
  icpStatus:
    | "not_submitted"
    | "preparing"
    | "submitted"
    | "approved"
    | "rejected"
    | "not_required";
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  const domain = normalizeDomain(input.domain);
  if (input.domainStatus === "completed" && !domain) {
    throw new DeliveryTicketError(
      "INVALID_DOMAIN",
      "完成域名阶段前必须填写并核验实际域名。",
      400,
    );
  }
  if (
    (input.icpStatus === "approved" || input.icpStatus === "not_required") &&
    input.domainStatus !== "completed"
  ) {
    throw new DeliveryTicketError(
      "DOMAIN_PREREQUISITE_REQUIRED",
      "必须先完成域名核验，才能确认 ICP 阶段完成。",
      400,
    );
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.userId))
      .limit(1)
      .for("update");
    const current = rows[0];
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new DeliveryTicketError(
        "SITE_PROFILE_REVISION_CONFLICT",
        "官网资料已更新，请刷新后重试。",
      );
    }
    const now = new Date();
    const switchingDomain = Boolean(
      current && normalizeDomain(current.domain) !== domain,
    );
    const domainRevision = switchingDomain
      ? current!.domainRevision + 1
      : (current?.domainRevision ?? 1);
    const effectiveIcpStatus = switchingDomain
      ? ("not_submitted" as const)
      : input.icpStatus;
    if (current) {
      await tx
        .update(workspaceSiteProfiles)
        .set({
          domain,
          normalizedAsciiDomain: domain || null,
          unicodeDisplayDomain: domain || null,
          domainRevision,
          siteMode: input.siteMode,
          domainStatus: input.domainStatus,
          domainVerifiedAt:
            input.domainStatus === "completed"
              ? (current.domainVerifiedAt ?? now)
              : null,
          icpProvince: switchingDomain ? null : nonEmpty(input.icpProvince),
          icpNumber: switchingDomain ? null : nonEmpty(input.icpNumber),
          icpStatus: effectiveIcpStatus,
          icpDomainRevision:
            effectiveIcpStatus === "approved" ? domainRevision : null,
          icpVerifiedAt:
            effectiveIcpStatus === "approved" ||
            effectiveIcpStatus === "not_required"
              ? (current.icpVerifiedAt ?? now)
              : null,
          revision: revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(workspaceSiteProfiles.userId, input.userId));
    } else {
      await tx.insert(workspaceSiteProfiles).values({
        userId: input.userId,
        domain,
        normalizedAsciiDomain: domain || null,
        unicodeDisplayDomain: domain || null,
        domainRevision,
        siteMode: input.siteMode,
        domainStatus: input.domainStatus,
        domainVerifiedAt: input.domainStatus === "completed" ? now : null,
        icpProvince: nonEmpty(input.icpProvince),
        icpNumber: nonEmpty(input.icpNumber),
        icpStatus: effectiveIcpStatus,
        icpDomainRevision:
          effectiveIcpStatus === "approved" ? domainRevision : null,
        icpVerifiedAt:
          effectiveIcpStatus === "approved" ||
          effectiveIcpStatus === "not_required"
            ? now
            : null,
        revision: 1,
        updatedByUserId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (switchingDomain) {
      await tx
        .update(siteProjects)
        .set({
          canonicalHostname: domain || null,
          mainlandLiveDeploymentId: null,
          updatedAt: now,
        })
        .where(eq(siteProjects.userId, input.userId));
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "workspace.site_profile.updated",
        targetType: "workspace_site_profile",
        targetId: input.userId,
        workspaceUserId: input.userId,
        metadata: { domain, revision: revision + 1 },
      },
      tx,
    );
    return {
      siteProfile: {
        domain,
        siteMode: input.siteMode,
        domainStatus: input.domainStatus,
        domainVerifiedAt:
          input.domainStatus === "completed" ? now.getTime() : null,
        icpProvince: switchingDomain ? null : nonEmpty(input.icpProvince),
        icpNumber: switchingDomain ? null : nonEmpty(input.icpNumber),
        icpStatus: effectiveIcpStatus,
        icpVerifiedAt:
          effectiveIcpStatus === "approved" ||
          effectiveIcpStatus === "not_required"
            ? now.getTime()
            : null,
        revision: revision + 1,
        updatedAt: now.getTime(),
      },
    };
  });
}

export async function upsertWorkspaceSiteCheck(input: {
  actor: AuthenticatedUser;
  userId: number;
  key: string;
  label: string;
  status:
    | "not_checked"
    | "pending"
    | "passed"
    | "warning"
    | "failed"
    | "not_applicable";
  summary?: string;
  evidence?: string;
  source?: string;
  checkedAt?: number | null;
  expectedRevision: number;
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(workspaceSiteChecks)
      .where(
        and(
          eq(workspaceSiteChecks.userId, input.userId),
          eq(workspaceSiteChecks.key, input.key),
        ),
      )
      .limit(1)
      .for("update");
    const current = rows[0];
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new DeliveryTicketError(
        "SITE_CHECK_REVISION_CONFLICT",
        "官网检查项已更新，请刷新后重试。",
      );
    }
    const now = new Date();
    const values = {
      label: input.label,
      status: input.status,
      summary: nonEmpty(input.summary),
      evidence: nonEmpty(input.evidence),
      source: nonEmpty(input.source),
      checkedAt:
        input.checkedAt === undefined
          ? (current?.checkedAt ?? null)
          : input.checkedAt === null
            ? null
            : new Date(input.checkedAt),
      revision: revision + 1,
      updatedByUserId: input.actor.id,
      updatedAt: now,
    };
    if (current) {
      await tx
        .update(workspaceSiteChecks)
        .set(values)
        .where(eq(workspaceSiteChecks.id, current.id));
    } else {
      await tx.insert(workspaceSiteChecks).values({
        id: randomUUID(),
        userId: input.userId,
        key: input.key,
        ...values,
        createdAt: now,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "workspace.site_check.updated",
        targetType: "workspace_site_check",
        targetId: `${input.userId}:${input.key}`,
        workspaceUserId: input.userId,
        metadata: {
          key: input.key,
          status: input.status,
          revision: revision + 1,
        },
      },
      tx,
    );
    return { success: true, revision: revision + 1 };
  });
}
