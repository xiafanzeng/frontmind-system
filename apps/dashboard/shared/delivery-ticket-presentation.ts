import {
  CONTENT_ASSET_CATALOG,
  WEBSITE_CONTENT_CATALOG,
} from "./delivery-catalog";
import { getDeliveryOperationSpec } from "./delivery-operation-spec";
import {
  DELIVERY_TICKET_STATUS_LABELS,
  type DeliveryTicketStatus,
} from "./delivery-ticket";

export type DeliveryPresentationAudience = "internal" | "customer";

export type DeliveryActorRole = "user" | "admin" | "delivery_member" | "system";

const DELIVERY_STATUS_VALUES = new Set<string>([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
]);

const CUSTOMER_STATUS_LABELS: Record<DeliveryTicketStatus, string> = {
  submitted: "待处理",
  needs_information: "待处理",
  scheduled: "待处理",
  in_progress: "待处理",
  completed: "已完成",
  rejected: "已完成",
  cancelled: "已完成",
};

const INTERNAL_ACTOR_ROLE_LABELS: Record<DeliveryActorRole, string> = {
  user: "客户",
  admin: "管理员",
  delivery_member: "工程师",
  system: "系统",
};

const CUSTOMER_ACTOR_ROLE_LABELS: Record<DeliveryActorRole, string> = {
  user: "用户",
  admin: "服务团队",
  delivery_member: "服务团队",
  system: "服务团队",
};

const DELIVERY_EVENT_KIND_LABELS: Record<string, string> = {
  created: "创建需求",
  message: "补充说明",
  status_change: "状态更新",
  attachment: "附件更新",
  delivery_result: "交付结果",
};

const DELIVERY_VISIBILITY_LABELS: Record<string, string> = {
  customer: "客户可见",
  internal: "内部记录",
};

const DELIVERY_PRIORITY_LABELS: Record<string, string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

const DELIVERY_QUOTA_STATE_LABELS: Record<string, string> = {
  reserved: "已预留",
  consumed: "已使用",
  released: "已释放",
};

const DELIVERY_RESULT_STATUS_LABELS: Record<string, string> = {
  success: "成功",
  failed: "失败",
  pending_confirmation: "待确认",
};

const DELIVERY_ATTACHMENT_AUTHORIZATION_LABELS: Record<string, string> = {
  owned: "企业自有",
  licensed: "已获授权",
  public: "公开可用",
  authorization_pending: "授权待确认",
};

const KNOWLEDGE_RESET_REASON_LABELS: Record<string, string> = {
  stuck: "知识库流程卡住",
  upload_error: "上传资料有误",
  build_error: "知识库构建异常",
  enterprise_materials: "企业资料需要更换",
  other: "其他原因",
};

const KNOWLEDGE_RESET_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  approved: "已批准",
  rejected: "已拒绝",
};

const KNOWLEDGE_CLEANUP_KEY_LABELS: Record<string, string> = {
  builds: "知识库构建记录",
  snapshots: "知识库快照",
  conversations: "知识库对话",
  attachments: "知识库附件",
  importReceipts: "资料导入记录",
};

const DELIVERY_CATEGORY_LABELS: Record<string, string> = Object.freeze({
  ...Object.fromEntries(
    CONTENT_ASSET_CATALOG.map((item) => [item.id, item.label]),
  ),
  ...Object.fromEntries(
    WEBSITE_CONTENT_CATALOG.map((item) => [item.value, item.label]),
  ),
  domain_application: "域名核验与备案准备",
  icp_filing: "ICP 备案结果核验",
  website_style_samples: "官网图片风格",
  website_build: "AI 专用官网构建",
  site_check: "站点检查",
  knowledge_base_maintenance: "知识库维护",
  knowledge_reset: "知识库重置",
  knowledge_delivery: "品牌全域知识库",
  question_catalog: "配置品牌词库",
  question_review: "问题审核",
  question_modify: "问题修改",
  question_delete: "问题删除",
  response_logic_reset: "应答逻辑修改",
  blog_update: "博客更新",
  company_blog: "企业博客",
  product_page_content: "产品页面内容",
  case_study: "客户案例",
  landing_page_content: "落地页内容",
  content_correction: "内容修订",
  domain_https: "域名与 HTTPS",
  privacy_compliance: "隐私合规",
  metadata_tdk: "页面标题与描述",
  structured_data: "结构化数据",
  image_accessibility: "图片可访问性",
  crawl_directives: "抓取规则",
  url_governance: "URL 规范",
  webmaster_indexing: "站长平台收录",
  local_service: "本地服务页面",
  multilingual_region: "多语言与地区",
  verification_code: "验证代码",
  bulk_redirect: "批量重定向",
  technical_diagnosis: "技术诊断",
  site_rebuild: "官网重制",
  prelaunch_review: "上线前检查",
  llms_txt_experiment: "llms.txt 实验",
});

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mappedLabel(map: Record<string, string>, value: unknown) {
  const key = normalizedString(value);
  if (!key || !Object.prototype.hasOwnProperty.call(map, key)) return null;
  return map[key];
}

