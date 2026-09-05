import {
  ArrowUpRight,
  BadgeCheck,
  CalendarRange,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Database,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  MessageCircle,
  PackageCheck,
  RefreshCw,
  Settings2,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@shared/auth-constraints";
import type { AccountMarketEdition } from "@shared/account-edition";
import { keywordCategoryKey } from "@shared/keyword-categories";

import {
  getCapability,
  getRouteCapability,
  getWorkflowStepAccess,
  isCapabilityIncludedInPlan,
  type ServiceAction,
  type ServiceCapability,
  type ServiceCapabilityKey,
  type ServicePortalView,
  type ServiceWorkflowStep,
} from "./service-portal";

function displayDate(value: string) {
  if (!value) return "";
  const epochValue = /^\d{10,13}$/.test(value) ? Number(value) : value;
  const date = new Date(epochValue);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validityLabel(portal: ServicePortalView) {
  const from = displayDate(portal.plan.validFrom);
  const until = displayDate(portal.plan.validUntil);
  if (from && until) return `${from} 至 ${until}`;
  if (until) return `有效至 ${until}`;
  if (portal.plan.code === "basic") return "单次交付，账号内长期可查看";
  return "有效期待服务配置同步";
}

function progressiveQuotaDetails(portal: ServicePortalView) {
  const unlock = portal.quotaUnlock;
  if (
    portal.plan.code !== "luxury" ||
    !unlock ||
    unlock.current === null ||
    unlock.total === null ||
    unlock.total <= 1
  ) {
    return null;
  }
  const unlocked = portal.quotas.reduce(
    (sum, quota) => sum + (quota.limit ?? 0),
    0,
  );
  const entitlement = portal.quotas.reduce(
    (sum, quota) => sum + (quota.entitlementLimit ?? quota.limit ?? 0),
    0,
  );
  return {
    ...unlock,
    unlocked,
    entitlement,
    nextUnlockLabel: unlock.nextUnlockAt
      ? displayDate(unlock.nextUnlockAt)
      : "",
  };
}

function ProgressiveQuotaSummary({ portal }: { portal: ServicePortalView }) {
  const details = progressiveQuotaDetails(portal);
  if (!details) return null;
  return (
    <div
      className="mt-4 flex flex-col gap-1 rounded-xl border border-[#dfd2e8] bg-[#faf7fc] px-4 py-3 text-xs leading-5 text-[#716a80] sm:flex-row sm:items-center sm:justify-between"
      data-testid="quota-unlock-summary"
    >
      <span>
        <strong className="font-semibold text-[#5b2a86]">
          第 {details.current}/{details.total} 服务季度
        </strong>
        <span className="mx-2 text-[#c0b5c8]">·</span>
        当前已解锁 {details.unlocked} / 全年 {details.entitlement} 个问题
      </span>
      {details.capacityState === "exhausted" ? (
        <span>全年问题额度已用完</span>
      ) : details.nextUnlockLabel ? (
        <span>下一季度额度将于 {details.nextUnlockLabel} 开放</span>
      ) : null}
    </div>
  );
}

function actionHref(action: ServiceAction | undefined) {
  return action?.href?.trim() || "";
}

function ServiceActionButton({
  action,
  onRefresh,
  onOpenAccount,
  onNavigate,
  variant = "default",
  className = "",
}: {
  action?: ServiceAction;
  onRefresh?: () => void;
  onOpenAccount?: () => void;
  onNavigate?: (section: string, sub?: string | null) => void;
  variant?: "default" | "outline";
  className?: string;
}) {
  if (!action) return null;
  const href = actionHref(action);
  const content = (
    <>
      {action.kind === "refresh" ? (
        <RefreshCw className="h-4 w-4" />
      ) : action.kind.includes("purchase") ? (
        <ShoppingCart className="h-4 w-4" />
      ) : (
        <ArrowUpRight className="h-4 w-4" />
      )}
      {action.label}
    </>
  );

  if (href && !href.startsWith("/")) {
    return (
      <Button className={className} variant={variant} asChild>
        <a href={href} target="_blank" rel="noreferrer">
          {content}
        </a>
      </Button>
    );
  }

  return (
    <Button
      className={className}
      variant={variant}
      onClick={() => {
        if (action.kind === "refresh") {
          onRefresh?.();
          return;
        }
        if (action.kind === "view_knowledge") {
          onNavigate?.("knowledge-agent", "display");
          return;
        }
        if (
          action.kind === "start_knowledge_build" ||
          action.kind === "resume_knowledge_build"
        ) {
          onNavigate?.("knowledge-agent", "build");
          return;
        }
        if (
          action.kind === "await_question_catalog" ||
          action.kind === "generate_question_candidates" ||
          action.kind === "select_service_questions"
        ) {
          onNavigate?.("brand", "global-keywords");
          return;
        }
        if (action.kind === "optimize_service_questions") {
          onNavigate?.("intent", "question-optimization");
          return;
        }
        if (action.kind === "build_response_logic") {
          onNavigate?.("response-logic", "agent");
          return;
        }
        if (action.kind === "await_monitoring_data") {
          onNavigate?.("progress", "monitor");
          return;
        }
        if (action.kind === "await_channel_distribution") {
          onNavigate?.("progress", "monitor");
          return;
        }
        if (
          action.kind === "await_progress_report" ||
          action.kind === "view_progress_report"
        ) {
          onNavigate?.("progress", "optimization");
          return;
        }
        onOpenAccount?.();
      }}
    >
      {content}
    </Button>
  );
}

function AccessPill({ access }: { access: ServiceCapability }) {
  if (access.allowed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已开放
      </span>
    );
  }
  if (access.effectiveStatus === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
        <Clock3 className="h-3.5 w-3.5" />
        准备中
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
      <LockKeyhole className="h-3.5 w-3.5" />
      未开放
    </span>
  );
}

function ServicePathStatusPill({ unlocked }: { unlocked: boolean }) {
  if (unlocked) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已解锁
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
      <LockKeyhole className="h-3.5 w-3.5" />
      未解锁
    </span>
  );
}

