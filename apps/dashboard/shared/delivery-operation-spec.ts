import type {
  DeliveryRoleType,
  KnownDeliveryOperation,
} from "./delivery-roles";

export type DeliveryOperationCompletionField =
  | "domain"
  | "icp_service_code"
  | "icp_resolution"
  | "monitoring_batch"
  | "optimization_question_ids"
  | "response_logic_revision"
  | "content_asset_ids"
  | "channel_target_media"
  | "needs_further_optimization"
  | "site_check"
  | "site_check_source";

export type DeliveryOperationPublicUrlPolicy = "hidden" | "required";
export type DeliveryOperationPreviewVerificationPolicy = "hidden" | "required";
export type DeliveryOperationCompletionMode =
  | "form"
  | "dedicated"
  | "system_readonly";

export type DeliveryCompletionEvidencePath =
  | "message"
  | "publicUrl"
  | "previewVerified"
  | "handoff.monitoringBatchKey"
  | "handoff.optimizationQuestionIds"
  | "handoff.responseLogicRevision"
  | "handoff.contentAssetIds"
  | "handoff.targetMedia"
  | "handoff.needsFurtherOptimization"
  | "handoff.domain"
  | "handoff.icpServiceCode"
  | "handoff.icpProvince"
  | "handoff.icpNumber"
  | "handoff.icpNotRequired"
  | "handoff.siteCheck";

export type DeliverySummaryOnlyOperation =
  | "build_exception"
  | "knowledge_maintenance"
  | "question_catalog";

export type DeliveryWebsiteContentOperation =
  | "company_facts"
  | "product_case_docs"
  | "industry_news"
  | "company_news"
  | "faq_content";

export type DeliverySiteCheckEvidence = {
  key: string;
  label: string;
  status: "passed" | "warning" | "failed" | "not_applicable";
  summary?: string;
  evidence?: string;
  source: string;
};

/**
 * Strict evidence shapes accepted when completing known executable operations.
 * Dedicated approval operations and system records are deliberately absent.
 */
export type DeliveryCompletionEvidence =
  | {
      operation: DeliverySummaryOnlyOperation;
      message: string;
    }
  | {
      operation: "initial_monitoring" | "monitoring_import";
      message: string;
      handoff: {
        monitoringBatchKey: string;
        optimizationQuestionIds?: string[];
      };
    }
  | {
      operation: "monitoring_retest";
      message: string;
      handoff: { monitoringBatchKey: string };
    }
  | {
      operation: "stage_report";
      message: string;
      handoff: { needsFurtherOptimization: boolean };
    }
  | {
      operation: "response_logic";
      message: string;
      handoff: { responseLogicRevision: number };
    }
  | {
      operation: "content_asset_publish";
      message: string;
      handoff: { contentAssetIds: string[] };
    }
  | {
      operation: "channel_distribution";
      message: string;
      publicUrl: string;
      handoff: { targetMedia: string };
    }
  | {
      operation: "domain_application";
      message: string;
      handoff: { domain: string; icpServiceCode?: string };
    }
  | {
      operation: "icp_filing";
      message: string;
      handoff: {
        icpProvince?: string;
        icpNumber?: string;
        icpNotRequired: boolean;
      };
    }
  | {
      operation: "website_build";
      message: string;
      publicUrl: string;
      previewVerified: true;
    }
  | {
      operation: DeliveryWebsiteContentOperation;
      message: string;
      publicUrl: string;
      handoff: { contentAssetIds: string[] };
    }
  | {
      operation: "site_check";
      message: string;
      handoff: { siteCheck: DeliverySiteCheckEvidence };
    };

/**
 * Unknown historical operation codes use a compatibility close: summary only,
 * with no URL, preview flag, handoff, or inferred business behavior.
 */
export type LegacyDeliverySummaryEvidence = {
  operation: string;
  message: string;
  publicUrl?: never;
  previewVerified?: never;
  handoff?: never;
};

export type DeliveryOperationSpec = {
  operation: KnownDeliveryOperation;
  label: string;
  ownerRole: DeliveryRoleType | "system";
  completion: {
    mode: DeliveryOperationCompletionMode;
    fields: readonly DeliveryOperationCompletionField[];
    publicUrl: DeliveryOperationPublicUrlPolicy;
    previewVerification: DeliveryOperationPreviewVerificationPolicy;
  };
  nextStep: string;
};

