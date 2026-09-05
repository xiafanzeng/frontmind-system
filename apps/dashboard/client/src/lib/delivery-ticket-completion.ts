import type { DeliveryWorkflowOperation } from "@shared/delivery-roles";

export type WebsiteContentOperation =
  | "company_facts"
  | "product_case_docs"
  | "industry_news"
  | "company_news"
  | "faq_content";

export type DeliveryCompletionDraft = {
  summary: string;
  publicUrl: string;
  previewVerified: boolean;
  domain: string;
  icpServiceCode: string;
  icpResolution: "approved" | "not_required";
  icpProvince: string;
  icpNumber: string;
  monitoringBatchKey: string;
  optimizationQuestionIds: string;
  responseLogicRevision: string;
  contentAssetIds: string;
  publishMedia: boolean;
  publishWebsite: boolean;
  websiteOperation: WebsiteContentOperation;
  needsFurtherOptimization: boolean;
  siteCheckKey: string;
  siteCheckLabel: string;
  siteCheckStatus: "passed" | "warning" | "failed" | "not_applicable";
  siteCheckSummary: string;
  siteCheckEvidence: string;
};

export type DeliveryCompletionTicket = {
  operation: DeliveryWorkflowOperation;
  marketEdition?: "domestic" | "overseas" | null;
  topic?: string | null;
  monitoringBatchKey?: string | null;
  responseLogicRevision?: number | null;
  contentAssetIds?: string[] | null;
};

export type DeliveryCompletionPayload = {
  message: string;
  publicUrl?: string;
  handoff?: {
    monitoringBatchKey?: string;
    optimizationQuestionIds?: string[];
    responseLogicRevision?: number;
    contentAssetIds?: string[];
    publishTargets?: Array<"media" | "website">;
    websiteOperation?: WebsiteContentOperation;
    needsFurtherOptimization?: boolean;
    domain?: string;
    icpServiceCode?: string;
    icpProvince?: string;
    icpNumber?: string;
    icpNotRequired?: boolean;
    siteCheck?: {
      key: string;
      label: string;
      status: "passed" | "warning" | "failed" | "not_applicable";
      summary?: string;
      evidence?: string;
    };
  };
};

const WEBSITE_CONTENT_OPERATIONS = new Set<DeliveryWorkflowOperation>([
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
]);

const PUBLIC_URL_REQUIRED_OPERATIONS = new Set<DeliveryWorkflowOperation>([
  "content_asset_publish",
  "channel_distribution",
  ...WEBSITE_CONTENT_OPERATIONS,
]);

export function createDeliveryCompletionDraft(
  ticket: DeliveryCompletionTicket,
): DeliveryCompletionDraft {
  return {
    summary: "",
    publicUrl: "",
    previewVerified: false,
    domain: ticket.topic?.trim() || "",
    icpServiceCode: "",
    icpResolution: "approved",
    icpProvince: "",
    icpNumber: "",
    monitoringBatchKey:
      ticket.operation === "monitoring_retest"
        ? ""
        : ticket.monitoringBatchKey?.trim() || "",
    optimizationQuestionIds: "",
    responseLogicRevision: String(ticket.responseLogicRevision || 1),
    contentAssetIds: (ticket.contentAssetIds || []).join(", "),
    publishMedia: true,
    publishWebsite: false,
    websiteOperation: "company_facts",
    needsFurtherOptimization: false,
    siteCheckKey: "published-page-check",
    siteCheckLabel: "已发布页面检查",
    siteCheckStatus: "passed",
    siteCheckSummary: "",
    siteCheckEvidence: "",
  };
}

export function deliveryCompletionRequiresPublicUrl(
  operation: DeliveryWorkflowOperation,
) {
  return PUBLIC_URL_REQUIRED_OPERATIONS.has(operation);
}

export function deliveryCompletionCreatesNextStep(
  operation: DeliveryWorkflowOperation,
) {
  switch (operation) {
    case "initial_monitoring":
    case "monitoring_import":
      return "填写的待优化问题会分别生成“应答逻辑”下游工单。";
    case "response_logic":
      return "完成后自动生成“内容资产发布”工单。";
    case "content_asset_publish":
      return "系统会按所选发布目标生成媒体分发或官网内容工单。";
    case "monitoring_retest":
      return "完成后自动生成“阶段效果报告”工单。";
    case "stage_report":
      return "若仍需优化，系统会沿原问题生成下一轮应答逻辑工单。";
    case "domain_application":
      return "域名结果会写入用户官网流程；海外版将直接进入风格样例阶段。";
    case "icp_filing":
      return "备案结果会写入用户官网流程，并自动生成风格样例工单。";
    case "company_facts":
    case "product_case_docs":
    case "industry_news":
    case "company_news":
    case "faq_content":
      return "完成后自动生成站点检查工单；站点检查通过后才进入效果复测。";
    case "channel_distribution":
      return "公开链接登记后，系统会按来源问题生成效果复测工单。";
    case "site_check":
      return "站点检查通过后，系统会按来源问题生成效果复测工单；检查失败时不能完成交付。";
    default:
      return "完成后结果会进入客户任务记录和管理员交付记录。";
  }
}

