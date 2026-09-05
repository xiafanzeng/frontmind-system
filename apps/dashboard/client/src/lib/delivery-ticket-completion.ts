import {
  getDeliveryOperationSpec,
  type DeliveryOperationCompletionField,
  type DeliveryOperationCompletionMode,
} from "@shared/delivery-operation-spec";

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
  optimizationQuestionIds: string[];
  responseLogicRevision: string;
  contentAssetIds: string;
  channelTargetMedia: string;
  needsFurtherOptimization: boolean;
  siteCheckKey: string;
  siteCheckLabel: string;
  siteCheckStatus: "passed" | "warning" | "failed" | "not_applicable";
  siteCheckSummary: string;
  siteCheckEvidence: string;
  siteCheckSource: string;
};

export type DeliveryCompletionTicket = {
  operation: string;
  credentialTargetUserId?: number | null;
  status?: string | null;
  marketEdition?: "domestic" | "overseas" | null;
  topic?: string | null;
  preferredMedia?: string | null;
  monitoringBatchKey?: string | null;
  responseLogicRevision?: number | null;
  contentAssetIds?: string[] | null;
};

export type DeliveryMonitoringBatchOption = {
  batchKey: string;
  sourceName: string;
  collectedAt: number;
  sampleCount: number;
};

export type DeliveryApprovedQuestionOption = {
  id: string;
  question: string;
  category?: string | null;
};

export type DeliveryCompletionOptions = {
  monitoringBatches: DeliveryMonitoringBatchOption[];
  approvedQuestions: DeliveryApprovedQuestionOption[];
  keywordCatalogPublished: boolean;
};

const EMPTY_DELIVERY_COMPLETION_OPTIONS: DeliveryCompletionOptions = {
  monitoringBatches: [],
  approvedQuestions: [],
  keywordCatalogPublished: false,
};

const ACTIVE_DELIVERY_STATUSES = new Set([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
]);

export function deliveryTicketWaitsForAdminCredential(ticket: {
  credentialTargetUserId?: number | null;
  status?: string | null;
}) {
  return Boolean(
    typeof ticket.credentialTargetUserId === "number" &&
      ticket.credentialTargetUserId > 0 &&
      ticket.status &&
      ACTIVE_DELIVERY_STATUSES.has(ticket.status),
  );
}

export type DeliveryCompletionPayload = {
  message: string;
  publicUrl?: string;
  previewVerified?: true;
  handoff?: {
    monitoringBatchKey?: string;
    optimizationQuestionIds?: string[];
    responseLogicRevision?: number;
    contentAssetIds?: string[];
    targetMedia?: string;
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
      source?: string;
    };
  };
};

export function createDeliveryCompletionDraft(
  ticket: DeliveryCompletionTicket,
  options: DeliveryCompletionOptions = EMPTY_DELIVERY_COMPLETION_OPTIONS,
): DeliveryCompletionDraft {
  const eligibleMonitoringBatches = deliveryCompletionMonitoringBatchOptions(
    ticket,
    options,
  );
  const existingMonitoringBatchKey = ticket.monitoringBatchKey?.trim() || "";
  return {
    summary: ticket.operation === "question_catalog" ? "品牌词库已发布" : "",
    publicUrl: "",
    previewVerified: false,
    domain: ticket.topic?.trim() || "",
    icpServiceCode: "",
    icpResolution: "approved",
    icpProvince: "",
    icpNumber: "",
    monitoringBatchKey:
      ticket.operation !== "monitoring_retest" &&
      eligibleMonitoringBatches.some(
        (batch) => batch.batchKey === existingMonitoringBatchKey,
      )
        ? existingMonitoringBatchKey
        : "",
    optimizationQuestionIds: [],
    responseLogicRevision: String(ticket.responseLogicRevision || 1),
    contentAssetIds: (ticket.contentAssetIds || []).join(", "),
    channelTargetMedia: ticket.preferredMedia?.trim() || "",
    needsFurtherOptimization: false,
    siteCheckKey: "published-page-check",
    siteCheckLabel: "已发布页面检查",
    siteCheckStatus: "passed",
    siteCheckSummary: "",
    siteCheckEvidence: "",
    siteCheckSource: "",
  };
}

export function deliveryCompletionMode(
  operation: string | null | undefined,
): DeliveryOperationCompletionMode | "legacy_summary" {
  return (
    getDeliveryOperationSpec(operation)?.completion.mode ?? "legacy_summary"
  );
}

export function deliveryCompletionHasField(
  operation: string | null | undefined,
  field: DeliveryOperationCompletionField,
) {
  return Boolean(
    getDeliveryOperationSpec(operation)?.completion.fields.includes(field),
  );
}

export function deliveryCompletionRequiresPublicUrl(
  operation: string | null | undefined,
) {
  return (
    getDeliveryOperationSpec(operation)?.completion.publicUrl === "required"
  );
}

