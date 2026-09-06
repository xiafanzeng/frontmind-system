// @ts-nocheck
import { Link } from "wouter";
import { lazy, Suspense, useState, useMemo, useEffect } from "react";
import {
  Activity,
  Database,
  House,
  LockKeyhole,
  Shield,
  Target,
  Search,
  Filter,
  ChevronRight,
  X,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  Check,
  Eye,
  BarChart3,
  ArrowDownRight,
  Minus,
  MessageSquareQuote,
  Layers3,
  ChartNoAxesColumnIncreasing,
  Radar,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

import ResponseLogicWorkspace, {
  ResponseLogicConfirmationBoard,
  useResponseLogicWorkspaceState,
} from "@/components/ResponseLogicWorkspace";
import ManagedCitationWorkbench, {
  PreviewCitationWorkbench,
} from "./ManagedCitationWorkbench";
import ManagedKeywordTables from "./ManagedKeywordTables";
import QuestionIntakePanel, {
  previewQuestionCategoryMeta,
  type PreviewConfirmedQuestion,
  type PreviewQuestionCategory,
} from "./QuestionIntakePanel";
import ProgressReportWorkspace from "./ProgressReportWorkspace";
import HistoricalResultsReadOnly from "./HistoricalResultsReadOnly";
import ConnectedSiteOpsConversationPanel from "./siteops/ConnectedSiteOpsConversationPanel";
import { trpc } from "@/lib/trpc";
import {
  KEYWORD_CATEGORY_OPTIONS,
  keywordCategoryKey,
  keywordCategoryLabel,
  keywordCategoryTone,
} from "@shared/keyword-categories";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import {
  getCapability,
  getPreviewPlanCode,
  getRouteCapability,
  isCapabilityIncludedInPlan,
  normalizeServicePortal,
} from "./service-portal";
import {
  citationModelLabels,
  loadCitationDistributionData,
  type QuestionCitationRow,
} from "./citationDistributionData";
import {
  SalesAdvisorDialog,
  ServiceAccountDrawer,
  ServiceHome,
  ServiceLockedPage,
  ServiceQuotaOverview,
} from "./service-portal-ui";
import "./dashboard-styles.css";

export { ManagedKeywordTables };

const QUESTION_QUOTA_KEY_BY_CATEGORY = {
  industry: "industry",
  competitor_comparison: "competitor",
  reputation: "reputation",
  product_scenario: "scenario",
};

export function buildKeywordQuotaAvailability(portal) {
  const unlock =
    portal.plan.code === "luxury" &&
    portal.quotaUnlock?.total !== null &&
    portal.quotaUnlock?.total !== undefined &&
    portal.quotaUnlock.total > 1
      ? portal.quotaUnlock
      : undefined;
  const futureUnlock = Boolean(
    unlock &&
      unlock.capacityState === "available" &&
      unlock.current !== null &&
      unlock.total !== null &&
      unlock.current < unlock.total,
  );
  return Object.fromEntries(
    Object.entries(QUESTION_QUOTA_KEY_BY_CATEGORY).flatMap(
      ([category, quotaKey]) => {
        const quota = portal.quotas.find((item) => item.key === quotaKey);
        if (!quota || quota.limit === null || quota.used === null) return [];
        const blockedBySchedule =
          unlock?.capacityState === "awaiting_unlock" ||
          unlock?.capacityState === "exhausted";
        const available = !blockedBySchedule && quota.used < quota.limit;
        const annualExhausted =
          unlock?.capacityState === "exhausted" ||
          (unlock?.capacityState !== null &&
            unlock?.capacityState !== undefined &&
            quota.entitlementLimit !== undefined &&
            quota.entitlementLimit !== null &&
            quota.used >= quota.entitlementLimit);
        return [
          [
            category,
            {
              available,
              unavailableLabel: annualExhausted
                ? "全年额度已用完"
                : unlock?.capacityState === "awaiting_unlock" || futureUnlock
                  ? "下一季度开放"
                  : "该类额度已满",
            },
          ],
        ];
      },
    ),
  );
}

const DashboardSkeletonEditor = lazy(
  () => import("@/components/DashboardSkeletonEditor"),
);

const EmbeddedKnowledgeBasePanel = lazy(
  () => import("@/components/EmbeddedKnowledgeBasePanel"),
);

const BrandTrackingAgentPanel = lazy(
  () => import("@/components/BrandTrackingAgentPanel"),
);

const QuestionMonitoringWorkspace = lazy(
  () => import("./QuestionMonitoringWorkspace"),
);

const FORMAL_QUERY_REFRESH_INTERVAL_MS = 30_000;

const geoIntentMeta = {
  basic: {
    label: "产品场景",
    short: "产品场景",
    desc: "围绕应用需求与决策场景，核验产品、方案与使用路径是否回答完整。",
    tone: "green",
  },
  reputation: {
    label: "美誉舆情",
    short: "美誉舆情",
    desc: "围绕信任证据与品牌口碑，核验价值判断是否有事实与第三方依据支撑。",
    tone: "purple",
  },
  comparison: {
    label: "竞品对比",
    short: "竞品对比",
    desc: "围绕差异定位与选择依据，建立客观、可核验且不过度承诺的比较口径。",
    tone: "blue",
  },
  ranking: {
    label: "行业排名",
    short: "行业排名",
    desc: "围绕行业排名词与品牌优胜，监测出现率、答案位次、权威引用与品类入口覆盖。",
    tone: "gold",
  },
};

const brandSubpages = [
  {
    id: "build",
    section: "knowledge-agent",
    label: "知识库智能体",
    desc: "通过对话确认企业事实并构建可持续更新的品牌知识库。",
  },
  {
    id: "display",
    section: "knowledge-agent",
    label: "知识库展示",
    desc: "查看已迁移或已确认发布的知识库内容。",
  },
  {
    id: "global-keywords",
    label: "品牌全域词库",
    desc: "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。",
  },
];

const serviceSubpages = [
  {
    id: "home",
    section: "service",
    label: "服务首页",
    matchSectionOnly: true,
  },
];

const intentSubpages = [
  { id: "question-optimization", label: "问题优化" },
  {
    id: "agent",
    label: "应答逻辑智能体",
    section: "response-logic",
    matchSectionOnly: true,
  },
];

const progressSubpages = [
  {
    id: "monitor",
    label: "问题监控",
    desc: "按问题查看跨平台答案，并在同一页面核验信源引用与渠道分发记录。",
  },
  {
    id: "optimization",
    label: "进度报告",
    desc: "按服务周期查看已发布的复测记录、发现与下一步。",
  },
];

const publicOpinionSubpages = [
  {
    id: "brand-tracking",
    section: "public-opinion",
    label: "品牌追踪智能体",
    desc: "通过 FrontMind 品牌追踪智能体追踪品牌评价、舆情趋势与潜在风险。",
  },
];

const semanticSubpages = [
  {
    id: "content-assets",
    section: "semantic",
    label: "内容资产运营",
    desc: "按内容类型提交制作与行业权威信源发布需求。",
  },
  {
    id: "website-management",
    section: "semantic",
    label: SITEOPS_CUSTOMER_DISPLAY_NAME,
    desc: "先购买并提交域名，领取 AI 运维返回的备案服务码后完成 ICP 备案。",
  },
];

function previewDeliveryQuota(planCode, type, used = 0) {
  const limits = {
    basic: { content_asset_publish: 1, website_content_publish: 0 },
    advanced: { content_asset_publish: 5, website_content_publish: 20 },
    luxury: { content_asset_publish: 20, website_content_publish: 100 },
    unknown: { content_asset_publish: 0, website_content_publish: 0 },
  };
  const limit = limits[planCode]?.[type] ?? 0;
  return {
    type,
    allowed: limit > 0,
    used: Math.min(used, limit),
    reserved: Math.min(used, limit),
    consumed: 0,
    limit,
    remaining: Math.max(limit - used, 0),
    periodId: `preview-${planCode}`,
    validFrom: null,
    validUntil: null,
    reason: limit > 0 ? null : "当前版本不包含此项需求服务，历史记录仍可查看。",
  };
}

const toneMap = {
  purple: "#5B2A86",
  gold: "#C89013",
  blue: "#1D4E89",
  green: "#16794F",
  rose: "#BA2454",
};

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\[\]\(@[^)]*\)/g, "")
    .replace(/\[citation:\d+\]/g, "")
    .replace(/@replace=\d+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFFFD]/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanAnswerCopy(value) {
  if (value === null || value === undefined) return "";
  let text = String(value)
    .replace(/\[\]\(@[^)]*\)/g, "")
    .replace(/\[citation:\d+\]/g, "")
    .replace(/@replace=\d+/g, "")
    .replace(/\[\]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFFFD]/g, "")
    .replace(
      /如果你[^。！？\n]{0,120}(?:问我|继续问我|再问我|告诉我|需要)[^。！？\n]*[。！？～~]?/g,
      "",
    )
    .replace(
      /如需[^。！？\n]{0,120}(?:问我|了解|联系|获取)[^。！？\n]*[。！？～~]?/g,
      "",
    )
    .replace(/需要我[^。！？\n]{0,120}[吗么][？?]?/g, "")
    .replace(/要不要我[^。！？\n]{0,120}[？?]?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function excerpt(value, max = 520) {
  const text = safeText(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderAnswerBlocks(value) {
  const clean = cleanAnswerCopy(value);
  return <MarkdownRenderer content={clean} />;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function buildManagedQuestionGroups(questions) {
  const groups = new Map();
  for (const item of questions || []) {
    if (!groups.has(item.groupId)) {
      const semanticTone =
        keywordCategoryTone(item.groupId) ||
        keywordCategoryTone(item.groupTitle);
      groups.set(item.groupId, {
        id: item.groupId,
        title: item.groupTitle,
        subtitle: item.groupSubtitle || "",
        tone: semanticTone || item.tone || "plum",
        questions: [],
      });
    }
    groups.get(item.groupId).questions.push({
      id: item.id,
      question: item.question,
      intent: item.intent || "",
      summary: item.summary || "",
    });
  }
  return [...groups.values()];
}

export function buildServiceQuestionGroups(purchasedQuestions, managedGroups) {
  if (!purchasedQuestions?.length) return managedGroups;

  const knownQuestions = new Map();
  for (const group of managedGroups || []) {
    for (const question of group.questions || []) {
      knownQuestions.set(question.id, question);
    }
  }

  const groupMeta = {
    basic: {
      id: "purchased",
      title: "已购问题",
      subtitle: "官网购买时已确认的问题",
      tone: "plum",
    },
    industry: {
      id: "ranking",
      title: "行业排名词",
      subtitle: "行业入口与品牌优胜问题",
      tone: "amber",
    },
    competitor: {
      id: "comparison",
      title: "竞品对比词",
      subtitle: "差异定位与选择依据",
      tone: "blue",
    },
    reputation: {
      id: "reputation",
      title: "美誉舆情词",
      subtitle: "信任证据与品牌口碑",
      tone: "plum",
    },
    scenario: {
      id: "scenario",
      title: "产品场景词",
      subtitle: "应用需求与决策问题",
      tone: "teal",
    },
  };
  const groupOrder = [
    groupMeta.industry.id,
    groupMeta.competitor.id,
    groupMeta.reputation.id,
    groupMeta.scenario.id,
    groupMeta.basic.id,
  ];
  const groups = new Map();
  for (const purchased of purchasedQuestions) {
    const meta = groupMeta[purchased.kind] || groupMeta.basic;
    if (!groups.has(meta.id)) {
      groups.set(meta.id, { ...meta, questions: [] });
    }
    const known = [
      purchased.id,
      purchased.externalQuestionId,
      purchased.sourceQuestionId,
    ]
      .filter(Boolean)
      .map((id) => knownQuestions.get(id))
      .find(Boolean);
    groups.get(meta.id).questions.push({
      id: purchased.id,
      question: purchased.question,
      intent: purchased.intent || known?.intent || "",
      summary: purchased.rationale || known?.summary || "",
      revision: purchased.revision,
      intentRevision: purchased.intentRevision,
      intentConfirmedRevision: purchased.intentConfirmedRevision,
      intentConfirmedAt: purchased.intentConfirmedAt,
      intentConfirmed: purchased.intentConfirmed,
    });
  }
  return groupOrder.map((groupId) => groups.get(groupId)).filter(Boolean);
}

// ==================== MAIN DASHBOARD ====================
export default function UserBrandDashboard({ initialSection = "brand" }) {
  return <PersistentUserBrandDashboard initialSection={initialSection} />;
}

type PreviewUserBrandDashboardProps = {
  initialSection?: string;
  planCode?: "basic" | "advanced" | "luxury" | "unknown";
  fixtures?: {
    getServicePortal: (planCode: "basic" | "advanced" | "luxury") => unknown;
    contentAssetCatalog: readonly unknown[];
    overview: { brand: string };
    brandBuilding: unknown;
    globalKeywordBank: unknown;
    geoIntents: readonly unknown[];
    geoAnswerBooks: Record<string, unknown>;
    optimizationReport: unknown;
    publishedContentAssets?: readonly unknown[];
    knowledgeProgress: unknown;
    knowledgeSnapshot: unknown;
    buildHistoricalResults?: (question: any) => any;
  };
};

export function PreviewUserBrandDashboard({
  initialSection = "brand",
  planCode: previewPlanCode = undefined,
  fixtures,
}: PreviewUserBrandDashboardProps) {
  const planCode =
    previewPlanCode ||
    getPreviewPlanCode(
      typeof window === "undefined" ? "" : window.location.search,
    );
  if (planCode === "unknown") {
    return (
      <div role="alert" className="p-6 text-sm text-[#716a80]">
        当前开发预览未指定可用套餐。
      </div>
    );
  }
  if (!fixtures) {
    return (
      <div role="alert" className="p-6 text-sm text-[#716a80]">
        当前开发预览未加载验收数据。
      </div>
    );
  }
  return (
    <UserBrandDashboardContent
      preview
      initialSection={initialSection}
      servicePortalPayload={fixtures.getServicePortal(planCode)}
      servicePortalLoading={false}
      servicePortalError={false}
      managedPayload={{
        brandName: fixtures.overview.brand,
        questions: [],
        contentAssets: fixtures.publishedContentAssets || [],
      }}
      managedRevision={0}
      dashboardLoading={false}
      dashboardError={false}
      previewBrandName={fixtures.overview.brand}
      renderPreviewBrandSection={({
        sub,
        onUseQuestion,
        quotaAvailability,
      }) => (
        <BrandSection
          sub={sub}
          onUseQuestion={onUseQuestion}
          quotaAvailability={quotaAvailability}
          brandBuildingData={fixtures.brandBuilding}
          globalKeywordData={fixtures.globalKeywordBank}
        />
      )}
      renderPreviewMonitoringWorkspace={({ channelDistributionAccess }) => (
        <PreviewQuestionMonitoringWorkspace
          channelDistributionAccess={channelDistributionAccess}
          intents={fixtures.geoIntents}
          answerBooks={fixtures.geoAnswerBooks}
        />
      )}
      renderPreviewProgressSection={({ sub, questionGroups }) =>
        sub === "optimization" ? (
          <OptimizationReport
            questionGroups={questionGroups}
            report={fixtures.optimizationReport}
          />
        ) : (
          <PreviewProgressOverview />
        )
      }
      previewKnowledgeData={{
        progress: fixtures.knowledgeProgress,
        snapshot: fixtures.knowledgeSnapshot,
      }}
      buildPreviewHistoricalResults={fixtures.buildHistoricalResults}
    />
  );
}

function PersistentUserBrandDashboard({ initialSection }) {
  const { user } = useAuth();
  const [editingSection, setEditingSection] = useState(null);
  const queryOptions = {
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: FORMAL_QUERY_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  };
  const portal = trpc.workspace.portal.useQuery(undefined, queryOptions);
  const dashboard = trpc.workspace.dashboard.useQuery(undefined, queryOptions);
  const refresh = async () => {
    await Promise.all([portal.refetch(), dashboard.refetch()]);
  };
  if (editingSection && user)
    return (
      <DashboardSkeletonEditor
        customerMode
        userId={user.id}
        initialSection={editingSection}
        workspace={dashboard.data}
        loading={dashboard.isLoading}
        dashboardLayout="workspace"
        marketEdition={user.marketEdition || "domestic"}
        servicePortal={portal.data}
        servicePortalLoading={portal.isLoading}
        servicePortalError={portal.isError}
        onRefreshServicePortal={refresh}
        authoritativeQuestions={portal.data?.purchasedQuestions}
        authoritativeQuestionsLoading={portal.isLoading}
        authoritativeQuestionsError={portal.error?.message}
        onExitDashboard={() => setEditingSection(null)}
        onWorkspaceChanged={refresh}
      />
    );
  return (
    <UserBrandDashboardContent
      preview={false}
      marketEdition={user?.marketEdition || "domestic"}
      initialSection={initialSection}
      servicePortalPayload={portal.data}
      servicePortalLoading={portal.isLoading}
      servicePortalError={portal.isError}
      onRefreshServicePortal={refresh}
      managedPayload={dashboard.data?.payload}
      managedRevision={dashboard.data?.revision ?? null}
      dashboardLoading={dashboard.isLoading}
      dashboardError={dashboard.isError}
      onEditDashboard={(section = "home") => setEditingSection(section)}
    />
  );
}

function UserBrandDashboardContent({
  preview,
  marketEdition = "domestic",
  initialSection,
  servicePortalPayload,
  servicePortalLoading,
  servicePortalError,
  onRefreshServicePortal,
  managedPayload,
  managedRevision = null,
  dashboardLoading,
  dashboardError,
  onEditDashboard,
  previewBrandName = "企业看板",
  renderPreviewBrandSection = null,
  renderPreviewMonitoringWorkspace = null,
  renderPreviewProgressSection = null,
  previewKnowledgeData = undefined,
  buildPreviewHistoricalResults = null,
}) {
  const previewMode = import.meta.env.DEV && preview;
  const [route, setRoute] = useState(
    initialSection === "knowledge-agent"
      ? { section: "knowledge-agent", sub: "build" }
      : { section: "service", sub: null },
  );
  const [accountOpen, setAccountOpen] = useState(false);
  const [salesAdvisorOpen, setSalesAdvisorOpen] = useState(false);
  const [responseQuestionId, setResponseQuestionId] = useState(null);
  const [questionIntakeDraft, setQuestionIntakeDraft] = useState(null);
  const servicePortal = useMemo(
    () => normalizeServicePortal(servicePortalPayload),
    [servicePortalPayload],
  );
  const keywordQuotaAvailability = useMemo(
    () => buildKeywordQuotaAvailability(servicePortal),
    [servicePortal],
  );
  const managedQuestionGroups = useMemo(
    () => buildManagedQuestionGroups(managedPayload?.questions || []),
    [managedPayload?.questions],
  );
  const activeQuestionGroups = useMemo(
    () =>
      buildServiceQuestionGroups(
        servicePortal.purchasedQuestions,
        managedQuestionGroups,
      ),
    [managedQuestionGroups, servicePortal.purchasedQuestions],
  );
  const progressQuestionGroups = useMemo(() => {
    if (previewMode) return activeQuestionGroups;
    const confirmedQuestions = servicePortal.purchasedQuestions.filter(
      (question) => question.responseLogicConfirmed,
    );
    const hasConfirmationProjection = servicePortal.purchasedQuestions.some(
      (question) => question.responseLogicConfirmed !== undefined,
    );
    return buildServiceQuestionGroups(
      confirmedQuestions.length > 0
        ? confirmedQuestions
        : hasConfirmationProjection
          ? []
          : servicePortal.purchasedQuestions,
      [],
    );
  }, [activeQuestionGroups, previewMode, servicePortal.purchasedQuestions]);
  const responseLogicWorkspaceState =
    useResponseLogicWorkspaceState(activeQuestionGroups);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigate = (section, sub = null) => {
    const legacyMonitoringRoute =
      (section === "intent" && sub === "monitor") ||
      (section === "progress" &&
        (sub === "distribution" || sub === "sentiment"));
    setRoute(
      legacyMonitoringRoute
        ? { section: "progress", sub: "monitor" }
        : { section, sub },
    );
    setMobileNavOpen(false);
  };
  const openResponseLogic = (questionId) => {
    setResponseQuestionId(questionId);
    navigate("response-logic", "agent");
  };
  const handleResponseLogicPublished = (questionId) => {
    setResponseQuestionId(questionId);
    void onRefreshServicePortal?.();
    navigate("intent", "question-optimization");
  };
  const useBrandQuestion = (question) => {
    if (question.status === "selected") {
      setResponseQuestionId(question.id);
      setQuestionIntakeDraft(null);
    } else {
      setQuestionIntakeDraft({
        origin: "brand_keyword_library",
        question: question.question,
        category: question.category,
        libraryRef:
          managedRevision !== null &&
          question.tableId &&
          Number.isInteger(question.rowIndex)
            ? {
                dashboardRevision: managedRevision,
                tableId: question.tableId,
                rowIndex: question.rowIndex,
              }
            : null,
      });
    }
    navigate("intent", "question-optimization");
  };
  const capabilityKey = getRouteCapability(route.section, route.sub);
  const routeAccess = capabilityKey
    ? getCapability(servicePortal, capabilityKey)
    : null;
  const routeLocked = Boolean(routeAccess && !routeAccess.allowed);
  const knowledgeBuildWorkspace =
    route.section === "knowledge-agent" && route.sub !== "display";
  const brandTrackingWorkspace =
    marketEdition === "overseas" && route.section === "public-opinion";
  const immersiveAgentWorkspace =
    knowledgeBuildWorkspace || brandTrackingWorkspace;
  const routeTitle =
    route.section === "public-opinion"
      ? "品牌追踪智能体"
      : route.section === "knowledge-agent"
        ? route.sub === "display"
          ? "知识库展示"
          : "知识库智能体"
        : route.section === "brand"
          ? route.sub === "global-keywords"
            ? "品牌全域词库"
            : "品牌建设"
          : route.section === "intent"
            ? "问题优化"
            : route.section === "response-logic"
              ? "应答逻辑智能体"
              : route.section === "progress"
                ? route.sub === "monitor"
                  ? "问题监控"
                  : "进度报告"
                : route.section === "semantic"
                  ? route.sub === "website-management"
                    ? SITEOPS_CUSTOMER_DISPLAY_NAME
                    : "内容资产运营"
                  : "服务页面";
  return (
    <div
      className={`user-brand-dashboard ${
        immersiveAgentWorkspace ? "knowledge-build-workspace" : ""
      }`}
    >
      <div
        className={`app-shell ${mobileNavOpen ? "nav-open" : ""} ${
          immersiveAgentWorkspace ? "knowledge-build-app-shell" : ""
        }`}
      >
        {/* 移动端汉堡按钮 */}
        <button
          className="mobile-menu-btn"
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
          aria-label="切换菜单"
        >
          {mobileNavOpen ? <X size={22} /> : <BarChart3 size={22} />}
        </button>
        {/* 移动端遮罩层 */}
        {mobileNavOpen && (
          <div
            className="mobile-nav-overlay"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <Sidebar
          route={route}
          onNavigate={navigate}
          brandName={
            managedPayload?.brandName ||
            servicePortal.account.displayName ||
            (previewMode ? previewBrandName : "企业看板")
          }
          portal={servicePortal}
          preview={previewMode}
          marketEdition={marketEdition}
          accountOpen={accountOpen}
          onAccountOpenChange={setAccountOpen}
        />
        <main
          className={`dashboard-main ${
            immersiveAgentWorkspace ? "knowledge-build-main" : ""
          }`}
        >
          {!immersiveAgentWorkspace && (
            <ProjectRibbon
              brandName={
                managedPayload?.brandName ||
                servicePortal.account.displayName ||
                (previewMode ? previewBrandName : "企业看板")
              }
            />
          )}
          {!immersiveAgentWorkspace && onEditDashboard && (
            <div className="flex justify-end px-6 py-3">
              <Button variant="outline" onClick={() => onEditDashboard("home")}>
                编辑看板内容
              </Button>
            </div>
          )}
          {route.section === "service" ? (
            <ServiceHome
              portal={servicePortal}
              companyName={
                managedPayload?.brandName ||
                servicePortal.account.displayName ||
                (previewMode ? previewBrandName : "企业看板")
              }
              marketEdition={marketEdition}
              loading={servicePortalLoading}
              error={servicePortalError}
              onNavigate={navigate}
              onRefresh={onRefreshServicePortal}
              onOpenAccount={() => setAccountOpen(true)}
            />
          ) : routeLocked ? (
            <ServiceLockedPage
              title={routeTitle}
              access={routeAccess}
              portal={servicePortal}
              onRefresh={onRefreshServicePortal}
              onOpenAccount={() => setAccountOpen(true)}
              onNavigate={navigate}
            />
          ) : (
            <>
              {route.section === "historical-results" && (
                <HistoricalResultsReadOnly
                  questionId={route.sub || ""}
                  portal={servicePortal}
                  onBack={() => navigate("service")}
                  resultOverride={
                    previewMode
                      ? (() => {
                          const question =
                            servicePortal.historicalQuestions.find(
                              (item) => item.id === (route.sub || ""),
                            );
                          return question && buildPreviewHistoricalResults
                            ? buildPreviewHistoricalResults(question)
                            : null;
                        })()
                      : undefined
                  }
                  overrideError={
                    previewMode ? "未找到该只读历史问题或预览结果。" : undefined
                  }
                />
              )}
              {route.section === "brand" &&
                (previewMode ? (
                  renderPreviewBrandSection?.({
                    sub: route.sub,
                    onUseQuestion: useBrandQuestion,
                    quotaAvailability: keywordQuotaAvailability,
                  }) || (
                    <ManagedModuleEmpty
                      title="品牌建设"
                      description="当前预览未配置品牌建设内容。"
                    />
                  )
                ) : (
                  <ManagedKeywordTables
                    tables={managedPayload?.keywordTables || []}
                    loading={dashboardLoading}
                    error={dashboardError}
                    onUseQuestion={useBrandQuestion}
                    quotaAvailability={keywordQuotaAvailability}
                    generationEnabled
                  />
                ))}
              {route.section === "intent" && (
                <ProblemOptimizationResults
                  portal={servicePortal}
                  preview={previewMode}
                  workspaceState={responseLogicWorkspaceState}
                  initialQuestionId={responseQuestionId}
                  intakeDraft={questionIntakeDraft}
                  onIntakeDraftChange={setQuestionIntakeDraft}
                  onPortalRefresh={onRefreshServicePortal}
                  questionGroups={activeQuestionGroups}
                  onOpenResponseLogic={openResponseLogic}
                  onOpenBrandQuestions={() =>
                    navigate("brand", "global-keywords")
                  }
                />
              )}
              {route.section === "response-logic" &&
                (activeQuestionGroups.length > 0 ? (
                  <ResponseLogicWorkspace
                    preview={previewMode}
                    initialQuestionId={responseQuestionId}
                    workspaceState={responseLogicWorkspaceState}
                    questionGroups={activeQuestionGroups}
                    onSelectedQuestionChange={setResponseQuestionId}
                    onPublished={handleResponseLogicPublished}
                  />
                ) : (
                  <ManagedModuleEmpty
                    title="应答逻辑智能体"
                    description="当前账号没有已购问题。服务问题同步后，可在这里逐题对话、核验并确认应答逻辑。"
                  />
                ))}
              {route.section === "progress" &&
                (route.sub === "monitor" ? (
                  <IntentSection
                    preview={previewMode}
                    questionGroups={progressQuestionGroups}
                    renderPreview={renderPreviewMonitoringWorkspace}
                    channelDistributionAccess={getCapability(
                      servicePortal,
                      "channelDistribution",
                    )}
                  />
                ) : (
                  <ProgressSection
                    sub={route.sub}
                    preview={previewMode}
                    renderPreview={renderPreviewProgressSection}
                    questionGroups={progressQuestionGroups}
                    optimizationReport={
                      managedPayload?.optimizationReport || null
                    }
                    progressReports={managedPayload?.progressReports || []}
                  />
                ))}
              {route.section === "semantic" &&
                (route.sub === "website-management" ? (
                  <section className="page-shell">
                    <PageHeader
                      title={SITEOPS_CUSTOMER_DISPLAY_NAME}
                      desc="管理官网及已发布内容。"
                    />
                    {!previewMode && <ConnectedSiteOpsConversationPanel />}
                    {onEditDashboard && (
                      <Button
                        variant="outline"
                        onClick={() => onEditDashboard("website")}
                      >
                        编辑官网内容
                      </Button>
                    )}
                    <PublishedContentAssets
                      assets={managedPayload?.contentAssets || []}
                    />
                  </section>
                ) : (
                  <SemanticAssetSystem
                    publishedAssets={managedPayload?.contentAssets || []}
                    onEdit={
                      onEditDashboard
                        ? () => onEditDashboard("content")
                        : undefined
                    }
                  />
                ))}
              {route.section === "knowledge-agent" && (
                <Suspense
                  fallback={
                    <div className="citation-workbench-loading" role="status">
                      <span aria-hidden="true" />
                      正在载入知识库…
                    </div>
                  }
                >
                  <EmbeddedKnowledgeBasePanel
                    preview={previewMode}
                    previewData={previewKnowledgeData}
                    page={route.sub === "display" ? "display" : "build"}
                    onPageChange={(page) => navigate("knowledge-agent", page)}
                    mode={route.sub === "display" ? "standard" : "workspace"}
                  />
                </Suspense>
              )}
              {brandTrackingWorkspace && (
                <Suspense
                  fallback={
                    <div className="citation-workbench-loading" role="status">
                      <span aria-hidden="true" />
                      正在载入品牌追踪智能体…
                    </div>
                  }
                >
                  <BrandTrackingAgentPanel
                    brandName={
                      managedPayload?.brandName ||
                      servicePortal.account.displayName ||
                      "该品牌"
                    }
                  />
                </Suspense>
              )}
            </>
          )}
        </main>
      </div>
      <SalesAdvisorDialog
        open={salesAdvisorOpen}
        onOpenChange={setSalesAdvisorOpen}
      />
    </div>
  );
}

// ==================== SIDEBAR ====================
function Sidebar({
  route,
  onNavigate,
  brandName,
  portal,
  preview,
  marketEdition,
  accountOpen,
  onAccountOpenChange,
}) {
  return (
    <aside className="global-nav">
      <div className="nav-title-block">
        <img
          className="frontmind-logo frontmind-reference-logo"
          src="/frontmind-contract-logo-white.svg"
          alt="FrontMind"
        />
        <p>智能品牌优化看板</p>
      </div>
      <div className="nav-group-card promise-card">
        <div className="nav-group-head">
          <span>MindPromise智诺</span>
        </div>
        <SidebarGroup
          id="service"
          label="服务概览"
          icon={House}
          items={serviceSubpages}
          route={route}
          onNavigate={onNavigate}
          portal={portal}
        />
        <SidebarGroup
          id="brand"
          label="品牌建设"
          icon={Shield}
          items={brandSubpages}
          route={route}
          onNavigate={onNavigate}
          portal={portal}
          activeSections={["knowledge-agent"]}
        />
        <SidebarGroup
          id="intent"
          label="意图优化"
          icon={Target}
          items={intentSubpages}
          route={route}
          onNavigate={onNavigate}
          portal={portal}
          activeSections={["response-logic"]}
        />
        <SidebarGroup
          id="progress"
          label="进度监控"
          icon={Activity}
          items={progressSubpages}
          route={route}
          onNavigate={onNavigate}
          portal={portal}
        />
        {marketEdition === "overseas" && (
          <SidebarGroup
            id="public-opinion"
            label="舆情监控"
            icon={Radar}
            items={publicOpinionSubpages}
            route={route}
            onNavigate={onNavigate}
            portal={portal}
          />
        )}
        <SidebarGroup
          id="semantic"
          label="AI 友好内容资产"
          icon={Database}
          items={semanticSubpages}
          route={route}
          onNavigate={onNavigate}
          portal={portal}
        />
      </div>
      {!preview && (
        <div className="nav-group-card promise-card">
          <div className="nav-group-head">
            <span>监控与发布</span>
          </div>
          <Link
            href="/monitoring-system"
            className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-white/75 hover:bg-white/10 hover:text-white"
          >
            <Activity size={17} />
            问题监控
          </Link>
          <Link
            href="/publishing"
            className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-white/75 hover:bg-white/10 hover:text-white"
          >
            <Database size={17} />
            媒体发布
          </Link>
        </div>
      )}
      <div className="mt-auto grid gap-2">
        <ServiceAccountDrawer
          portal={portal}
          companyName={brandName}
          preview={preview}
          open={accountOpen}
          onOpenChange={onAccountOpenChange}
        />
      </div>
    </aside>
  );
}

function SidebarGroup({
  id,
  label,
  icon,
  items,
  route,
  onNavigate,
  portal,
  activeSections = [],
}) {
  const active = route.section === id || activeSections.includes(route.section);
  return (
    <>
      <NavSectionLabel label={label} icon={icon} active={active} />
      <SubNav
        items={items}
        section={id}
        route={route}
        onNavigate={onNavigate}
        portal={portal}
      />
    </>
  );
}

function NavSectionLabel({ label, icon: Icon, active }) {
  return (
    <div className={`nav-section-label ${active ? "active" : ""}`}>
      {Icon && <Icon className="nav-icon" size={16} />}
      <span>{safeText(label)}</span>
    </div>
  );
}
function SubNav({ items, section, route, onNavigate, portal }) {
  return (
    <div className="sub-nav">
      {items.map((item) => {
        const targetSection = item.section || section;
        const capabilityKey = getRouteCapability(targetSection, item.id);
        const access = capabilityKey
          ? getCapability(portal, capabilityKey)
          : null;
        const showPlanLock = Boolean(
          capabilityKey &&
            !isCapabilityIncludedInPlan(portal.plan.code, capabilityKey),
        );
        const active =
          route.section === targetSection &&
          (item.matchSectionOnly || route.sub === item.id);
        return (
          <button
            className={active ? "active" : ""}
            key={`${targetSection}-${item.id}`}
            onClick={
              showPlanLock
                ? undefined
                : () => onNavigate(targetSection, item.id)
            }
            disabled={showPlanLock}
            aria-disabled={showPlanLock}
            title={showPlanLock ? access?.reason : undefined}
            style={
              showPlanLock
                ? { gridTemplateColumns: "minmax(0, 1fr) auto" }
                : undefined
            }
          >
            <span>{safeText(item.label)}</span>
            {showPlanLock && (
              <LockKeyhole
                aria-hidden="true"
                size={12}
                style={{ marginLeft: "auto", opacity: 0.6 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
function ProjectRibbon({ brandName }) {
  return (
    <div className="project-ribbon final-ribbon">
      <div>
        <span>FrontMind 智能品牌优化看板</span>
        <h1>{safeText(brandName)}</h1>
      </div>
    </div>
  );
}
function PageHeader({ eyebrow, title, desc }) {
  return (
    <header className="page-header">
      <span className="eyebrow">{safeText(eyebrow)}</span>
      <h2>{safeText(title)}</h2>
      <p>{safeText(desc)}</p>
    </header>
  );
}

function ManagedModuleEmpty({ title, description, action = null }) {
  return (
    <section className="page-shell">
      <PageHeader eyebrow="MindPromise智诺" title={title} desc={description} />
      {action && <div className="mb-4 flex justify-end">{action}</div>}
      <section className="panel">
        <div className="panel-head">
          <h3>暂无已发布内容</h3>
        </div>
        <div className="empty-state">
          <Database size={24} />
          <p>{safeText(description)}</p>
        </div>
      </section>
    </section>
  );
}

export function ManagedDashboardSection({
  payload,
  loading,
  error,
  embedded = false,
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const sections = useMemo(() => {
    if (!payload) return [];
    if (!normalizedSearch) return payload.sections;
    return payload.sections
      .map((section) => {
        const sectionMatches = [
          section.title,
          section.subtitle,
          section.body,
        ].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(normalizedSearch),
        );
        const items = section.items.filter((item) =>
          [item.title, item.description, item.meta].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(normalizedSearch),
          ),
        );
        return sectionMatches ? section : { ...section, items };
      })
      .filter(
        (section) =>
          section.items.length > 0 ||
          [section.title, section.subtitle, section.body].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(normalizedSearch),
          ),
      );
  }, [normalizedSearch, payload]);

  if (loading) {
    return (
      <ManagedModuleEmpty
        title="品牌资料"
        description="正在载入当前企业已发布的内容。"
      />
    );
  }
  if (error) {
    return (
      <ManagedModuleEmpty
        title="品牌资料"
        description="当前企业内容暂时无法载入，请稍后刷新。"
      />
    );
  }
  if (!payload) {
    return null;
  }

  return (
    <section
      className={`page-shell brand-deep-page ${
        embedded ? "managed-dashboard-embedded" : ""
      }`}
    >
      <PageHeader
        eyebrow={embedded ? "客户看板预览" : "MindPromise智诺 / 品牌建设"}
        title={payload.headline}
        desc={payload.summary}
      />
      <div className="saas-toolbar">
        <div className="saas-search">
          <Search size={16} />
          <input
            type="search"
            placeholder="搜索内容条目..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          {searchTerm && (
            <button
              type="button"
              className="clear-btn"
              aria-label="清空搜索"
              onClick={() => setSearchTerm("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="saas-entity-grid">
        {payload.metrics.map((metric) => (
          <article className="entity-card" key={metric.label}>
            <div className="entity-card-header">
              <h4>{safeText(metric.label)}</h4>
            </div>
            <strong style={{ fontSize: "1.45rem", color: "#5b2a86" }}>
              {safeText(metric.value)}
              {metric.unit ? ` ${safeText(metric.unit)}` : ""}
            </strong>
            {metric.note && <p>{safeText(metric.note)}</p>}
          </article>
        ))}
      </div>

      <div className="saas-content-area" style={{ marginTop: 20 }}>
        {sections.map((section) => (
          <Panel title={section.title} key={section.id}>
            {section.subtitle && (
              <p className="panel-subtitle">{safeText(section.subtitle)}</p>
            )}
            {section.body && <MarkdownRenderer content={section.body} />}
            {section.items.length > 0 && (
              <div className="saas-entity-grid" style={{ marginTop: 16 }}>
                {section.items.map((item, index) => (
                  <article
                    className="entity-card"
                    key={`${section.id}-${item.title}-${index}`}
                  >
                    {item.imageUrl && (
                      <img
                        src={item.imageUrl}
                        alt={item.title}
                        loading="lazy"
                        style={{
                          width: "100%",
                          aspectRatio: "16 / 9",
                          objectFit: "cover",
                          borderRadius: 12,
                          marginBottom: 12,
                        }}
                      />
                    )}
                    <div className="entity-card-header">
                      <h4>{safeText(item.title)}</h4>
                    </div>
                    {item.description && (
                      <MarkdownRenderer content={item.description} />
                    )}
                    {item.meta && (
                      <div className="entity-card-footer">
                        <small>{safeText(item.meta)}</small>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
            {(section.tables || []).map((table) => (
              <section
                key={`${section.id}-${table.id}`}
                style={{ marginTop: 20 }}
                aria-label={safeText(table.title)}
              >
                <div className="panel-head" style={{ marginBottom: 10 }}>
                  <div>
                    <h4>{safeText(table.title)}</h4>
                    {table.description && (
                      <p className="panel-subtitle">
                        {safeText(table.description)}
                      </p>
                    )}
                  </div>
                </div>
                <DataTable headers={table.columns} rows={table.rows} />
              </section>
            ))}
          </Panel>
        ))}
        {sections.length === 0 && (
          <section className="panel">
            <div className="empty-state">
              <Database size={22} />
              <p>
                {normalizedSearch
                  ? "没有找到匹配的内容条目。"
                  : "管理员尚未发布当前企业的内容资料。"}
              </p>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function Panel({ title, children, className = "", actions = null }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h3>{safeText(title)}</h3>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
function DataTable({ headers, rows }) {
  return (
    <div className="table-frame">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{safeText(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{safeText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function ProgressBar({ value, color = "#5B2A86" }) {
  return (
    <div className="progress">
      <i
        style={{
          width: `${Math.min(Number(value) || 0, 100)}%`,
          background: color,
        }}
      />
    </div>
  );
}
function TokenCloud({ items }) {
  return (
    <div className="token-cloud">
      {items.map((item) => (
        <span key={item}>{safeText(item)}</span>
      ))}
    </div>
  );
}

// ==================== BRAND SECTION (SaaS化) ====================
function BrandSection({
  sub,
  onUseQuestion,
  quotaAvailability,
  brandBuildingData,
  globalKeywordData,
}) {
  if (sub === "global-keywords")
    return (
      <BrandGlobalKeywords
        onUseQuestion={onUseQuestion}
        quotaAvailability={quotaAvailability}
        bank={globalKeywordData}
      />
    );
  return <BrandKnowledgeSystem data={brandBuildingData} />;
}

function BrandKnowledgeSystem({ data }) {
  const {
    knowledgeBase,
    knowledgeManuals,
    visualSystem,
    qaArchitecture,
    positioning,
    verbalVisual,
    semanticAudit,
  } = data;
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = [
    { id: "overview", label: "体系总览" },
    { id: "facts", label: "事实图谱" },
    { id: "manuals", label: "资料手册" },
    { id: "qa", label: "问答架构" },
    { id: "visual", label: "视觉体系" },
    { id: "audit", label: "语义治理" },
  ];

  const factDimensions = Array.isArray(knowledgeBase?.facts)
    ? knowledgeBase.facts
        .map((item) => (Array.isArray(item) ? item[0] : ""))
        .filter(Boolean)
        .join("、")
    : "";
  const finalSystemRows = [
    ["品牌事实", factDimensions || "暂无已发布的品牌事实"],
    ["品牌定位", positioning.statement],
    ["核心人群", positioning.audience],
    ["差异化价值", positioning.differentiator],
    ["话语与视觉", "核心词、禁用表达、品牌谚语、视觉色板、视觉 Do / Don't"],
    ["问答架构", qaArchitecture.path],
    ["内容资产落地", "FAQ、证据卡片、落地页蓝图、视觉模板、内容日历"],
  ];

  return (
    <section className="page-shell brand-deep-page">
      <PageHeader
        eyebrow="MindPromise智诺 / 品牌建设"
        title="品牌知识库"
        desc="统一管理品牌事实、定位口径、话语手册与视觉约束，形成可持续更新的内容生产标准。"
      />

      {/* SaaS化：搜索栏 + Tab导航 */}
      <div className="saas-toolbar">
        <div className="saas-search">
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索内容条目..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className="clear-btn" onClick={() => setSearchTerm("")}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="saas-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" && (
        <>
          <div className="saas-entity-grid">
            {finalSystemRows.map(([module, content]) => (
              <article className="entity-card" key={module}>
                <div className="entity-card-header">
                  <h4>{module}</h4>
                </div>
                <p>{safeText(content)}</p>
                <div className="entity-card-footer">
                  <small>
                    最后更新：{safeText(data.updatedAt || "暂无更新时间")}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {activeTab === "facts" && (
        <div className="saas-content-area">
          <Panel
            title="基础事实图谱"
            actions={
              <span className="entity-count">
                {knowledgeBase.facts.length} 条
              </span>
            }
          >
            <div className="fact-entity-list">
              {knowledgeBase.facts.map(([dim, content]) => (
                <div className="fact-entity-row" key={dim}>
                  <div className="fact-label">{safeText(dim)}</div>
                  <div className="fact-content">{safeText(content)}</div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel
            title="证据锚点"
            actions={
              <span className="entity-count">
                {knowledgeBase.evidence.length} 条
              </span>
            }
          >
            <div className="evidence-grid">
              {knowledgeBase.evidence.map((item) => (
                <div className="evidence-chip" key={item}>
                  <CheckCircle size={14} />
                  <span>{safeText(item)}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "manuals" && (
        <div className="manual-card-grid">
          {knowledgeManuals.map((manual) => (
            <article key={manual.module} className="manual-card-saas">
              <div className="manual-card-head">
                <span className="manual-module-tag">
                  {safeText(manual.module)}
                </span>
              </div>
              <h4>{safeText(manual.title)}</h4>
              <p>{safeText(manual.content)}</p>
              <div className="manual-deliverables">
                {manual.deliverables.map((d) => (
                  <div className="deliverable-item" key={d.name}>
                    <strong>{safeText(d.name)}</strong>
                    <small>{safeText(d.detail)}</small>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      {activeTab === "qa" && (
        <Panel title="问答 QA 架构">
          <div className="qa-system-card">
            <div className="qa-path-badge">
              <span>{safeText(qaArchitecture.path)}</span>
            </div>
            <p>{safeText(qaArchitecture.principle)}</p>
            <div className="qa-metric-grid">
              {qaArchitecture.metrics.map(([value, label, desc]) => (
                <div key={label}>
                  <strong>{safeText(value)}</strong>
                  <span>{safeText(label)}</span>
                  <small>{safeText(desc)}</small>
                </div>
              ))}
            </div>
            <DataTable
              headers={["优先级", "内容资产"]}
              rows={qaArchitecture.priorityAssets}
            />
            <div className="qa-showcase-box">
              <div className="qa-showcase-head">
                <span>标准问答样例</span>
              </div>
              <div className="qa-example-grid">
                {qaArchitecture.sampleAnswers.map((item) => (
                  <article key={item.question} className="qa-sample-card">
                    <span className="qa-category-tag">
                      {safeText(item.category)}
                    </span>
                    <h4>{safeText(item.question)}</h4>
                    <p>{safeText(item.answer)}</p>
                    <div className="qa-evidence-list">
                      <strong>证据锚点</strong>
                      {item.evidence.map((e) => (
                        <small key={e}>{safeText(e)}</small>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {activeTab === "visual" && (
        <Panel title="视觉体系手册">
          <div className="visual-system-card">
            <span>{safeText(visualSystem.concept)}</span>
            <p>{safeText(visualSystem.principle)}</p>
            <DataTable
              headers={["层级", "执行内容"]}
              rows={visualSystem.motifs}
            />
          </div>
          <div className="brand-expression-stack" style={{ marginTop: "24px" }}>
            <div>
              <strong>高频词汇</strong>
              <TokenCloud items={verbalVisual.vocabulary} />
            </div>
            <div>
              <strong>禁用表达</strong>
              <div className="risk-words">
                {verbalVisual.banned.map((item) => (
                  <span key={item}>{safeText(item)}</span>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {activeTab === "audit" && (
        <Panel
          title="语义问题治理矩阵"
          actions={
            <span className="entity-count">
              {semanticAudit.issueMatrix.length} 个议题
            </span>
          }
        >
          <DataTable
            headers={["主题", "核验得分", "核心命中", "治理口径"]}
            rows={semanticAudit.issueMatrix}
          />
        </Panel>
      )}
    </section>
  );
}

function previewQuestionCategory(item) {
  const category = String(item["核心词分类"] || "");
  const scene = String(item["GEO场景"] || "");
  const mapped = keywordCategoryKey(category);
  if (mapped) return mapped;
  if (category.includes("竞品") || scene.includes("竞品"))
    return "competitor_comparison";
  if (category.includes("场景") || scene.includes("场景"))
    return "product_scenario";
  return "reputation";
}

function BrandGlobalKeywords({ onUseQuestion, quotaAvailability, bank }) {
  const [category, setCategory] = useState("all");
  const [subdivision, setSubdivision] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const subdivisionOptions = useMemo(
    () =>
      [
        ...new Set(
          bank.questions.map((item) => item["问题细分"]).filter(Boolean),
        ),
      ]
        .map(String)
        .sort((left, right) => left.localeCompare(right, "zh-CN")),
    [bank.questions],
  );
  const filteredQuestions = useMemo(() => {
    let items = bank.questions;
    if (category !== "all")
      items = items.filter(
        (item) => keywordCategoryKey(item["核心词分类"]) === category,
      );
    if (subdivision !== "all")
      items = items.filter(
        (item) => String(item["问题细分"] || "") === subdivision,
      );
    if (searchTerm)
      items = items.filter(
        (item) =>
          item["问题"].includes(searchTerm) ||
          String(item["问题细分"] || "").includes(searchTerm) ||
          String(keywordCategoryLabel(item["核心词分类"]) || "").includes(
            searchTerm,
          ),
      );
    return items;
  }, [bank.questions, category, searchTerm, subdivision]);

  const topRows = filteredQuestions.slice(0, 160);

  return (
    <section className="page-shell brand-deep-page">
      <PageHeader
        eyebrow="MindPromise智诺 / 品牌建设"
        title="品牌全域词库"
        desc="基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。"
      />

      {/* SaaS化：多维筛选工具栏 */}
      <div className="saas-toolbar keyword-toolbar-saas">
        <div className="saas-search">
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索问题、主分类或问题细分..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className="clear-btn" onClick={() => setSearchTerm("")}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="filter-group">
          <div className="filter-item">
            <label>主分类</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">全部主分类</option>
              {KEYWORD_CATEGORY_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-item">
            <label>问题细分</label>
            <select
              value={subdivision}
              onChange={(e) => setSubdivision(e.target.value)}
            >
              <option value="all">全部问题细分</option>
              {subdivisionOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="keyword-stats-bar">
        <span>
          <strong>{formatNumber(filteredQuestions.length)}</strong> 个问题
        </span>
        <span>
          展示前 <strong>{Math.min(160, filteredQuestions.length)}</strong> 条
        </span>
      </div>

      <Panel title="全域词库" className="global-keyword-panel">
        <div className="keyword-table-wrap">
          <table className="keyword-table">
            <thead>
              <tr>
                <th>问题</th>
                <th>主分类</th>
                <th>问题细分</th>
                <th>问题优化</th>
              </tr>
            </thead>
            <tbody>
              {topRows.map((item) => {
                const category = previewQuestionCategory(item);
                const quotaAccess = quotaAvailability?.[category];
                return (
                  <tr key={`${item["序号"]}-${item["问题"]}`}>
                    <td className="keyword-question-cell">
                      {safeText(item["问题"])}
                    </td>
                    <td>
                      <span
                        className="keyword-pill fm-question-category-pill"
                        data-category={
                          keywordCategoryKey(item["核心词分类"]) || undefined
                        }
                      >
                        {keywordCategoryLabel(item["核心词分类"]) ||
                          safeText(item["核心词分类"])}
                      </span>
                    </td>
                    <td>{safeText(item["问题细分"])}</td>
                    <td>
                      <button
                        type="button"
                        className="keyword-optimize-button"
                        disabled={quotaAccess?.available === false}
                        onClick={() =>
                          onUseQuestion({
                            id: `preview-keyword-${item["序号"]}`,
                            question: safeText(item["问题"]),
                            category,
                            tableId: "preview-brand-keywords",
                            rowIndex: Math.max(
                              0,
                              Number(item["序号"] || 1) - 1,
                            ),
                            revision: 1,
                            status: "candidate",
                          })
                        }
                      >
                        {quotaAccess?.available === false
                          ? quotaAccess.unavailableLabel || "该类额度已满"
                          : "选择并进入问题优化"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

// ==================== INTENT SECTION ====================
function ProblemOptimizationResults({
  portal,
  preview,
  workspaceState,
  initialQuestionId,
  intakeDraft,
  onIntakeDraftChange,
  onPortalRefresh,
  questionGroups,
  onOpenResponseLogic,
  onOpenBrandQuestions,
}) {
  const responseLogicStep = portal.workflowSteps.find(
    (step) => step.id === "response_logic",
  );
  const [previewConfirmedQuestions, setPreviewConfirmedQuestions] = useState<
    PreviewConfirmedQuestion[]
  >([]);
  const displayedPortal = useMemo(() => {
    if (!preview || previewConfirmedQuestions.length === 0) return portal;
    return {
      ...portal,
      quotas: portal.quotas.map((quota) => {
        const added = previewConfirmedQuestions.filter(
          (question) =>
            previewQuestionCategoryMeta[question.category]?.quotaKey ===
            quota.key,
        ).length;
        return added > 0 && quota.used !== null
          ? { ...quota, used: quota.used + added }
          : quota;
      }),
    };
  }, [portal, preview, previewConfirmedQuestions]);
  const displayedQuestionGroups = useMemo(() => {
    if (!preview || previewConfirmedQuestions.length === 0) {
      return questionGroups;
    }
    const groups = (questionGroups || []).map((group) => ({
      ...group,
      questions: [...(group.questions || [])],
    }));
    for (const question of previewConfirmedQuestions) {
      const meta = previewQuestionCategoryMeta[question.category];
      if (!meta) continue;
      let group = groups.find((item) => item.id === meta.groupId);
      if (!group) {
        group = {
          id: meta.groupId,
          title: meta.title,
          subtitle: meta.subtitle,
          tone: meta.tone,
          questions: [],
        };
        groups.push(group);
      }
      if (!group.questions.some((item) => item.id === question.id)) {
        group.questions.push({
          id: question.id,
          question: question.question,
          intent: "",
          summary: "",
        });
      }
    }
    return groups;
  }, [preview, previewConfirmedQuestions, questionGroups]);
  return (
    <section className="response-logic-workspace page-shell">
      <header className="rl-page-header rl-page-header-with-action">
        <div>
          <span className="rl-eyebrow">MindPromise 智诺 / 意图优化</span>
          <h2>问题优化</h2>
          <p>
            按问题查看应答逻辑智能体确认后的完整回答口径、事实依据、表达边界与图文资料。
          </p>
        </div>
      </header>

      <ServiceQuotaOverview portal={displayedPortal} className="mb-5" />

      <QuestionIntakePanel
        preview={preview}
        portal={displayedPortal}
        draft={intakeDraft}
        onDraftChange={onIntakeDraftChange}
        onOpenBrandQuestions={onOpenBrandQuestions}
        onPortalRefresh={onPortalRefresh}
        onPreviewBrandConfirmed={(input) => {
          const category = input.category as PreviewQuestionCategory;
          if (!previewQuestionCategoryMeta[category]) return;
          const id = `preview-brand-${input.libraryRef?.tableId || "keyword"}-${
            input.libraryRef?.rowIndex ?? "row"
          }`;
          setPreviewConfirmedQuestions((current) =>
            current.some((question) => question.id === id) ||
            (questionGroups || []).some((group) =>
              (group.questions || []).some(
                (question) => question.question === input.question,
              ),
            )
              ? current
              : [
                  ...current,
                  {
                    id,
                    question: input.question,
                    category,
                  },
                ],
          );
        }}
      />

      <ResponseLogicConfirmationBoard
        preview={preview}
        previewPublished={responseLogicStep?.status === "complete"}
        workspaceState={workspaceState}
        initialQuestionId={initialQuestionId}
        questionGroups={displayedQuestionGroups}
        onOpenAgent={onOpenResponseLogic}
      />
    </section>
  );
}

function IntentSection({
  preview,
  questionGroups,
  channelDistributionAccess,
  renderPreview,
}) {
  return (
    <Suspense
      fallback={
        <div className="citation-workbench-loading" role="status">
          <span aria-hidden="true" />
          正在载入问题监控…
        </div>
      }
    >
      {preview ? (
        renderPreview?.({ channelDistributionAccess }) || (
          <ManagedModuleEmpty
            title="问题监控"
            description="当前预览未配置监控数据。"
          />
        )
      ) : (
        <ManagedQuestionMonitoringWorkspace
          questionGroups={questionGroups}
          channelDistributionAccess={channelDistributionAccess}
        />
      )}
    </Suspense>
  );
}

function LockedMonitoringDistribution({ access }) {
  return (
    <div className="question-monitor-distribution-state" role="status">
      <LockKeyhole size={22} aria-hidden="true" />
      <div>
        <strong>渠道分发数据尚未开放</strong>
        <p>
          {access?.reason ||
            "完成当前问题监控阶段后，信源引用与渠道分发记录将在这里开放。"}
        </p>
      </div>
    </div>
  );
}

function citationDomain(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function previewCitationModelIdentity(value: unknown) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function buildPreviewQuestionCitationSummary(
  rows: readonly QuestionCitationRow[],
  selectedQuestion: string,
  selectedModel: string,
  selectedDateFrom: string,
  selectedDateTo: string,
) {
  const selectedModelIdentity = previewCitationModelIdentity(selectedModel);
  const records = rows.filter((row) => {
    const date = String(row[5] || "");
    const rowModelLabel =
      citationModelLabels[String(row[0] || "").toLowerCase()] || row[0];
    return (
      row[1] === selectedQuestion &&
      (!selectedModelIdentity ||
        previewCitationModelIdentity(rowModelLabel) ===
          selectedModelIdentity) &&
      (!selectedDateFrom || date >= selectedDateFrom) &&
      (!selectedDateTo || date <= selectedDateTo)
    );
  });
  if (!selectedQuestion) return null;

  const channelCounts = new Map();
  const contentCounts = new Map();
  for (const [, , title, url, media] of records) {
    const domain = citationDomain(url);
    const channelName = String(media || domain || "未标注渠道").trim();
    const channelKey = domain
      ? `domain:${domain}`
      : `media:${channelName.toLocaleLowerCase("zh-CN")}`;
    const channel = channelCounts.get(channelKey) || {
      name: channelName,
      domain,
      citationCount: 0,
    };
    channel.citationCount += 1;
    channelCounts.set(channelKey, channel);

    const normalizedTitle = String(title || url || "未标注内容").trim();
    const contentKey = url
      ? `url:${url}`
      : `title:${normalizedTitle}|${channelKey}`;
    const content = contentCounts.get(contentKey) || {
      title: normalizedTitle,
      url,
      channelName,
      domain,
      citationCount: 0,
    };
    content.citationCount += 1;
    contentCounts.set(contentKey, content);
  }

  const totalCitations = records.length;
  const byCountThenName = (left, right) =>
    right.citationCount - left.citationCount ||
    String(left.name || left.title).localeCompare(
      String(right.name || right.title),
      "zh-CN",
    );
  const share = (count) => (totalCitations > 0 ? count / totalCitations : 0);
  return {
    batchKey: "preview-citation-fixture",
    questionId: selectedQuestion,
    scopeLabel:
      selectedDateFrom || selectedDateTo
        ? `${selectedDateFrom || "最早"} 至 ${selectedDateTo || "最新"}`
        : undefined,
    totalCitations,
    channels: [...channelCounts.values()]
      .map((item) => ({
        ...item,
        share: share(item.citationCount),
      }))
      .sort(byCountThenName),
    contents: [...contentCounts.values()]
      .map((item) => ({
        ...item,
        share: share(item.citationCount),
      }))
      .sort(byCountThenName),
  };
}

function PreviewQuestionMonitoringWorkspace({
  channelDistributionAccess,
  intents,
  answerBooks,
}) {
  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedDateFrom, setSelectedDateFrom] = useState("");
  const [selectedDateTo, setSelectedDateTo] = useState("");
  const [citationRows, setCitationRows] = useState<
    readonly QuestionCitationRow[] | null
  >(null);
  const [citationError, setCitationError] = useState(false);

  useEffect(() => {
    if (!channelDistributionAccess?.allowed) return;
    let active = true;
    setCitationError(false);
    loadCitationDistributionData()
      .then((data) => {
        if (active) setCitationRows(data.questionRows);
      })
      .catch(() => {
        if (active) setCitationError(true);
      });
    return () => {
      active = false;
    };
  }, [channelDistributionAccess?.allowed]);

  const summary = useMemo(
    () =>
      citationRows
        ? buildPreviewQuestionCitationSummary(
            citationRows,
            selectedQuestion,
            selectedModel,
            selectedDateFrom,
            selectedDateTo,
          )
        : null,
    [
      citationRows,
      selectedDateFrom,
      selectedDateTo,
      selectedModel,
      selectedQuestion,
    ],
  );
  const distributionContent = channelDistributionAccess?.allowed ? (
    <PreviewCitationWorkbench
      data={summary || undefined}
      loading={!citationRows && !citationError}
      error={citationError}
    />
  ) : (
    <LockedMonitoringDistribution access={channelDistributionAccess} />
  );

  return (
    <QuestionMonitoringWorkspace
      citationMode="inline"
      previewIntents={intents}
      previewAnswerBooks={answerBooks}
      onSelectedQuestionChange={setSelectedQuestion}
      selectedModel={selectedModel}
      onSelectedModelChange={setSelectedModel}
      selectedDateFrom={selectedDateFrom}
      selectedDateTo={selectedDateTo}
      onSelectedDateFromChange={setSelectedDateFrom}
      onSelectedDateToChange={setSelectedDateTo}
      distributionContent={distributionContent}
    />
  );
}

const monitoringDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "long",
  day: "numeric",
});

function monitoringDateKey(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const timestamp =
    typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

function monitoringBatchDateLabel(value, fallback) {
  const timestamp =
    typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    ? monitoringDateFormatter.format(timestamp)
    : fallback;
}

function ManagedQuestionMonitoringWorkspace({
  questionGroups,
  channelDistributionAccess,
}) {
  const firstQuestionId = questionGroups?.[0]?.questions?.[0]?.id || "";
  const [selectedQuestionId, setSelectedQuestionId] = useState(firstQuestionId);
  const [selectedDateFrom, setSelectedDateFrom] = useState("");
  const [selectedDateTo, setSelectedDateTo] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [samplePage, setSamplePage] = useState(1);
  const [sampleCollection, setSampleCollection] = useState({
    scope: "",
    pages: {},
    total: 0,
  });
  useEffect(() => {
    const exists = (questionGroups || []).some((group) =>
      group.questions.some((question) => question.id === selectedQuestionId),
    );
    if (!exists) setSelectedQuestionId(firstQuestionId);
  }, [firstQuestionId, questionGroups, selectedQuestionId]);

  const baseFiltersQuery = trpc.workspace.monitoring.filters.useQuery(
    {
      questionId: selectedQuestionId || undefined,
    },
    {
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: FORMAL_QUERY_REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  );
  const dateOptions = useMemo(() => {
    const filterData = baseFiltersQuery.data || {};
    const backendOptions = filterData.dateOptions || [];
    if (backendOptions.length > 0) {
      return backendOptions
        .map((option) => {
          const value =
            option.value || option.batchKey || option.key || option.id || "";
          const collectedAt =
            option.collectedAt || option.date || option.timestamp || null;
          return {
            value: option.dateKey || monitoringDateKey(collectedAt || value),
            collectedAt,
            dateKey: option.dateKey || monitoringDateKey(collectedAt || value),
            label:
              option.label ||
              monitoringBatchDateLabel(collectedAt, String(value || "")),
          };
        })
        .filter((option) => option.value);
    }
    return (filterData.batches || []).map((batch) => ({
      value: monitoringDateKey(batch.collectedAt),
      collectedAt: batch.collectedAt,
      dateKey: monitoringDateKey(batch.collectedAt),
      label: monitoringBatchDateLabel(
        batch.collectedAt,
        batch.sourceName || batch.batchKey,
      ),
    }));
  }, [baseFiltersQuery.data]);
  const availableDates = useMemo(
    () =>
      [
        ...new Set(dateOptions.map((option) => option.dateKey).filter(Boolean)),
      ].sort(),
    [dateOptions],
  );
  const activeDateFrom = availableDates.includes(selectedDateFrom)
    ? selectedDateFrom
    : availableDates[0] || "";
  const activeDateTo = availableDates.includes(selectedDateTo)
    ? selectedDateTo
    : availableDates.at(-1) || "";
  const modelOptions = useMemo(() => {
    const filterData = baseFiltersQuery.data || {};
    const source =
      (filterData.modelOptions || []).length > 0
        ? filterData.modelOptions
        : (filterData.sampleModels || filterData.answerModels || []).length > 0
          ? filterData.sampleModels || filterData.answerModels
          : (filterData.platforms || []).length > 0
            ? filterData.platforms
            : filterData.models || [];
    return source
      .map((option) =>
        typeof option === "string"
          ? option
          : {
              value:
                option.value ||
                option.modelKey ||
                option.platform ||
                option.key ||
                "",
              label: option.label || option.modelLabel || option.name,
            },
      )
      .filter((option) =>
        typeof option === "string" ? Boolean(option) : Boolean(option.value),
      );
  }, [baseFiltersQuery.data]);
  const modelValues = modelOptions.map((option) =>
    typeof option === "string" ? option : option.value,
  );
  const activeModel = modelValues.includes(selectedModel)
    ? selectedModel
    : modelValues[0] || "";
  const sampleScope = `${activeDateFrom}:${activeDateTo}:${selectedQuestionId}:${activeModel}`;
  const queryEnabled = Boolean(selectedQuestionId);

  useEffect(() => {
    setSamplePage(1);
    setSampleCollection({ scope: sampleScope, pages: {}, total: 0 });
  }, [sampleScope]);

  const sampleQuery = trpc.workspace.monitoring.samples.useQuery(
    {
      questionId: selectedQuestionId || undefined,
      from: activeDateFrom || undefined,
      to: activeDateTo || undefined,
      model: activeModel || undefined,
      query: "",
      page: samplePage,
      pageSize: 100,
      sortOrder: "desc",
    },
    {
      enabled: queryEnabled,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: FORMAL_QUERY_REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  );

  useEffect(() => {
    if (!queryEnabled || !sampleQuery.data) return;
    setSampleCollection((current) => {
      const pages = current.scope === sampleScope ? current.pages : {};
      return {
        scope: sampleScope,
        pages: {
          ...pages,
          [samplePage]: sampleQuery.data.items || [],
        },
        total: sampleQuery.data.total || 0,
      };
    });
  }, [queryEnabled, samplePage, sampleQuery.data, sampleScope]);

  const samples = useMemo(() => {
    if (sampleCollection.scope !== sampleScope) return [];
    return Object.keys(sampleCollection.pages)
      .map(Number)
      .sort((left, right) => left - right)
      .flatMap((page) => sampleCollection.pages[page] || []);
  }, [sampleCollection, sampleScope]);
  const monitoringAnswers = useMemo(() => {
    return samples.map((sample) => ({
      id: sample.id,
      sourceRecordId: sample.sourceRecordId,
      questionId: sample.questionId,
      platform: sample.platform,
      batchKey: sample.batchKey || "",
      model:
        sample.modelLabel || sample.model || sample.modelKey || sample.platform,
      collectedAt: Number.isFinite(new Date(sample.collectedAt).getTime())
        ? new Date(sample.collectedAt).toISOString()
        : "",
      answerNo: sample.answerNo,
      content: sample.content,
      citationCount: sample.citationCount,
      monitorRank: sample.monitorRank || undefined,
      screenshotUrl: sample.screenshotUrl || "",
      citations: [],
    }));
  }, [samples]);
  const totalAnswerCount =
    sampleCollection.scope === sampleScope ? sampleCollection.total : 0;
  const hasMoreAnswers = monitoringAnswers.length < totalAnswerCount;
  const firstPagePending =
    queryEnabled &&
    monitoringAnswers.length === 0 &&
    (sampleQuery.isLoading || sampleQuery.isFetching);
  const answersFailed =
    Boolean(sampleQuery.error) && monitoringAnswers.length === 0;
  const distributionContent = channelDistributionAccess?.allowed ? (
    baseFiltersQuery.isLoading ? (
      <div className="managed-citation-state" role="status">
        <span aria-hidden="true" />
        正在读取监控批次…
      </div>
    ) : baseFiltersQuery.error ? (
      <div className="managed-citation-state error" role="alert">
        监控批次暂时无法读取，请稍后重试。
      </div>
    ) : (
      <ManagedCitationWorkbench
        selectedQuestionId={selectedQuestionId}
        model={activeModel || undefined}
        from={activeDateFrom || undefined}
        to={activeDateTo || undefined}
        scopeLabel={
          activeDateFrom || activeDateTo
            ? `${activeDateFrom || "最早"} 至 ${activeDateTo || "最新"}`
            : undefined
        }
      />
    )
  ) : (
    <LockedMonitoringDistribution access={channelDistributionAccess} />
  );

  return (
    <QuestionMonitoringWorkspace
      questionGroups={questionGroups}
      monitoringAnswers={monitoringAnswers}
      batchKey=""
      modelOptions={modelOptions}
      dateOptions={dateOptions}
      selectedModel={activeModel}
      selectedDateFrom={activeDateFrom}
      selectedDateTo={activeDateTo}
      onSelectedModelChange={setSelectedModel}
      onSelectedDateFromChange={setSelectedDateFrom}
      onSelectedDateToChange={setSelectedDateTo}
      citationMode="server"
      onSelectedQuestionIdChange={setSelectedQuestionId}
      distributionContent={distributionContent}
      monitoringAnswersLoading={baseFiltersQuery.isLoading || firstPagePending}
      monitoringAnswersError={Boolean(baseFiltersQuery.error) || answersFailed}
      totalAnswerCount={totalAnswerCount}
      hasMoreAnswers={hasMoreAnswers}
      loadingMoreAnswers={samplePage > 1 && sampleQuery.isFetching}
      onLoadMoreAnswers={() => {
        if (hasMoreAnswers && !sampleQuery.isFetching) {
          setSamplePage((current) => current + 1);
        }
      }}
    />
  );
}

function metricDisplayName(name, intentId) {
  if (intentId === "ranking") {
    const mapping = {
      出现率: "出现率",
      平均位次: "平均出现位次",
      前五位占比: "前五位占比",
      目标出现率: "目标出现率",
    };
    return mapping[name] || name;
  }
  const mapping = {
    "是985/211吗": "事实准确度｜985/211身份",
    本部关系: "事实准确度｜本部关系",
    证书口径: "事实准确度｜证书口径",
    含金量: "优势陈述能力｜认可度",
    就业薪资: "事实准确度｜就业证据",
    学费值得吗: "优势陈述能力｜投入回报",
    对中山大学: "比较口径稳定度｜中山大学",
    对港科广: "比较口径稳定度｜港科广",
    对南科大: "比较口径稳定度｜南科大",
  };
  return mapping[name] || name;
}

function IntentDetail({ intentId }) {
  const intent =
    geoIntents.find((item) => item.id === intentId) || geoIntents[0];
  const meta = geoIntentMeta[intent.id];
  const book = geoAnswerBooks[intent.id];
  const [activeView, setActiveView] = useState("workbench");

  return (
    <section className="page-shell">
      <PageHeader
        eyebrow={`MindPromise智诺 / 意图优化 / ${meta.short}`}
        title={meta.label}
        desc={meta.desc}
      />

      {/* SaaS化：视图切换 */}
      <div className="saas-tabs view-tabs">
        <button
          className={activeView === "workbench" ? "active" : ""}
          onClick={() => setActiveView("workbench")}
        >
          答案工作台
        </button>
        <button
          className={activeView === "metrics" ? "active" : ""}
          onClick={() => setActiveView("metrics")}
        >
          指标趋势
        </button>
        <button
          className={activeView === "sources" ? "active" : ""}
          onClick={() => setActiveView("sources")}
        >
          信源管理
        </button>
      </div>

      {activeView === "metrics" && (
        <div className="metrics-dashboard">
          <div className="metrics-cards-row">
            {intent.bars.map(([name, value]) => (
              <article className="metric-trend-card" key={name}>
                <span className="metric-label">
                  {safeText(metricDisplayName(name, intent.id))}
                </span>
                <div className="metric-value-row">
                  <strong>{value}%</strong>
                  <span
                    className={`trend-indicator ${value > 70 ? "up" : value > 50 ? "flat" : "down"}`}
                  >
                    {value > 70 ? (
                      <TrendingUp size={14} />
                    ) : value > 50 ? (
                      <Minus size={14} />
                    ) : (
                      <TrendingDown size={14} />
                    )}
                    {value > 70 ? "+2.3%" : value > 50 ? "0%" : "-1.2%"}
                  </span>
                </div>
                <ProgressBar value={value} color={toneMap[meta.tone]} />
                <small>vs 上周</small>
              </article>
            ))}
          </div>
          <Panel title="监控摘要">
            <p className="lead-text">{safeText(intent.summary)}</p>
          </Panel>
        </div>
      )}

      {activeView === "sources" && (
        <Panel
          title="引用信源管理"
          actions={
            <span className="entity-count">{intent.sources.length} 个信源</span>
          }
        >
          <div className="source-entity-list">
            {intent.sources.map(([name, url, usage]) => (
              <div className="source-entity-row" key={name}>
                <div className="source-name">{safeText(name)}</div>
                <div className="source-url">
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {safeText(url)}
                  </a>
                </div>
                <div className="source-usage">{safeText(usage)}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {activeView === "workbench" && book && (
        <AnswerWorkbench
          book={book}
          tone={meta.tone}
          intentId={intent.id}
          intent={intent}
        />
      )}
      {activeView === "workbench" && !book && (
        <Panel title="监控具体数据">
          <DataTable
            headers={["平台", "问题", "答案摘要", "口径边界"]}
            rows={intent.samples.map((s) => [
              s.platform,
              s.question,
              s.answer,
              s.risk,
            ])}
          />
        </Panel>
      )}
    </section>
  );
}

// SaaS化的答案工作台：列表 + 侧边抽屉
function AnswerWorkbench({ book, tone, intentId, intent }) {
  const [selectedPlatform, setSelectedPlatform] = useState("全部");
  const [selectedQuestion, setSelectedQuestion] = useState("全部");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerAnswer, setDrawerAnswer] = useState(null);

  const allAnswers = useMemo(() => {
    const results = [];
    book.platforms.forEach((platform) => {
      platform.questions.forEach((question) => {
        if (!question.answers?.length) return;
        question.answers.forEach((answer) => {
          results.push({
            platform: platform.name,
            question: question.question,
            date: question.date,
            keyword: question.keyword,
            ...answer,
          });
        });
      });
    });
    return results;
  }, [book]);

  const platforms = useMemo(
    () => ["全部", ...new Set(allAnswers.map((a) => a.platform))],
    [allAnswers],
  );
  const questions = useMemo(
    () => ["全部", ...new Set(allAnswers.map((a) => a.question))],
    [allAnswers],
  );

  const filtered = useMemo(() => {
    let items = allAnswers;
    if (selectedPlatform !== "全部")
      items = items.filter((a) => a.platform === selectedPlatform);
    if (selectedQuestion !== "全部")
      items = items.filter((a) => a.question === selectedQuestion);
    return items;
  }, [allAnswers, selectedPlatform, selectedQuestion]);

  const openDrawer = (answer) => {
    setDrawerAnswer(answer);
    setDrawerOpen(true);
  };

  return (
    <div className="workbench-layout">
      {/* 筛选工具栏 */}
      <div className="saas-toolbar workbench-toolbar">
        <div className="filter-group">
          <div className="filter-item">
            <label>平台</label>
            <select
              value={selectedPlatform}
              onChange={(e) => setSelectedPlatform(e.target.value)}
            >
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-item">
            <label>问题</label>
            <select
              value={selectedQuestion}
              onChange={(e) => setSelectedQuestion(e.target.value)}
            >
              {questions.map((q) => (
                <option key={q} value={q}>
                  {q.length > 30 ? q.slice(0, 30) + "..." : q}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="workbench-stats">
          <span>
            <strong>{filtered.length}</strong> 条答案
          </span>
        </div>
      </div>

      {/* 答案数据列表 */}
      <div className="answer-data-grid">
        <div className="answer-list-header">
          <span className="col-platform">平台</span>
          <span className="col-question">问题</span>
          <span className="col-date">采集时间</span>
          <span className="col-action">操作</span>
        </div>
        {filtered.slice(0, 50).map((answer, idx) => (
          <div
            className="answer-list-row"
            key={`${answer.platform}-${answer.question}-${answer.answerNo}-${idx}`}
            onClick={() => openDrawer(answer)}
          >
            <span className="col-platform">
              <span className="platform-badge">
                {safeText(answer.platform)}
              </span>
            </span>
            <span className="col-question">
              {safeText(answer.question).slice(0, 40)}
              {answer.question.length > 40 ? "..." : ""}
            </span>
            <span className="col-date">{safeText(answer.date)}</span>
            <span className="col-action">
              <button
                className="view-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  openDrawer(answer);
                }}
              >
                <Eye size={14} /> 查看
              </button>
            </span>
          </div>
        ))}
      </div>

      {/* 侧边抽屉 */}
      {drawerOpen && drawerAnswer && (
        <div
          className="answer-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
        >
          <aside className="answer-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>答案详情</h3>
              <button
                className="drawer-close"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="drawer-meta">
              <div className="drawer-meta-row">
                <span className="platform-badge">
                  {safeText(drawerAnswer.platform)}
                </span>
                <span>{safeText(drawerAnswer.date)}</span>
                <span>答案 #{drawerAnswer.answerNo}</span>
              </div>
              <h4>{safeText(drawerAnswer.question)}</h4>
            </div>
            <div className="drawer-stats">
              <div>
                <span>引用篇数</span>
                <strong>{drawerAnswer.citationCount || "-"}</strong>
              </div>
              {intentId === "ranking" && (
                <div>
                  <span>品类名次</span>
                  <strong>{drawerAnswer.monitorRank || "-"}</strong>
                </div>
              )}
            </div>
            <div className="drawer-body">
              {renderAnswerBlocks(drawerAnswer.content)}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

// ==================== PROGRESS SECTION (SaaS化：实时监控大盘) ====================
function ProgressSection({
  sub,
  preview = false,
  questionGroups = [],
  optimizationReport = null,
  progressReports = [],
  renderPreview = null,
}) {
  if (preview) {
    return (
      renderPreview?.({ sub, questionGroups }) || (
        <ManagedModuleEmpty
          title="进度报告"
          description="当前预览未配置进度报告。"
        />
      )
    );
  }
  if (sub === "optimization") {
    return (
      <ManagedProgressReports
        currentReport={optimizationReport}
        versions={progressReports}
        questionGroups={questionGroups}
      />
    );
  }
  return (
    <ManagedModuleEmpty
      title="进度监控"
      description="请从左侧选择“问题监控”或“进度报告”查看已发布的数据。"
    />
  );
}

function ManagedProgressReports({ currentReport, versions, questionGroups }) {
  const reportVersions = useMemo(() => {
    const normalized = [...(versions || [])];
    if (
      currentReport &&
      !normalized.some(
        (version) =>
          JSON.stringify(version.report) === JSON.stringify(currentReport),
      )
    ) {
      normalized.push({
        id: "current-progress-report",
        revision: Number.MAX_SAFE_INTEGER,
        publishedAt: Date.now(),
        report: currentReport,
      });
    }
    return normalized.sort(
      (left, right) =>
        right.revision - left.revision || right.publishedAt - left.publishedAt,
    );
  }, [currentReport, versions]);
  const [selectedVersionId, setSelectedVersionId] = useState(
    reportVersions[0]?.id || "",
  );
  useEffect(() => {
    if (reportVersions.some((version) => version.id === selectedVersionId)) {
      return;
    }
    setSelectedVersionId(reportVersions[0]?.id || "");
  }, [reportVersions, selectedVersionId]);

  if (reportVersions.length === 0) {
    return (
      <section className="page-shell optimization-report-page">
        <ProgressReportWorkspace
          report={null}
          questionGroups={questionGroups}
        />
      </section>
    );
  }
  const selected =
    reportVersions.find((version) => version.id === selectedVersionId) ||
    reportVersions[0];

  return (
    <section className="page-shell optimization-report-page">
      <ProgressReportWorkspace
        report={selected.report}
        questionGroups={questionGroups}
        progressToolbar={
          <div className="mb-4 rounded-2xl border border-[#e8e1ee] bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-[.1em] text-[#8d8498]">
                  报告周期
                </span>
                <p className="m-0 mt-1 text-sm text-[#625a70]">
                  历史周期报告会持续保留，不会被最新一次发布覆盖。
                </p>
              </div>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="进度报告版本"
              >
                {reportVersions.map((version, index) => (
                  <button
                    type="button"
                    key={version.id}
                    aria-pressed={version.id === selected.id}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      version.id === selected.id
                        ? "border-[#5b2a86] bg-[#5b2a86] text-white"
                        : "border-[#ddd5e5] bg-white text-[#625a70] hover:border-[#a68bb8]"
                    }`}
                    onClick={() => setSelectedVersionId(version.id)}
                  >
                    {version.report.period ||
                      `版本 ${reportVersions.length - index}`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        }
      />
    </section>
  );
}

function PreviewProgressOverview() {
  return (
    <section className="page-shell">
      <PageHeader
        eyebrow="MindPromise智诺 / 进度监控"
        title="进度监控综合面板"
        desc="以综合结论呈现项目进展、复测节奏和交付状态。"
      />
      <div className="conclusion-grid">
        <Panel title="渠道分发结论">
          <strong className="conclusion">
            按监控问题拆解 AI
            模型引用的媒体、文章与日期，识别高频信源和待补足的分发渠道。
          </strong>
        </Panel>
        <Panel title="进度报告结论">
          <strong className="conclusion">
            优化目标从"回答里出现"升级为"被正确引用、靠前呈现、口径稳定"。
          </strong>
        </Panel>
      </div>
    </section>
  );
}

function OptimizationReport({ questionGroups, report }) {
  return (
    <section className="page-shell optimization-report-page">
      <ProgressReportWorkspace
        report={report}
        questionGroups={questionGroups}
      />
    </section>
  );
}

// ==================== SEMANTIC ASSET SECTION (SaaS化：生产与分发流) ====================
function SemanticAssetSystem({ publishedAssets = [], onEdit }) {
  return (
    <section className="page-shell semantic-page">
      <PageHeader
        eyebrow="MindPromise智诺 / AI 友好内容资产"
        title="内容资产运营"
        desc="查看和编辑自己的内容资产，可下载原格式模板、导入并确认发布。"
      />
      {onEdit && (
        <Button variant="outline" onClick={onEdit}>
          编辑内容资产
        </Button>
      )}
      {!publishedAssets.length && (
        <p className="mt-5 text-sm text-muted-foreground">
          暂无内容资产，可从编辑入口导入内容。
        </p>
      )}
      <PublishedContentAssets assets={publishedAssets} />
    </section>
  );
}

function safePublishedMediaUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function PublishedContentAssets({ assets }) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  return (
    <section
      className="published-content-assets"
      aria-labelledby="published-content-assets-title"
    >
      <div className="published-content-assets-heading">
        <h3 id="published-content-assets-title">已发布内容资产</h3>
        <p>以下内容来自最近一次确认发布的内容资产版本。</p>
      </div>
      <div className="published-content-assets-list">
        {assets.map((asset) => (
          <details className="published-content-asset" key={asset.id}>
            <summary>
              <span>{safeText(asset.group || "内容资产")}</span>
              <strong>{safeText(asset.name)}</strong>
              {asset.description ? (
                <small>{safeText(asset.description)}</small>
              ) : null}
            </summary>
            <div className="published-content-asset-body">
              {asset.scene ? (
                <p className="published-content-scene">
                  {safeText(asset.scene)}
                </p>
              ) : null}
              {Array.isArray(asset.articles) && asset.articles.length > 0 ? (
                <div className="published-content-articles">
                  {asset.articles.map((article) => (
                    <article key={article.id}>
                      <h4>{safeText(article.title)}</h4>
                      {article.intro ? (
                        <MarkdownRenderer
                          content={safeText(article.intro)}
                          className="published-content-markdown"
                        />
                      ) : null}
                      {(article.sections || []).map((section, index) => {
                        const tuple = Array.isArray(section);
                        const heading = tuple ? section[0] : section.heading;
                        const body = tuple ? section[1] : section.body;
                        const media = tuple ? [] : section.media || [];
                        return (
                          <section
                            className="published-content-section"
                            key={`${article.id}-${index}`}
                          >
                            {heading ? <h5>{safeText(heading)}</h5> : null}
                            {body ? (
                              <MarkdownRenderer
                                content={safeText(body)}
                                className="published-content-markdown"
                              />
                            ) : null}
                            {media.length > 0 ? (
                              <div className="published-content-media">
                                {media.map((item, mediaIndex) => {
                                  const mediaUrl = safePublishedMediaUrl(
                                    item.url,
                                  );
                                  if (!mediaUrl) return null;
                                  return (
                                    <figure
                                      key={`${article.id}-${index}-${mediaIndex}`}
                                    >
                                      <img
                                        src={mediaUrl}
                                        alt={safeText(item.alt || "")}
                                        loading="lazy"
                                      />
                                      {item.caption ? (
                                        <figcaption>
                                          {safeText(item.caption)}
                                        </figcaption>
                                      ) : null}
                                    </figure>
                                  );
                                })}
                              </div>
                            ) : null}
                          </section>
                        );
                      })}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="published-content-empty">
                  当前资产没有已发布文章。
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