function knownDeliveryStatus(value: unknown): DeliveryTicketStatus | null {
  const status = normalizedString(value);
  return status && DELIVERY_STATUS_VALUES.has(status)
    ? (status as DeliveryTicketStatus)
    : null;
}

function safeProvidedChineseLabel(value: unknown, rawValue: unknown) {
  const label = normalizedString(value);
  const raw = normalizedString(rawValue);
  if (!label || label === raw) return null;
  return /[\u3400-\u9fff]/u.test(label) ? label : null;
}

function categoryFallback(type: unknown) {
  if (type === "content_asset") return "内容资产需求";
  if (type === "website_operation") return "官网运营需求";
  if (type === "knowledge_base") return "知识库需求";
  return "交付需求";
}

function knownCategoryLabel(input: {
  category?: unknown;
  providedLabel?: unknown;
}) {
  const category = normalizedString(input.category);
  if (category === "question_catalog") {
    return mappedLabel(DELIVERY_CATEGORY_LABELS, category);
  }
  return (
    safeProvidedChineseLabel(input.providedLabel, input.category) ||
    mappedLabel(DELIVERY_CATEGORY_LABELS, input.category)
  );
}

export function deliveryTicketStatusLabel(
  value: unknown,
  audience: DeliveryPresentationAudience = "internal",
) {
  const status = knownDeliveryStatus(value);
  if (!status) return audience === "customer" ? "状态待确认" : "未知状态";
  return audience === "customer"
    ? CUSTOMER_STATUS_LABELS[status]
    : DELIVERY_TICKET_STATUS_LABELS[status];
}

export function deliveryStatusTransitionLabel(
  fromStatus: unknown,
  toStatus: unknown,
  audience: DeliveryPresentationAudience = "internal",
) {
  const from = knownDeliveryStatus(fromStatus);
  const to = knownDeliveryStatus(toStatus);
  if (audience === "customer") {
    return to
      ? `需求状态更新为${CUSTOMER_STATUS_LABELS[to]}。`
      : "需求记录已更新。";
  }
  if (fromStatus != null && toStatus != null) {
    return `${deliveryTicketStatusLabel(from, "internal")} → ${deliveryTicketStatusLabel(to, "internal")}`;
  }
  if (toStatus != null) {
    return `状态更新为${deliveryTicketStatusLabel(to, "internal")}`;
  }
  return "需求记录已更新";
}

export function deliveryActorRoleLabel(
  value: unknown,
  audience: DeliveryPresentationAudience = "internal",
) {
  const role = normalizedString(value);
  const labels =
    audience === "customer"
      ? CUSTOMER_ACTOR_ROLE_LABELS
      : INTERNAL_ACTOR_ROLE_LABELS;
  return role && Object.prototype.hasOwnProperty.call(labels, role)
    ? labels[role as DeliveryActorRole]
    : audience === "customer"
      ? "服务团队"
      : "相关人员";
}

export function deliveryOperationLabel(value: unknown) {
  const operation = normalizedString(value);
  return (
    (operation && getDeliveryOperationSpec(operation)?.label) || "历史交付任务"
  );
}

export function deliveryCategoryLabel(input: {
  type?: unknown;
  category?: unknown;
  providedLabel?: unknown;
}) {
  return knownCategoryLabel(input) || categoryFallback(input.type);
}

export function deliveryTicketPresentationTitle(input: {
  title?: unknown;
  type?: unknown;
  operation?: unknown;
  category?: unknown;
  categoryLabel?: unknown;
}) {
  const operation = normalizedString(input.operation);
  const category = normalizedString(input.category);
  if (operation === "question_catalog" || category === "question_catalog") {
    return (
      getDeliveryOperationSpec("question_catalog")?.label || "配置品牌词库"
    );
  }
  const title = normalizedString(input.title);
  if (title) return title;
  const operationLabel = operation
    ? getDeliveryOperationSpec(operation)?.label
    : null;
  return (
    operationLabel ||
    knownCategoryLabel({
      category: input.category,
      providedLabel: input.categoryLabel,
    }) ||
    categoryFallback(input.type)
  );
}