export function validateDeliveryCompletionDraft(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
): string[] {
  const errors: string[] = [];
  const operation = ticket.operation;

  if (!draft.summary.trim()) {
    errors.push("请填写客户能理解的交付结果摘要");
  }
  if (!draft.previewVerified) {
    errors.push("请先核对用户实际页面或可核验交付记录");
  }

  if (deliveryCompletionRequiresPublicUrl(operation)) {
    if (!draft.publicUrl.trim()) {
      errors.push("本工单必须登记公开链接");
    } else if (!isHttpUrl(draft.publicUrl)) {
      errors.push("公开链接必须是有效的 http(s) 地址");
    }
  } else if (draft.publicUrl.trim() && !isHttpUrl(draft.publicUrl)) {
    errors.push("公开链接必须是有效的 http(s) 地址");
  }

  if (operation === "domain_application") {
    if (!draft.domain.trim()) {
      errors.push("请填写已核验的客户域名");
    } else if (!isHostname(draft.domain)) {
      errors.push("客户域名格式不正确");
    }
    if (ticket.marketEdition !== "overseas" && !draft.icpServiceCode.trim()) {
      errors.push("国内版客户必须填写备案服务码");
    }
  }

  if (
    operation === "icp_filing" &&
    draft.icpResolution === "approved" &&
    !draft.icpNumber.trim()
  ) {
    errors.push("备案已通过时必须填写 ICP 备案号");
  }

  if (
    (operation === "initial_monitoring" ||
      operation === "monitoring_import" ||
      operation === "monitoring_retest") &&
    !draft.monitoringBatchKey.trim()
  ) {
    errors.push("请填写本次正式监控批次标识");
  }
  if (
    operation === "monitoring_retest" &&
    draft.monitoringBatchKey.trim() === ticket.monitoringBatchKey?.trim()
  ) {
    errors.push("效果复测必须填写新的监控批次，不能继续使用复测前基线");
  }

  if (operation === "response_logic") {
    const revision = Number(draft.responseLogicRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      errors.push("应答逻辑版本必须是大于等于 1 的整数");
    }
  }

  if (operation === "content_asset_publish") {
    if (!splitValues(draft.contentAssetIds).length) {
      errors.push("请填写已经进入客户正式看板的内容资产 ID");
    }
    if (!draft.publishMedia && !draft.publishWebsite) {
      errors.push("请至少选择一个发布目标");
    }
  }

  if (
    WEBSITE_CONTENT_OPERATIONS.has(operation) &&
    !splitValues(draft.contentAssetIds).length
  ) {
    errors.push("官网页面必须绑定已发布的内容资产 ID");
  }

  if (operation === "site_check") {
    if (!draft.siteCheckKey.trim()) errors.push("请填写检查项标识");
    if (!draft.siteCheckLabel.trim()) errors.push("请填写检查项名称");
    if (draft.siteCheckStatus === "failed") {
      errors.push("站点检查未通过时不能完成工单，请先修正页面或等待补充");
    }
  }

  return errors;
}

export function buildDeliveryCompletionPayload(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
): DeliveryCompletionPayload {
  const operation = ticket.operation;
  const publicUrl = draft.publicUrl.trim() || undefined;
  const handoff: NonNullable<DeliveryCompletionPayload["handoff"]> = {};

  if (operation === "domain_application") {
    handoff.domain = draft.domain.trim();
    if (draft.icpServiceCode.trim()) {
      handoff.icpServiceCode = draft.icpServiceCode.trim();
    }
  } else if (operation === "icp_filing") {
    handoff.icpNotRequired = draft.icpResolution === "not_required";
    if (draft.icpResolution === "approved") {
      handoff.icpNumber = draft.icpNumber.trim();
      if (draft.icpProvince.trim()) {
        handoff.icpProvince = draft.icpProvince.trim();
      }
    }
  } else if (
    operation === "initial_monitoring" ||
    operation === "monitoring_import" ||
    operation === "monitoring_retest"
  ) {
    handoff.monitoringBatchKey = draft.monitoringBatchKey.trim();
    if (operation !== "monitoring_retest") {
      handoff.optimizationQuestionIds = splitValues(
        draft.optimizationQuestionIds,
      );
    }
  } else if (operation === "response_logic") {
    handoff.responseLogicRevision = Number(draft.responseLogicRevision);
  } else if (operation === "content_asset_publish") {
    handoff.contentAssetIds = splitValues(draft.contentAssetIds);
    handoff.publishTargets = [
      ...(draft.publishMedia ? (["media"] as const) : []),
      ...(draft.publishWebsite ? (["website"] as const) : []),
    ];
    if (draft.publishWebsite) {
      handoff.websiteOperation = draft.websiteOperation;
    }
  } else if (WEBSITE_CONTENT_OPERATIONS.has(operation)) {
    handoff.contentAssetIds = splitValues(draft.contentAssetIds);
  } else if (operation === "site_check") {
    handoff.siteCheck = {
      key: draft.siteCheckKey.trim(),
      label: draft.siteCheckLabel.trim(),
      status: draft.siteCheckStatus,
      summary: draft.siteCheckSummary.trim() || undefined,
      evidence: draft.siteCheckEvidence.trim() || undefined,
    };
  } else if (operation === "stage_report") {
    handoff.needsFurtherOptimization = draft.needsFurtherOptimization;
  }

  return {
    message: draft.summary.trim(),
    publicUrl,
    ...(Object.keys(handoff).length ? { handoff } : {}),
  };
}

function splitValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHostname(value: string) {
  try {
    const hostname = new URL(
      /^https?:\/\//i.test(value.trim())
        ? value.trim()
        : `https://${value.trim()}`,
    ).hostname;
    return Boolean(hostname && hostname.includes("."));
  } catch {
    return false;
  }
}