const SERVICE_JOURNEY: Array<{
  key: ServiceCapabilityKey;
  title: string;
  description: string;
  route?: { section: string; sub: string };
}> = [
  {
    key: "knowledgeDisplay",
    title: "品牌知识库",
    description: "查看已迁移或已确认发布的知识库内容。",
    route: { section: "knowledge-agent", sub: "display" },
  },
  {
    key: "intentOptimization",
    title: "已购问题优化",
    description: "只围绕当前服务已购问题开展应答逻辑与内容优化。",
    route: { section: "intent", sub: "question-optimization" },
  },
  {
    key: "monitoring",
    title: "问题监控",
    description: "服务团队完成基线采集后，逐平台查看真实监控记录。",
    route: { section: "progress", sub: "monitor" },
  },
  {
    key: "progressReport",
    title: "进度报告",
    description: "按服务周期查看已发布的复测记录、发现与下一步。",
    route: { section: "progress", sub: "optimization" },
  },
];

const WORKFLOW_JOURNEY_META: Record<
  ServiceWorkflowStep["id"],
  {
    title: string;
    description: string;
    route: { section: string; sub: string };
  }
> = {
  knowledge: {
    title: "知识库智能体",
    description: "逐节点构建并发布当前服务使用的企业知识库。",
    route: { section: "knowledge-agent", sub: "build" },
  },
  question: {
    title: "品牌全域词库与选题",
    description:
      "知识库发布后，由 AI 监控与优化工程师通过需求配置并发布品牌词库，客户再按当期额度选择或自主填写优化问题。",
    route: { section: "brand", sub: "global-keywords" },
  },
  intent_optimization: {
    title: "问题优化",
    description: "逐题核对希望 AI 回答的重点、事实边界与优化方向。",
    route: { section: "intent", sub: "question-optimization" },
  },
  response_logic: {
    title: "应答逻辑",
    description: "逐题确认品牌应答逻辑与可核验表达。",
    route: { section: "response-logic", sub: "agent" },
  },
  monitoring: {
    title: "问题监控",
    description: "查看各平台真实回答与基线监控记录。",
    route: { section: "progress", sub: "monitor" },
  },
  channel_distribution: {
    title: "渠道分发",
    description: "查看已核验的媒体、渠道与引用分布。",
    route: { section: "progress", sub: "monitor" },
  },
  progress_report: {
    title: "进度报告",
    description: "查看复测发现与下一步。",
    route: { section: "progress", sub: "optimization" },
  },
};

type KnownServicePlanCode = Exclude<
  ServicePortalView["plan"]["code"],
  "unknown"
>;

type ServiceScopeModule = {
  key: string;
  label: string;
};

const SHARED_SERVICE_SCOPE_MODULES: readonly ServiceScopeModule[] = [
  { key: "intent-optimization", label: "问题优化" },
  { key: "response-logic", label: "应答逻辑智能体" },
  { key: "monitoring", label: "问题监控" },
  { key: "progress-report", label: "进度报告" },
  { key: "content-assets", label: "AI 友好内容资产" },
];

const SERVICE_SCOPE_MODULES_BY_PLAN: Record<
  KnownServicePlanCode,
  readonly ServiceScopeModule[]
> = {
  basic: [
    { key: "knowledge-display", label: "知识库展示" },
    ...SHARED_SERVICE_SCOPE_MODULES,
  ],
  advanced: [
    { key: "knowledge-build", label: "知识库智能体" },
    { key: "global-keywords", label: "品牌全域词库与选题" },
    ...SHARED_SERVICE_SCOPE_MODULES,
  ],
  luxury: [
    { key: "knowledge-build", label: "知识库智能体" },
    { key: "global-keywords", label: "品牌全域词库与选题" },
    ...SHARED_SERVICE_SCOPE_MODULES,
  ],
};

const OVERSEAS_SERVICE_SCOPE_MODULE: ServiceScopeModule = {
  key: "overseas-brand-tracking",
  label: "舆情监控·品牌追踪",
};

function serviceScopeModules(
  planCode: ServicePortalView["plan"]["code"],
  marketEdition: AccountMarketEdition,
) {
  if (planCode === "unknown") return [];
  const planModules = SERVICE_SCOPE_MODULES_BY_PLAN[planCode];
  return marketEdition === "overseas"
    ? [...planModules, OVERSEAS_SERVICE_SCOPE_MODULE]
    : planModules;
}

