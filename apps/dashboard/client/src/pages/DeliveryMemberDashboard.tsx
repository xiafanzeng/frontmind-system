import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Send,
  Upload,
  Users,
  Loader2,
  Trash2,
  AlertTriangle,
  Download,
  ExternalLink,
  PanelRightOpen,
  RefreshCw,
  ArrowLeft,
  ClipboardList,
} from "lucide-react";
import { toast } from "sonner";

import PortalShell, { type PortalNavItem } from "@/components/PortalShell";
import CustomerDashboardMirror, {
  type CustomerDashboardMirrorSection,
} from "@/components/CustomerDashboardMirror";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { deliveryTicketDisplayDescription } from "@/lib/delivery-workflow";
import {
  buildDeliveryCompletionPayload,
  createDeliveryCompletionDraft,
  deliveryCompletionCreatesNextStep,
  deliveryCompletionHasField,
  deliveryCompletionMonitoringBatchOptions,
  deliveryCompletionMode,
  deliveryCompletionOptionBlockReasons,
  deliveryCompletionRequiresPublicUrl,
  deliveryCompletionRequiresPreviewVerification,
  deliveryCompletionSummaryPlaceholder,
  deliveryTicketWaitsForAdminCredential,
  type DeliveryCompletionDraft,
  type DeliveryCompletionOptions,
  validateDeliveryCompletionDraft,
} from "@/lib/delivery-ticket-completion";
import {
  DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
  uploadFile,
} from "@/lib/frontmind-api";
import {
  channelDistributionUrl,
  getAdminNav,
  issueMonitorUrl,
} from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryWorkflowOperation,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import {
  QUESTION_QUOTA_CATEGORY_MAX,
  type ServiceQuotaLimits,
  type ServiceQuotaUsage,
} from "@shared/service-portal";
import {
  BRAND_TRACKING_CREDITS_INPUT_PATTERN,
  brandTrackingAmountToCredits,
  formatBrandTrackingCredits,
} from "@shared/brand-tracking-credits";
import { keywordCategoryKey } from "@shared/keyword-categories";
import {
  deliveryActorRoleLabel,
  deliveryCategoryLabel,
  deliveryCleanupSummaryText,
  deliveryEventDisplayMessage,
  deliveryOperationLabel as deliveryOperationPresentationLabel,
  deliveryTicketPresentationTitle,
  deliveryTicketStatusLabel,
  knowledgeResetReasonLabel,
  knowledgeResetStatusLabel,
} from "@shared/delivery-ticket-presentation";
import { contentAssetMediaOptionsForMarketEdition } from "@shared/delivery-catalog";

const CUSTOMER_DASHBOARD_BUTTON_CLASS =
  "border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700 hover:text-white focus-visible:border-blue-600 focus-visible:ring-blue-600/30 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-700";

const QUESTION_QUOTA_FIELDS = [
  {
    category: "industry",
    limitKey: "industryLimit",
    usageKey: "industry",
    label: "行业排名词",
  },
  {
    category: "competitor_comparison",
    limitKey: "competitorComparisonLimit",
    usageKey: "competitorComparison",
    label: "竞品对比词",
  },
  {
    category: "reputation",
    limitKey: "reputationLimit",
    usageKey: "reputation",
    label: "美誉舆情词",
  },
  {
    category: "product_scenario",
    limitKey: "productScenarioLimit",
    usageKey: "productScenario",
    label: "产品场景词",
  },
] as const;

const QUESTION_MIRROR_GROUPS = {
  industry: {
    groupId: "ranking",
    groupTitle: "行业排名词",
    groupSubtitle: "行业入口与品牌优胜问题",
    tone: "amber",
  },
  competitor_comparison: {
    groupId: "comparison",
    groupTitle: "竞品对比词",
    groupSubtitle: "差异定位与选择依据",
    tone: "blue",
  },
  reputation: {
    groupId: "reputation",
    groupTitle: "美誉舆情词",
    groupSubtitle: "信任证据与品牌口碑",
    tone: "plum",
  },
  product_scenario: {
    groupId: "scenario",
    groupTitle: "产品场景词",
    groupSubtitle: "应用需求与决策问题",
    tone: "teal",
  },
} as const;

const WORKBENCH_SECTION_BY_OPERATION: Partial<
  Record<DeliveryWorkflowOperation, CustomerDashboardMirrorSection>
> = {
  build_exception: "knowledge-build",
  knowledge_reset: "knowledge-build",
  knowledge_maintenance: "knowledge",
  question_catalog: "keywords",
  question_maintenance: "questions",
  initial_monitoring: "monitoring",
  monitoring_import: "monitoring",
  monitoring_retest: "monitoring",
  stage_report: "report",
  response_logic: "response-logic",
  content_asset_publish: "content",
  channel_distribution: "content",
  domain_application: "website",
  icp_filing: "website",
  website_style_samples: "website",
  website_build: "website",
  site_rebuild: "website",
  company_facts: "website",
  product_case_docs: "website",
  industry_news: "website",
  company_news: "website",
  faq_content: "website",
  site_check: "website",
};

export function deliveryWorkbenchHref(input: {
  projectAssignmentId: string;
  ticketId: string;
  operation?: string | null;
  systemAdminMode?: boolean;
}) {
  const section =
    WORKBENCH_SECTION_BY_OPERATION[
      input.operation as DeliveryWorkflowOperation
    ] ?? "home";
  const params = new URLSearchParams({
    projectAssignmentId: input.projectAssignmentId,
    section,
    ticketId: input.ticketId,
    focus: "1",
  });
  return `${input.systemAdminMode ? "/admin/delivery-workbench" : "/delivery/workbench"}?${params.toString()}`;
}

function readDeliveryWorkbenchRequest() {
  if (typeof window === "undefined") {
    return { projectAssignmentId: "", section: "", ticketId: "", focus: false };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    projectAssignmentId: params.get("projectAssignmentId")?.trim() || "",
    section: params.get("section")?.trim() || "",
    ticketId: params.get("ticketId")?.trim() || "",
    focus: params.get("focus") === "1",
  };
}

export type SiteRebuildResetState =
  | "queued"
  | "reconciling"
  | "blocked"
  | "completed"
  | "invalidated";

export type SiteRebuildResetIssue =
  | "esa_runtime_required"
  | "external_outcome_unknown"
  | "project_coordinates_changed";

export function siteRebuildResetProjection(ticket: unknown) {
  const record =
    ticket && typeof ticket === "object" && !Array.isArray(ticket)
      ? (ticket as Record<string, unknown>)
      : {};
  const hasExplicitState = Object.prototype.hasOwnProperty.call(
    record,
    "siteRebuildResetState",
  );
  const explicitState = [
    "queued",
    "reconciling",
    "blocked",
    "completed",
    "invalidated",
  ].includes(String(record.siteRebuildResetState ?? ""))
    ? (record.siteRebuildResetState as SiteRebuildResetState)
    : null;
  const issue = [
    "esa_runtime_required",
    "external_outcome_unknown",
    "project_coordinates_changed",
  ].includes(String(record.siteRebuildResetIssue ?? ""))
    ? (record.siteRebuildResetIssue as SiteRebuildResetIssue)
    : null;
  const state = hasExplicitState
    ? explicitState
    : record.siteRebuildResetApplied === true && record.status === "in_progress"
      ? ("completed" as const)
      : record.siteRebuildResetPending === true
        ? ("blocked" as const)
        : null;
  return {
    state,
    issue,
    canRecheck:
      typeof record.siteRebuildCanRecheck === "boolean"
        ? record.siteRebuildCanRecheck
        : state === "blocked" && record.siteRebuildResetPending === true,
  } as const;
}

export function siteRebuildResetNeedsAutomaticRefresh(ticket: unknown) {
  const state = siteRebuildResetProjection(ticket).state;
  return state === "queued" || state === "reconciling";
}

function siteRebuildResetIssueCopy(issue: SiteRebuildResetIssue | null) {
  if (issue === "esa_runtime_required") {
    return "发布运行环境尚未就绪，官网重置尚未开始。";
  }
  if (issue === "project_coordinates_changed") {
    return "项目状态已变化，需要重新检查当前官网后再继续。";
  }
  return "旧官网的外部下线结果尚未确认，需要重新检查。";
}

function focusedSiteRebuildStatus(ticket: unknown) {
  const reset = siteRebuildResetProjection(ticket);
  if (reset.state === "completed") {
    return "当前需求状态：旧官网已下线，企业知识库保持不变；客户可点击“从知识库开始建站”。";
  }
  if (reset.state === "queued") {
    return "当前需求状态：正在完成官网重置，旧官网已进入安全下线队列。";
  }
  if (reset.state === "reconciling") {
    return "当前需求状态：正在核对旧官网下线结果，确认后将自动完成重置。";
  }
  if (reset.state === "blocked") {
    return `当前需求状态：${siteRebuildResetIssueCopy(reset.issue)}`;
  }
  if (reset.state === "invalidated") {
    return "当前需求状态：原重置申请已失效，请客户重新提交。";
  }
  return "当前需求状态：待通过重置。";
}

function normalizeMirrorQuestionText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function registerMirrorQuestionIdentity(
  identities: Map<string, Set<string>>,
  legacyId: string | null | undefined,
  currentId: string,
) {
  if (!legacyId) return;
  const matches = identities.get(legacyId) ?? new Set<string>();
  matches.add(currentId);
  identities.set(legacyId, matches);
}

type QuestionQuotaLimitKey = (typeof QUESTION_QUOTA_FIELDS)[number]["limitKey"];
type QuestionCategory = (typeof QUESTION_QUOTA_FIELDS)[number]["category"];
type QuestionQuotaDraft = Record<QuestionQuotaLimitKey, string>;

type WorkbenchQuestionQuota = {
  periodId: string;
  revision: number;
  validFrom: number;
  validUntil: number;
  limits: ServiceQuotaLimits;
  unlockedLimits?: ServiceQuotaLimits;
  unlockStage?: { current: number; total: number };
  nextUnlockAt?: number | null;
  progressiveUnlock?: boolean;
  selectedUsage: ServiceQuotaUsage;
  reservedUsage: ServiceQuotaUsage;
  remaining: ServiceQuotaUsage;
};

type WorkbenchBrandTrackingUsage = {
  rolling30DayCost: string;
  lifetimeCost: string;
  limit: string;
  remaining: string;
  exceededBy: string;
  windowStartedAt: string;
  windowEndsAt: string;
  pendingReconciliationCount: number;
  hasUnknownUsage: boolean;
  keyConfigured: boolean;
  blocked: boolean;
  blockReason: string | null;
};

function questionQuotaDraft(limits: ServiceQuotaLimits): QuestionQuotaDraft {
  return {
    industryLimit: String(limits.industryLimit),
    competitorComparisonLimit: String(limits.competitorComparisonLimit),
    reputationLimit: String(limits.reputationLimit),
    productScenarioLimit: String(limits.productScenarioLimit),
  };
}

export const deliveryMemberNav: PortalNavItem[] = [
  {
    label: "客户工作台",
    href: "/",
    icon: Users,
    group: "工作台",
    activePrefixes: ["/delivery/workbench"],
  },
  {
    label: "通用智能体",
    href: "/delivery/agent",
    icon: Bot,
    group: "工具",
  },
];

