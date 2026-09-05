import { SERVICE_PLAN_CATALOG } from "@shared/service-portal";

export type ServicePlanCode = "basic" | "advanced" | "luxury" | "unknown";

export type ServiceCapabilityKey =
  | "knowledgeBuild"
  | "knowledgeDisplay"
  | "globalKeywords"
  | "questionSelection"
  | "intentOptimization"
  | "responseLogic"
  | "monitoring"
  | "channelDistribution"
  | "progressReport"
  | "brandTracking"
  | "contentAssets";

export type ServiceAction = {
  kind: string;
  label: string;
  href?: string;
  targetPlan?: Exclude<ServicePlanCode, "unknown">;
};

export type ServiceCapability = {
  allowed: boolean;
  effectiveStatus: "available" | "pending" | "locked" | "unavailable";
  reason: string;
  nextAction?: ServiceAction;
};

export type ServiceQuota = {
  key: "basicQuestion" | "industry" | "competitor" | "reputation" | "scenario";
  label: string;
  limit: number | null;
  /** Full-contract entitlement. `limit` remains the currently unlocked cap. */
  entitlementLimit?: number | null;
  used: number | null;
  unit: string;
};

export type ServiceQuotaCapacityState =
  | "available"
  | "awaiting_unlock"
  | "exhausted";

export type ServiceQuotaUnlock = {
  current: number | null;
  total: number | null;
  nextUnlockAt: string | null;
  capacityState: ServiceQuotaCapacityState | null;
};

const CANONICAL_KEYWORD_QUOTA_LABELS: Partial<
  Record<ServiceQuota["key"], string>
> = {
  industry: "行业排名词",
  competitor: "竞品对比词",
  reputation: "美誉舆情词",
  scenario: "产品场景词",
};

export type PurchasedServiceQuestion = {
  id: string;
  question: string;
  kind: "basic" | "industry" | "competitor" | "reputation" | "scenario";
  statusLabel: string;
  externalQuestionId?: string;
  sourceQuestionId?: string;
  intent: string;
  rationale: string;
  revision: number;
  intentRevision: number;
  intentConfirmedRevision: number | null;
  intentConfirmedAt: number | null;
  intentConfirmed: boolean;
  responseLogicConfirmed?: boolean;
};

export type ServiceWorkflowStep = {
  id:
    | "knowledge"
    | "question"
    | "intent_optimization"
    | "response_logic"
    | "monitoring"
    | "channel_distribution"
    | "progress_report";
  label: string;
  status: "complete" | "ready" | "locked";
  lockedReason: string;
  href: string;
  nextAction?: ServiceAction;
};

export type ServicePortalView = {
  schemaVersion: number;
  known: boolean;
  account: {
    displayName: string;
    username: string;
  };
  plan: {
    code: ServicePlanCode;
    name: string;
    billingLabel: string;
    statusLabel: string;
    validFrom: string;
    validUntil: string;
  };
  quotas: ServiceQuota[];
  /** Present only when the server publishes an authoritative unlock schedule. */
  quotaUnlock?: ServiceQuotaUnlock;
  purchasedQuestions: PurchasedServiceQuestion[];
  historicalQuestions: PurchasedServiceQuestion[];
  workflowSteps: ServiceWorkflowStep[];
  knowledgeBase: {
    status: "ready" | "importing" | "missing" | "failed" | "unknown";
    statusLabel: string;
    version: string;
    sourceLabel: string;
    updatedAt: string;
  };
  capabilities: Record<ServiceCapabilityKey, ServiceCapability>;
  primaryNextAction?: ServiceAction;
  purchaseActions: ServiceAction[];
};

export const SERVICE_PLAN_PRESENTATION = {
  basic: {
    name: "普通版",
    billingLabel: "30 天单题服务",
  },
  advanced: {
    name: "进阶版",
    billingLabel: "按季度",
  },
  luxury: {
    name: "豪华版",
    billingLabel: "季度服务",
  },
} as const;

const CAPABILITY_KEYS: ServiceCapabilityKey[] = [
  "knowledgeBuild",
  "knowledgeDisplay",
  "globalKeywords",
  "questionSelection",
  "intentOptimization",
  "responseLogic",
  "monitoring",
  "channelDistribution",
  "progressReport",
  "brandTracking",
  "contentAssets",
];