export function ServiceQuotaOverview({
  portal,
  className = "",
}: {
  portal: ServicePortalView;
  className?: string;
}) {
  const progressiveQuota = progressiveQuotaDetails(portal) !== null;
  return (
    <section
      className={`rounded-[22px] border border-[#e8e1ee] bg-white p-5 shadow-[0_14px_36px_rgba(33,19,58,.05)] md:p-6 ${className}`}
      aria-label="套餐配额"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f3edf8] text-[#5b2a86]">
          <PackageCheck className="h-5 w-5" />
        </span>
        <div>
          <h3 className="m-0 text-lg font-semibold text-[#171321]">套餐配额</h3>
        </div>
      </div>

      <ProgressiveQuotaSummary portal={portal} />

      {portal.quotas.length > 0 ? (
        <div className="mt-5 grid grid-cols-2 gap-3">
          {portal.quotas.map((quota) => {
            const synchronized =
              quota.used !== null && quota.limit !== null && quota.limit >= 0;
            const categoryKey = keywordCategoryKey(quota.key);
            return (
              <article
                key={quota.key}
                data-category={categoryKey || undefined}
                className="fm-question-category-surface rounded-2xl border border-[#ece6f1] p-4"
              >
                <span className="fm-question-category-ink text-xs font-semibold">
                  {quota.label}
                </span>
                <strong className="fm-question-category-ink mt-2 block text-xl">
                  {synchronized
                    ? progressiveQuota && quota.entitlementLimit !== undefined
                      ? `已用 ${quota.used} / 已解锁 ${quota.limit}`
                      : `${quota.used} / ${quota.limit}`
                    : "待同步"}
                  {synchronized && (
                    <small className="ml-1 text-xs font-medium text-[#8d8496]">
                      {quota.unit}
                    </small>
                  )}
                </strong>
                {synchronized &&
                  progressiveQuota &&
                  quota.entitlementLimit !== undefined && (
                    <p className="m-0 mt-1 text-xs text-[#8d8496]">
                      全年 {quota.entitlementLimit} {quota.unit}
                    </p>
                  )}
                {!synchronized && (
                  <p className="m-0 mt-2 text-xs text-[#8d8496]">
                    等待服务配置同步
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="m-0 mt-5 rounded-xl border border-dashed border-[#d8cde3] p-4 text-sm text-[#716a80]">
          套餐配额待服务配置同步。
        </p>
      )}
    </section>
  );
}

function ServiceCycleOverview({
  portal,
  onNavigate,
}: {
  portal: ServicePortalView;
  onNavigate: (section: string, sub?: string | null) => void;
}) {
  const progressiveQuota = progressiveQuotaDetails(portal) !== null;
  const purchasedQuestionLabel =
    portal.purchasedQuestions.length > 0
      ? `${portal.purchasedQuestions.length} 个已购问题`
      : "待确认问题清单";

  return (
    <section
      className="w-full min-w-0 max-w-full rounded-[22px] border border-[#e8e1ee] bg-white p-4 shadow-[0_14px_36px_rgba(33,19,58,.05)] md:p-5"
      aria-label="套餐配额"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#f3edf8] text-[#5b2a86]">
            <PackageCheck className="h-5 w-5" />
          </span>
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <strong className="text-base font-semibold text-[#171321]">
              套餐配额
            </strong>
          </div>
        </div>

        <div className="flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto sm:flex-nowrap">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <span className="text-xs text-[#716a80]">当前服务问题</span>
            <strong className="text-base font-semibold text-[#171321]">
              {purchasedQuestionLabel}
            </strong>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => onNavigate("intent", "question-optimization")}
          >
            查看已购问题
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ProgressiveQuotaSummary portal={portal} />

      {portal.quotas.length > 0 ? (
        <div className="mt-4 grid min-w-0 grid-cols-2 gap-2">
          {portal.quotas.map((quota) => {
            const synchronized =
              quota.used !== null && quota.limit !== null && quota.limit >= 0;
            const categoryKey = keywordCategoryKey(quota.key);
            return (
              <article
                key={quota.key}
                data-category={categoryKey || undefined}
                className="fm-question-category-surface min-w-0 rounded-xl border border-[#ece6f1] px-3 py-2.5"
              >
                <span className="fm-question-category-ink block truncate text-xs font-semibold">
                  {quota.label}
                </span>
                <strong className="fm-question-category-ink mt-1 block text-base">
                  {synchronized
                    ? progressiveQuota && quota.entitlementLimit !== undefined
                      ? `已用 ${quota.used} / 已解锁 ${quota.limit}`
                      : `${quota.used} / ${quota.limit}`
                    : "待同步"}
                </strong>
                {synchronized &&
                  progressiveQuota &&
                  quota.entitlementLimit !== undefined && (
                    <small className="mt-0.5 block text-xs text-[#8d8496]">
                      全年 {quota.entitlementLimit} {quota.unit}
                    </small>
                  )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="m-0 mt-4 rounded-xl border border-dashed border-[#d8cde3] px-4 py-3 text-sm text-[#716a80]">
          套餐配额待服务配置同步。
        </p>
      )}
    </section>
  );
}

export function ServiceHome({
  portal,
  companyName,
  marketEdition = "domestic",
  allowBrandTrackingManagement = false,
  showPublicOpinionJourneyItem = true,
  loading = false,
  error = false,
  onNavigate,
  onRefresh,
  onOpenAccount,
}: {
  portal: ServicePortalView;
  companyName?: string;
  marketEdition?: AccountMarketEdition;
  allowBrandTrackingManagement?: boolean;
  showPublicOpinionJourneyItem?: boolean;
  loading?: boolean;
  error?: boolean;
  onNavigate: (section: string, sub?: string | null) => void;
  onRefresh?: () => void;
  onOpenAccount?: () => void;
}) {
  const usesInteractiveKnowledgeFlow =
    portal.plan.code === "advanced" || portal.plan.code === "luxury";
  const knowledgeStep = portal.workflowSteps.find(
    (step) => step.id === "knowledge",
  );
  const knowledgeFlowComplete =
    knowledgeStep?.status === "complete" ||
    (!knowledgeStep && portal.knowledgeBase.status === "ready");
  const knowledgeNeedsInteractiveBuild =
    usesInteractiveKnowledgeFlow && !knowledgeFlowComplete;
  const channelDistributionStep = portal.workflowSteps.find(
    (step) => step.id === "channel_distribution",
  );
  const workflowJourneyItems =
    portal.workflowSteps.length > 0
      ? portal.workflowSteps
          .filter((step) => step.id !== "channel_distribution")
          .map((step) => {
            const meta = WORKFLOW_JOURNEY_META[step.id];
            const isKnowledge = step.id === "knowledge";
            const isQuestion = step.id === "question";
            const isMonitoring = step.id === "monitoring";
            const displayStep =
              isMonitoring &&
              step.status === "complete" &&
              channelDistributionStep
                ? channelDistributionStep
                : step;
            return {
              id: step.id,
              title: isKnowledge
                ? usesInteractiveKnowledgeFlow
                  ? "知识库智能体"
                  : "知识库展示"
                : isQuestion && usesInteractiveKnowledgeFlow
                  ? "品牌全域词库与选题"
                  : isMonitoring
                    ? "问题监控"
                    : step.label || meta.title,
              description: isKnowledge
                ? usesInteractiveKnowledgeFlow
                  ? "在系统内通过对话逐节点补齐并确认企业资料，全部完成后发布知识库。"
                  : "知识库由 Website 流程自动同步至本账号，服务团队可补录；完成后可直接查看。"
                : isQuestion && usesInteractiveKnowledgeFlow
                  ? "知识库发布后，由 AI 监控与优化工程师通过需求配置并发布品牌词库，客户再按本期额度选择或自主填写优化问题。"
                  : isMonitoring
                    ? "查看跨平台真实回答，并在同一页面核验媒体信源与渠道分发记录。"
                    : meta.description,
              route: isKnowledge
                ? {
                    section: "knowledge-agent",
                    sub: usesInteractiveKnowledgeFlow ? "build" : "display",
                  }
                : meta.route,
              step: displayStep,
              access: getWorkflowStepAccess(portal, displayStep),
            };
          })
      : SERVICE_JOURNEY.map((item) => ({
          id: item.key,
          title: item.title,
          description: item.description,
          route: item.route,
          step: null,
          access: getCapability(portal, item.key),
        }));
  const journeyItems =
    marketEdition === "overseas" && showPublicOpinionJourneyItem
      ? [
          ...workflowJourneyItems,
          {
            id: allowBrandTrackingManagement
              ? "public_opinion_management"
              : "public_opinion_monitoring",
            title: "舆情监控",
            description:
              "通过 FrontMind 品牌追踪智能体监测品牌评价、舆情趋势与潜在风险。",
            route: { section: "public-opinion", sub: "brand-tracking" },
            step: null,
            access: getCapability(portal, "brandTracking"),
          },
        ]
      : workflowJourneyItems;
  const contentOperationsAccess = getCapability(portal, "contentAssets");
  const planScopeModules = serviceScopeModules(portal.plan.code, marketEdition);

  if (loading) {
    return (
      <section className="page-shell">
        <div
          className="flex min-h-[420px] items-center justify-center rounded-[22px] border border-[#e8e1ee] bg-white"
          role="status"
        >
          <div className="flex items-center gap-3 text-sm text-[#716a80]">
            <Loader2 className="h-5 w-5 animate-spin text-[#5b2a86]" />
            正在同步账号与服务配置…
          </div>
        </div>
      </section>
    );
  }

  if (error || !portal.known) {
    return (
      <section className="page-shell">
        <div className="rounded-[22px] border border-amber-200 bg-amber-50/70 p-6 md:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
            <RefreshCw className="h-5 w-5" />
          </div>
          <h2 className="mt-5 text-2xl font-semibold text-[#171321]">
            服务配置暂未同步
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-[#716a80]">
            为避免错误开放未购买的功能，看板已暂时锁定服务页面。刷新后仍未恢复时，请联系管理员核对账号套餐。
          </p>
          <Button className="mt-5" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
            刷新服务配置
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="page-shell w-full min-w-0">
      <header className="mb-6">
        <span className="eyebrow">MindPromise 智诺 · 服务首页</span>
      </header>

      <div
        className="grid w-full min-w-0 gap-4 lg:grid-cols-2"
        data-testid="service-home-overview"
      >
        <article
          className="min-w-0 overflow-hidden rounded-[22px] border border-[#5b2a86]/15 bg-[linear-gradient(135deg,#25124f,#5b2a86)] p-6 text-white shadow-[0_18px_48px_rgba(33,19,58,.13)] md:p-8"
          aria-label={`当前服务版本：${portal.plan.name}`}
        >
          <div>
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/80">
                <PackageCheck className="h-3.5 w-3.5" />
                当前服务版本
              </span>
              <div className="mt-8 grid gap-3">
                <h3 className="m-0 text-3xl font-semibold leading-tight text-white">
                  {portal.plan.name}
                </h3>
                <p className="m-0 text-sm leading-6 text-white/70">
                  {portal.plan.statusLabel}
                  {portal.plan.billingLabel
                    ? ` · ${portal.plan.billingLabel}`
                    : ""}
                </p>
              </div>
            </div>
          </div>
          <div
            className="mt-8 grid min-w-0 gap-3"
            data-testid="service-plan-summary"
          >
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.07] p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <span className="flex shrink-0 items-center gap-2 text-xs text-white/55">
                  <CalendarRange className="h-4 w-4" />
                  服务有效期
                </span>
                <strong className="min-w-0 text-right text-sm leading-5 text-white">
                  {validityLabel(portal)}
                </strong>
              </div>
            </div>
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.07] p-4">
              <span className="flex items-center gap-2 text-xs text-white/55">
                <Sparkles className="h-4 w-4" />
                套餐范围
              </span>
              {planScopeModules.length > 0 ? (
                <ul
                  className="m-0 mt-3 flex min-w-0 list-none flex-wrap gap-2 p-0"
                  data-testid="service-plan-scope"
                  aria-label="套餐包含的智能服务板块"
                >
                  {planScopeModules.map((module) => (
                    <li
                      key={module.key}
                      className="flex min-h-11 max-w-full shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-3 py-2.5 text-xs font-semibold leading-5 text-white"
                    >
                      <CheckCircle2
                        className="h-3.5 w-3.5 shrink-0 text-white/70"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 whitespace-nowrap">
                        {module.label}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mt-3 text-sm leading-6 text-white/70">
                  待服务配置同步
                </p>
              )}
            </div>
          </div>
        </article>

        <div
          className="grid w-full min-w-0 max-w-full content-start gap-4"
          aria-label="知识库与套餐配额"
        >
          <article className="w-full min-w-0 max-w-full rounded-[22px] border border-[#e8e1ee] bg-white p-5 shadow-[0_14px_36px_rgba(33,19,58,.06)] md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-[#716a80]">
                  当前知识库
                </span>
                <div className="mt-2">
                  <h3 className="m-0 text-xl font-semibold text-[#171321]">
                    {knowledgeNeedsInteractiveBuild
                      ? "知识库智能体待完成"
                      : portal.knowledgeBase.status === "ready"
                        ? "企业知识库"
                        : portal.knowledgeBase.statusLabel}
                  </h3>
                </div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#5b2a86]/8 text-[#5b2a86]">
                <Database className="h-5 w-5" />
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-[#716a80]">
              {knowledgeNeedsInteractiveBuild
                ? portal.knowledgeBase.status === "ready"
                  ? "账号中已有历史知识库可供预填参考；当前套餐仍需在系统内逐节点完成知识库智能体流程并发布知识库。"
                  : "进阶版与豪华版从知识库智能体开始：先在系统内完成资料采集、逐节点确认与知识库发布，再进入品牌全域词库和选题。"
                : usesInteractiveKnowledgeFlow &&
                    portal.knowledgeBase.status === "ready"
                  ? "当前知识库由知识库智能体逐节点确认后发布，可直接查看并继续维护。"
                  : portal.knowledgeBase.status === "ready"
                    ? "知识库由 Website 流程自动同步至本账号，服务团队可补录，可直接查看。"
                    : portal.knowledgeBase.status === "importing"
                      ? "Website 流程正在自动同步知识库至本账号，服务团队也可补录；完成后会在此显示。"
                      : "Website 流程尚未完成知识库自动同步；服务团队可补录，完成后会在此显示。"}
            </p>
            {portal.knowledgeBase.updatedAt && (
              <p className="mt-2 text-xs text-[#9a94a8]">
                最近更新：{displayDate(portal.knowledgeBase.updatedAt)}
              </p>
            )}
            <Button
              className="mt-5 w-full justify-between"
              variant="outline"
              onClick={() =>
                onNavigate(
                  "knowledge-agent",
                  knowledgeNeedsInteractiveBuild ? "build" : "display",
                )
              }
            >
              {knowledgeNeedsInteractiveBuild
                ? "进入知识库智能体"
                : "查看知识库"}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </article>

          <ServiceCycleOverview portal={portal} onNavigate={onNavigate} />
        </div>
      </div>

      <section
        className="mt-5 rounded-[22px] border border-[#e8e1ee] bg-white p-5 shadow-[0_14px_36px_rgba(33,19,58,.05)] md:p-6"
        aria-label="智能交付"
      >
        <div className="mb-5">
          <span className="fm-eyebrow text-[#9a94a8]">智能交付</span>
          <h3 className="mt-1 text-xl font-semibold text-[#171321]">
            智能服务路径
          </h3>
        </div>
        <div className="grid gap-3" aria-label="GEO 服务交付">
          <div className="mb-1 flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8d8496]">
              GEO 服务交付
            </span>
            <span className="h-px flex-1 bg-[#ece6f1]" aria-hidden="true" />
          </div>
          {journeyItems.map((item, index) => {
            const { access } = item;
            const capabilityKey = item.route
              ? getRouteCapability(item.route.section, item.route.sub)
              : null;
            const planLocked = Boolean(
              capabilityKey &&
                !isCapabilityIncludedInPlan(portal.plan.code, capabilityKey),
            );
            return (
              <article
                key={item.id}
                className="grid gap-3 rounded-2xl border border-[#ece6f1] bg-[#fbf9fd] p-4 sm:grid-cols-[38px_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-sm font-bold text-[#5b2a86] shadow-sm">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="m-0 text-sm font-semibold text-[#171321]">
                      {item.title}
                    </h4>
                    <ServicePathStatusPill
                      unlocked={
                        item.step
                          ? item.step.status !== "locked"
                          : access.allowed
                      }
                    />
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-[#716a80]">
                    {access.allowed
                      ? item.description
                      : access.reason || item.description}
                  </p>
                </div>
                {item.step?.status === "ready" && access.nextAction ? (
                  <ServiceActionButton
                    action={access.nextAction}
                    onRefresh={onRefresh}
                    onOpenAccount={onOpenAccount}
                    onNavigate={onNavigate}
                    variant="outline"
                    className="justify-self-start sm:justify-self-end"
                  />
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-self-start text-[#5b2a86] sm:justify-self-end"
                    disabled={planLocked}
                    aria-disabled={planLocked}
                    title={planLocked ? access.reason : undefined}
                    onClick={
                      planLocked
                        ? undefined
                        : () => onNavigate(item.route!.section, item.route!.sub)
                    }
                  >
                    {item.step?.status === "complete"
                      ? "查看"
                      : item.step?.status === "locked"
                        ? "查看原因"
                        : "进入"}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                )}
              </article>
            );
          })}
        </div>
        <div
          className="mt-6 grid gap-3 border-t border-[#ece6f1] pt-6"
          aria-label="持续内容运营"
        >
          <div className="mb-1 flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8d8496]">
              持续内容运营
            </span>
            <span className="h-px flex-1 bg-[#ece6f1]" aria-hidden="true" />
          </div>
          <article className="grid gap-3 rounded-2xl border border-[#e2d7e9] bg-[linear-gradient(135deg,#fbf8fd,#f5eff9)] p-4 sm:grid-cols-[38px_minmax(0,1fr)_auto] sm:items-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#5b2a86] shadow-sm">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="m-0 text-sm font-semibold text-[#171321]">
                  AI 友好内容资产
                </h4>
                <ServicePathStatusPill
                  unlocked={contentOperationsAccess.allowed}
                />
              </div>
              <p className="mt-1.5 text-xs leading-5 text-[#716a80]">
                {contentOperationsAccess.allowed
                  ? "在 GEO 交付之外，自主提交并持续管理 AI 友好内容更新。"
                  : contentOperationsAccess.reason ||
                    "当前套餐尚未开放持续内容运营。"}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="justify-self-start text-[#5b2a86] sm:justify-self-end"
              disabled={
                !isCapabilityIncludedInPlan(portal.plan.code, "contentAssets")
              }
              aria-disabled={
                !isCapabilityIncludedInPlan(portal.plan.code, "contentAssets")
              }
              title={
                !isCapabilityIncludedInPlan(portal.plan.code, "contentAssets")
                  ? contentOperationsAccess.reason
                  : undefined
              }
              onClick={
                isCapabilityIncludedInPlan(portal.plan.code, "contentAssets")
                  ? () => onNavigate("semantic", "content-assets")
                  : undefined
              }
            >
              {contentOperationsAccess.allowed ? "管理" : "查看原因"}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </article>
        </div>
      </section>
    </section>
  );
}

export function ServiceLockedPage({
  title,
  access,
  portal,
  onRefresh,
  onOpenAccount,
  onNavigate,
}: {
  title: string;
  access: ServiceCapability;
  portal: ServicePortalView;
  onRefresh?: () => void;
  onOpenAccount?: () => void;
  onNavigate?: (section: string, sub?: string | null) => void;
}) {
  const pending = access.effectiveStatus === "pending";
  const upgradeAction = portal.purchaseActions.find(
    (action) => action.kind === "upgrade",
  );
  const nextAction =
    !pending && access.effectiveStatus === "locked" && upgradeAction
      ? upgradeAction
      : (access.nextAction ?? portal.primaryNextAction);
  return (
    <section className="page-shell">
      <div className="mx-auto mt-8 max-w-3xl overflow-hidden rounded-[24px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)]">
        <div className="border-b border-[#eee8f2] bg-[linear-gradient(135deg,rgba(91,42,134,.08),rgba(200,144,19,.08))] p-6 md:p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#5b2a86] shadow-sm">
            {pending ? (
              <Clock3 className="h-6 w-6" />
            ) : (
              <LockKeyhole className="h-6 w-6" />
            )}
          </div>
          <span className="fm-eyebrow mt-5 block text-[#8d7b9e]">
            {portal.plan.name} · {pending ? "服务准备中" : "功能未开放"}
          </span>
          <h2 className="mt-2 text-2xl font-semibold text-[#171321]">
            {title}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[#625a70]">
            {access.reason || "当前服务尚未开放此页面。"}
          </p>
        </div>
        <div className="grid gap-4 p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-8">
          <div>
            <span className="text-xs font-semibold text-[#9a94a8]">
              当前版本
            </span>
            <p className="m-0 mt-1 text-sm font-semibold text-[#332a48]">
              {portal.plan.name}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!pending && (
              <Button variant="outline" onClick={onOpenAccount}>
                <Settings2 className="h-4 w-4" />
                账号与服务
              </Button>
            )}
            <ServiceActionButton
              action={nextAction}
              onRefresh={onRefresh}
              onOpenAccount={onOpenAccount}
              onNavigate={onNavigate}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function AccountInfoBlock({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
      <span className="mt-0.5 text-primary">{icon}</span>
      <div className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <strong className="mt-1 block break-words text-sm font-medium text-foreground">
          {value || "待同步"}
        </strong>
      </div>
    </div>
  );
}

function PreviewSecurityActions() {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        variant="outline"
        onClick={() =>
          toast.info("预览模式不提交密码", {
            description: "正式账号中会打开安全的密码修改表单。",
          })
        }
      >
        <KeyRound className="h-4 w-4" />
        修改密码
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.info("预览模式不执行退出")}
      >
        <LogOut className="h-4 w-4" />
        退出登录
      </Button>
    </div>
  );
}

function requiresSalesAdvisor(action: ServiceAction) {
  return (
    action.kind.includes("upgrade") ||
    action.targetPlan === "advanced" ||
    action.targetPlan === "luxury"
  );
}

function FormalPurchaseActions({
  actions,
  onContactAdvisor,
}: {
  actions: ServiceAction[];
  onContactAdvisor: (action: ServiceAction) => void;
}) {
  const purchaseIntentMutation = (
    trpc.workspace as any
  ).purchaseIntent.useMutation();

  const startPurchase = async (action: ServiceAction) => {
    if (requiresSalesAdvisor(action)) {
      onContactAdvisor(action);
      return;
    }
    if (!action.targetPlan) {
      toast.error("购买版本尚未配置");
      return;
    }
    const kind = action.kind.includes("purchase")
      ? "repeat_basic"
      : action.kind.includes("renew")
        ? "renewal"
        : "upgrade";
    try {
      const result = await purchaseIntentMutation.mutateAsync({
        targetPlanCode: action.targetPlan,
        kind,
      });
      if (!result?.purchaseUrl) {
        toast.error("购买入口暂不可用");
        return;
      }
      window.location.assign(result.purchaseUrl);
    } catch (error) {
      toast.error("无法打开购买入口", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <div className="grid gap-2">
      {actions.map((action) => (
        <Button
          key={`${action.kind}-${action.label}`}
          variant="outline"
          className="w-full justify-between"
          disabled={purchaseIntentMutation.isPending}
          onClick={() => void startPurchase(action)}
        >
          <span className="inline-flex items-center gap-2">
            {requiresSalesAdvisor(action) ? (
              <MessageCircle className="h-4 w-4" />
            ) : purchaseIntentMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShoppingCart className="h-4 w-4" />
            )}
            {action.label}
          </span>
          <ArrowUpRight className="h-4 w-4" />
        </Button>
      ))}
    </div>
  );
}

export function SalesAdvisorDialog({
  open,
  onOpenChange,
  targetPlan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetPlan?: ServiceAction["targetPlan"];
}) {
  const planLabel =
    targetPlan === "luxury"
      ? "豪华版"
      : targetPlan === "advanced"
        ? "进阶版"
        : "企业服务";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="z-[1210] w-[min(calc(100vw-1rem),460px)] overflow-hidden bg-white p-0 shadow-2xl"
        overlayClassName="z-[1200] bg-black/35"
      >
        <DialogHeader className="border-b bg-muted/20 px-6 pb-5 pt-6 text-left">
          <DialogTitle className="flex items-center gap-2 pr-8 text-xl">
            <MessageCircle className="h-5 w-5 text-primary" />
            联系服务专员
          </DialogTitle>
          <DialogDescription className="mt-2 leading-6">
            {planLabel}
            需要由专员确认企业需求、服务周期与交付范围，请使用企业微信扫码联系。
          </DialogDescription>
          {targetPlan === "luxury" && (
            <p className="mb-0 mt-3 rounded-xl border border-[#dfd2e8] bg-white px-3 py-2 text-xs leading-5 text-[#5f5668]">
              豪华版全年包含 4 个行业排名词、4 个竞品对比词、4 个美誉舆情词和 20
              个产品场景词；额度按四个服务季度逐步开放，每季度新增 1、1、1、5
              个。
            </p>
          )}
        </DialogHeader>
        <div className="px-6 pb-6 pt-5">
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-white p-3">
            <img
              src="/frontmind-sales-wechat.png?v=wecom-20260801"
              alt="FrontMind 服务专员企业微信二维码"
              className="mx-auto block max-h-[430px] w-full object-contain"
            />
          </div>
          <p className="mb-0 mt-4 text-center text-xs leading-5 text-muted-foreground">
            使用企业微信扫码添加后，请备注企业名称与希望咨询的套餐版本。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FormalSecurityActions() {
  const [, setLocation] = useLocation();
  const { logout, loading } = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await logout();
      setLocation("/login", { replace: true });
    } catch (error) {
      toast.error("退出失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => setPasswordOpen(true)}>
          <KeyRound className="h-4 w-4" />
          修改密码
        </Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void handleLogout()}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
          退出登录
        </Button>
      </div>
      {passwordOpen && (
        <ChangePasswordDialog
          open={passwordOpen}
          onOpenChange={setPasswordOpen}
        />
      )}
    </>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const changePasswordMutation = trpc.auth.changePassword.useMutation();

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    changePasswordMutation.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && changePasswordMutation.isPending) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentPassword || !newPassword || !confirmation) {
      toast.error("请填写所有密码字段");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
      return;
    }
    if (newPassword !== confirmation) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (newPassword === currentPassword) {
      toast.error("新密码不能与当前密码相同");
      return;
    }

    try {
      await changePasswordMutation.mutateAsync({
        currentPassword,
        newPassword,
      });
      toast.success("密码已更新，请重新登录");
      reset();
      onOpenChange(false);
      window.location.replace("/login");
    } catch (error) {
      toast.error("无法修改密码", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1rem),440px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <KeyRound className="h-5 w-5 text-primary" />
            修改密码
          </DialogTitle>
          <DialogDescription>
            更新当前账号密码。请使用至少 {MIN_PASSWORD_LENGTH}{" "}
            个字符的独立密码。
          </DialogDescription>
        </DialogHeader>
        <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="service-current-password">当前密码</Label>
            <Input
              id="service-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="service-new-password">新密码</Label>
            <Input
              id="service-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="service-confirm-password">确认新密码</Label>
            <Input
              id="service-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={changePasswordMutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              保存新密码
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ServiceAccountDrawer({
  portal,
  companyName,
  preview,
  open,
  onOpenChange,
}: {
  portal: ServicePortalView;
  companyName: string;
  preview: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [advisorAction, setAdvisorAction] = useState<ServiceAction | null>(
    null,
  );
  const openAdvisor = (action: ServiceAction) => {
    onOpenChange(false);
    setAdvisorAction(action);
  };
  const initials = useMemo(
    () =>
      Array.from(portal.account.displayName || "用户")
        .slice(0, 2)
        .join(""),
    [portal.account.displayName],
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="账号与服务"
            className="flex w-full items-center gap-3 rounded-2xl border border-white/10 px-3 py-3 text-left transition hover:border-white/20"
            style={{
              color: "white",
              background:
                "linear-gradient(135deg, rgba(255,255,255,.1), rgba(255,255,255,.04))",
            }}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-xs font-bold">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm font-semibold text-white">
                {portal.account.displayName}
              </strong>
              <small className="mt-0.5 block truncate text-xs text-white/55">
                {portal.plan.name}
              </small>
            </span>
            <Settings2 className="h-4 w-4 shrink-0 text-white/55" />
          </button>
        </SheetTrigger>
        <SheetContent
          className="z-[1210] w-[min(94vw,440px)] gap-0 overflow-hidden p-0 sm:max-w-[440px]"
          overlayClassName="z-[1200]"
        >
          <SheetHeader className="shrink-0 gap-2 border-b bg-muted/20 px-6 pb-5 pt-6 pr-12 text-left">
            <SheetTitle className="flex items-center gap-2 text-xl">
              <CircleUserRound className="h-5 w-5 text-primary" />
              账号与服务
            </SheetTitle>
            <SheetDescription className="m-0 leading-6">
              查看当前套餐、交付范围和账号安全设置。
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-6 overflow-y-auto p-5 pb-8">
            <section className="rounded-2xl bg-[linear-gradient(135deg,#25124f,#5b2a86)] p-5 text-white">
              <span className="text-xs font-semibold text-white/60">
                当前服务版本
              </span>
              <div className="mt-2">
                <div>
                  <h3 className="m-0 text-2xl font-semibold text-white">
                    {portal.plan.name}
                  </h3>
                  <p className="mt-1 text-xs text-white/65">
                    {portal.plan.statusLabel}
                  </p>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-xs leading-5 text-white/75">
                有效期：{validityLabel(portal)}
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                账号信息
              </h3>
              <div className="grid gap-2">
                <AccountInfoBlock
                  icon={<PackageCheck className="h-4 w-4" />}
                  label="企业名称"
                  value={companyName}
                />
                <AccountInfoBlock
                  icon={<BadgeCheck className="h-4 w-4" />}
                  label="登录账号"
                  value={portal.account.username}
                />
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                购买与升级
              </h3>
              {portal.purchaseActions.length > 0 ? (
                preview ? (
                  <div className="grid gap-2">
                    {portal.purchaseActions.map((action) =>
                      requiresSalesAdvisor(action) ? (
                        <Button
                          key={`${action.kind}-${action.label}`}
                          variant="outline"
                          className="w-full justify-between"
                          onClick={() => openAdvisor(action)}
                        >
                          <span className="inline-flex items-center gap-2">
                            <MessageCircle className="h-4 w-4" />
                            {action.label}
                          </span>
                          <ArrowUpRight className="h-4 w-4" />
                        </Button>
                      ) : (
                        <ServiceActionButton
                          key={`${action.kind}-${action.label}`}
                          action={action}
                          variant="outline"
                          className="w-full justify-between"
                          onOpenAccount={() =>
                            toast.info("购买入口待服务端配置", {
                              description:
                                "当前页面没有收到购买链接，请联系服务顾问完成下单。",
                            })
                          }
                        />
                      ),
                    )}
                  </div>
                ) : (
                  <FormalPurchaseActions
                    actions={portal.purchaseActions}
                    onContactAdvisor={openAdvisor}
                  />
                )
              ) : (
                <p className="rounded-xl border border-dashed p-3 text-xs leading-5 text-muted-foreground">
                  购买入口尚未配置。请联系服务顾问继续购买普通版或升级套餐。
                </p>
              )}
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                账号安全
              </h3>
              {preview ? <PreviewSecurityActions /> : <FormalSecurityActions />}
            </section>
          </div>
        </SheetContent>
      </Sheet>
      <SalesAdvisorDialog
        open={Boolean(advisorAction)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setAdvisorAction(null);
        }}
        targetPlan={advisorAction?.targetPlan}
      />
    </>
  );
}

export function ServiceConfigurationNotice({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-[#d8cde3] bg-white/70 p-4 text-sm leading-6 text-[#716a80]">
      {children}
    </div>
  );
}