export function deliveryCompletionRequiresPreviewVerification(
  operation: string | null | undefined,
) {
  return (
    getDeliveryOperationSpec(operation)?.completion.previewVerification ===
    "required"
  );
}

export function deliveryCompletionCreatesNextStep(
  operation: string | null | undefined,
) {
  return (
    getDeliveryOperationSpec(operation)?.nextStep ??
    "该历史需求完成时只保存交付摘要，不生成其他字段或下游动作。"
  );
}

export function deliveryCompletionSummaryPlaceholder(
  operation: string | null | undefined,
) {
  const label = getDeliveryOperationSpec(operation)?.label;
  return label
    ? `请说明“${label}”已完成的内容、可核验结果及后续注意事项。`
    : "请说明该历史需求已完成的内容和可核验结果。";
}

export function validateDeliveryCompletionDraft(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
  options: DeliveryCompletionOptions = EMPTY_DELIVERY_COMPLETION_OPTIONS,
): string[] {
  const errors: string[] = [];
  const operation = ticket.operation;
  const spec = getDeliveryOperationSpec(operation);

  if (spec && spec.completion.mode !== "form") {
    return ["该需求仅供查看，不能通过通用表单完成"];
  }

  if (!draft.summary.trim()) {
    errors.push("请填写客户能理解的交付结果摘要");
  }

  if (!spec) return errors;

  errors.push(...deliveryCompletionOptionBlockReasons(ticket, options));

  if (deliveryCompletionRequiresPublicUrl(operation)) {
    if (!draft.publicUrl.trim()) {
      errors.push("本需求必须登记公开链接");
    } else if (!isHttpUrl(draft.publicUrl)) {
      errors.push("公开链接必须是有效的 http(s) 地址");
    }
  }

  if (
    deliveryCompletionRequiresPreviewVerification(operation) &&
    !draft.previewVerified
  ) {
    errors.push("请先核对用户实际页面");
  }

  if (deliveryCompletionHasField(operation, "domain")) {
    if (!draft.domain.trim()) {
      errors.push("请填写已核验的客户域名");
    } else if (!isHostname(draft.domain)) {
      errors.push("客户域名格式不正确");
    }
    if (
      deliveryCompletionHasField(operation, "icp_service_code") &&
      ticket.marketEdition !== "overseas" &&
      !draft.icpServiceCode.trim()
    ) {
      errors.push("国内版客户必须填写备案服务码");
    }
  }

  if (
    deliveryCompletionHasField(operation, "icp_resolution") &&
    draft.icpResolution === "approved" &&
    !draft.icpNumber.trim()
  ) {
    errors.push("备案已通过时必须填写 ICP 备案号");
  }
  if (
    deliveryCompletionHasField(operation, "icp_resolution") &&
    draft.icpResolution === "not_required" &&
    ticket.marketEdition !== "overseas"
  ) {
    errors.push("国内版官网必须填写已通过的 ICP 备案结果");
  }

  if (deliveryCompletionHasField(operation, "monitoring_batch")) {
    const eligibleMonitoringBatches = deliveryCompletionMonitoringBatchOptions(
      ticket,
      options,
    );
    if (eligibleMonitoringBatches.length && !draft.monitoringBatchKey.trim()) {
      errors.push("请选择本次已发布的正式监控批次");
    } else if (
      draft.monitoringBatchKey.trim() &&
      !eligibleMonitoringBatches.some(
        (batch) => batch.batchKey === draft.monitoringBatchKey.trim(),
      )
    ) {
      errors.push("监控批次必须从当前客户已发布的正式批次中选择");
    }
  }
  if (
    operation === "monitoring_retest" &&
    draft.monitoringBatchKey.trim() === ticket.monitoringBatchKey?.trim()
  ) {
    errors.push("效果复测必须填写新的监控批次，不能继续使用复测前基线");
  }

  if (
    deliveryCompletionHasField(operation, "optimization_question_ids") &&
    draft.optimizationQuestionIds.some(
      (questionId) =>
        !options.approvedQuestions.some(
          (question) => question.id === questionId.trim(),
        ),
    )
  ) {
    errors.push("待优化问题只能从客户已确认且审核通过的问题中选择");
  }

  if (deliveryCompletionHasField(operation, "response_logic_revision")) {
    const revision = Number(draft.responseLogicRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      errors.push("应答逻辑版本必须是大于等于 1 的整数");
    }
  }

  if (
    deliveryCompletionHasField(operation, "content_asset_ids") &&
    !contentAssetIdsForCompletion(ticket, draft).length
  ) {
    errors.push(
      operation === "content_asset_publish"
        ? "请填写已经进入客户正式看板的内容资产 ID"
        : "官网页面必须绑定已发布的内容资产 ID",
    );
  }

  if (
    deliveryCompletionHasField(operation, "channel_target_media") &&
    !targetMediaForCompletion(ticket, draft)
  ) {
    errors.push("请填写本次实际发布的目标媒体或渠道");
  }

  if (deliveryCompletionHasField(operation, "site_check")) {
    if (!draft.siteCheckKey.trim()) errors.push("请填写检查项标识");
    if (!draft.siteCheckLabel.trim()) errors.push("请填写检查项名称");
  }
  if (deliveryCompletionHasField(operation, "site_check_source")) {
    if (!draft.siteCheckSource.trim()) {
      errors.push("请填写本次检查的页面地址");
    } else if (!isHttpUrl(draft.siteCheckSource)) {
      errors.push("检查页面地址必须是有效的 http(s) 地址");
    }
  }

  return errors;
}