const CAPABILITY_ALIASES: Record<ServiceCapabilityKey, string[]> = {
  knowledgeBuild: [
    "knowledgeBuild",
    "knowledge_build",
    "knowledgeBaseBuild",
    "knowledge_base_build",
  ],
  knowledgeDisplay: [
    "knowledgeDisplay",
    "knowledge_display",
    "knowledgeBaseDisplay",
    "knowledge_base_display",
  ],
  globalKeywords: [
    "globalKeywords",
    "global_keywords",
    "keywordBank",
    "keyword_bank",
  ],
  questionSelection: [
    "questionSelection",
    "question_selection",
    "selectQuestions",
    "select_questions",
  ],
  intentOptimization: [
    "intentOptimization",
    "intent_optimization",
    "questionOptimization",
    "question_optimization",
  ],
  responseLogic: [
    "responseLogic",
    "response_logic",
    "responseAgent",
    "response_agent",
  ],
  monitoring: ["monitoring", "questionMonitoring", "question_monitoring"],
  channelDistribution: [
    "channelDistribution",
    "channel_distribution",
    "distribution",
  ],
  progressReport: [
    "progressReport",
    "progress_report",
    "optimizationReport",
    "optimization_report",
  ],
  brandTracking: [
    "brandTracking",
    "brand_tracking",
    "publicOpinion",
    "public_opinion",
  ],
  contentAssets: [
    "contentAssets",
    "content_assets",
    "semanticAssets",
    "semantic_assets",
  ],
};

const EMPTY_ACCESS: ServiceCapability = {
  allowed: false,
  effectiveStatus: "unavailable",
  reason: "服务能力尚未同步，请稍后刷新或联系服务顾问。",
};