export function deliveryMemberNavForRole(
  roleType?: DeliveryRoleType | null,
): PortalNavItem[] {
  if (roleType === "monitoring_optimization_engineer") {
    return [
      deliveryMemberNav[0]!,
      {
        label: "问题监控",
        href: issueMonitorUrl,
        icon: Activity,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[1]!,
    ];
  }
  if (roleType === "content_distribution_engineer") {
    return [
      deliveryMemberNav[0]!,
      {
        label: "渠道分发",
        href: channelDistributionUrl,
        icon: Send,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[1]!,
    ];
  }
  return deliveryMemberNav;
}

export const ROLE_DASHBOARD_SECTIONS: Record<
  DeliveryRoleType,
  readonly CustomerDashboardMirrorSection[]
> = {
  ai_operations_engineer: [
    "knowledge-build",
    "brand-tracking",
    "knowledge",
    "website",
  ],
  monitoring_optimization_engineer: [
    "keywords",
    "questions",
    "monitoring",
    "report",
  ],
  content_distribution_engineer: ["response-logic", "content"],
};

export function deliveryDashboardSectionsForAssignment(
  roleType: DeliveryRoleType,
  marketEdition?: "domestic" | "overseas" | null,
) {
  return ROLE_DASHBOARD_SECTIONS[roleType].filter(
    (section) => section !== "brand-tracking" || marketEdition === "overseas",
  );
}

type BusinessModuleImportDefinition = {
  module:
    | "keywords"
    | "questions"
    | "monitoring"
    | "optimization-report"
    | "response-logic"
    | "content-assets";
  label: string;
  accept: string;
};

type BusinessModuleImportIssue =
  | string
  | {
      level?: string;
      severity?: string;
      message?: string;
      sheet?: string;
      row?: number;
    };

type BusinessModuleImportPreview = {
  sourceName?: string;
  fileHash?: string;
  preflightToken?: string;
  preflightExpiresAt?: string;
  preflightTargetBatchKey?: string;
  targetBatchRequired?: boolean;
  suggestedBatchKey?: string;
  availableBatches?: Array<{
    batchKey?: string;
    sourceName?: string;
    collectedAt?: string | number;
    sampleCount?: number;
  }>;
  mode?: string;
  sampleCount?: number;
  citationCount?: number;
  questions?: Array<
    string | { id?: string; label?: string; question?: string }
  >;
  models?: Array<
    string | { key?: string; value?: string; label?: string; name?: string }
  >;
  dates?: string[];
  summary?: string[];
  recordStats?: Array<{
    label?: string;
    beforeCount?: number;
    afterCount?: number;
    added?: number;
    updated?: number;
    removed?: number;
    unchanged?: number;
  }>;
  issues?: BusinessModuleImportIssue[];
};

type PendingBusinessModuleImport = {
  definition: BusinessModuleImportDefinition;
  file: File;
  preview: BusinessModuleImportPreview;
  targetBatchKey: string;
};

const TICKET_MODULE_IMPORTS: Record<string, BusinessModuleImportDefinition[]> =
  {
    question_catalog: [
      {
        module: "keywords",
        label: "上传品牌词库",
        accept:
          ".xlsx,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/json",
      },
    ],
    initial_monitoring: [
      {
        module: "monitoring",
        label: "预检并发布监控数据",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    monitoring_import: [
      {
        module: "monitoring",
        label: "预检并发布监控数据",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    monitoring_retest: [
      {
        module: "monitoring",
        label: "上传复测结果",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    stage_report: [
      {
        module: "optimization-report",
        label: "上传阶段报告",
        accept: ".json,application/json",
      },
    ],
    response_logic: [
      {
        module: "response-logic",
        label: "上传应答逻辑",
        accept: ".json,application/json",
      },
    ],
    content_asset_publish: [
      {
        module: "content-assets",
        label: "上传内容资产",
        accept: ".json,application/json",
      },
    ],
  };

function businessModulePreflightUsable(preview: BusinessModuleImportPreview) {
  if (!preview.fileHash?.trim() || !preview.preflightToken?.trim())
    return false;
  if (!preview.preflightExpiresAt) return true;
  const expiresAt = Date.parse(preview.preflightExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 5_000;
}

function businessModulePreviewHasErrors(preview: BusinessModuleImportPreview) {
  return (
    preview.mode === "invalid" ||
    preview.issues?.some(
      (issue) =>
        typeof issue !== "string" &&
        (issue.level === "error" || issue.severity === "error"),
    ) === true
  );
}

function businessModuleIssueText(issue: BusinessModuleImportIssue) {
  if (typeof issue === "string") return issue;
  const location = [
    issue.sheet?.trim(),
    Number.isFinite(issue.row) ? `第 ${issue.row} 行` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [location, issue.message?.trim()].filter(Boolean).join("：");
}

function businessModuleValueText(
  value:
    | string
    | {
        id?: string;
        key?: string;
        value?: string;
        label?: string;
        name?: string;
        question?: string;
      },
) {
  if (typeof value === "string") return value;
  return (
    value.label ||
    value.name ||
    value.question ||
    value.value ||
    value.id ||
    value.key ||
    "未命名"
  );
}

function businessModuleBatchLabel(
  batch: NonNullable<BusinessModuleImportPreview["availableBatches"]>[number],
) {
  const timestamp = batch.collectedAt
    ? new Date(batch.collectedAt).getTime()
    : Number.NaN;
  const date = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(timestamp)
    : "";
  return [
    date,
    batch.sourceName,
    Number.isFinite(batch.sampleCount) ? `${batch.sampleCount} 条答案` : "",
    batch.batchKey,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function DeliveryMemberDashboard({
  systemAdminMode = false,
}: {
  /** Kept so the legacy /delivery/workbench route can render this same view. */
  customerWorkbench?: boolean;
  /** Lets a system administrator use the full role-owned ticket workbench. */
  systemAdminMode?: boolean;
}) {
  return <CustomerWorkbenchView systemAdminMode={systemAdminMode} />;
}

function QuestionQuotaEditor({
  projectAssignmentId,
  quota,
  systemAdminMode,
  onSaved,
}: {
  projectAssignmentId: string;
  quota: WorkbenchQuestionQuota;
  systemAdminMode: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const adjustQuestionQuota =
    trpc.delivery.mine.adjustQuestionQuota.useMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<QuestionQuotaDraft>(() =>
    questionQuotaDraft(quota.limits),
  );
  const [reason, setReason] = useState("");

  useEffect(() => {
    setDraft(questionQuotaDraft(quota.limits));
    setReason("");
    setEditing(false);
  }, [
    quota.limits.competitorComparisonLimit,
    quota.limits.industryLimit,
    quota.limits.productScenarioLimit,
    quota.limits.reputationLimit,
    quota.periodId,
    quota.revision,
  ]);

  const validation = useMemo(() => {
    const values = {} as Record<QuestionQuotaLimitKey, number>;
    for (const field of QUESTION_QUOTA_FIELDS) {
      const raw = draft[field.limitKey].trim();
      const value = Number(raw);
      const minimum = quota.reservedUsage[field.usageKey];
      const maximum = quota.progressiveUnlock
        ? (quota.unlockedLimits?.[field.limitKey] ??
          quota.limits[field.limitKey])
        : QUESTION_QUOTA_CATEGORY_MAX;
      if (!raw || !Number.isInteger(value)) {
        return { message: `${field.label}额度必须是整数`, values: null };
      }
      if (value < minimum) {
        return {
          message: `${field.label}额度不能低于已确认与待审核预留数量 ${minimum}`,
          values: null,
        };
      }
      if (value > maximum) {
        return {
          message: `${field.label}额度不能超过当前已解锁上限 ${maximum}`,
          values: null,
        };
      }
      if (value > QUESTION_QUOTA_CATEGORY_MAX) {
        return {
          message: `${field.label}额度不能超过 ${QUESTION_QUOTA_CATEGORY_MAX}`,
          values: null,
        };
      }
      values[field.limitKey] = value;
    }
    return { message: "", values };
  }, [
    draft,
    quota.limits,
    quota.progressiveUnlock,
    quota.reservedUsage,
    quota.unlockedLimits,
  ]);

  const resetDraft = () => {
    setDraft(questionQuotaDraft(quota.limits));
    setReason("");
    setEditing(false);
  };
  const formMessage =
    validation.message ||
    (reason.trim().length < 2 ? "请填写至少 2 个字的调整原因" : "");

  return (
    <Card className="mt-5" data-testid="question-quota-editor">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle>客户问题额度</CardTitle>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {quota.progressiveUnlock
              ? `豪华版按季度自动解锁，当前第 ${quota.unlockStage?.current ?? 1}/${quota.unlockStage?.total ?? 4} 档；可下调但不能超过当前已解锁上限。`
              : "当前额度按四类问题分别管理；已确认与待审核预留中的问题不会因下调额度而被挤出。"}
          </p>
          {quota.progressiveUnlock && quota.nextUnlockAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              下一档将于{" "}
              {new Date(quota.nextUnlockAt).toLocaleDateString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}{" "}
              自动解锁。
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={editing ? "ghost" : "outline"}
          disabled={adjustQuestionQuota.isPending}
          onClick={() => {
            if (editing) {
              resetDraft();
            } else {
              setDraft(questionQuotaDraft(quota.limits));
              setEditing(true);
            }
          }}
        >
          {editing ? "取消修改" : "修改额度"}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {QUESTION_QUOTA_FIELDS.map((field) => {
            const selected = quota.selectedUsage[field.usageKey];
            const reserved = quota.reservedUsage[field.usageKey];
            const pending = Math.max(0, reserved - selected);
            const maximum = quota.progressiveUnlock
              ? (quota.unlockedLimits?.[field.limitKey] ??
                quota.limits[field.limitKey])
              : QUESTION_QUOTA_CATEGORY_MAX;
            return (
              <div
                key={field.limitKey}
                data-category={field.category}
                className="fm-question-category-surface rounded-xl border p-4"
              >
                <label
                  className="fm-question-category-ink text-sm font-medium"
                  htmlFor={`question-quota-${field.limitKey}`}
                >
                  {field.label}
                </label>
                {editing ? (
                  <Input
                    id={`question-quota-${field.limitKey}`}
                    className="mt-3"
                    type="number"
                    inputMode="numeric"
                    min={reserved}
                    max={maximum}
                    step={1}
                    value={draft[field.limitKey]}
                    aria-label={`${field.label}额度`}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [field.limitKey]: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <p className="fm-question-category-ink mt-2 text-2xl font-semibold tabular-nums">
                    {quota.limits[field.limitKey]}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      个问题
                    </span>
                  </p>
                )}
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  已确认 {selected} · 待审核预留 {pending}
                </p>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-xl bg-muted/35 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            当前周期总额度 {quota.limits.totalQuestionLimit}，已占用及预留{" "}
            {quota.reservedUsage.total}，剩余 {quota.remaining.total}
          </span>
          <span>
            有效期至 {new Date(quota.validUntil).toLocaleDateString("zh-CN")}
          </span>
        </div>

        {editing && (
          <div className="mt-4 space-y-3">
            <div>
              <label
                className="text-sm font-medium"
                htmlFor="question-quota-reason"
              >
                调整原因
              </label>
              <Input
                id="question-quota-reason"
                className="mt-2"
                value={reason}
                maxLength={2_000}
                placeholder={
                  systemAdminMode
                    ? "例如：根据客户本期补充需求调整"
                    : "例如：根据客户确认的本期需求调整"
                }
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p
                className={`text-xs ${formMessage ? "text-destructive" : "text-muted-foreground"}`}
                role={formMessage ? "alert" : undefined}
              >
                {formMessage ||
                  (quota.progressiveUnlock
                    ? "保存后立即用于当前客户；系统会继续按权益周期自动解锁后续额度。"
                    : `每类最多 ${QUESTION_QUOTA_CATEGORY_MAX} 个问题，保存后立即用于当前客户本周期。`)}
              </p>
              <Button
                type="button"
                className="shrink-0"
                disabled={adjustQuestionQuota.isPending || Boolean(formMessage)}
                onClick={async () => {
                  if (!validation.values || formMessage) return;
                  try {
                    await adjustQuestionQuota.mutateAsync({
                      projectAssignmentId,
                      quotaPeriodId: quota.periodId,
                      expectedRevision: quota.revision,
                      ...validation.values,
                      reason: reason.trim(),
                    });
                    await onSaved();
                    setReason("");
                    setEditing(false);
                    toast.success("客户问题额度已更新");
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "客户问题额度更新失败",
                    );
                  }
                }}
              >
                {adjustQuestionQuota.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                保存额度
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BrandTrackingUsageEditor({
  projectAssignmentId,
  usage,
  onSaved,
}: {
  projectAssignmentId: string;
  usage: WorkbenchBrandTrackingUsage;
  onSaved: () => Promise<unknown>;
}) {
  const updateLimit = trpc.delivery.mine.updateBrandTrackingLimit.useMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    brandTrackingAmountToCredits(usage.limit) ?? "",
  );

  useEffect(() => {
    setDraft(brandTrackingAmountToCredits(usage.limit) ?? "");
    setEditing(false);
  }, [usage.limit, usage.windowStartedAt]);

  const trimmed = draft.trim();
  const invalid = !BRAND_TRACKING_CREDITS_INPUT_PATTERN.test(trimmed);

  return (
    <section className="page-shell">
      <Card data-testid="brand-tracking-usage-editor">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>品牌追踪积分</CardTitle>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              仅展示该海外客户由 FrontMind
              明确归因的品牌追踪积分消耗；不提供对话内容或凭据配置能力。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={editing ? "ghost" : "outline"}
            disabled={updateLimit.isPending}
            onClick={() => {
              if (editing) {
                setDraft(brandTrackingAmountToCredits(usage.limit) ?? "");
                setEditing(false);
              } else {
                setEditing(true);
              }
            }}
          >
            {editing ? "取消修改" : "修改额度"}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天已使用</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {formatBrandTrackingCredits(usage.rolling30DayCost)}
              </p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天上限</p>
              {editing ? (
                <Input
                  className="mt-3"
                  aria-label="品牌追踪滚动 30 天积分上限"
                  type="text"
                  inputMode="decimal"
                  value={draft}
                  placeholder="例如 10000"
                  onChange={(event) => setDraft(event.target.value)}
                />
              ) : (
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {formatBrandTrackingCredits(usage.limit)}
                </p>
              )}
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天剩余</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {formatBrandTrackingCredits(usage.remaining)}
              </p>
            </div>
          </div>

          {(usage.blocked || usage.hasUnknownUsage) && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {usage.hasUnknownUsage
                ? `有 ${usage.pendingReconciliationCount} 笔积分记录待确认，未知积分不会按 0 积分处理。`
                : usage.blockReason ||
                  `当前已超出上限 ${formatBrandTrackingCredits(usage.exceededBy)}，新的消息已暂停。`}
            </div>
          )}

          {editing && (
            <div className="mt-4 flex flex-col gap-3 rounded-xl bg-muted/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p
                className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
                role={invalid ? "alert" : undefined}
              >
                {invalid
                  ? "积分上限必须是非负数，最多 15 位整数和 5 位小数。"
                  : "设置为 0 积分可暂停新的品牌追踪；保存后立即按滚动 30 天用量判断。"}
              </p>
              <Button
                type="button"
                className="shrink-0"
                disabled={updateLimit.isPending || invalid}
                onClick={async () => {
                  if (invalid) return;
                  try {
                    await updateLimit.mutateAsync({
                      projectAssignmentId,
                      limitCredits: trimmed,
                    });
                    await onSaved();
                    setEditing(false);
                    toast.success("品牌追踪积分上限已更新");
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "品牌追踪积分上限更新失败",
                    );
                  }
                }}
              >
                {updateLimit.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                保存积分上限
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function CustomerWorkbenchView({
  systemAdminMode = false,
}: {
  systemAdminMode?: boolean;
}) {
  const workbenchRequest = useMemo(readDeliveryWorkbenchRequest, []);
  const assignmentsQuery = trpc.delivery.mine.assignments.useQuery();
  const [dashboardOpen, setDashboardOpen] = useState(workbenchRequest.focus);
  const [dashboardInitialSection, setDashboardInitialSection] =
    useState<CustomerDashboardMirrorSection | null>(
      (workbenchRequest.section as CustomerDashboardMirrorSection) || null,
    );
  const [dashboardTicketId, setDashboardTicketId] = useState<string | null>(
    workbenchRequest.ticketId || null,
  );
  const [statusGroup, setStatusGroup] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [projectAssignmentId, setProjectAssignmentId] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      workbenchRequest.projectAssignmentId ||
      sessionStorage.getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY) ||
      ""
    );
  });
  const [questionCategorySelections, setQuestionCategorySelections] = useState<
    Record<string, QuestionCategory | "">
  >({});
  const currentAssignment = assignmentsQuery.data?.find(
    (assignment) => assignment.projectAssignmentId === projectAssignmentId,
  );
  const currentAllowedSections = currentAssignment
    ? deliveryDashboardSectionsForAssignment(
        currentAssignment.roleType,
        currentAssignment.marketEdition,
      )
    : [];
  useEffect(() => {
    if (!assignmentsQuery.data) return;
    if (!assignmentsQuery.data.length) {
      sessionStorage.removeItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY);
      setProjectAssignmentId("");
      return;
    }
    if (
      !assignmentsQuery.data.some(
        (assignment) => assignment.projectAssignmentId === projectAssignmentId,
      )
    ) {
      const nextProjectAssignmentId =
        assignmentsQuery.data[0]!.projectAssignmentId;
      sessionStorage.setItem(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
        nextProjectAssignmentId,
      );
      setProjectAssignmentId(nextProjectAssignmentId);
      return;
    }
    sessionStorage.setItem(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      projectAssignmentId,
    );
  }, [assignmentsQuery.data, projectAssignmentId]);
  useEffect(() => {
    setQuestionCategorySelections({});
  }, [projectAssignmentId]);
  const workbench = trpc.delivery.mine.workbench.useQuery(
    { projectAssignmentId },
    { enabled: Boolean(currentAssignment) },
  );
  const customerTickets = trpc.delivery.mine.tickets.useInfiniteQuery(
    {
      customerUserId: currentAssignment?.customerUserId ?? 1,
      projectAssignmentId: currentAssignment?.projectAssignmentId,
      ...(statusGroup
        ? { statusGroup: statusGroup as "pending" | "completed" }
        : {}),
      limit: 50,
    },
    {
      enabled: Boolean(currentAssignment),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );
  const customerTicketItems = useMemo(
    () =>
      (customerTickets.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter(
          (ticket) =>
            ticket.userId === currentAssignment?.customerUserId &&
            ticket.assignedProjectAssignmentId ===
              currentAssignment?.projectAssignmentId,
        ),
    [
      currentAssignment?.customerUserId,
      currentAssignment?.projectAssignmentId,
      customerTickets.data?.pages,
    ],
  );
  const pendingCustomerTickets = customerTicketItems.filter(
    (ticket) => ticket.statusGroup === "pending",
  );
  const completedCustomerTickets = customerTicketItems.filter(
    (ticket) => ticket.statusGroup === "completed",
  );
  const customerTicketSummary = customerTickets.data?.pages[0];
  const detailTicketId = selectedTicketId || dashboardTicketId;
  const ticketDetail = trpc.delivery.mine.ticketDetail.useQuery(
    {
      ticketId: detailTicketId || "00000000-0000-4000-8000-000000000000",
    },
    { enabled: Boolean(detailTicketId), retry: false },
  );
  const resetPollingTicketFromList = customerTicketItems.find(
    (ticket) => ticket.id === dashboardTicketId,
  );
  const resetPollingTicketFromDetail = ticketDetail.data?.ticket;
  const resetPollingTicket =
    resetPollingTicketFromList ||
    (resetPollingTicketFromDetail?.id === dashboardTicketId &&
    resetPollingTicketFromDetail.userId === currentAssignment?.customerUserId &&
    resetPollingTicketFromDetail.assignedProjectAssignmentId ===
      currentAssignment?.projectAssignmentId
      ? resetPollingTicketFromDetail
      : null);
  const resetAutoRefresh = Boolean(
    systemAdminMode &&
      resetPollingTicket?.operation === "site_rebuild" &&
      siteRebuildResetNeedsAutomaticRefresh(resetPollingTicket),
  );
  useEffect(() => {
    if (!resetAutoRefresh) return;
    let refreshRunning = false;
    const refreshResetState = async () => {
      if (refreshRunning) return;
      refreshRunning = true;
      try {
        await Promise.all([
          customerTickets.refetch(),
          workbench.refetch(),
          ticketDetail.refetch(),
        ]);
      } finally {
        refreshRunning = false;
      }
    };
    const interval = window.setInterval(() => {
      void refreshResetState();
    }, 3_000);
    const refreshOnFocus = () => {
      void refreshResetState();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [
    customerTickets.refetch,
    resetAutoRefresh,
    ticketDetail.refetch,
    workbench.refetch,
  ]);
  const refreshCustomerActionsAndPreview = async () => {
    await Promise.all([
      customerTickets.refetch(),
      workbench.refetch(),
      ...(detailTicketId ? [ticketDetail.refetch()] : []),
    ]);
  };
  const openCustomerDashboard = (
    operation?: string | null,
    ticketId?: string | null,
  ) => {
    if (currentAssignment) {
      const operationSection = operation
        ? WORKBENCH_SECTION_BY_OPERATION[operation as DeliveryWorkflowOperation]
        : null;
      setDashboardInitialSection(
        operationSection && currentAllowedSections.includes(operationSection)
          ? operationSection
          : currentAllowedSections[0],
      );
    }
    setDashboardTicketId(ticketId || null);
    setDashboardOpen(true);
  };
  const closeCustomerDashboard = () => {
    setDashboardOpen(false);
    setDashboardTicketId(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("ticketId");
      url.searchParams.delete("section");
      url.searchParams.delete("focus");
      window.history.replaceState({}, "", url);
    }
  };
  const approveQuestionSelection =
    trpc.delivery.mine.approveQuestionSelection.useMutation();
  const pendingCustomerQuestions = useMemo(
    () =>
      (workbench.data?.customerQuestions ?? []).filter(
        (question) =>
          question.status === "candidate" &&
          question.selectionApprovalStatus === "pending",
      ),
    [workbench.data?.customerQuestions],
  );
  const currentNav = systemAdminMode
    ? getAdminNav(true)
    : deliveryMemberNavForRole(currentAssignment?.roleType);
  const shellEyebrow = systemAdminMode
    ? "系统管理员 · 需求处理"
    : "工程师 · 客户工作台";
  const shellTitle = systemAdminMode ? "系统管理员工作台" : "客户工作台";
  const shellToolbar = systemAdminMode ? (
    <Button asChild size="sm" variant="outline">
      <a
        href={
          currentAssignment
            ? `/admin/customers/${currentAssignment.customerUserId}/workspace`
            : "/admin/workspace"
        }
      >
        <ArrowLeft className="h-4 w-4" />
        返回客户工作台
      </a>
    </Button>
  ) : undefined;
  const projectSelector = assignmentsQuery.data?.length ? (
    <select
      aria-label="当前客户"
      className="h-10 w-full rounded-md border bg-card px-3 text-sm"
      value={projectAssignmentId}
      onChange={(event) => {
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("projectAssignmentId", event.target.value);
          url.searchParams.delete("ticketId");
          url.searchParams.delete("section");
          url.searchParams.delete("focus");
          window.history.replaceState({}, "", url);
        }
        sessionStorage.setItem(
          DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
          event.target.value,
        );
        setDashboardOpen(false);
        setDashboardTicketId(null);
        setSelectedTicketId(null);
        setProjectAssignmentId(event.target.value);
      }}
    >
      {assignmentsQuery.data.map((assignment) => (
        <option
          key={assignment.projectAssignmentId}
          value={assignment.projectAssignmentId}
        >
          {assignment.customerName || assignment.customerUsername}
          {systemAdminMode
            ? ` · ${DELIVERY_ROLE_LABELS[assignment.roleType]}`
            : ""}
        </option>
      ))}
    </select>
  ) : null;

  if (assignmentsQuery.error) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <p className="mt-4 font-medium">客户项目读取失败</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {assignmentsQuery.error.message || "请检查网络连接后重试。"}
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void assignmentsQuery.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (assignmentsQuery.isLoading) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
            正在载入客户项目
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (!assignmentsQuery.isLoading && !assignmentsQuery.data?.length) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-4 font-medium">
              {systemAdminMode
                ? "当前没有可处理的客户项目"
                : "尚未分配客户项目，请联系交付管理员"}
            </p>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (currentAssignment && workbench.error) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
        roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <p className="mt-4 font-medium">项目工作台读取失败</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {workbench.error.message || "请检查网络连接后重试。"}
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void workbench.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  const dashboardMirrorPayload = workbench.data?.dashboard?.payload ?? {
    brandName:
      currentAssignment?.customerName ||
      currentAssignment?.customerUsername ||
      "当前客户",
    headline: "客户页面尚未发布内容",
    summary: "",
    metrics: [],
    sections: [],
    keywordTables: [],
    questions: [],
    monitoringAnswers: [],
    citations: [],
    contentAssets: [],
    optimizationReport: null,
    progressReports: [],
  };
  const dashboardQuestionById = new Map(
    dashboardMirrorPayload.questions.map((question) => [question.id, question]),
  );
  const dashboardQuestionsByText = new Map<
    string,
    (typeof dashboardMirrorPayload.questions)[number][]
  >();
  for (const question of dashboardMirrorPayload.questions) {
    const identity = normalizeMirrorQuestionText(question.question);
    dashboardQuestionsByText.set(identity, [
      ...(dashboardQuestionsByText.get(identity) ?? []),
      question,
    ]);
  }
  const authoritativeQuestionRows = (
    workbench.data?.customerQuestions ?? []
  ).filter(
    (question) =>
      question.status === "selected" &&
      question.selectionApprovalStatus === "approved" &&
      Boolean(question.category),
  );
  const authoritativeIdsByText = new Map<string, string[]>();
  for (const question of authoritativeQuestionRows) {
    const identity = normalizeMirrorQuestionText(question.question);
    authoritativeIdsByText.set(identity, [
      ...(authoritativeIdsByText.get(identity) ?? []),
      question.id,
    ]);
  }
  const legacyQuestionIdentities = new Map<string, Set<string>>();
  const authoritativeQuestions = authoritativeQuestionRows.flatMap(
    (question) => {
      const category = question.category as QuestionCategory;
      const group = QUESTION_MIRROR_GROUPS[category];
      if (!group) return [];
      const normalizedText = normalizeMirrorQuestionText(question.question);
      const uniqueTextMatch =
        authoritativeIdsByText.get(normalizedText)?.length === 1 &&
        dashboardQuestionsByText.get(normalizedText)?.length === 1
          ? dashboardQuestionsByText.get(normalizedText)?.[0]
          : undefined;
      const published =
        [
          dashboardQuestionById.get(question.id),
          question.sourceQuestionId
            ? dashboardQuestionById.get(question.sourceQuestionId)
            : undefined,
          question.externalQuestionId
            ? dashboardQuestionById.get(question.externalQuestionId)
            : undefined,
        ].find(
          (candidate) =>
            candidate &&
            normalizeMirrorQuestionText(candidate.question) === normalizedText,
        ) || uniqueTextMatch;
      registerMirrorQuestionIdentity(
        legacyQuestionIdentities,
        published?.id,
        question.id,
      );
      return [
        {
          id: question.id,
          ...group,
          question: question.question,
          intent: question.intent || published?.intent || "",
          summary: question.rationale || published?.summary || "",
        },
      ];
    },
  );
  const currentQuestionIdByLegacyId = new Map(
    [...legacyQuestionIdentities.entries()].flatMap(([legacyId, currentIds]) =>
      currentIds.size === 1 ? [[legacyId, [...currentIds][0]!] as const] : [],
    ),
  );
  const authoritativeMonitoringAnswers =
    dashboardMirrorPayload.monitoringAnswers.flatMap((answer) => {
      const currentQuestionId = currentQuestionIdByLegacyId.get(
        answer.questionId,
      );
      return currentQuestionId
        ? [{ ...answer, questionId: currentQuestionId }]
        : [];
    });
  const authoritativeQuestionTextById = new Map(
    authoritativeQuestionRows.map((question) => [
      question.id,
      normalizeMirrorQuestionText(question.question),
    ]),
  );
  const authoritativeResponseLogicRecords = (
    workbench.data?.responseLogicRecords ?? []
  ).filter(
    (record) =>
      authoritativeQuestionTextById.get(record.questionId) ===
      normalizeMirrorQuestionText(record.question),
  );
  const customerMirrorPayload = {
    ...dashboardMirrorPayload,
    ...(currentAssignment?.roleType === "monitoring_optimization_engineer"
      ? {
          questions: authoritativeQuestions,
          monitoringAnswers: authoritativeMonitoringAnswers,
        }
      : {}),
  };
  const deliveryCompletionOptions: DeliveryCompletionOptions = {
    monitoringBatches: workbench.data?.monitoringBatches ?? [],
    approvedQuestions: authoritativeQuestionRows.map((question) => ({
      id: question.id,
      question: question.question,
      category: question.category,
    })),
    keywordCatalogPublished: dashboardMirrorPayload.keywordTables.length > 0,
  };
  const focusedTicketFromList = customerTicketItems.find(
    (ticket) => ticket.id === dashboardTicketId,
  );
  const detailTicket = ticketDetail.data?.ticket;
  const detailTicketMatchesCurrentAssignment = Boolean(
    detailTicket?.id === dashboardTicketId &&
      detailTicket.userId === currentAssignment?.customerUserId &&
      detailTicket.assignedProjectAssignmentId ===
        currentAssignment?.projectAssignmentId,
  );
  const focusedTicket =
    focusedTicketFromList ||
    (detailTicketMatchesCurrentAssignment ? detailTicket : null);
  const focusedTicketMismatch = Boolean(
    dashboardTicketId &&
      !focusedTicketFromList &&
      detailTicket &&
      !detailTicketMatchesCurrentAssignment,
  );
  const focusedDependencyBlockReason =
    focusedTicket && "dependencyBlockReason" in focusedTicket
      ? focusedTicket.dependencyBlockReason
      : null;
  const requestedSection =
    dashboardInitialSection ||
    (workbenchRequest.section as CustomerDashboardMirrorSection);
  const initialMirrorSection =
    currentAssignment && currentAllowedSections.includes(requestedSection)
      ? requestedSection
      : currentAssignment
        ? currentAllowedSections[0]
        : "home";
  const focusedTicketWorkspace =
    currentAssignment && focusedTicket ? (
      <Card
        data-testid="focused-customer-demand"
        className="mb-5 border-red-400 bg-red-50/70"
      >
        <CardHeader>
          <CardTitle>
            {deliveryTicketPresentationTitle(focusedTicket)}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {focusedTicket.operation === "site_rebuild"
              ? focusedSiteRebuildStatus(focusedTicket)
              : "当前需求状态：待处理。请在本客户看板内完成处理。"}
          </p>
        </CardHeader>
        <CardContent>
          {focusedTicket.operation === "knowledge_reset" &&
            focusedTicket.status === "submitted" &&
            focusedTicket.clientRequestId && (
              <KnowledgeResetDecision
                projectAssignmentId={currentAssignment.projectAssignmentId}
                requestId={focusedTicket.clientRequestId}
                systemAdminMode={systemAdminMode}
                onDone={refreshCustomerActionsAndPreview}
              />
            )}
          {focusedTicket.operation === "question_maintenance" &&
            focusedTicket.status === "submitted" && (
              <QuestionMaintenanceDecision
                projectAssignmentId={currentAssignment.projectAssignmentId}
                ticket={focusedTicket}
                systemAdminMode={systemAdminMode}
                onDone={refreshCustomerActionsAndPreview}
              />
            )}
          {focusedTicket.operation !== "knowledge_reset" &&
            focusedTicket.operation !== "question_maintenance" &&
            !focusedDependencyBlockReason && (
              <DeliveryTicketActions
                projectAssignmentId={currentAssignment.projectAssignmentId}
                ticket={focusedTicket}
                completionOptions={deliveryCompletionOptions}
                onDone={refreshCustomerActionsAndPreview}
                onOpenCustomerDashboard={() =>
                  openCustomerDashboard(
                    focusedTicket.operation,
                    focusedTicket.id,
                  )
                }
              />
            )}
          {focusedDependencyBlockReason && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              <strong>等待前置需求</strong>
              <p className="mt-0.5">{focusedDependencyBlockReason}</p>
            </div>
          )}
        </CardContent>
      </Card>
    ) : focusedTicketMismatch ? (
      <Card className="mb-5 border-amber-300/60 bg-amber-50">
        <CardContent className="py-8 text-center text-sm text-amber-900">
          当前需求不属于所选客户岗位，请返回客户工作台重新选择。
        </CardContent>
      </Card>
    ) : dashboardTicketId && ticketDetail.isLoading ? (
      <Card className="mb-5">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
          正在读取当前需求…
        </CardContent>
      </Card>
    ) : dashboardTicketId && ticketDetail.error ? (
      <Card className="mb-5 border-destructive/30">
        <CardContent className="py-8 text-center text-sm text-destructive">
          {ticketDetail.error.message || "当前需求暂时无法读取。"}
        </CardContent>
      </Card>
    ) : null;

  if (dashboardOpen && currentAssignment) {
    return (
      <PortalShell
        mode="fullscreen"
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
      >
        <CustomerDashboardMirror
          layout="workspace"
          payload={customerMirrorPayload}
          websiteWorkspace={
            workbench.data?.aiOperationsPreview?.websiteWorkspace
          }
          knowledgePreview={
            workbench.data?.aiOperationsPreview
              ? {
                  progress:
                    workbench.data.aiOperationsPreview.knowledgeProgress,
                  snapshot:
                    workbench.data.aiOperationsPreview.knowledgeSnapshot,
                }
              : null
          }
          allowedSections={currentAllowedSections}
          initialSection={initialMirrorSection}
          responseLogicRecords={
            currentAssignment.roleType === "monitoring_optimization_engineer"
              ? authoritativeResponseLogicRecords
              : undefined
          }
          heading="客户看板"
          statusLabel={
            workbench.data?.dashboard
              ? `R${workbench.data.dashboard.revision}`
              : undefined
          }
          editActions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={closeCustomerDashboard}
            >
              <ArrowLeft className="h-4 w-4" />
              返回客户工作台
            </Button>
          }
          renderSectionWorkspace={(section) => {
            if (
              section === "brand-tracking" &&
              workbench.data?.brandTrackingUsage
            ) {
              return (
                <BrandTrackingUsageEditor
                  projectAssignmentId={currentAssignment.projectAssignmentId}
                  usage={workbench.data.brandTrackingUsage}
                  onSaved={() => workbench.refetch()}
                />
              );
            }
            return dashboardTicketId && section === initialMirrorSection
              ? focusedTicketWorkspace
              : null;
          }}
        />
      </PortalShell>
    );
  }

  return (
    <PortalShell
      eyebrow={shellEyebrow}
      title={shellTitle}
      navItems={currentNav}
      toolbar={shellToolbar}
      roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
    >
      <div className="grid gap-5">
        <Card data-testid="current-delivery-target">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <span className="shrink-0 text-sm font-semibold">当前客户</span>
            <div className="min-w-0 flex-1">{projectSelector}</div>
            <Button
              type="button"
              className={`${CUSTOMER_DASHBOARD_BUTTON_CLASS} shrink-0`}
              onClick={() => openCustomerDashboard()}
            >
              进入客户看板
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {currentAssignment?.roleType === "monitoring_optimization_engineer" &&
        workbench.data?.questionQuota && (
          <QuestionQuotaEditor
            projectAssignmentId={currentAssignment.projectAssignmentId}
            quota={workbench.data.questionQuota}
            systemAdminMode={systemAdminMode}
            onSaved={() => workbench.refetch()}
          />
        )}

      {currentAssignment && (
        <Card
          id="customer-content-actions"
          data-testid="customer-content-actions"
          className="mt-5 scroll-mt-5"
        >
          <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between sm:space-y-0">
            <div>
              <CardTitle>客户需求</CardTitle>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-red-600">
                  待处理 {customerTicketSummary?.counts.pending ?? 0}
                </span>
                <span>
                  已完成 {customerTicketSummary?.counts.completed ?? 0}
                </span>
              </div>
            </div>
            <select
              aria-label="按状态筛选"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={statusGroup}
              onChange={(event) => setStatusGroup(event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="pending">待处理</option>
              <option value="completed">已完成</option>
            </select>
          </CardHeader>
          <CardContent className="space-y-3">
            {customerTickets.isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />
                正在载入客户需求
              </div>
            ) : customerTickets.error ? (
              <div className="py-10 text-center">
                <AlertTriangle className="mx-auto h-6 w-6 text-destructive" />
                <p className="mt-3 text-sm font-medium">需求读取失败</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {customerTickets.error.message}
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => void customerTickets.refetch()}
                >
                  <RefreshCw className="h-4 w-4" />
                  重试
                </Button>
              </div>
            ) : customerTicketItems.length ? (
              <>
                {pendingCustomerTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    data-testid="customer-content-action"
                    data-pending-ticket="true"
                    className="rounded-xl border border-red-500 bg-red-50/80 p-4 ring-2 ring-red-500/25"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {deliveryTicketPresentationTitle(ticket)}
                        </p>
                        {operationLabel(ticket.operation) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {operationLabel(ticket.operation)}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Badge variant="destructive">
                          {deliveryTicketStatusLabel(ticket.status, "internal")}
                        </Badge>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={CUSTOMER_DASHBOARD_BUTTON_CLASS}
                          onClick={() =>
                            openCustomerDashboard(ticket.operation, ticket.id)
                          }
                        >
                          进入客户看板
                          <PanelRightOpen className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {ticket.operation === "knowledge_reset" &&
                      ticket.status === "submitted" &&
                      ticket.clientRequestId && (
                        <KnowledgeResetDecision
                          projectAssignmentId={
                            currentAssignment.projectAssignmentId
                          }
                          requestId={ticket.clientRequestId}
                          systemAdminMode={systemAdminMode}
                          onDone={refreshCustomerActionsAndPreview}
                        />
                      )}
                    {ticket.operation === "question_maintenance" &&
                      ticket.status === "submitted" && (
                        <QuestionMaintenanceDecision
                          projectAssignmentId={
                            currentAssignment.projectAssignmentId
                          }
                          ticket={ticket}
                          systemAdminMode={systemAdminMode}
                          onDone={refreshCustomerActionsAndPreview}
                        />
                      )}
                    {ticket.operation !== "knowledge_reset" &&
                      ticket.operation !== "question_maintenance" &&
                      !ticket.dependencyBlockReason && (
                        <DeliveryTicketActions
                          projectAssignmentId={
                            currentAssignment.projectAssignmentId
                          }
                          ticket={ticket}
                          completionOptions={deliveryCompletionOptions}
                          onDone={refreshCustomerActionsAndPreview}
                          onOpenCustomerDashboard={() =>
                            openCustomerDashboard(ticket.operation, ticket.id)
                          }
                        />
                      )}
                    {ticket.dependencyBlockReason && (
                      <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                        <strong>等待前置需求</strong>
                        <p className="mt-0.5">{ticket.dependencyBlockReason}</p>
                      </div>
                    )}
                  </div>
                ))}

                {completedCustomerTickets.length > 0 && (
                  <div className="pt-4">
                    <p className="mb-3 text-sm font-semibold">已完成需求</p>
                    <div className="space-y-3">
                      {completedCustomerTickets.map((ticket) => (
                        <button
                          key={ticket.id}
                          type="button"
                          className="w-full rounded-xl border p-4 text-left transition hover:border-primary/40 hover:bg-muted/30"
                          onClick={() => setSelectedTicketId(ticket.id)}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">
                                {deliveryTicketPresentationTitle(ticket)}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {operationLabel(ticket.operation) || "交付任务"}
                              </p>
                            </div>
                            <Badge variant="outline">
                              {deliveryTicketStatusLabel(
                                ticket.status,
                                "internal",
                              )}
                            </Badge>
                          </div>
                          <p className="mt-3 text-xs text-muted-foreground">
                            {displayTaskDate(
                              ticket.resolvedAt || ticket.updatedAt,
                            )}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {customerTickets.hasNextPage && (
                  <div className="pt-2 text-center">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={customerTickets.isFetchingNextPage}
                      onClick={() => void customerTickets.fetchNextPage()}
                    >
                      {customerTickets.isFetchingNextPage && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      加载更多需求
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <CheckCircle2 className="mx-auto mb-3 h-6 w-6" />
                当前筛选条件下暂无需求
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {currentAssignment?.roleType === "monitoring_optimization_engineer" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>客户问题审核</CardTitle>
            <p className="text-sm text-muted-foreground">
              客户提交选择后在这里确认；“配置品牌词库”需求处于执行中、已完成或存在可复用里程碑时可以通过。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingCustomerQuestions.map((question) => {
              const existingCategory = QUESTION_QUOTA_FIELDS.find(
                (field) => field.category === question.category,
              );
              const selectedCategory =
                questionCategorySelections[question.id] || "";
              const quota = workbench.data?.questionQuota as
                | WorkbenchQuestionQuota
                | null
                | undefined;
              const unavailableCategories = QUESTION_QUOTA_FIELDS.filter(
                (field) => !quota || quota.remaining[field.usageKey] <= 0,
              );
              const selectedCategoryUnavailable = Boolean(
                selectedCategory &&
                  unavailableCategories.some(
                    (field) => field.category === selectedCategory,
                  ),
              );
              const needsCategory = !existingCategory;

              return (
                <div
                  key={question.id}
                  className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {needsCategory ? (
                        <Badge variant="outline">问题来源：自主填写</Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          data-category={
                            keywordCategoryKey(existingCategory.category) ||
                            undefined
                          }
                          className="fm-question-category-pill"
                        >
                          {existingCategory.label}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        客户已提交审核
                      </span>
                    </div>
                    <p className="mt-2 font-medium leading-6">
                      {question.question}
                    </p>
                    {question.intent && (
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {question.intent}
                      </p>
                    )}
                    {needsCategory && (
                      <div className="mt-3 max-w-sm">
                        <label
                          className="text-xs font-medium text-foreground"
                          htmlFor={`question-review-category-${question.id}`}
                        >
                          问题类型
                        </label>
                        <select
                          id={`question-review-category-${question.id}`}
                          aria-label={`“${question.question}”的问题类型`}
                          className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
                          value={selectedCategory}
                          disabled={!quota}
                          onChange={(event) =>
                            setQuestionCategorySelections((current) => ({
                              ...current,
                              [question.id]: event.target
                                .value as QuestionCategory,
                            }))
                          }
                        >
                          <option value="">请选择问题类型</option>
                          {QUESTION_QUOTA_FIELDS.map((field) => {
                            const unavailable = unavailableCategories.some(
                              (item) => item.category === field.category,
                            );
                            return (
                              <option
                                key={field.category}
                                value={field.category}
                                disabled={unavailable}
                              >
                                {field.label}
                                {unavailable
                                  ? quota
                                    ? "（额度已满）"
                                    : "（额度待同步）"
                                  : ""}
                              </option>
                            );
                          })}
                        </select>
                        <p
                          className="mt-2 text-xs leading-5 text-muted-foreground"
                          role="status"
                        >
                          {!quota
                            ? "问题额度尚未同步，暂不能审核。"
                            : unavailableCategories.length > 0
                              ? `${unavailableCategories
                                  .map((field) => field.label)
                                  .join(
                                    "、",
                                  )}额度已满，请选择仍有额度的问题类型。`
                              : "请选择问题类型后再审核。"}
                        </p>
                      </div>
                    )}
                  </div>
                  <Button
                    className="shrink-0"
                    disabled={
                      approveQuestionSelection.isPending ||
                      (needsCategory &&
                        (!selectedCategory || selectedCategoryUnavailable))
                    }
                    onClick={async () => {
                      if (needsCategory && !selectedCategory) return;
                      try {
                        await approveQuestionSelection.mutateAsync({
                          projectAssignmentId,
                          questionId: question.id,
                          expectedRevision: question.revision,
                          ...(needsCategory
                            ? { category: selectedCategory as QuestionCategory }
                            : {}),
                        });
                        setQuestionCategorySelections((current) => ({
                          ...current,
                          [question.id]: "",
                        }));
                        await refreshCustomerActionsAndPreview();
                        toast.success("客户问题已审核通过");
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "问题审核失败",
                        );
                      }
                    }}
                  >
                    {approveQuestionSelection.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    审核通过
                  </Button>
                </div>
              );
            })}
            {!pendingCustomerQuestions.length && (
              <p className="py-7 text-center text-sm text-muted-foreground">
                暂无客户提交的待审核问题
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <DeliveryHistoryDetailDialog
        open={Boolean(selectedTicketId)}
        onOpenChange={(open) => {
          if (!open) setSelectedTicketId(null);
        }}
        detail={selectedTicketId ? ticketDetail.data : null}
        loading={Boolean(selectedTicketId) && ticketDetail.isLoading}
        error={selectedTicketId ? ticketDetail.error?.message : undefined}
        onOpenCustomerDashboard={() => {
          const historyTicket = ticketDetail.data?.ticket;
          setSelectedTicketId(null);
          openCustomerDashboard(
            historyTicket?.operation,
            historyTicket?.id || null,
          );
        }}
      />
    </PortalShell>
  );
}

function operationLabel(value: string | null | undefined) {
  return value ? deliveryOperationPresentationLabel(value) : "";
}

function displayTaskDate(value: number | Date | null | undefined) {
  if (!value) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function DeliveryHistoryDetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  onOpenCustomerDashboard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: any;
  loading: boolean;
  error?: string;
  onOpenCustomerDashboard?: () => void;
}) {
  const [downloadError, setDownloadError] = useState("");
  const downloadAttachment = async (attachment: any) => {
    setDownloadError("");
    try {
      const projectAssignmentId = detail?.ticket?.assignedProjectAssignmentId;
      const response = await fetch(attachment.downloadUrl, {
        credentials: "include",
        headers: projectAssignmentId
          ? { "x-delivery-project-assignment-id": projectAssignmentId }
          : undefined,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || "附件下载失败");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadFailure) {
      setDownloadError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "附件下载失败",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {detail?.ticket
              ? deliveryTicketPresentationTitle(detail.ticket)
              : "任务详情"}
          </DialogTitle>
          <DialogDescription>
            {detail?.customer
              ? `${detail.customer.name}${
                  detail.customer.username
                    ? ` · @${detail.customer.username}`
                    : ""
                }`
              : "查看任务处理记录"}
          </DialogDescription>
        </DialogHeader>
        {detail && onOpenCustomerDashboard && (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={CUSTOMER_DASHBOARD_BUTTON_CLASS}
              onClick={() => {
                onOpenChange(false);
                onOpenCustomerDashboard();
              }}
            >
              进入客户看板
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </div>
        )}
        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
            正在载入任务详情
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-destructive">
            {error}
          </div>
        ) : detail ? (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">处理状态</p>
                <p className="mt-1 font-medium">
                  {deliveryTicketStatusLabel(detail.ticket.status, "internal")}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">完成时间</p>
                <p className="mt-1 font-medium">
                  {displayTaskDate(
                    detail.ticket.resolvedAt || detail.ticket.updatedAt,
                  )}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">申请内容</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {deliveryTicketDisplayDescription(detail.ticket) ||
                    "未填写补充说明"}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">处理结论</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {detail.ticket.publicSummary ||
                    detail.ticket.internalNote ||
                    "处理已结束，详细过程见下方时间线。"}
                </p>
              </div>
            </div>

            {detail.rootContext?.ticket && (
              <section>
                <h3 className="font-medium">原始客户需求</h3>
                <div className="mt-2 space-y-3 rounded-xl border border-primary/20 bg-primary/[0.025] p-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">需求类型</p>
                    <p className="mt-1 font-medium">
                      {deliveryCategoryLabel({
                        type: detail.rootContext.ticket.type,
                        category: detail.rootContext.ticket.category,
                      })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      客户原始标题
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">
                      {detail.rootContext.ticket.title ||
                        detail.rootContext.ticket.topic ||
                        "客户未填写标题"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      客户原始说明
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">
                      {detail.rootContext.ticket.description ||
                        "客户未填写补充说明"}
                    </p>
                  </div>
                  {detail.rootContext.ticket.preferredMedia && (
                    <p>
                      <span className="text-muted-foreground">指定媒体：</span>
                      {detail.rootContext.ticket.preferredMedia}
                    </p>
                  )}
                  {detail.rootContext.ticket.targetPage && (
                    <p>
                      <span className="text-muted-foreground">目标页面：</span>
                      {detail.rootContext.ticket.targetPage}
                    </p>
                  )}
                  {Array.isArray(detail.rootContext.ticket.materialUrls) &&
                    detail.rootContext.ticket.materialUrls.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground">
                          客户参考资料
                        </p>
                        <ul className="mt-1 space-y-1 break-all">
                          {detail.rootContext.ticket.materialUrls.map(
                            (url: string) => (
                              <li key={url}>{url}</li>
                            ),
                          )}
                        </ul>
                      </div>
                    )}
                  {Array.isArray(detail.rootContext.attachments) &&
                    detail.rootContext.attachments.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground">
                          客户原始附件
                        </p>
                        <p className="mt-1">
                          {detail.rootContext.attachments
                            .map((attachment: any) => attachment.filename)
                            .filter(Boolean)
                            .join("、")}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          可下载的附件副本列在下方“任务附件”中。
                        </p>
                      </div>
                    )}
                </div>
              </section>
            )}

            {detail.knowledgeReset && (
              <section>
                <h3 className="font-medium">知识库重置结果</h3>
                <div className="mt-2 rounded-xl border p-4 text-sm">
                  <p>
                    申请原因：
                    {knowledgeResetReasonLabel(
                      detail.knowledgeReset.reasonCode,
                    )}
                    {detail.knowledgeReset.reasonNote
                      ? ` · ${detail.knowledgeReset.reasonNote}`
                      : ""}
                  </p>
                  <p className="mt-2">
                    审批结果：
                    {knowledgeResetStatusLabel(detail.knowledgeReset.status)}
                  </p>
                  {detail.knowledgeReset.decisionNote && (
                    <p className="mt-2 whitespace-pre-wrap">
                      审批备注：{detail.knowledgeReset.decisionNote}
                    </p>
                  )}
                  {detail.knowledgeReset.cleanupSummary && (
                    <p className="mt-2 text-muted-foreground">
                      清理结果：
                      {deliveryCleanupSummaryText(
                        detail.knowledgeReset.cleanupSummary as Record<
                          string,
                          number
                        >,
                      )}
                    </p>
                  )}
                  {detail.knowledgeReset.decidedAt && (
                    <p className="mt-2 text-muted-foreground">
                      完成时间：
                      {displayTaskDate(detail.knowledgeReset.decidedAt)}
                    </p>
                  )}
                </div>
              </section>
            )}

            <section>
              <h3 className="font-medium">处理时间线</h3>
              <div className="mt-2 space-y-2">
                {detail.events.map((event: any) => (
                  <div key={event.id} className="rounded-xl border p-3 text-sm">
                    <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        {deliveryActorRoleLabel(event.actorRole, "internal")}
                        {event.visibility === "internal" ? " · 内部记录" : ""}
                      </span>
                      <span>{displayTaskDate(event.createdAt)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap">
                      {deliveryEventDisplayMessage(event, "internal")}
                    </p>
                  </div>
                ))}
                {!detail.events.length && (
                  <p className="text-sm text-muted-foreground">
                    暂无时间线记录
                  </p>
                )}
              </div>
            </section>

            {detail.ticket.deliveryLinks?.length > 0 && (
              <section>
                <h3 className="font-medium">交付链接</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.ticket.deliveryLinks.map((link: any) => (
                    <a
                      key={`${link.label}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm text-primary"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {link.label}
                    </a>
                  ))}
                </div>
              </section>
            )}

            {detail.attachments.length > 0 && (
              <section>
                <h3 className="font-medium">任务附件</h3>
                <div className="mt-2 space-y-2">
                  {detail.attachments.map((attachment: any) => (
                    <div
                      key={attachment.id}
                      className="flex items-center justify-between gap-3 rounded-xl border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {attachment.filename}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {attachment.kind === "deliverable"
                            ? "交付文件"
                            : "输入资料"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void downloadAttachment(attachment)}
                      >
                        <Download className="h-4 w-4" />
                        下载
                      </Button>
                    </div>
                  ))}
                </div>
                {downloadError && (
                  <p className="mt-2 text-sm text-destructive">
                    {downloadError}
                  </p>
                )}
              </section>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeliveryTicketActions({
  projectAssignmentId,
  ticket,
  completionOptions,
  onDone,
  onOpenCustomerDashboard,
}: {
  projectAssignmentId: string;
  ticket: any;
  completionOptions: DeliveryCompletionOptions;
  onDone: () => Promise<unknown>;
  onOpenCustomerDashboard: () => void;
}) {
  const update = trpc.delivery.mine.updateTicket.useMutation();
  const approveSiteRebuild =
    trpc.delivery.mine.approveSiteRebuild.useMutation();
  const publishStyleSamples =
    trpc.delivery.mine.publishWebsiteStyleSamples.useMutation();
  const operation = String(ticket.operation || "");
  const completionTicket = {
    operation,
    credentialTargetUserId: ticket.credentialTargetUserId,
    status: ticket.status,
    marketEdition: ticket.marketEdition,
    topic: ticket.topic,
    preferredMedia: ticket.preferredMedia,
    monitoringBatchKey: ticket.monitoringBatchKey,
    responseLogicRevision: ticket.responseLogicRevision,
    contentAssetIds: ticket.contentAssetIds,
  };
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionDraft, setCompletionDraft] =
    useState<DeliveryCompletionDraft>(() =>
      createDeliveryCompletionDraft(completionTicket, completionOptions),
    );
  const [informationOpen, setInformationOpen] = useState(false);
  const [informationMessage, setInformationMessage] = useState("");
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false);
  const [uploadingModule, setUploadingModule] = useState("");
  const [pendingBusinessModuleImport, setPendingBusinessModuleImport] =
    useState<PendingBusinessModuleImport | null>(null);
  const [styleFiles, setStyleFiles] = useState<File[]>([]);
  const [styleLabels, setStyleLabels] = useState([
    "风格样例一",
    "风格样例二",
    "风格样例三",
  ]);
  const [styleNote, setStyleNote] = useState("");
  const [uploadingStyles, setUploadingStyles] = useState(false);
  const [siteRebuildApprovalOpen, setSiteRebuildApprovalOpen] = useState(false);
  const moduleImports = TICKET_MODULE_IMPORTS[ticket.operation] ?? [];
  const completionMode = deliveryCompletionMode(operation);

  const confirmSiteRebuildApproval = async () => {
    try {
      await approveSiteRebuild.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
      });
      setSiteRebuildApprovalOpen(false);
      await onDone();
      toast.success("官网重置需求已通过", {
        description:
          "旧官网正在安全下线；企业知识库保持不变。完成后客户可点击“从知识库开始建站”。",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "通过重置需求失败");
    }
  };

  if (operation === "site_rebuild") {
    const reset = siteRebuildResetProjection(ticket);
    if (reset.state === "completed") {
      return (
        <div className="mt-3 rounded-xl border bg-muted/25 px-4 py-3 text-sm leading-6">
          <strong>重置需求已通过</strong>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            旧官网已下线；企业知识库保持不变，客户可点击“从知识库开始建站”。
          </p>
        </div>
      );
    }

    if (reset.state === "queued" || reset.state === "reconciling") {
      return (
        <div
          className="mt-3 rounded-xl border border-blue-300/60 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-950"
          aria-live="polite"
        >
          <strong className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {reset.state === "queued"
              ? "正在完成官网重置"
              : "正在核对旧官网下线结果"}
          </strong>
          <p className="mt-1 text-xs leading-5 text-blue-800">
            {reset.state === "queued"
              ? "旧官网已进入安全下线队列，本页面会自动刷新进度。"
              : "系统正在只读核对外部下线结果，确认后会自动完成重置。"}
          </p>
        </div>
      );
    }

    if (reset.state === "invalidated") {
      return (
        <div
          className="mt-3 rounded-xl border border-red-300/60 bg-red-50 px-4 py-3 text-sm leading-6 text-red-950"
          role="alert"
        >
          <strong>重置申请已失效</strong>
          <p className="mt-1 text-xs leading-5 text-red-800">
            项目已进入新的处理周期，请客户重新提交官网重置申请。
          </p>
        </div>
      );
    }

    const approvalAvailable =
      (reset.state === "blocked" && reset.canRecheck) ||
      (reset.state === null &&
        ["submitted", "needs_information", "scheduled", "in_progress"].includes(
          String(ticket.status || ""),
        ));
    const recheck = reset.state === "blocked" && reset.canRecheck;

    return (
      <div className="mt-3">
        {reset.state === "blocked" && (
          <div
            className="mb-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
            role="alert"
          >
            <strong>官网重置需要处理</strong>
            <p className="mt-1 text-xs leading-5 text-amber-800">
              {siteRebuildResetIssueCopy(reset.issue)}
            </p>
          </div>
        )}
        {approvalAvailable && (
          <Button
            type="button"
            size="sm"
            disabled={approveSiteRebuild.isPending}
            onClick={() => setSiteRebuildApprovalOpen(true)}
          >
            {approveSiteRebuild.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {recheck ? "重新检查" : "通过重置需求"}
          </Button>
        )}
        <Dialog
          open={siteRebuildApprovalOpen}
          onOpenChange={(open) => {
            if (!approveSiteRebuild.isPending) {
              setSiteRebuildApprovalOpen(open);
            }
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {recheck ? "重新检查官网重置？" : "通过官网重置需求？"}
              </DialogTitle>
              <DialogDescription>
                {recheck
                  ? "确认后，系统会检查同一重置任务的真实外部状态；不会重复执行已经确认的下线步骤。"
                  : "确认后，旧官网将进入安全下线流程；下线确认完成后，当前官网轮次将重置，企业知识库保持不变，客户可点击“从知识库开始建站”创建全新官网任务。"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={approveSiteRebuild.isPending}
                onClick={() => setSiteRebuildApprovalOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={approveSiteRebuild.isPending}
                onClick={() => void confirmSiteRebuildApproval()}
              >
                {approveSiteRebuild.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                确认通过
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (deliveryTicketWaitsForAdminCredential(completionTicket)) {
    return (
      <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
        <strong>等待系统管理员配置 API Key</strong>
        <p className="mt-1 text-xs leading-5 text-amber-800">
          API Key
          仅由系统管理员在“API与人员管理”统一维护。配置完成后，此处会自动更新；工程师无需填写密钥、链接或交付结果。
        </p>
      </div>
    );
  }

  if (completionMode === "system_readonly") {
    return (
      <div className="mt-3 rounded-xl border bg-muted/25 px-4 py-3 text-sm leading-6">
        <strong>系统交付记录（只读）</strong>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {ticket.publicSummary ||
            deliveryTicketDisplayDescription(ticket) ||
            "该记录由系统生成，不需要工程师处理。"}
        </p>
      </div>
    );
  }

  const publishStyles = async () => {
    if (styleFiles.length !== 3) {
      toast.warning("请选择恰好三张图片样例");
      return;
    }
    if (
      styleFiles.some(
        (file) =>
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size <= 0 ||
          file.size > 10 * 1024 * 1024,
      )
    ) {
      toast.warning("样例仅支持 10MB 以内的 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (styleLabels.some((label) => !label.trim())) {
      toast.warning("请为三张样例分别填写名称");
      return;
    }
    setUploadingStyles(true);
    try {
      const uploaded = await Promise.all(
        styleFiles.map(async (file, index) => {
          const result = await uploadFile(file);
          return {
            fileId: result.fileId,
            filename: result.filename,
            mimeType: file.type,
            sizeBytes: file.size,
            label: styleLabels[index]!.trim(),
          };
        }),
      );
      await publishStyleSamples.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedWorkflowRevision: ticket.websiteStyleWorkflowRevision,
        engineerNote: styleNote.trim() || undefined,
        samples: uploaded,
      });
      setStyleFiles([]);
      setStyleNote("");
      await onDone();
      toast.success("三张官网风格样例已发布", {
        description: "需求已进入等待客户选择状态。",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "风格样例发布失败");
    } finally {
      setUploadingStyles(false);
    }
  };
  const uploadKnowledgeArchive = async (file: File) => {
    setUploadingKnowledge(true);
    try {
      const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "knowledge",
          "x-maintenance-ticket-id": ticket.id,
          "x-delivery-project-assignment-id": projectAssignmentId,
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || "知识库文件上传与校验失败");
      }
      await onDone();
      toast.success("新知识库版本已上传并发布", {
        description: "现在可以完成知识库维护需求。",
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "知识库文件上传失败",
      );
    } finally {
      setUploadingKnowledge(false);
    }
  };
  const requestBusinessModuleImport = async (
    definition: BusinessModuleImportDefinition,
    file: File,
    input: {
      preview: boolean;
      targetBatchKey?: string;
      fileHash?: string;
      preflightToken?: string;
    },
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-import-mode": "dashboard",
      "x-dashboard-module": definition.module,
      "x-dashboard-revision": String(ticket.dashboardRevision),
      "x-delivery-project-assignment-id": projectAssignmentId,
      "x-delivery-ticket-id": ticket.id,
    };
    if (input.preview) headers["x-import-preview"] = "true";
    if (input.targetBatchKey) {
      headers["x-monitoring-target-batch-key"] = input.targetBatchKey;
    }
    if (input.fileHash) {
      headers[
        definition.module === "monitoring"
          ? "x-monitoring-file-hash"
          : "x-import-file-hash"
      ] = input.fileHash;
    }
    if (input.preflightToken) {
      headers["x-import-preflight-token"] = input.preflightToken;
    }
    const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
      method: "PUT",
      credentials: "include",
      headers,
      body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || "业务文件预检失败");
    }
    return payload;
  };

  const preflightBusinessModule = async (
    definition: BusinessModuleImportDefinition,
    file: File,
  ) => {
    setUploadingModule(definition.module);
    try {
      const result = await requestBusinessModuleImport(definition, file, {
        preview: true,
      });
      const preview = (result?.preview ||
        result) as BusinessModuleImportPreview;
      if (businessModulePreviewHasErrors(preview)) {
        const firstError = preview.issues
          ?.map(businessModuleIssueText)
          .find(Boolean);
        throw new Error(firstError || "文件未通过业务规则校验");
      }
      setPendingBusinessModuleImport({
        definition,
        file,
        preview,
        targetBatchKey:
          preview.preflightTargetBatchKey || preview.suggestedBatchKey || "",
      });
    } catch (error) {
      toast.error(`${definition.label}预检失败`, {
        description:
          error instanceof Error ? error.message : "请检查文件格式后重试",
      });
    } finally {
      setUploadingModule("");
    }
  };

  const publishBusinessModule = async () => {
    if (!pendingBusinessModuleImport) return;
    const { definition, file, targetBatchKey } = pendingBusinessModuleImport;
    if (
      pendingBusinessModuleImport.preview.targetBatchRequired &&
      !targetBatchKey.trim()
    ) {
      toast.warning("请选择目标监控批次", {
        description: "引用补充文件必须绑定到已有答案批次。",
      });
      return;
    }
    setUploadingModule(definition.module);
    try {
      let publishPreview = pendingBusinessModuleImport.preview;
      const normalizedTargetBatchKey = targetBatchKey.trim() || undefined;
      if (
        !businessModulePreflightUsable(publishPreview) ||
        normalizedTargetBatchKey !==
          (publishPreview.preflightTargetBatchKey || undefined)
      ) {
        const refreshed = await requestBusinessModuleImport(definition, file, {
          preview: true,
          targetBatchKey: normalizedTargetBatchKey,
        });
        publishPreview = (refreshed?.preview ||
          refreshed) as BusinessModuleImportPreview;
        setPendingBusinessModuleImport((current) =>
          current ? { ...current, preview: publishPreview } : current,
        );
      }
      if (
        businessModulePreviewHasErrors(publishPreview) ||
        !businessModulePreflightUsable(publishPreview)
      ) {
        throw new Error("文件未取得有效预检凭证，请重新选择文件预检。");
      }
      await requestBusinessModuleImport(definition, file, {
        preview: false,
        targetBatchKey: normalizedTargetBatchKey,
        fileHash: publishPreview.fileHash,
        preflightToken: publishPreview.preflightToken,
      });
      setPendingBusinessModuleImport(null);
      await onDone();
      toast.success(`${definition.label}已发布`, {
        description:
          "正式数据已经写入客户业务模块；请在下方用户验收视图核对结果后再完成需求。",
      });
    } catch (error) {
      toast.error(`${definition.label}发布失败`, {
        description:
          error instanceof Error ? error.message : "请重新预检后发布",
      });
    } finally {
      setUploadingModule("");
    }
  };
  const updateStatus = async (input: {
    status: "in_progress" | "needs_information" | "completed";
    message?: string;
    publicUrl?: string;
    previewVerified?: true;
    handoff?: ReturnType<typeof buildDeliveryCompletionPayload>["handoff"];
  }) => {
    try {
      await update.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        ...input,
      });
      await onDone();
      toast.success(
        input.status === "completed"
          ? "交付已完成"
          : input.status === "needs_information"
            ? "补充要求已发送给客户"
            : "需求已开始处理",
      );
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return false;
    }
  };

  const completeDelivery = async () => {
    const errors = validateDeliveryCompletionDraft(
      completionTicket,
      completionDraft,
      completionOptions,
    );
    if (errors.length) {
      toast.warning(errors[0], {
        description:
          errors.length > 1
            ? `还需处理：${errors.slice(1).join("；")}`
            : undefined,
      });
      return;
    }
    const payload = buildDeliveryCompletionPayload(
      completionTicket,
      completionDraft,
    );
    if (
      await updateStatus({
        status: "completed",
        ...payload,
      })
    ) {
      setCompletionOpen(false);
    }
  };

  const requestInformation = async () => {
    const message = informationMessage.trim();
    if (!message) {
      toast.warning("请明确填写客户需要补充的资料");
      return;
    }
    if (await updateStatus({ status: "needs_information", message })) {
      setInformationMessage("");
      setInformationOpen(false);
    }
  };

  const openCustomerDashboard = () => {
    setCompletionOpen(false);
    onOpenCustomerDashboard();
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ticket.status !== "in_progress" &&
        !(
          ticket.operation === "website_style_samples" &&
          ticket.status === "needs_information"
        ) && (
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void updateStatus({ status: "in_progress" })}
          >
            开始处理
          </Button>
        )}
      {ticket.status === "in_progress" && (
        <>
          {ticket.operation === "website_style_samples" && (
            <div className="w-full space-y-3 rounded-xl border bg-muted/20 p-4">
              <div>
                <p className="text-sm font-medium">发布官网图片风格样例</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  请选择恰好三张 PNG、JPEG 或 WebP 图片，每张不超过 10MB。
                </p>
              </div>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={uploadingStyles}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files || []);
                  if (files.length !== 3) {
                    toast.warning("每批必须选择恰好三张图片");
                    event.currentTarget.value = "";
                    setStyleFiles([]);
                    return;
                  }
                  setStyleFiles(files);
                }}
              />
              {styleFiles.length === 3 && (
                <div className="grid gap-3 md:grid-cols-3">
                  {styleFiles.map((file, index) => (
                    <label
                      key={`${file.name}:${file.lastModified}`}
                      className="space-y-2 rounded-lg border bg-background p-3"
                    >
                      <img
                        src={URL.createObjectURL(file)}
                        alt={styleLabels[index]}
                        className="aspect-video w-full rounded-md object-cover"
                        onLoad={(event) =>
                          URL.revokeObjectURL(event.currentTarget.src)
                        }
                      />
                      <Input
                        value={styleLabels[index]}
                        maxLength={160}
                        disabled={uploadingStyles}
                        onChange={(event) =>
                          setStyleLabels((current) =>
                            current.map((label, labelIndex) =>
                              labelIndex === index ? event.target.value : label,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
              <textarea
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={styleNote}
                maxLength={2000}
                disabled={uploadingStyles}
                placeholder="可选：说明三种风格的设计方向和适用场景"
                onChange={(event) => setStyleNote(event.target.value)}
              />
              <Button
                size="sm"
                disabled={
                  uploadingStyles ||
                  publishStyleSamples.isPending ||
                  styleFiles.length !== 3
                }
                onClick={() => void publishStyles()}
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadingStyles ? "正在上传并发布" : "发布三张样例"}
              </Button>
            </div>
          )}
          {ticket.operation === "knowledge_maintenance" && (
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" />
              {uploadingKnowledge ? "正在校验" : "上传并发布新版本"}
              <input
                className="hidden"
                type="file"
                accept=".zip,application/zip"
                disabled={uploadingKnowledge}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadKnowledgeArchive(file);
                }}
              />
            </label>
          )}
          {moduleImports.map((moduleImport) => (
            <label
              key={moduleImport.module}
              className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingModule === moduleImport.module
                ? "正在预检"
                : moduleImport.label}
              <input
                className="hidden"
                type="file"
                accept={moduleImport.accept}
                disabled={Boolean(uploadingModule)}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void preflightBusinessModule(moduleImport, file);
                }}
              />
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => setInformationOpen(true)}
          >
            等待用户补充
          </Button>
          {(completionMode === "form" ||
            completionMode === "legacy_summary") && (
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => setCompletionOpen(true)}
            >
              填写交付结果
            </Button>
          )}
        </>
      )}
      {ticket.operation === "website_style_samples" &&
        ticket.status === "needs_information" && (
          <p className="w-full text-xs text-muted-foreground">
            已发布本批三张样例，正在等待客户选择或退回重做。
          </p>
        )}

      <BusinessModuleImportDialog
        pending={pendingBusinessModuleImport}
        publishing={Boolean(uploadingModule)}
        customerName={
          ticket.customerName ||
          ticket.customerUsername ||
          `客户 #${ticket.userId}`
        }
        onTargetBatchKeyChange={(targetBatchKey) =>
          setPendingBusinessModuleImport((current) =>
            current ? { ...current, targetBatchKey } : current,
          )
        }
        onClose={() => {
          if (!uploadingModule) setPendingBusinessModuleImport(null);
        }}
        onPublish={() => void publishBusinessModule()}
      />

      <Dialog open={informationOpen} onOpenChange={setInformationOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>向客户说明需要补充的资料</DialogTitle>
            <DialogDescription>
              需求会保留并进入“等待客户补充”，客户回复后继续当前需求，不会重复创建任务。
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">补充要求</span>
            <textarea
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2"
              value={informationMessage}
              maxLength={8_000}
              placeholder="请具体说明缺少什么、接受什么格式，以及补充后将继续哪一步。"
              onChange={(event) => setInformationMessage(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInformationOpen(false)}>
              取消
            </Button>
            <Button
              disabled={update.isPending || !informationMessage.trim()}
              onClick={() => void requestInformation()}
            >
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              发送并等待客户
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeliveryCompletionDialog
        open={completionOpen}
        onOpenChange={setCompletionOpen}
        ticket={ticket}
        draft={completionDraft}
        completionOptions={completionOptions}
        onDraftChange={setCompletionDraft}
        submitting={update.isPending}
        onInspectPreview={openCustomerDashboard}
        onSubmit={() => void completeDelivery()}
      />
    </div>
  );
}

function BusinessModuleImportDialog({
  pending,
  publishing,
  customerName,
  onTargetBatchKeyChange,
  onClose,
  onPublish,
}: {
  pending: PendingBusinessModuleImport | null;
  publishing: boolean;
  customerName: string;
  onTargetBatchKeyChange: (targetBatchKey: string) => void;
  onClose: () => void;
  onPublish: () => void;
}) {
  const preview = pending?.preview;
  const errors = preview?.issues
    ?.filter(
      (issue) =>
        typeof issue !== "string" &&
        (issue.level === "error" || issue.severity === "error"),
    )
    .map(businessModuleIssueText);
  const questions = preview?.questions
    ?.map(businessModuleValueText)
    .filter(Boolean);
  const models = preview?.models?.map(businessModuleValueText).filter(Boolean);
  const targetBatchMissing = Boolean(
    preview?.targetBatchRequired && !pending?.targetBatchKey.trim(),
  );

  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open && !publishing) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>业务文件预检与发布确认</DialogTitle>
          <DialogDescription>
            预检只读取文件，不修改客户数据。确认后将以同一文件校验值发布到正式业务模块。
          </DialogDescription>
        </DialogHeader>

        {pending && preview && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <BusinessModulePreviewMetric
                label="目标客户"
                value={customerName}
              />
              <BusinessModulePreviewMetric
                label="目标模块"
                value={pending.definition.label}
              />
              <BusinessModulePreviewMetric
                label="源文件"
                value={preview.sourceName || pending.file.name}
              />
              <BusinessModulePreviewMetric
                label="文件大小"
                value={`${Math.max(1, Math.ceil(pending.file.size / 1024))} KB`}
              />
            </div>

            {(preview.sampleCount !== undefined ||
              preview.citationCount !== undefined ||
              (questions?.length ?? 0) > 0 ||
              (models?.length ?? 0) > 0) && (
              <section className="rounded-xl border bg-muted/20 p-4">
                <p className="text-sm font-medium">识别结果</p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  {preview.sampleCount !== undefined && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        答案记录
                      </dt>
                      <dd className="mt-1 font-medium">
                        {preview.sampleCount} 条
                      </dd>
                    </div>
                  )}
                  {preview.citationCount !== undefined && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        引用记录
                      </dt>
                      <dd className="mt-1 font-medium">
                        {preview.citationCount} 条
                      </dd>
                    </div>
                  )}
                  {(questions?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">问题</dt>
                      <dd className="mt-1 break-words font-medium">
                        {questions!.join("、")}
                      </dd>
                    </div>
                  )}
                  {(models?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">模型</dt>
                      <dd className="mt-1 break-words font-medium">
                        {models!.join("、")}
                      </dd>
                    </div>
                  )}
                  {(preview.dates?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        采集日期
                      </dt>
                      <dd className="mt-1 break-words font-medium">
                        {preview.dates!.join("、")}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            {(preview.summary?.length ?? 0) > 0 && (
              <section className="rounded-xl border p-4">
                <p className="text-sm font-medium">变更摘要</p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  {preview.summary!.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            )}

            {(preview.recordStats?.length ?? 0) > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {preview.recordStats!.map((stats, index) => (
                  <section
                    key={`${stats.label || "记录"}-${index}`}
                    className="rounded-xl border p-4"
                  >
                    <p className="text-sm font-medium">
                      {stats.label || "记录变化"}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      现有 {stats.beforeCount ?? 0} 条 → 发布后{" "}
                      {stats.afterCount ?? 0} 条
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      新增 {stats.added ?? 0} · 更新 {stats.updated ?? 0} · 删除{" "}
                      {stats.removed ?? 0} · 不变 {stats.unchanged ?? 0}
                    </p>
                  </section>
                ))}
              </div>
            )}

            {preview.targetBatchRequired && (
              <label className="block space-y-2 text-sm">
                <span className="font-medium">
                  目标监控批次
                  <span className="ml-1 text-destructive">*</span>
                </span>
                {(preview.availableBatches?.length ?? 0) > 0 ? (
                  <select
                    aria-label="目标监控批次"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={pending.targetBatchKey}
                    onChange={(event) =>
                      onTargetBatchKeyChange(event.target.value)
                    }
                  >
                    <option value="">请选择已有答案批次</option>
                    {preview
                      .availableBatches!.filter((batch) =>
                        Boolean(batch.batchKey),
                      )
                      .map((batch) => (
                        <option key={batch.batchKey} value={batch.batchKey}>
                          {businessModuleBatchLabel(batch)}
                        </option>
                      ))}
                  </select>
                ) : (
                  <Input
                    aria-label="目标监控批次"
                    value={pending.targetBatchKey}
                    placeholder="填写已有答案批次标识"
                    onChange={(event) =>
                      onTargetBatchKeyChange(event.target.value)
                    }
                  />
                )}
                <span className="block text-xs leading-5 text-muted-foreground">
                  引用补充文件必须明确绑定已有答案批次，系统不会猜测或跨批次合并。
                </span>
              </label>
            )}

            {(preview.issues?.length ?? 0) > 0 && (
              <section
                className={`rounded-xl border p-4 ${
                  (errors?.length ?? 0) > 0
                    ? "border-destructive/30 bg-destructive/[0.035]"
                    : "bg-muted/20"
                }`}
              >
                <p className="text-sm font-medium">
                  {(errors?.length ?? 0) > 0 ? "必须处理的问题" : "预检提示"}
                </p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  {preview.issues!.map((issue, index) => (
                    <li key={`${businessModuleIssueText(issue)}-${index}`}>
                      {businessModuleIssueText(issue)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="rounded-xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
              确认发布后会更新客户正式数据，但不会自动完成需求。请先在用户验收视图检查结果，再填写交付摘要并完成交接。
              {preview.fileHash && (
                <span className="mt-1 block font-mono">
                  校验值：{preview.fileHash.slice(0, 16)}…
                </span>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={publishing}
                onClick={onClose}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  publishing || targetBatchMissing || (errors?.length ?? 0) > 0
                }
                onClick={onPublish}
              >
                {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
                确认发布到正式数据
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BusinessModulePreviewMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-muted/20 px-4 py-3">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <strong className="mt-1 block truncate text-sm" title={value}>
        {value}
      </strong>
    </div>
  );
}

function DeliveryCompletionDialog({
  open,
  onOpenChange,
  ticket,
  draft,
  completionOptions,
  onDraftChange,
  submitting,
  onInspectPreview,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: any;
  draft: DeliveryCompletionDraft;
  completionOptions: DeliveryCompletionOptions;
  onDraftChange: (draft: DeliveryCompletionDraft) => void;
  submitting: boolean;
  onInspectPreview: () => void;
  onSubmit: () => void;
}) {
  const operation = String(ticket.operation || "");
  const publicUrlRequired = deliveryCompletionRequiresPublicUrl(operation);
  const previewVerificationRequired =
    deliveryCompletionRequiresPreviewVerification(operation);
  const patchDraft = (patch: Partial<DeliveryCompletionDraft>) =>
    onDraftChange({ ...draft, ...patch });
  const channelMediaOptions = contentAssetMediaOptionsForMarketEdition(
    ticket.marketEdition === "overseas" ? "overseas" : "domestic",
  );
  const monitoringBatchOptions = deliveryCompletionMonitoringBatchOptions(
    ticket,
    completionOptions,
  );
  const optionBlockReasons = deliveryCompletionOptionBlockReasons(
    ticket,
    completionOptions,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>完成交付并确认下游交接</DialogTitle>
          <DialogDescription>
            {operationLabel(operation)} · 客户 #{ticket.userId}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-sm leading-6">
          <p className="font-medium">完成后系统动作</p>
          <p className="mt-1 text-muted-foreground">
            {deliveryCompletionCreatesNextStep(operation)}
          </p>
        </div>

        {optionBlockReasons.length > 0 && (
          <div
            role="alert"
            className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          >
            <p className="font-medium">当前正式数据尚不满足完成条件</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5">
              {optionBlockReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-5">
          <CompletionField
            label="交付结果摘要"
            description="写给客户和下一岗位看，说明完成了什么、结果在哪里、还需注意什么。"
            required
          >
            <textarea
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={draft.summary}
              maxLength={8_000}
              placeholder={deliveryCompletionSummaryPlaceholder(operation)}
              onChange={(event) => patchDraft({ summary: event.target.value })}
            />
          </CompletionField>

          {operation === "question_catalog" && (
            <section
              data-testid="question-catalog-completion-evidence"
              className="space-y-3 rounded-xl border bg-muted/20 px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">正式品牌词库</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    这里只核对正式发布结果，不接受手填词库数据。
                  </p>
                </div>
                <Badge
                  variant={
                    completionOptions.keywordCatalogPublished
                      ? "secondary"
                      : "outline"
                  }
                >
                  {completionOptions.keywordCatalogPublished
                    ? "已发布"
                    : "尚未发布"}
                </Badge>
              </div>
            </section>
          )}

          {deliveryCompletionHasField(operation, "domain") && (
            <div className="grid gap-4 sm:grid-cols-2">
              <CompletionField label="已核验域名" required>
                <Input
                  value={draft.domain}
                  placeholder="example.com"
                  onChange={(event) =>
                    patchDraft({ domain: event.target.value })
                  }
                />
              </CompletionField>
              {ticket.marketEdition === "overseas" ? (
                <div className="rounded-xl border bg-muted/25 px-4 py-3 text-sm">
                  <p className="font-medium">海外版客户</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    无需填写工信部备案服务码；域名确认后直接进入官网风格样例阶段。
                  </p>
                </div>
              ) : (
                <CompletionField
                  label="备案服务码"
                  description="返回给国内版客户办理 ICP 备案。"
                  required
                >
                  <Input
                    value={draft.icpServiceCode}
                    onChange={(event) =>
                      patchDraft({ icpServiceCode: event.target.value })
                    }
                  />
                </CompletionField>
              )}
            </div>
          )}

          {deliveryCompletionHasField(operation, "icp_resolution") && (
            <div className="space-y-4">
              <CompletionField label="备案结论" required>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.icpResolution}
                  onChange={(event) =>
                    patchDraft({
                      icpResolution: event.target.value as
                        | "approved"
                        | "not_required",
                    })
                  }
                >
                  <option value="approved">备案已通过</option>
                  {ticket.marketEdition === "overseas" && (
                    <option value="not_required">依法无需备案</option>
                  )}
                </select>
              </CompletionField>
              {draft.icpResolution === "approved" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <CompletionField label="ICP 备案号" required>
                    <Input
                      value={draft.icpNumber}
                      onChange={(event) =>
                        patchDraft({ icpNumber: event.target.value })
                      }
                    />
                  </CompletionField>
                  <CompletionField label="备案省份">
                    <Input
                      value={draft.icpProvince}
                      placeholder="例如：浙江"
                      onChange={(event) =>
                        patchDraft({ icpProvince: event.target.value })
                      }
                    />
                  </CompletionField>
                </div>
              )}
            </div>
          )}

          {deliveryCompletionHasField(operation, "monitoring_batch") && (
            <div className="grid gap-4 sm:grid-cols-2">
              <CompletionField
                label={
                  operation === "monitoring_retest"
                    ? "本次复测的新监控批次"
                    : "正式监控批次标识"
                }
                description={
                  operation === "monitoring_retest"
                    ? "必须选择本次复测新发布的批次，不能继续沿用复测前基线。"
                    : "供下一岗位回查本次回答与信源。"
                }
                required
              >
                <select
                  aria-label={
                    operation === "monitoring_retest"
                      ? "本次复测的新监控批次"
                      : "正式监控批次"
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.monitoringBatchKey}
                  onChange={(event) =>
                    patchDraft({ monitoringBatchKey: event.target.value })
                  }
                >
                  <option value="">请选择已发布的正式监控批次</option>
                  {monitoringBatchOptions.map((batch) => (
                    <option key={batch.batchKey} value={batch.batchKey}>
                      {batch.batchKey} · {batch.sourceName} ·{" "}
                      {new Date(batch.collectedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}{" "}
                      · {batch.sampleCount} 条答案
                    </option>
                  ))}
                </select>
                {operation === "monitoring_retest" &&
                  ticket.monitoringBatchKey && (
                    <span className="block text-xs text-muted-foreground">
                      复测前基线：{ticket.monitoringBatchKey}（已从选项中排除）
                    </span>
                  )}
              </CompletionField>
              {deliveryCompletionHasField(
                operation,
                "optimization_question_ids",
              ) && (
                <fieldset
                  aria-label="待优化问题"
                  className="space-y-2 rounded-xl border px-3 py-3 text-sm"
                >
                  <legend className="px-1 font-medium">待优化问题</legend>
                  <p className="text-xs leading-5 text-muted-foreground">
                    只能从客户已确认且审核通过的问题中选择；所选问题还会由服务端核对是否属于本次批次。
                  </p>
                  {completionOptions.approvedQuestions.length > 0 ? (
                    <div className="max-h-52 space-y-2 overflow-y-auto">
                      {completionOptions.approvedQuestions.map((question) => {
                        const checked = draft.optimizationQuestionIds.includes(
                          question.id,
                        );
                        const categoryLabel = QUESTION_QUOTA_FIELDS.find(
                          (item) => item.category === question.category,
                        )?.label;
                        return (
                          <label
                            key={question.id}
                            className="flex items-start gap-2 rounded-lg border bg-background px-3 py-2"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) =>
                                patchDraft({
                                  optimizationQuestionIds: event.target.checked
                                    ? [
                                        ...draft.optimizationQuestionIds,
                                        question.id,
                                      ]
                                    : draft.optimizationQuestionIds.filter(
                                        (questionId) =>
                                          questionId !== question.id,
                                      ),
                                })
                              }
                            />
                            <span>
                              <span className="block">{question.question}</span>
                              {categoryLabel && (
                                <span className="mt-0.5 block text-xs text-muted-foreground">
                                  {categoryLabel}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-800">
                      暂无已审核通过的客户问题。
                    </p>
                  )}
                </fieldset>
              )}
            </div>
          )}

          {deliveryCompletionHasField(operation, "response_logic_revision") && (
            <CompletionField
              label="已确认应答逻辑版本"
              description="完成后，下游内容资产需求会锁定到这个版本。"
              required
            >
              <Input
                type="number"
                min={1}
                step={1}
                value={draft.responseLogicRevision}
                onChange={(event) =>
                  patchDraft({ responseLogicRevision: event.target.value })
                }
              />
            </CompletionField>
          )}

          {deliveryCompletionHasField(operation, "content_asset_ids") && (
            <CompletionField
              label={
                operation === "content_asset_publish"
                  ? "已确认内容资产 ID"
                  : "本页面绑定的内容资产 ID"
              }
              description={
                operation === "content_asset_publish"
                  ? "多个 ID 用逗号或换行分隔；必须已经进入客户正式看板。"
                  : "只能填写已通过内容分发岗位需求完成发布的资产 ID。"
              }
              required
            >
              {operation !== "content_asset_publish" &&
              Array.isArray(ticket.contentAssetIds) &&
              ticket.contentAssetIds.length > 0 ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  {ticket.contentAssetIds.join("、")}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    该官网子工单已继承内容资产，不能在完成时改写。
                  </span>
                </div>
              ) : (
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.contentAssetIds}
                  onChange={(event) =>
                    patchDraft({ contentAssetIds: event.target.value })
                  }
                />
              )}
            </CompletionField>
          )}

          {deliveryCompletionHasField(operation, "channel_target_media") && (
            <CompletionField
              label="目标媒体或渠道"
              description="填写本次实际发布的平台、媒体或渠道，供后续效果复测准确归因。"
              required
            >
              <select
                aria-label="目标媒体或渠道"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={draft.channelTargetMedia}
                disabled={Boolean(ticket.preferredMedia?.trim())}
                onChange={(event) =>
                  patchDraft({ channelTargetMedia: event.target.value })
                }
              >
                <option value="">请选择实际发布媒体</option>
                {channelMediaOptions.map((media) => (
                  <option key={media} value={media}>
                    {media}
                  </option>
                ))}
              </select>
              {ticket.preferredMedia?.trim() && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  已按客户提交时指定的目标媒体锁定，完成时不能改写。
                </span>
              )}
            </CompletionField>
          )}

          {deliveryCompletionHasField(operation, "site_check") && (
            <div className="space-y-4">
              {deliveryCompletionHasField(operation, "site_check_source") && (
                <CompletionField
                  label="检查页面地址"
                  description="填写本次实际检查的官网页面 http(s) 地址。"
                  required
                >
                  <Input
                    type="url"
                    value={draft.siteCheckSource}
                    placeholder="https://"
                    onChange={(event) =>
                      patchDraft({ siteCheckSource: event.target.value })
                    }
                  />
                </CompletionField>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <CompletionField label="检查项标识" required>
                  <Input
                    value={draft.siteCheckKey}
                    onChange={(event) =>
                      patchDraft({ siteCheckKey: event.target.value })
                    }
                  />
                </CompletionField>
                <CompletionField label="检查项名称" required>
                  <Input
                    value={draft.siteCheckLabel}
                    onChange={(event) =>
                      patchDraft({ siteCheckLabel: event.target.value })
                    }
                  />
                </CompletionField>
              </div>
              <CompletionField label="检查结论" required>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.siteCheckStatus}
                  onChange={(event) =>
                    patchDraft({
                      siteCheckStatus: event.target
                        .value as DeliveryCompletionDraft["siteCheckStatus"],
                    })
                  }
                >
                  <option value="passed">通过</option>
                  <option value="warning">有风险但可继续</option>
                  <option value="failed">未通过</option>
                  <option value="not_applicable">不适用</option>
                </select>
              </CompletionField>
              <CompletionField label="检查摘要">
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.siteCheckSummary}
                  onChange={(event) =>
                    patchDraft({ siteCheckSummary: event.target.value })
                  }
                />
              </CompletionField>
              <CompletionField
                label="检查证据说明"
                description="可填写截图编号、检查工具结果或其他内部证据，不用于登记页面地址。"
              >
                <Input
                  value={draft.siteCheckEvidence}
                  onChange={(event) =>
                    patchDraft({ siteCheckEvidence: event.target.value })
                  }
                />
              </CompletionField>
            </div>
          )}

          {deliveryCompletionHasField(
            operation,
            "needs_further_optimization",
          ) && (
            <label className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={draft.needsFurtherOptimization}
                onChange={(event) =>
                  patchDraft({
                    needsFurtherOptimization: event.target.checked,
                  })
                }
              />
              <span>
                <strong>复测仍未达到目标，需要继续优化</strong>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  勾选后沿原问题创建下一轮应答逻辑需求；未绑定来源问题时服务端会拒绝，防止错误串单。
                </span>
              </span>
            </label>
          )}

          {publicUrlRequired && (
            <CompletionField
              label="公开链接"
              description="该需求属于公开发布，必须填写客户可访问的 http(s) 地址。"
              required
            >
              <Input
                type="url"
                value={draft.publicUrl}
                placeholder="https://"
                onChange={(event) =>
                  patchDraft({ publicUrl: event.target.value })
                }
              />
            </CompletionField>
          )}

          {previewVerificationRequired && (
            <label className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.025] px-4 py-3 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={draft.previewVerified}
                onChange={(event) =>
                  patchDraft({ previewVerified: event.target.checked })
                }
              />
              <span>
                <strong>我已完成官网用户侧验收</strong>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  已核对用户实际官网，页面展示、公开链接和本次摘要一致。
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className={CUSTOMER_DASHBOARD_BUTTON_CLASS}
            onClick={onInspectPreview}
          >
            进入客户看板
            <PanelRightOpen className="h-4 w-4" />
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              暂不完成
            </Button>
            <Button
              type="button"
              disabled={submitting || optionBlockReasons.length > 0}
              onClick={onSubmit}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              完成并交接
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompletionField({
  label,
  description,
  required = false,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="font-medium">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {description && (
        <span className="block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      )}
      {children}
    </label>
  );
}

function parseQuestionMaintenancePayload(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return { questionSnapshot: "", proposedQuestion: "", reason: "" };
  }
  try {
    const parsed = JSON.parse(value) as {
      questionSnapshot?: unknown;
      proposedQuestion?: unknown;
      reason?: unknown;
    };
    return {
      questionSnapshot:
        typeof parsed.questionSnapshot === "string"
          ? parsed.questionSnapshot.trim()
          : "",
      proposedQuestion:
        typeof parsed.proposedQuestion === "string"
          ? parsed.proposedQuestion.trim()
          : "",
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    };
  } catch {
    return { questionSnapshot: "", proposedQuestion: "", reason: value.trim() };
  }
}

function QuestionMaintenanceDecision({
  projectAssignmentId,
  ticket,
  systemAdminMode = false,
  onDone,
}: {
  projectAssignmentId: string;
  ticket: {
    id: string;
    revision: number;
    category?: string | null;
    topic?: string | null;
    description?: string | null;
  };
  systemAdminMode?: boolean;
  onDone: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [category, setCategory] = useState<
    "industry" | "competitor_comparison" | "reputation" | "product_scenario"
  >("industry");
  const [decisionNote, setDecisionNote] = useState("");
  const decide = trpc.delivery.mine.decideQuestionMaintenance.useMutation();
  const payload = parseQuestionMaintenancePayload(ticket.description);
  const actionLabel =
    ticket.category === "question_review"
      ? "审核问题"
      : ticket.category === "question_modify"
        ? "修改问题"
        : ticket.category === "question_delete"
          ? "删除问题"
          : "清空应答逻辑";
  const destructive =
    ticket.category !== "question_review" &&
    ticket.category !== "question_modify";

  const submit = async (decision: "approve" | "reject") => {
    if (decision === "approve" && !confirmed) {
      toast.warning("请先确认已核对本次变更范围");
      return;
    }
    if (decision === "reject" && !decisionNote.trim()) {
      toast.warning("驳回时必须填写原因");
      return;
    }
    try {
      await decide.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        decision,
        ...(ticket.category === "question_review" ? { category } : {}),
        decisionNote: decisionNote.trim() || undefined,
      });
      await onDone();
      setOpen(false);
      toast.success(
        decision === "approve" ? "维护需求已通过" : "维护需求已驳回",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    }
  };

  return (
    <>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <ClipboardList className="h-4 w-4" /> 审批{actionLabel}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setConfirmed(false);
            setCategory("industry");
            setDecisionNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>问题维护审批 · {actionLabel}</DialogTitle>
            <DialogDescription>
              {systemAdminMode
                ? "系统管理员正在接管审批。请核对目标问题与用户提交内容后再决定。"
                : "请核对客户原问题与变更内容。通过后系统会自动执行，不需要再手工修改记录。"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 text-sm">
            <div className="rounded-xl border bg-muted/25 p-3">
              <p className="text-xs text-muted-foreground">原问题</p>
              <p className="mt-1 whitespace-pre-wrap leading-6">
                {payload.questionSnapshot || ticket.topic || "未记录"}
              </p>
            </div>
            {ticket.category === "question_modify" && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">修改为</p>
                <p className="mt-1 leading-6">
                  {payload.proposedQuestion || "未填写"}
                </p>
              </div>
            )}
            {ticket.category === "question_review" && (
              <label className="grid gap-2">
                问题类型
                <select
                  className="h-10 rounded-md border bg-background px-3"
                  value={category}
                  onChange={(event) =>
                    setCategory(
                      event.target.value as
                        | "industry"
                        | "competitor_comparison"
                        | "reputation"
                        | "product_scenario",
                    )
                  }
                >
                  <option value="industry">行业问题</option>
                  <option value="competitor_comparison">竞品对比</option>
                  <option value="reputation">口碑问题</option>
                  <option value="product_scenario">产品场景</option>
                </select>
              </label>
            )}
            {payload.reason && (
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">客户说明</p>
                <p className="mt-1 whitespace-pre-wrap leading-6">
                  {payload.reason}
                </p>
              </div>
            )}
            <label className="grid gap-2">
              审批说明（驳回时必填）
              <textarea
                className="min-h-24 rounded-md border p-3"
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                maxLength={2_000}
              />
            </label>
            <label className="flex items-start gap-2">
              <input
                className="mt-1"
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已核对目标问题与变更内容，确认通过后立即执行。
            </label>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void submit("reject")}
              disabled={decide.isPending}
            >
              驳回
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => void submit("approve")}
              disabled={decide.isPending || !confirmed}
            >
              {decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              通过并执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function KnowledgeResetDecision({
  projectAssignmentId,
  requestId,
  systemAdminMode = false,
  onDone,
}: {
  projectAssignmentId: string;
  requestId: string;
  systemAdminMode?: boolean;
  onDone: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const preview = trpc.delivery.mine.knowledgeResetPreview.useQuery(
    { projectAssignmentId, requestId },
    { enabled: open },
  );
  const decide = trpc.delivery.mine.decideKnowledgeReset.useMutation();
  const submit = async (decision: "approve" | "reject") => {
    if (!preview.data) return;
    if (decision === "approve" && !confirmed) {
      toast.warning("请先确认已核对清理范围");
      return;
    }
    if (decision === "reject" && !decisionNote.trim()) {
      toast.warning("驳回时必须填写原因");
      return;
    }
    try {
      await decide.mutateAsync({
        projectAssignmentId,
        requestId,
        expectedRevision: preview.data.expectedRevision,
        decision,
        decisionNote: decisionNote.trim() || undefined,
      });
      await onDone();
      setOpen(false);
      toast.success(
        decision === "approve"
          ? "知识库已完成重置"
          : "重置申请已驳回，知识库锁定已解除",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    }
  };
  const cleanup = preview.data?.cleanup;
  return (
    <>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" /> 审批知识库重置
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>知识库重置审批</DialogTitle>
            <DialogDescription>
              {systemAdminMode
                ? "系统管理员正在以异常接管身份执行。批准后正文、历史快照和上传文件内容不会保留。"
                : "只有该客户当前负责的 AI 运维工程师可以执行。批准后正文、历史快照和上传文件内容不会保留。"}
            </DialogDescription>
          </DialogHeader>
          {preview.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="py-6 text-sm text-destructive">
              {preview.error.message}
            </p>
          ) : cleanup ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <CleanupCount label="构建记录" value={cleanup.builds} />
                <CleanupCount label="展示版本" value={cleanup.snapshots} />
                <CleanupCount label="专属对话" value={cleanup.conversations} />
                <CleanupCount label="附件" value={cleanup.attachments} />
                <CleanupCount
                  label="官网导入回执"
                  value={cleanup.importReceipts}
                />
              </div>
              <label className="grid gap-2 text-sm">
                审批说明（驳回时必填）
                <textarea
                  className="min-h-24 rounded-md border p-3"
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  maxLength={2_000}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对清理预览，确认本操作会永久删除该客户全部知识库内容。
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void submit("reject")}
              disabled={decide.isPending || !preview.data}
            >
              驳回并解除锁定
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submit("approve")}
              disabled={decide.isPending || !preview.data || !confirmed}
            >
              {decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              二次确认并清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CleanupCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-muted/25 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