export function deliveryTicketPresentationTopic(input: {
  topic?: unknown;
  title?: unknown;
  type?: unknown;
  operation?: unknown;
  category?: unknown;
  fallbackLabel?: unknown;
}) {
  const operation = normalizedString(input.operation);
  const category = normalizedString(input.category);
  if (operation === "question_catalog" || category === "question_catalog") {
    return (
      getDeliveryOperationSpec("question_catalog")?.label || "配置品牌词库"
    );
  }
  const rawValues = new Set(
    [operation, category].filter((value): value is string => Boolean(value)),
  );
  const topic = normalizedString(input.topic);
  if (topic && !rawValues.has(topic)) return topic;
  const title = normalizedString(input.title);
  if (title && !rawValues.has(title)) return title;
  const fallbackLabel = normalizedString(input.fallbackLabel);
  if (fallbackLabel && /[\u3400-\u9fff]/u.test(fallbackLabel)) {
    return fallbackLabel;
  }
  return categoryFallback(input.type);
}

export function deliveryEventKindLabel(value: unknown) {
  return mappedLabel(DELIVERY_EVENT_KIND_LABELS, value) || "系统记录";
}

export function deliveryVisibilityLabel(value: unknown) {
  return mappedLabel(DELIVERY_VISIBILITY_LABELS, value) || "记录范围待确认";
}

export function deliveryPriorityLabel(value: unknown) {
  return mappedLabel(DELIVERY_PRIORITY_LABELS, value) || "优先级待确认";
}

export function deliveryQuotaStateLabel(value: unknown) {
  return mappedLabel(DELIVERY_QUOTA_STATE_LABELS, value) || "额度状态待确认";
}

export function deliveryResultStatusLabel(value: unknown) {
  return mappedLabel(DELIVERY_RESULT_STATUS_LABELS, value) || "结果待确认";
}

export function deliveryAttachmentAuthorizationLabel(value: unknown) {
  return (
    mappedLabel(DELIVERY_ATTACHMENT_AUTHORIZATION_LABELS, value) ||
    "授权状态待确认"
  );
}

export function knowledgeResetReasonLabel(value: unknown) {
  return mappedLabel(KNOWLEDGE_RESET_REASON_LABELS, value) || "其他原因";
}

export function knowledgeResetStatusLabel(value: unknown) {
  return mappedLabel(KNOWLEDGE_RESET_STATUS_LABELS, value) || "审批状态待确认";
}

export function deliveryCleanupKeyLabel(value: unknown) {
  return mappedLabel(KNOWLEDGE_CLEANUP_KEY_LABELS, value) || "其他清理项";
}

export function deliveryCleanupSummaryText(
  summary: Record<string, number> | null | undefined,
) {
  if (!summary) return "";
  return Object.entries(summary)
    .map(([key, value]) => `${deliveryCleanupKeyLabel(key)} ${value}`)
    .join("、");
}

export function deliveryEventDisplayMessage(
  event: {
    message?: unknown;
    eventType?: unknown;
    kind?: unknown;
    fromStatus?: unknown;
    toStatus?: unknown;
  },
  audience: DeliveryPresentationAudience = "internal",
) {
  const message = normalizedString(event.message);
  if (message) {
    const rawTransition = message.match(
      /^([a-z][a-z0-9_]*)\s*(?:→|->)\s*([a-z][a-z0-9_]*)$/iu,
    );
    if (rawTransition) {
      return deliveryStatusTransitionLabel(
        rawTransition[1],
        rawTransition[2],
        audience,
      );
    }
    return message;
  }

  const kind =
    normalizedString(event.eventType) || normalizedString(event.kind);
  if (audience === "customer") {
    const to = knownDeliveryStatus(event.toStatus);
    if (to) return deliveryStatusTransitionLabel(null, to, "customer");
    if (kind === "created") return "需求已提交。";
    if (kind === "attachment") return "需求附件已更新。";
    if (kind === "delivery_result") return "需求交付结果已更新。";
    return "需求记录已更新。";
  }

  if (event.fromStatus != null || event.toStatus != null) {
    return deliveryStatusTransitionLabel(
      event.fromStatus,
      event.toStatus,
      "internal",
    );
  }
  return kind ? deliveryEventKindLabel(kind) : "需求记录已更新";
}