const SERVICE_STATUS_LABELS: Record<string, string> = {
  unconfigured: "待配置",
  pending_confirmation: "待确认",
  scheduled: "待生效",
  active: "已生效",
  suspended: "已暂停",
  expired: "已到期",
  cancelled: "已取消",
  superseded: "已升级",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstRecord(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  for (const key of keys) {
    const next = asRecord(record[key]);
    if (Object.keys(next).length > 0) return next;
  }
  return {};
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function textValue(value: unknown, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePlanCode(value: unknown): ServicePlanCode {
  const normalized = textValue(value).toLowerCase();
  if (
    normalized === "basic" ||
    normalized === "starter" ||
    normalized === "base"
  ) {
    return "basic";
  }
  if (
    normalized === "advanced" ||
    normalized === "growth" ||
    normalized === "quarterly"
  ) {
    return "advanced";
  }
  if (
    normalized === "luxury" ||
    normalized === "premium" ||
    normalized === "monthly"
  ) {
    return "luxury";
  }
  return "unknown";
}

function normalizeAction(value: unknown): ServiceAction | undefined {
  if (typeof value === "string" && value.trim()) {
    return { kind: value.trim(), label: value.trim() };
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const targetPlan = normalizePlanCode(
    firstValue(record, ["targetPlan", "target_plan", "planCode", "plan_code"]),
  );
  const kind = textValue(
    firstValue(record, ["kind", "type", "code"]),
    "contact",
  );
  const label = textValue(
    firstValue(record, ["label", "title", "text"]),
    kind === "upgrade" ? "升级服务" : "查看下一步",
  );
  const href = textValue(
    firstValue(record, ["href", "url", "purchaseUrl", "purchase_url"]),
  );
  return {
    kind,
    label,
    ...(href ? { href } : {}),
    ...(targetPlan !== "unknown" ? { targetPlan } : {}),
  };
}

function normalizeCapability(value: unknown): ServiceCapability {
  const direct = boolValue(value);
  if (direct !== undefined) {
    return direct
      ? {
          allowed: true,
          effectiveStatus: "available",
          reason: "",
        }
      : {
          allowed: false,
          effectiveStatus: "locked",
          reason: "当前服务版本未开放此功能。",
        };
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return { ...EMPTY_ACCESS };
  const rawStatus = textValue(
    firstValue(record, [
      "effectiveStatus",
      "effective_status",
      "status",
      "state",
    ]),
  ).toLowerCase();
  const explicitAllowed = boolValue(
    firstValue(record, ["allowed", "enabled", "available", "granted"]),
  );
  const allowed =
    explicitAllowed ??
    ["available", "active", "enabled", "ready", "granted"].includes(rawStatus);
  const effectiveStatus: ServiceCapability["effectiveStatus"] = allowed
    ? "available"
    : [
          "pending",
          "preparing",
          "importing",
          "processing",
          "workflow_prerequisite",
          "service_pending_confirmation",
          "service_scheduled",
        ].includes(rawStatus)
      ? "pending"
      : [
            "locked",
            "upgrade_required",
            "plan_locked",
            "not_in_plan",
            "service_suspended",
            "service_expired",
            "service_cancelled",
          ].includes(rawStatus)
        ? "locked"
        : "unavailable";
  return {
    allowed,
    effectiveStatus,
    reason: textValue(
      firstValue(record, [
        "reason",
        "message",
        "description",
        "effectiveReason",
        "effective_reason",
      ]),
      allowed ? "" : "当前服务尚未开放此功能。",
    ),
    nextAction: normalizeAction(
      firstValue(record, ["nextAction", "next_action", "action"]),
    ),
  };
}

function findCapability(
  capabilityRecord: Record<string, unknown>,
  key: ServiceCapabilityKey,
) {
  for (const alias of CAPABILITY_ALIASES[key]) {
    if (capabilityRecord[alias] !== undefined) {
      return normalizeCapability(capabilityRecord[alias]);
    }
  }
  return { ...EMPTY_ACCESS };
}

function quotaFromRecord(
  key: ServiceQuota["key"],
  label: string,
  record: Record<string, unknown>,
): ServiceQuota {
  return {
    key,
    label,
    limit: numberValue(
      firstValue(record, ["limit", "total", "quota", "included"]),
    ),
    used: numberValue(firstValue(record, ["used", "selected", "consumed"])),
    ...(numberValue(
      firstValue(record, [
        "entitlementLimit",
        "entitlement_limit",
        "contractLimit",
        "contract_limit",
      ]),
    ) !== null
      ? {
          entitlementLimit: numberValue(
            firstValue(record, [
              "entitlementLimit",
              "entitlement_limit",
              "contractLimit",
              "contract_limit",
            ]),
          ),
        }
      : {}),
    unit: textValue(
      firstValue(record, ["unit"]),
      key === "basicQuestion" ? "个问题" : "个词",
    ),
  };
}

function normalizeQuotas(
  rawPortal: Record<string, unknown>,
  planCode: ServicePlanCode,
): ServiceQuota[] {
  const quotaValue = firstValue(rawPortal, [
    "quotas",
    "quota",
    "serviceQuotas",
    "service_quotas",
  ]);
  const quotaRecord = asRecord(quotaValue);
  const quotaArray = arrayValue(quotaValue);
  const limitRecord = firstRecord(quotaRecord, ["limits", "limit"]);
  const usageRecord = firstRecord(quotaRecord, ["usage", "used"]);
  const entitlementRecord = firstRecord(quotaRecord, [
    "entitlementLimits",
    "entitlement_limits",
    "contractLimits",
    "contract_limits",
  ]);

  if (Object.keys(limitRecord).length > 0) {
    const limit = (key: string) => numberValue(limitRecord[key]) || 0;
    const used = (key: string) => numberValue(usageRecord[key]) || 0;
    const entitlement = (key: string) => numberValue(entitlementRecord[key]);
    if (planCode === "basic") {
      return [
        {
          key: "basicQuestion",
          label: "已购问题",
          limit: limit("totalQuestionLimit"),
          ...(entitlement("totalQuestionLimit") !== null
            ? { entitlementLimit: entitlement("totalQuestionLimit") }
            : {}),
          used: used("total"),
          unit: "个问题",
        },
      ];
    }
    return [
      {
        key: "industry",
        label: "行业排名词",
        limit: limit("industryLimit"),
        ...(entitlement("industryLimit") !== null
          ? { entitlementLimit: entitlement("industryLimit") }
          : {}),
        used: used("industry"),
        unit: "个词",
      },
      {
        key: "competitor",
        label: "竞品对比词",
        limit: limit("competitorComparisonLimit"),
        ...(entitlement("competitorComparisonLimit") !== null
          ? {
              entitlementLimit: entitlement("competitorComparisonLimit"),
            }
          : {}),
        used: used("competitorComparison"),
        unit: "个词",
      },
      {
        key: "reputation",
        label: "美誉舆情词",
        limit: limit("reputationLimit"),
        ...(entitlement("reputationLimit") !== null
          ? { entitlementLimit: entitlement("reputationLimit") }
          : {}),
        used: used("reputation"),
        unit: "个词",
      },
      {
        key: "scenario",
        label: "产品场景词",
        limit: limit("productScenarioLimit"),
        ...(entitlement("productScenarioLimit") !== null
          ? { entitlementLimit: entitlement("productScenarioLimit") }
          : {}),
        used: used("productScenario"),
        unit: "个词",
      },
    ];
  }

  if (quotaArray.length > 0) {
    return quotaArray.map((value, index) => {
      const record = asRecord(value);
      const rawKey = textValue(
        firstValue(record, ["key", "code", "type"]),
      ).toLowerCase();
      const key: ServiceQuota["key"] = rawKey.includes("basic")
        ? "basicQuestion"
        : rawKey.includes("industry")
          ? "industry"
          : rawKey.includes("reputation")
            ? "reputation"
            : rawKey.includes("compet")
              ? "competitor"
              : "scenario";
      return {
        ...quotaFromRecord(
          key,
          CANONICAL_KEYWORD_QUOTA_LABELS[key] ??
            textValue(
              firstValue(record, ["label", "name"]),
              `服务配额 ${index + 1}`,
            ),
          record,
        ),
      };
    });
  }

  const quotaAliases: Array<{
    key: ServiceQuota["key"];
    label: string;
    aliases: string[];
  }> = [
    {
      key: "basicQuestion",
      label: "基础问题",
      aliases: ["basicQuestion", "basic_question", "singleQuestion"],
    },
    {
      key: "industry",
      label: "行业排名词",
      aliases: ["industry", "industryKeywords", "industry_keywords"],
    },
    {
      key: "competitor",
      label: "竞品对比词",
      aliases: ["competitor", "competitorKeywords", "competitor_keywords"],
    },
    {
      key: "reputation",
      label: "美誉舆情词",
      aliases: ["reputation", "reputationKeywords", "reputation_keywords"],
    },
    {
      key: "scenario",
      label: "产品场景词",
      aliases: ["scenario", "scenarioKeywords", "scenario_keywords"],
    },
  ];

  const normalized = quotaAliases.flatMap(({ key, label, aliases }) => {
    const record = firstRecord(quotaRecord, aliases);
    if (Object.keys(record).length > 0) {
      return [quotaFromRecord(key, label, record)];
    }
    const scalar = firstValue(quotaRecord, aliases);
    const limit = numberValue(scalar);
    return limit === null
      ? []
      : [
          {
            key,
            label,
            limit,
            used: null,
            unit: key === "basicQuestion" ? "个问题" : "个词",
          },
        ];
  });

  return normalized;
}

function normalizeQuotaUnlock(
  rawPortal: Record<string, unknown>,
): ServiceQuotaUnlock | undefined {
  const directUnlockRecord = firstRecord(rawPortal, [
    "quotaUnlock",
    "quota_unlock",
  ]);
  const quotaRecord = asRecord(
    firstValue(rawPortal, [
      "quotas",
      "quota",
      "serviceQuotas",
      "service_quotas",
    ]),
  );
  if (
    Object.keys(quotaRecord).length === 0 &&
    Object.keys(directUnlockRecord).length === 0
  ) {
    return undefined;
  }

  const stageRecord =
    Object.keys(directUnlockRecord).length > 0
      ? directUnlockRecord
      : firstRecord(quotaRecord, ["unlockStage", "unlock_stage"]);
  const current = numberValue(
    firstValue(stageRecord, ["current", "ordinal", "stage"]),
  );
  const total = numberValue(
    firstValue(stageRecord, ["total", "count", "stages"]),
  );
  const unlockSource =
    Object.keys(directUnlockRecord).length > 0
      ? directUnlockRecord
      : quotaRecord;
  const rawNextUnlockAt = firstValue(unlockSource, [
    "nextUnlockAt",
    "next_unlock_at",
  ]);
  const nextUnlockAt =
    typeof rawNextUnlockAt === "string" ||
    (typeof rawNextUnlockAt === "number" && Number.isFinite(rawNextUnlockAt))
      ? String(rawNextUnlockAt).trim() || null
      : null;
  const rawCapacityState = textValue(
    firstValue(unlockSource, ["capacityState", "capacity_state"]),
  ).toLowerCase();
  const capacityState: ServiceQuotaCapacityState | null = [
    "available",
    "awaiting_unlock",
    "exhausted",
  ].includes(rawCapacityState)
    ? (rawCapacityState as ServiceQuotaCapacityState)
    : null;
  const entitlementRecord = firstRecord(quotaRecord, [
    "entitlementLimits",
    "entitlement_limits",
  ]);

  if (
    current === null &&
    total === null &&
    nextUnlockAt === null &&
    capacityState === null &&
    Object.keys(entitlementRecord).length === 0
  ) {
    return undefined;
  }

  return {
    current:
      current !== null && Number.isInteger(current) && current > 0
        ? current
        : null,
    total:
      total !== null && Number.isInteger(total) && total > 0 ? total : null,
    nextUnlockAt,
    capacityState,
  };
}

function normalizeQuestionKind(
  value: unknown,
): PurchasedServiceQuestion["kind"] {
  const normalized = textValue(value).toLowerCase();
  if (normalized.includes("industry") || normalized.includes("行业")) {
    return "industry";
  }
  if (
    normalized.includes("compet") ||
    normalized.includes("compare") ||
    normalized.includes("竞品")
  ) {
    return "competitor";
  }
  if (
    normalized.includes("reputation") ||
    normalized.includes("美誉") ||
    normalized.includes("舆情")
  ) {
    return "reputation";
  }
  if (
    normalized.includes("scenario") ||
    normalized.includes("product") ||
    normalized.includes("场景")
  ) {
    return "scenario";
  }
  return "basic";
}

function normalizeQuestions(
  rawPortal: Record<string, unknown>,
  fieldNames = [
    "purchasedQuestions",
    "purchased_questions",
    "selectedQuestions",
    "selected_questions",
    "questions",
  ],
  forcedStatusLabel?: string,
) {
  const values = arrayValue(firstValue(rawPortal, fieldNames));
  return values.flatMap((value, index) => {
    const record = asRecord(value);
    const question =
      typeof value === "string"
        ? value.trim()
        : textValue(
            firstValue(record, ["question", "text", "label", "keyword"]),
          );
    if (!question) return [];
    return [
      {
        id: textValue(
          firstValue(record, ["id", "questionId", "question_id"]),
          `service-question-${index + 1}`,
        ),
        question,
        kind: normalizeQuestionKind(
          firstValue(record, [
            "kind",
            "type",
            "category",
            "groupId",
            "group_id",
          ]),
        ),
        statusLabel:
          forcedStatusLabel ||
          textValue(
            firstValue(record, ["statusLabel", "status_label", "status"]),
            "已纳入服务",
          ),
        externalQuestionId:
          textValue(
            firstValue(record, ["externalQuestionId", "external_question_id"]),
          ) || undefined,
        sourceQuestionId:
          textValue(
            firstValue(record, ["sourceQuestionId", "source_question_id"]),
          ) || undefined,
        intent: textValue(firstValue(record, ["intent"])),
        rationale: textValue(firstValue(record, ["rationale"])),
        revision: numberValue(firstValue(record, ["revision"])) ?? 1,
        intentRevision:
          numberValue(
            firstValue(record, ["intentRevision", "intent_revision"]),
          ) ?? 1,
        intentConfirmedRevision: numberValue(
          firstValue(record, [
            "intentConfirmedRevision",
            "intent_confirmed_revision",
          ]),
        ),
        intentConfirmedAt: numberValue(
          firstValue(record, ["intentConfirmedAt", "intent_confirmed_at"]),
        ),
        intentConfirmed:
          boolValue(
            firstValue(record, ["intentConfirmed", "intent_confirmed"]),
          ) ?? false,
        responseLogicConfirmed: boolValue(
          firstValue(record, [
            "responseLogicConfirmed",
            "response_logic_confirmed",
          ]),
        ),
      } satisfies PurchasedServiceQuestion,
    ];
  });
}

function normalizeWorkflowSteps(
  rawPortal: Record<string, unknown>,
): ServiceWorkflowStep[] {
  const validIds = new Set<ServiceWorkflowStep["id"]>([
    "knowledge",
    "question",
    "intent_optimization",
    "response_logic",
    "monitoring",
    "channel_distribution",
    "progress_report",
  ]);
  return arrayValue(
    firstValue(rawPortal, ["workflowSteps", "workflow_steps", "steps"]),
  ).flatMap((value) => {
    const record = asRecord(value);
    const id = textValue(
      firstValue(record, ["id", "key"]),
    ) as ServiceWorkflowStep["id"];
    if (!validIds.has(id)) return [];
    const rawStatus = textValue(
      firstValue(record, ["status", "state"]),
    ).toLowerCase();
    const status: ServiceWorkflowStep["status"] =
      rawStatus === "complete"
        ? "complete"
        : rawStatus === "ready"
          ? "ready"
          : "locked";
    return [
      {
        id,
        label: textValue(firstValue(record, ["label", "name"]), id),
        status,
        lockedReason: textValue(
          firstValue(record, ["lockedReason", "locked_reason", "reason"]),
        ),
        href: textValue(firstValue(record, ["href", "url"])),
        nextAction: normalizeAction(
          firstValue(record, ["nextAction", "next_action", "action"]),
        ),
      },
    ];
  });
}

function defaultPurchaseActions(planCode: ServicePlanCode): ServiceAction[] {
  if (planCode === "basic") {
    return [
      {
        kind: "purchase_basic",
        label: "继续购买普通版",
        targetPlan: "basic",
      },
      { kind: "upgrade", label: "升级进阶版", targetPlan: "advanced" },
      { kind: "upgrade", label: "升级豪华版", targetPlan: "luxury" },
    ];
  }
  if (planCode === "advanced") {
    return [
      {
        kind: "renew",
        label: "续费进阶版",
        targetPlan: "advanced",
      },
      { kind: "upgrade", label: "升级豪华版", targetPlan: "luxury" },
    ];
  }
  if (planCode === "luxury") {
    return [
      {
        kind: "renew",
        label: "续费豪华版",
        targetPlan: "luxury",
      },
    ];
  }
  return [];
}

function unwrapPortal(raw: unknown) {
  const root = asRecord(raw);
  const data = asRecord(root.data);
  const payload = asRecord(root.payload);
  const candidates = [
    asRecord(root.portal),
    asRecord(root.servicePortal),
    asRecord(root.service_portal),
    asRecord(data.portal),
    asRecord(payload.portal),
    asRecord(payload.servicePortal),
    root,
  ];
  return (
    candidates.find((candidate) => Object.keys(candidate).length > 0) || {}
  );
}

export function createUnavailableServicePortal(): ServicePortalView {
  return {
    schemaVersion: 1,
    known: false,
    account: { displayName: "当前账号", username: "" },
    plan: {
      code: "unknown",
      name: "服务待同步",
      billingLabel: "",
      statusLabel: "待同步",
      validFrom: "",
      validUntil: "",
    },
    quotas: [],
    quotaUnlock: undefined,
    purchasedQuestions: [],
    historicalQuestions: [],
    workflowSteps: [],
    knowledgeBase: {
      status: "unknown",
      statusLabel: "待同步",
      version: "",
      sourceLabel: "",
      updatedAt: "",
    },
    capabilities: Object.fromEntries(
      CAPABILITY_KEYS.map((key) => [key, { ...EMPTY_ACCESS }]),
    ) as Record<ServiceCapabilityKey, ServiceCapability>,
    primaryNextAction: {
      kind: "refresh",
      label: "刷新服务配置",
    },
    purchaseActions: [],
  };
}

export function normalizeServicePortal(raw: unknown): ServicePortalView {
  const portal = unwrapPortal(raw);
  if (Object.keys(portal).length === 0) {
    return createUnavailableServicePortal();
  }

  const planRecord = firstRecord(portal, [
    "plan",
    "service",
    "servicePlan",
    "service_plan",
    "entitlement",
  ]);
  const planCode = normalizePlanCode(
    firstValue(planRecord, ["code", "planCode", "plan_code"]) ??
      firstValue(portal, ["planCode", "plan_code", "servicePlanCode"]),
  );
  const presentation =
    planCode === "unknown" ? undefined : SERVICE_PLAN_PRESENTATION[planCode];
  const accountRecord = firstRecord(portal, ["account", "user", "customer"]);
  const knowledgeRecord = firstRecord(portal, [
    "knowledgeBase",
    "knowledge_base",
    "knowledge",
    "snapshot",
  ]);
  const rawKnowledgeStatus = textValue(
    firstValue(knowledgeRecord, [
      "status",
      "importStatus",
      "import_status",
      "state",
    ]),
  ).toLowerCase();
  const knowledgeStatus: ServicePortalView["knowledgeBase"]["status"] = [
    "ready",
    "display_ready",
    "published",
    "active",
    "available",
    "complete",
  ].includes(rawKnowledgeStatus)
    ? "ready"
    : ["importing", "pending", "processing", "migrating"].includes(
          rawKnowledgeStatus,
        )
      ? "importing"
      : ["missing", "empty", "not_found"].includes(rawKnowledgeStatus)
        ? "missing"
        : ["failed", "error"].includes(rawKnowledgeStatus)
          ? "failed"
          : "unknown";
  const capabilityRecord = firstRecord(portal, [
    "capabilities",
    "access",
    "effectiveCapabilities",
    "effective_capabilities",
  ]);
  const capabilities = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, findCapability(capabilityRecord, key)]),
  ) as Record<ServiceCapabilityKey, ServiceCapability>;

  // Front-end defense in depth: the basic product never starts or mounts the
  // conversational knowledge-base builder, even if a stale payload says so.
  if (planCode === "basic") {
    capabilities.knowledgeBuild = {
      allowed: false,
      effectiveStatus: "locked",
      reason:
        "普通版不包含知识库智能体；知识库由 Website 流程自动同步至本账号，服务团队可补录。升级进阶版或豪华版后可解锁知识库智能体。",
      nextAction: {
        kind: "upgrade",
        label: "查看升级方案",
        targetPlan: "advanced",
      },
    };
  }

  const rawPlanStatus = textValue(
    firstValue(planRecord, [
      "statusLabel",
      "status_label",
      "status",
      "effectiveStatus",
      "effective_status",
    ]),
  );
  const planStatus =
    SERVICE_STATUS_LABELS[rawPlanStatus.toLowerCase()] ||
    rawPlanStatus ||
    (planCode === "unknown" ? "待同步" : "已生效");
  const primaryNextAction = normalizeAction(
    firstValue(portal, [
      "primaryNextAction",
      "primary_next_action",
      "nextAction",
      "next_action",
    ]),
  );
  const purchaseActions = arrayValue(
    firstValue(portal, [
      "purchaseActions",
      "purchase_actions",
      "availablePurchases",
      "available_purchases",
    ]),
  )
    .map(normalizeAction)
    .filter((value): value is ServiceAction => Boolean(value));

  return {
    schemaVersion:
      numberValue(firstValue(portal, ["schemaVersion", "schema_version"])) || 1,
    known: planCode !== "unknown",
    account: {
      displayName: textValue(
        firstValue(accountRecord, [
          "displayName",
          "display_name",
          "name",
          "companyName",
          "company_name",
        ]),
        "当前账号",
      ),
      username: textValue(
        firstValue(accountRecord, ["username", "loginName", "login_name"]),
      ),
    },
    plan: {
      code: planCode,
      name: textValue(
        firstValue(planRecord, ["name", "planName", "plan_name", "label"]),
        presentation?.name || "服务待同步",
      ),
      billingLabel: textValue(
        firstValue(planRecord, [
          "billingLabel",
          "billing_label",
          "billingCycle",
          "billing_cycle",
        ]),
        presentation?.billingLabel || "",
      ),
      statusLabel: planStatus,
      validFrom: textValue(
        firstValue(planRecord, [
          "validFrom",
          "valid_from",
          "startsAt",
          "starts_at",
        ]),
      ),
      validUntil: textValue(
        firstValue(planRecord, [
          "validUntil",
          "valid_until",
          "expiresAt",
          "expires_at",
        ]),
      ),
    },
    quotas: normalizeQuotas(portal, planCode),
    quotaUnlock: normalizeQuotaUnlock(portal),
    purchasedQuestions: normalizeQuestions(portal),
    historicalQuestions: normalizeQuestions(
      portal,
      ["historicalQuestions", "historical_questions"],
      "只读历史",
    ),
    workflowSteps: normalizeWorkflowSteps(portal),
    knowledgeBase: {
      status: knowledgeStatus,
      statusLabel: textValue(
        firstValue(knowledgeRecord, ["statusLabel", "status_label"]),
        knowledgeStatus === "ready"
          ? "可查看"
          : knowledgeStatus === "importing"
            ? "迁移中"
            : knowledgeStatus === "failed"
              ? "迁移失败"
              : knowledgeStatus === "missing"
                ? "尚未迁移"
                : "待同步",
      ),
      version: textValue(
        firstValue(knowledgeRecord, [
          "versionLabel",
          "version_label",
          "version",
        ]),
      ).replace(/^(\d+)$/, "V$1"),
      sourceLabel: textValue(
        firstValue(knowledgeRecord, [
          "sourceLabel",
          "source_label",
          "sourceKind",
          "source_kind",
        ]),
        firstValue(planRecord, ["source"]) === "website"
          ? "Website 流程同步知识库"
          : "",
      ),
      updatedAt: textValue(
        firstValue(knowledgeRecord, [
          "updatedAt",
          "updated_at",
          "createdAt",
          "created_at",
        ]),
      ),
    },
    capabilities,
    ...(primaryNextAction ? { primaryNextAction } : {}),
    purchaseActions:
      purchaseActions.length > 0
        ? purchaseActions
        : defaultPurchaseActions(planCode),
  };
}

export function getRouteCapability(
  section: string,
  sub: string | null,
): ServiceCapabilityKey | null {
  if (section === "knowledge-agent") {
    return sub === "display" ? "knowledgeDisplay" : "knowledgeBuild";
  }
  if (section === "brand" && sub === "enterprise-dashboard") {
    return "contentAssets";
  }
  if (section === "brand" && sub === "global-keywords") {
    return "globalKeywords";
  }
  if (section === "intent" && sub === "question-optimization") {
    return "intentOptimization";
  }
  if (section === "response-logic") return "responseLogic";
  if (section === "progress" && sub === "monitor") return "monitoring";
  // Legacy routes remain compatible with previously stored navigation targets.
  if (section === "intent" && sub === "monitor") return "monitoring";
  if (section === "progress" && sub === "distribution") {
    return "channelDistribution";
  }
  if (section === "progress" && sub === "optimization") {
    return "progressReport";
  }
  if (section === "public-opinion" && sub === "brand-tracking") {
    return "brandTracking";
  }
  if (section === "semantic") return "contentAssets";
  return null;
}

export function isCapabilityIncludedInPlan(
  planCode: ServicePlanCode,
  key: ServiceCapabilityKey,
): boolean {
  // A sidebar lock describes the purchased plan, not a temporary workflow or
  // service lifecycle gate. Avoid claiming exclusion until the plan is known.
  if (planCode === "unknown") return true;
  return SERVICE_PLAN_CATALOG[planCode].includedCapabilities[key];
}

export function getCapability(
  portal: ServicePortalView,
  key: ServiceCapabilityKey,
) {
  const explicit = portal.capabilities[key];

  const stepIdByCapability: Partial<
    Record<ServiceCapabilityKey, ServiceWorkflowStep["id"]>
  > = {
    knowledgeBuild: "knowledge",
    knowledgeDisplay: "knowledge",
    globalKeywords: "question",
    questionSelection: "question",
    intentOptimization: "intent_optimization",
    responseLogic: "response_logic",
    monitoring: "monitoring",
    channelDistribution: "channel_distribution",
    progressReport: "progress_report",
  };
  const stepId = stepIdByCapability[key];
  const step = stepId
    ? portal.workflowSteps.find((candidate) => candidate.id === stepId)
    : undefined;
  const knowledgeStep = portal.workflowSteps.find(
    (candidate) => candidate.id === "knowledge",
  );
  const knowledgeReady = knowledgeStep
    ? knowledgeStep.status === "complete"
    : portal.knowledgeBase.status === "ready";
  if (key === "contentAssets" && explicit.allowed && !knowledgeReady) {
    return {
      allowed: false,
      effectiveStatus: "pending",
      reason:
        portal.plan.code === "basic"
          ? "请先等待 Website 流程自动同步或服务团队补录知识库；知识库展示完成后解锁 AI 友好内容资产。"
          : "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
      nextAction: knowledgeStep?.nextAction ?? portal.primaryNextAction,
    } satisfies ServiceCapability;
  }
  if (
    key === "knowledgeDisplay" &&
    explicit.allowed &&
    step &&
    step.status !== "complete"
  ) {
    return {
      allowed: false,
      effectiveStatus: "pending",
      reason:
        step.status === "locked"
          ? step.lockedReason || "知识库尚未同步完成。"
          : "请先在知识库智能体中完成全部节点并发布知识库。",
      nextAction: step.nextAction ?? portal.primaryNextAction,
    } satisfies ServiceCapability;
  }
  if (explicit.allowed && step?.status === "locked") {
    return {
      allowed: false,
      effectiveStatus: "pending",
      reason:
        key === "globalKeywords"
          ? "请先通过知识库智能体完成全部节点，并联系管理员开启品牌全域词库。"
          : step.lockedReason || "当前步骤需要完成前置服务后开放。",
      nextAction: step.nextAction ?? portal.primaryNextAction,
    } satisfies ServiceCapability;
  }
  return explicit;
}

export function getWorkflowStepAccess(
  portal: ServicePortalView,
  step: ServiceWorkflowStep,
): ServiceCapability {
  if (step.status === "locked") {
    return {
      allowed: false,
      effectiveStatus: "pending",
      reason: step.lockedReason || "当前步骤需要完成前置服务后开放。",
      nextAction: step.nextAction ?? portal.primaryNextAction,
    };
  }
  return {
    allowed: true,
    effectiveStatus: "available",
    reason: "",
    ...(step.nextAction ? { nextAction: step.nextAction } : {}),
  };
}

export function getPreviewPlanCode(
  search: string,
): Exclude<ServicePlanCode, "unknown"> {
  const value = new URLSearchParams(search).get("plan");
  const normalized = normalizePlanCode(value);
  return normalized === "unknown" ? "basic" : normalized;
}