/**
 * Single presentation and completion contract for every supported delivery
 * operation. Adding an operation to the shared schema must also add a complete
 * entry here, otherwise TypeScript fails the exhaustive Record check.
 *
 * Unknown/legacy strings deliberately have no inferred business form. Callers
 * must use a summary-only compatibility close and must not infer fields from a
 * title, description, category, or another operation.
 */
export const DELIVERY_OPERATION_SPECS = {
  build_exception: {
    operation: "build_exception",
    label: "构建异常处理",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "完成后结果会进入客户任务记录和管理员交付记录。",
  },
  knowledge_maintenance: {
    operation: "knowledge_maintenance",
    label: "知识库维护",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "完成后，新知识库版本会作为客户当前正式版本继续使用。",
  },
  knowledge_reset: {
    operation: "knowledge_reset",
    label: "知识库重置",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "dedicated",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "该需求必须通过知识库重置专用审批处理。",
  },
  question_catalog: {
    operation: "question_catalog",
    label: "配置品牌词库",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "form",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep:
      "品牌词库发布完成后，客户可独立选择或提交问题；问题审核通过后，系统会进入首次监控。",
  },
  question_maintenance: {
    operation: "question_maintenance",
    label: "问题与应答逻辑维护",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "dedicated",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "该需求必须通过问题维护专用审批处理。",
  },
  initial_monitoring: {
    operation: "initial_monitoring",
    label: "首次监控",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "form",
      fields: ["monitoring_batch", "optimization_question_ids"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "填写的待优化问题会分别生成“应答逻辑”下游需求。",
  },
  monitoring_import: {
    operation: "monitoring_import",
    label: "监控导入",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "form",
      fields: ["monitoring_batch", "optimization_question_ids"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "填写的待优化问题会分别生成“应答逻辑”下游需求。",
  },
  monitoring_retest: {
    operation: "monitoring_retest",
    label: "监控复测",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "form",
      fields: ["monitoring_batch"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成“阶段效果报告”需求。",
  },
  stage_report: {
    operation: "stage_report",
    label: "阶段报告",
    ownerRole: "monitoring_optimization_engineer",
    completion: {
      mode: "form",
      fields: ["needs_further_optimization"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "若仍需优化，系统会沿原问题生成下一轮应答逻辑需求。",
  },
  response_logic: {
    operation: "response_logic",
    label: "应答逻辑",
    ownerRole: "content_distribution_engineer",
    completion: {
      mode: "form",
      fields: ["response_logic_revision"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成“内容资产发布”需求。",
  },
  content_asset_publish: {
    operation: "content_asset_publish",
    label: "内容资产发布",
    ownerRole: "content_distribution_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep:
      "完成后系统会按客户原始入口自动生成媒体分发或官网发布子任务，无需人工选择流转方向。",
  },
  channel_distribution: {
    operation: "channel_distribution",
    label: "渠道分发",
    ownerRole: "content_distribution_engineer",
    completion: {
      mode: "form",
      fields: ["channel_target_media"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep:
      "公开链接登记后会汇总到客户原始需求；仅在关联监控问题时继续生成效果复测。",
  },
  domain_application: {
    operation: "domain_application",
    label: "域名核验与备案准备",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["domain", "icp_service_code"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "域名结果会写入用户官网流程；海外版将直接进入风格样例阶段。",
  },
  icp_filing: {
    operation: "icp_filing",
    label: "ICP 备案结果核验",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["icp_resolution"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "备案结果会写入用户官网流程，并自动生成风格样例需求。",
  },
  website_style_samples: {
    operation: "website_style_samples",
    label: "官网风格样例",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "dedicated",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "发布三张样例后由客户选择；不能通过普通完成表单关闭。",
  },
  website_build: {
    operation: "website_build",
    label: "官网构建",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: [],
      publicUrl: "required",
      previewVerification: "required",
    },
    nextStep: "完成并登记官网公开链接后，系统会开放后续官网内容提交。",
  },
  site_rebuild: {
    operation: "site_rebuild",
    label: "官网重制",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "dedicated",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "受理后系统开启新的官网子版本；新版本构建完成后自动关闭工单。",
  },
  company_facts: {
    operation: "company_facts",
    label: "企业事实内容",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成站点检查需求；检查通过后汇总到客户原始需求。",
  },
  product_case_docs: {
    operation: "product_case_docs",
    label: "产品案例内容",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成站点检查需求；检查通过后汇总到客户原始需求。",
  },
  industry_news: {
    operation: "industry_news",
    label: "行业新闻",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成站点检查需求；检查通过后汇总到客户原始需求。",
  },
  company_news: {
    operation: "company_news",
    label: "企业新闻",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成站点检查需求；检查通过后汇总到客户原始需求。",
  },
  faq_content: {
    operation: "faq_content",
    label: "FAQ 内容",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["content_asset_ids"],
      publicUrl: "required",
      previewVerification: "hidden",
    },
    nextStep: "完成后自动生成站点检查需求；检查通过后汇总到客户原始需求。",
  },
  site_check: {
    operation: "site_check",
    label: "站点检查",
    ownerRole: "ai_operations_engineer",
    completion: {
      mode: "form",
      fields: ["site_check", "site_check_source"],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep:
      "站点检查通过后汇总到客户原始需求；检查失败时系统会生成 AI 运维修正子工单，修正后继续复检。",
  },
  knowledge_delivery: {
    operation: "knowledge_delivery",
    label: "品牌全域知识库",
    ownerRole: "system",
    completion: {
      mode: "system_readonly",
      fields: [],
      publicUrl: "hidden",
      previewVerification: "hidden",
    },
    nextStep: "该记录由系统在知识库发布后自动归档，不需要人工完成。",
  },
} as const satisfies Record<KnownDeliveryOperation, DeliveryOperationSpec>;

/**
 * Runtime allowlist for evidence received by the completion endpoint. Paths
 * are intentionally payload-shaped so the server can reject stale or hidden
 * fields before applying operation-specific business logic.
 */
export const DELIVERY_OPERATION_ALLOWED_EVIDENCE = {
  build_exception: ["message"],
  knowledge_maintenance: ["message"],
  knowledge_reset: [],
  question_catalog: ["message"],
  question_maintenance: [],
  initial_monitoring: [
    "message",
    "handoff.monitoringBatchKey",
    "handoff.optimizationQuestionIds",
  ],
  monitoring_import: [
    "message",
    "handoff.monitoringBatchKey",
    "handoff.optimizationQuestionIds",
  ],
  monitoring_retest: ["message", "handoff.monitoringBatchKey"],
  stage_report: ["message", "handoff.needsFurtherOptimization"],
  response_logic: ["message", "handoff.responseLogicRevision"],
  content_asset_publish: ["message", "handoff.contentAssetIds"],
  channel_distribution: ["message", "publicUrl", "handoff.targetMedia"],
  domain_application: ["message", "handoff.domain", "handoff.icpServiceCode"],
  icp_filing: [
    "message",
    "handoff.icpProvince",
    "handoff.icpNumber",
    "handoff.icpNotRequired",
  ],
  website_style_samples: [],
  website_build: ["message", "publicUrl", "previewVerified"],
  site_rebuild: [],
  company_facts: ["message", "publicUrl", "handoff.contentAssetIds"],
  product_case_docs: ["message", "publicUrl", "handoff.contentAssetIds"],
  industry_news: ["message", "publicUrl", "handoff.contentAssetIds"],
  company_news: ["message", "publicUrl", "handoff.contentAssetIds"],
  faq_content: ["message", "publicUrl", "handoff.contentAssetIds"],
  site_check: ["message", "handoff.siteCheck"],
  knowledge_delivery: [],
} as const satisfies Record<
  KnownDeliveryOperation,
  readonly DeliveryCompletionEvidencePath[]
>;

export const LEGACY_DELIVERY_ALLOWED_EVIDENCE = [
  "message",
] as const satisfies readonly DeliveryCompletionEvidencePath[];

export function deliveryOperationAllowedEvidence(
  value: string | null | undefined,
): readonly DeliveryCompletionEvidencePath[] {
  return value &&
    Object.prototype.hasOwnProperty.call(
      DELIVERY_OPERATION_ALLOWED_EVIDENCE,
      value,
    )
    ? DELIVERY_OPERATION_ALLOWED_EVIDENCE[value as KnownDeliveryOperation]
    : LEGACY_DELIVERY_ALLOWED_EVIDENCE;
}

export function getDeliveryOperationSpec(
  value: string | null | undefined,
): DeliveryOperationSpec | null {
  if (
    !value ||
    !Object.prototype.hasOwnProperty.call(DELIVERY_OPERATION_SPECS, value)
  ) {
    return null;
  }
  return DELIVERY_OPERATION_SPECS[
    value as KnownDeliveryOperation
  ] as DeliveryOperationSpec;
}

export function deliveryOperationLabel(
  value: string | null | undefined,
): string {
  return getDeliveryOperationSpec(value)?.label ?? "历史需求";
}