export function buildDeliveryCompletionPayload(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
): DeliveryCompletionPayload {
  const operation = ticket.operation;
  const spec = getDeliveryOperationSpec(operation);
  if (spec && spec.completion.mode !== "form") {
    throw new Error("该需求仅供查看，不能通过通用表单完成");
  }

  if (!spec) {
    return { message: draft.summary.trim() };
  }

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
    if (deliveryCompletionHasField(operation, "optimization_question_ids")) {
      handoff.optimizationQuestionIds = Array.from(
        new Set(
          draft.optimizationQuestionIds
            .map((questionId) => questionId.trim())
            .filter(Boolean),
        ),
      );
    }
  } else if (operation === "response_logic") {
    handoff.responseLogicRevision = Number(draft.responseLogicRevision);
  } else if (operation === "channel_distribution") {
    handoff.targetMedia = targetMediaForCompletion(ticket, draft);
  } else if (
    operation === "content_asset_publish" ||
    deliveryCompletionHasField(operation, "content_asset_ids")
  ) {
    handoff.contentAssetIds = contentAssetIdsForCompletion(ticket, draft);
  } else if (operation === "site_check") {
    handoff.siteCheck = {
      key: draft.siteCheckKey.trim(),
      label: draft.siteCheckLabel.trim(),
      status: draft.siteCheckStatus,
      summary: draft.siteCheckSummary.trim() || undefined,
      evidence: draft.siteCheckEvidence.trim() || undefined,
      source: draft.siteCheckSource.trim(),
    };
  } else if (operation === "stage_report") {
    handoff.needsFurtherOptimization = draft.needsFurtherOptimization;
  }

  return {
    message: draft.summary.trim(),
    ...(deliveryCompletionRequiresPublicUrl(operation) && draft.publicUrl.trim()
      ? { publicUrl: draft.publicUrl.trim() }
      : {}),
    ...(deliveryCompletionRequiresPreviewVerification(operation) &&
    draft.previewVerified
      ? { previewVerified: true as const }
      : {}),
    ...(Object.keys(handoff).length ? { handoff } : {}),
  };
}

export function deliveryCompletionMonitoringBatchOptions(
  ticket: DeliveryCompletionTicket,
  options: DeliveryCompletionOptions = EMPTY_DELIVERY_COMPLETION_OPTIONS,
) {
  const baselineBatchKey = ticket.monitoringBatchKey?.trim();
  return options.monitoringBatches.filter(
    (batch) =>
      batch.sampleCount > 0 &&
      batch.batchKey.trim().length > 0 &&
      (ticket.operation !== "monitoring_retest" ||
        batch.batchKey !== baselineBatchKey),
  );
}

export function deliveryCompletionOptionBlockReasons(
  ticket: DeliveryCompletionTicket,
  options: DeliveryCompletionOptions = EMPTY_DELIVERY_COMPLETION_OPTIONS,
) {
  const reasons: string[] = [];
  if (ticket.operation === "question_catalog") {
    if (!options.keywordCatalogPublished) {
      reasons.push("正式品牌词库尚未发布，请先通过业务文件发布入口完成发布");
    }
    return reasons;
  }

  if (deliveryCompletionHasField(ticket.operation, "monitoring_batch")) {
    const batches = deliveryCompletionMonitoringBatchOptions(ticket, options);
    if (!batches.length) {
      reasons.push(
        ticket.operation === "monitoring_retest"
          ? "当前没有可用于复测的正式监控批次，请先发布新批次；复测基线不能重复选择"
          : "当前没有已发布且包含正式答案的监控批次，请先完成监控数据发布",
      );
    }
  }
  if (
    deliveryCompletionHasField(ticket.operation, "optimization_question_ids") &&
    !options.approvedQuestions.length
  ) {
    reasons.push("当前没有已审核通过的客户问题，无法登记待优化问题");
  }
  return reasons;
}

function contentAssetIdsForCompletion(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
) {
  const inheritedIds = (ticket.contentAssetIds || [])
    .map((item) => item.trim())
    .filter(Boolean);
  return ticket.operation !== "content_asset_publish" && inheritedIds.length
    ? Array.from(new Set(inheritedIds))
    : splitValues(draft.contentAssetIds);
}

function targetMediaForCompletion(
  ticket: DeliveryCompletionTicket,
  draft: DeliveryCompletionDraft,
) {
  return ticket.preferredMedia?.trim() || draft.channelTargetMedia.trim();
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
