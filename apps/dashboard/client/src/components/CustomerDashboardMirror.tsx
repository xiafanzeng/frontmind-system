import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  Database,
  FileText,
  Globe2,
  House,
  LibraryBig,
  ListChecks,
  LockKeyhole,
  Menu,
  Newspaper,
  Shield,
  Target,
  X,
} from "lucide-react";

import KnowledgeBaseProgressPanel from "@/components/KnowledgeBaseProgressPanel";
import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "@/components/KnowledgeBaseViewer";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import AiWebsiteManagementWorkspace from "@/dashboard/AiWebsiteManagementWorkspace";
import ProgressReportWorkspace from "@/dashboard/ProgressReportWorkspace";
import QuestionMonitoringWorkspace from "@/dashboard/QuestionMonitoringWorkspace";
import { ServiceHome, ServiceLockedPage } from "@/dashboard/service-portal-ui";
import {
  getCapability,
  normalizeServicePortal,
  type ServiceCapabilityKey,
  type ServicePortalView,
} from "@/dashboard/service-portal";
import {
  ManagedDashboardSection,
  ManagedKeywordTables,
  PublishedContentAssets,
} from "@/dashboard/UserBrandDashboard";
import type { DashboardPayload } from "@shared/dashboard";
import type {
  PublicDeliveryTicketSummary,
  PublicDeliveryTicketWorkspaceMetadata,
} from "@shared/delivery-ticket";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";

import "@/dashboard/dashboard-styles.css";
import "./customer-dashboard-mirror.css";

export type CustomerDashboardMirrorSection =
  | "home"
  | "knowledge-build"
  | "knowledge"
  | "keywords"
  | "questions"
  | "response-logic"
  | "monitoring"
  | "report"
  | "content"
  | "website";

type CustomerDashboardNavigationItem = {
  value: CustomerDashboardMirrorSection;
  label: string;
  icon: typeof House;
};

const CUSTOMER_DASHBOARD_GROUPS: ReadonlyArray<{
  label: string;
  icon: typeof House;
  items: readonly CustomerDashboardNavigationItem[];
}> = [
  {
    label: "服务概览",
    icon: House,
    items: [{ value: "home", label: "服务首页", icon: House }],
  },
  {
    label: "品牌建设",
    icon: Shield,
    items: [
      {
        value: "knowledge-build",
        label: "知识库智能体",
        icon: Database,
      },
      { value: "knowledge", label: "知识库展示", icon: Database },
      { value: "keywords", label: "品牌全域词库", icon: LibraryBig },
    ],
  },
  {
    label: "意图优化",
    icon: Target,
    items: [
      { value: "questions", label: "问题优化", icon: ListChecks },
      { value: "response-logic", label: "应答逻辑智能体", icon: Bot },
    ],
  },
  {
    label: "进度监控",
    icon: Activity,
    items: [
      { value: "monitoring", label: "问题监控", icon: BarChart3 },
      { value: "report", label: "进度报告", icon: FileText },
    ],
  },
  {
    label: "AI 友好内容资产",
    icon: Database,
    items: [
      { value: "content", label: "内容资产运营", icon: Newspaper },
      { value: "website", label: "AI 友好官网管理", icon: Globe2 },
    ],
  },
];

const ALL_CUSTOMER_DASHBOARD_SECTIONS = CUSTOMER_DASHBOARD_GROUPS.flatMap(
  (group) => group.items.map((item) => item.value),
);

function mirrorSectionCapability(
  section: CustomerDashboardMirrorSection,
): ServiceCapabilityKey | null {
  switch (section) {
    case "knowledge-build":
      return "knowledgeBuild";
    case "knowledge":
      return "knowledgeDisplay";
    case "keywords":
      return "globalKeywords";
    case "questions":
      return "intentOptimization";
    case "response-logic":
      return "responseLogic";
    case "monitoring":
      return "monitoring";
    case "report":
      return "progressReport";
    case "content":
    case "website":
      return "contentAssets";
    default:
      return null;
  }
}

function mirrorSectionTitle(section: CustomerDashboardMirrorSection) {
  return (
    CUSTOMER_DASHBOARD_GROUPS.flatMap((group) => group.items).find(
      (item) => item.value === section,
    )?.label ?? "客户看板"
  );
}

function mirrorSectionForCustomerRoute(
  section: string,
  sub?: string | null,
): CustomerDashboardMirrorSection {
  if (section === "knowledge-agent") {
    return sub === "display" ? "knowledge" : "knowledge-build";
  }
  if (section === "brand") return "keywords";
  if (section === "intent") return "questions";
  if (section === "response-logic") return "response-logic";
  if (section === "progress") {
    return sub === "monitor" || sub === "distribution"
      ? "monitoring"
      : "report";
  }
  if (section === "semantic") {
    return sub === "website-management" ? "website" : "content";
  }
  return "home";
}

function CustomerMirrorNavButton({
  item,
  active,
  portal,
  onSelect,
}: {
  item: CustomerDashboardNavigationItem;
  active: boolean;
  portal: ServicePortalView | null;
  onSelect: (section: CustomerDashboardMirrorSection) => void;
}) {
  const capabilityKey = mirrorSectionCapability(item.value);
  const access =
    portal && capabilityKey ? getCapability(portal, capabilityKey) : null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "active" : ""}
      onClick={() => onSelect(item.value)}
      title={!access?.allowed ? access?.reason : undefined}
      style={
        access && !access.allowed
          ? { gridTemplateColumns: "minmax(0, 1fr) auto" }
          : undefined
      }
    >
      <span>{item.label}</span>
      {access && !access.allowed && (
        <LockKeyhole
          aria-hidden="true"
          size={12}
          className="ml-auto opacity-60"
        />
      )}
    </button>
  );
}

type CustomerDashboardMirrorProps = {
  payload: DashboardPayload;
  websiteWorkspace?:
    | (PublicDeliveryTicketWorkspaceMetadata & {
        tickets: PublicDeliveryTicketSummary[];
      })
    | null;
  knowledgePreview?: CustomerKnowledgePreview | null;
  servicePortal?: unknown;
  servicePortalLoading?: boolean;
  servicePortalError?: boolean;
  onRefreshServicePortal?: () => void;
  initialSection?: CustomerDashboardMirrorSection;
  allowedSections?: readonly CustomerDashboardMirrorSection[];
  heading?: string;
  description?: string;
  editActions?: ReactNode;
  renderSectionActions?: (section: CustomerDashboardMirrorSection) => ReactNode;
  statusLabel?: string;
};

export type CustomerKnowledgeActivity = {
  build: {
    companyName: string;
    conversationId: string;
    status: string;
    protocolError?: string | null;
  } | null;
  turns: Array<{
    id: string | number;
    model?: string | null;
    status: string;
    durationMs?: number | null;
    errorMessage?: string | null;
  }>;
  messages: Array<{
    id: string | number;
    role: string;
    content: string;
    sentAt?: number | string | Date | null;
  }>;
};

export type CustomerKnowledgePreview = {
  progress?: KnowledgeBaseProgressDto | null;
  snapshot?: KnowledgeSnapshotView | null;
  activity?: CustomerKnowledgeActivity | null;
  activityLoading?: boolean;
  activityError?: string | null;
  progressLoading?: boolean;
  progressError?: string | null;
  snapshotLoading?: boolean;
  snapshotError?: string | null;
};

export default function CustomerDashboardMirror({
  payload,
  websiteWorkspace = null,
  knowledgePreview = null,
  servicePortal,
  servicePortalLoading = false,
  servicePortalError = false,
  onRefreshServicePortal,
  initialSection = "home",
  allowedSections,
  heading,
  description,
  editActions,
  renderSectionActions,
  statusLabel,
}: CustomerDashboardMirrorProps) {
  const visibleSections = useMemo(
    () =>
      ALL_CUSTOMER_DASHBOARD_SECTIONS.filter(
        (section) => !allowedSections || allowedSections.includes(section),
      ),
    [allowedSections],
  );
  const [activeSection, setActiveSection] =
    useState<CustomerDashboardMirrorSection>(
      visibleSections.includes(initialSection)
        ? initialSection
        : (visibleSections[0] ?? "home"),
    );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const normalizedServicePortal = useMemo(
    () => normalizeServicePortal(servicePortal),
    [servicePortal],
  );
  const usesServicePortal = Boolean(
    servicePortal !== undefined ||
      servicePortalLoading ||
      servicePortalError ||
      onRefreshServicePortal,
  );

  useEffect(() => {
    if (visibleSections.includes(initialSection)) {
      setActiveSection(initialSection);
    } else {
      setActiveSection(visibleSections[0] ?? "home");
    }
  }, [initialSection, visibleSections]);

  const selectSection = (section: CustomerDashboardMirrorSection) => {
    setActiveSection(section);
    setMobileNavOpen(false);
  };
  const navigateCustomerRoute = (section: string, sub?: string | null) => {
    selectSection(mirrorSectionForCustomerRoute(section, sub));
  };
  const sectionActions = renderSectionActions?.(activeSection);
  const showEditorBar = Boolean(
    heading || description || editActions || sectionActions || statusLabel,
  );

  return (
    <section
      className="user-brand-dashboard customer-dashboard-mirror"
      aria-label={heading || "客户看板"}
    >
      <div
        className={`app-shell customer-dashboard-mirror-shell ${
          mobileNavOpen ? "nav-open" : ""
        }`}
      >
        <button
          className="mobile-menu-btn"
          type="button"
          onClick={() => setMobileNavOpen((open) => !open)}
          aria-label="切换客户看板菜单"
        >
          {mobileNavOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        {mobileNavOpen && (
          <button
            type="button"
            className="mobile-nav-overlay"
            aria-label="关闭客户看板菜单"
            onClick={() => setMobileNavOpen(false)}
          />
        )}

        <aside className="global-nav customer-dashboard-mirror-nav">
          <div className="nav-title-block">
            <img
              className="frontmind-logo frontmind-reference-logo"
              src="/frontmind-contract-logo-white.svg"
              alt="FrontMind"
            />
            <p>智能品牌优化看板</p>
          </div>

          <div
            className="nav-group-card promise-card"
            role="tablist"
            aria-label="客户页面分区"
          >
            <div className="nav-group-head">
              <span>MindPromise智诺</span>
            </div>
            {CUSTOMER_DASHBOARD_GROUPS.map((group) => {
              const items = group.items.filter((item) =>
                visibleSections.includes(item.value),
              );
              if (!items.length) return null;
              const GroupIcon = group.icon;
              const groupActive = items.some(
                (item) => item.value === activeSection,
              );
              return (
                <div key={group.label} className="customer-mirror-nav-group">
                  <div
                    className={`nav-section-label ${
                      groupActive ? "active" : ""
                    }`}
                  >
                    <GroupIcon className="nav-icon" size={16} />
                    <span>{group.label}</span>
                  </div>
                  <div className="sub-nav">
                    {items.map((item) => (
                      <CustomerMirrorNavButton
                        key={item.value}
                        item={item}
                        active={activeSection === item.value}
                        portal={
                          usesServicePortal ? normalizedServicePortal : null
                        }
                        onSelect={selectSection}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sidebar-footer-brand">
            <small>当前企业</small>
            <strong>{payload.brandName}</strong>
            <small>客户账号实际页面</small>
          </div>
        </aside>

        <main className="dashboard-main customer-dashboard-mirror-main">
          <div className="project-ribbon final-ribbon">
            <div>
              <span>FrontMind 智能品牌优化看板</span>
              <h1>{payload.brandName}</h1>
            </div>
          </div>

          {showEditorBar && (
            <div className="customer-dashboard-editor-bar">
              <div className="customer-dashboard-editor-copy">
                {heading && <strong>{heading}</strong>}
                {description && <p>{description}</p>}
              </div>
              <div className="customer-dashboard-editor-actions">
                {statusLabel && (
                  <span className="customer-dashboard-status">
                    {statusLabel}
                  </span>
                )}
                {editActions}
                {sectionActions}
              </div>
            </div>
          )}

          <CustomerDashboardSection
            section={activeSection}
            payload={payload}
            websiteWorkspace={websiteWorkspace}
            knowledgePreview={knowledgePreview}
            servicePortal={usesServicePortal ? normalizedServicePortal : null}
            servicePortalLoading={servicePortalLoading}
            servicePortalError={servicePortalError}
            onRefreshServicePortal={onRefreshServicePortal}
            onNavigate={navigateCustomerRoute}
          />
        </main>
      </div>
    </section>
  );
}

function CustomerDashboardSection({
  section,
  payload,
  websiteWorkspace,
  knowledgePreview,
  servicePortal,
  servicePortalLoading,
  servicePortalError,
  onRefreshServicePortal,
  onNavigate,
}: {
  section: CustomerDashboardMirrorSection;
  payload: DashboardPayload;
  websiteWorkspace: CustomerDashboardMirrorProps["websiteWorkspace"];
  knowledgePreview: CustomerDashboardMirrorProps["knowledgePreview"];
  servicePortal: ServicePortalView | null;
  servicePortalLoading: boolean;
  servicePortalError: boolean;
  onRefreshServicePortal?: () => void;
  onNavigate: (section: string, sub?: string | null) => void;
}) {
  const questionGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        title: string;
        subtitle: string;
        tone: "plum" | "teal" | "amber" | "blue";
        questions: Array<{
          id: string;
          question: string;
          intent: string;
          summary: string;
        }>;
      }
    >();
    for (const question of payload.questions) {
      const current = groups.get(question.groupId) || {
        id: question.groupId,
        title: question.groupTitle,
        subtitle: question.groupSubtitle || "",
        tone: question.tone || "plum",
        questions: [],
      };
      current.questions.push({
        id: question.id,
        question: question.question,
        intent: question.intent || "",
        summary: question.summary || "",
      });
      groups.set(question.groupId, current);
    }
    return [...groups.values()];
  }, [payload.questions]);

  if (section === "home") {
    return servicePortal ? (
      <ServiceHome
        portal={servicePortal}
        companyName={payload.brandName}
        loading={servicePortalLoading}
        error={servicePortalError}
        onNavigate={onNavigate}
        onRefresh={onRefreshServicePortal}
      />
    ) : (
      <ManagedDashboardSection payload={payload} loading={false} error={null} />
    );
  }

  const capabilityKey = mirrorSectionCapability(section);
  const access =
    servicePortal && capabilityKey
      ? getCapability(servicePortal, capabilityKey)
      : null;
  if (servicePortal && access && !access.allowed) {
    return (
      <ServiceLockedPage
        title={mirrorSectionTitle(section)}
        access={access}
        portal={servicePortal}
        onRefresh={onRefreshServicePortal}
        onNavigate={onNavigate}
      />
    );
  }

  if (section === "website") {
    return websiteWorkspace ? (
      <AiWebsiteManagementWorkspace
        planCode={servicePortal?.plan.code ?? "advanced"}
        marketEdition={websiteWorkspace.marketEdition}
        websiteWorkflow={websiteWorkspace.websiteWorkflow}
        contentCatalog={websiteWorkspace.websiteContentCatalog}
        quota={websiteWorkspace.quotas.website_content_publish}
        tickets={websiteWorkspace.tickets.filter(
          (ticket) => ticket.type === "website_operation",
        )}
        readOnlyPreview
      />
    ) : (
      <MirrorEmpty title="AI 友好官网管理" />
    );
  }

  if (section === "knowledge-build") {
    return knowledgePreview?.progress ||
      knowledgePreview?.activity ||
      knowledgePreview?.activityLoading ||
      knowledgePreview?.activityError ||
      knowledgePreview?.progressLoading ||
      knowledgePreview?.progressError ? (
      <section className="page-shell space-y-5">
        <KnowledgeActivityPanel
          activity={knowledgePreview.activity}
          loading={knowledgePreview.activityLoading}
          error={knowledgePreview.activityError}
        />
        {knowledgePreview.progressError ? (
          <MirrorError
            title="知识库构建进度读取失败"
            message={knowledgePreview.progressError}
          />
        ) : (
          <KnowledgeBaseProgressPanel
            progress={knowledgePreview.progress}
            loading={knowledgePreview.progressLoading}
            title="客户知识库构建进度"
            emptyMessage="该客户尚未开始对话式知识库构建；官网导入的一次性知识库不会伪造节点进度。"
          />
        )}
      </section>
    ) : (
      <MirrorEmpty title="知识库智能体" />
    );
  }

  if (section === "knowledge") {
    return knowledgePreview?.snapshotError ? (
      <section className="page-shell">
        <MirrorError
          title="知识库展示版本读取失败"
          message={knowledgePreview.snapshotError}
        />
      </section>
    ) : knowledgePreview?.snapshot || knowledgePreview?.snapshotLoading ? (
      <section className="page-shell">
        <div className="overflow-hidden rounded-2xl border border-[#e5ddea] bg-white p-4 sm:p-6">
          <KnowledgeBaseViewer
            snapshot={knowledgePreview.snapshot}
            loading={knowledgePreview.snapshotLoading}
          />
        </div>
      </section>
    ) : (
      <MirrorEmpty title="知识库展示" />
    );
  }

  if (section === "keywords") {
    return (
      <ManagedKeywordTables
        tables={payload.keywordTables}
        loading={false}
        error={null}
      />
    );
  }

  if (section === "questions" || section === "response-logic") {
    return payload.questions.length ? (
      <section className="page-shell">
        <header className="page-header">
          <span className="eyebrow">MindPromise智诺 / 意图优化</span>
          <h2>
            {section === "response-logic" ? "应答逻辑智能体" : "问题优化"}
          </h2>
          <p>
            {section === "response-logic"
              ? "逐题核对已发布的用户问题、应答目标与确认口径。"
              : "查看客户问题目录与每个问题对应的真实用户意图。"}
          </p>
        </header>
        <div className="customer-dashboard-question-grid">
          {payload.questions.map((question) => (
            <article key={question.id}>
              <span>{question.groupTitle}</span>
              <h4>{question.question}</h4>
              {question.intent && <p>{question.intent}</p>}
              {question.summary && <small>{question.summary}</small>}
            </article>
          ))}
        </div>
      </section>
    ) : (
      <MirrorEmpty
        title={section === "response-logic" ? "应答逻辑智能体" : "问题优化"}
      />
    );
  }

  if (section === "monitoring") {
    return questionGroups.length || payload.monitoringAnswers.length ? (
      <QuestionMonitoringWorkspace
        questionGroups={questionGroups}
        monitoringAnswers={payload.monitoringAnswers}
        citationMode="inline"
        monitoringAnswersLoading={false}
        monitoringAnswersError={false}
      />
    ) : (
      <MirrorEmpty title="问题监控" />
    );
  }

  if (section === "report") {
    return payload.optimizationReport ? (
      <ProgressReportWorkspace report={payload.optimizationReport} />
    ) : (
      <MirrorEmpty title="进度报告" />
    );
  }

  return payload.contentAssets.length ? (
    <section className="page-shell">
      <PublishedContentAssets assets={payload.contentAssets} />
    </section>
  ) : (
    <MirrorEmpty title="内容资产运营" />
  );
}

function KnowledgeActivityPanel({
  activity,
  loading,
  error,
}: {
  activity?: CustomerKnowledgeActivity | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (error) {
    return <MirrorError title="知识库任务记录读取失败" message={error} />;
  }
  if (loading) {
    return (
      <div className="rounded-2xl border border-[#e5ddea] bg-white p-6 text-sm text-[#716a80]">
        正在读取知识库任务与对话…
      </div>
    );
  }
  if (!activity?.build) {
    return (
      <div className="rounded-2xl border border-[#e5ddea] bg-white p-6 text-sm text-[#716a80]">
        该客户尚未开始对话式知识库构建。
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e5ddea] bg-white">
      <div className="border-b border-[#eee8f2] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-[#5b2a86]">
              当前知识库构建
            </p>
            <h3 className="mt-1 font-semibold text-[#171321]">
              {activity.build.companyName}
            </h3>
            <p className="mt-2 break-all font-mono text-xs text-[#9a94a8]">
              {activity.build.conversationId}
            </p>
          </div>
          <span className="w-fit rounded-full bg-[#5b2a86]/10 px-2.5 py-1 text-xs font-semibold text-[#5b2a86]">
            {activity.build.status}
          </span>
        </div>
        {activity.build.protocolError && (
          <div className="mt-4 rounded-xl border border-[#ebc8d4] bg-[#fff8fa] p-3 text-sm leading-6 text-[#a02652]">
            {activity.build.protocolError}
          </div>
        )}
      </div>
      <div className="grid gap-0 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-b border-[#eee8f2] p-5 xl:border-b-0 xl:border-r">
          <h4 className="text-sm font-semibold text-[#332842]">执行任务</h4>
          {activity.turns.length ? (
            <div className="mt-3 max-h-[430px] space-y-2 overflow-y-auto custom-scrollbar">
              {activity.turns.map((turn) => (
                <article
                  key={turn.id}
                  className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-[#484057]">
                      {turn.model || "模型未记录"}
                    </span>
                    <span className="text-xs text-[#857e91]">
                      {turn.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[#857e91]">
                    {displayDuration(turn.durationMs)}
                  </p>
                  {turn.errorMessage && (
                    <p className="mt-2 text-xs leading-5 text-[#a02652]">
                      {turn.errorMessage}
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#716a80]">暂无执行任务记录。</p>
          )}
        </div>
        <div className="p-5">
          <h4 className="text-sm font-semibold text-[#332842]">最近对话</h4>
          {activity.messages.length ? (
            <div className="mt-3 max-h-[520px] space-y-3 overflow-y-auto pr-1 custom-scrollbar">
              {activity.messages.map((message) => (
                <article
                  key={message.id}
                  className={`rounded-2xl border p-4 ${
                    message.role === "user"
                      ? "border-[#ddd1e5] bg-[#f7f1fb]"
                      : "border-[#e8e1ee] bg-white"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-[#857e91]">
                    <span>
                      {message.role === "user"
                        ? "用户"
                        : message.role === "assistant"
                          ? "Agent"
                          : message.role}
                    </span>
                    <span>
                      {message.sentAt
                        ? new Date(message.sentAt).toLocaleString("zh-CN")
                        : "时间未记录"}
                    </span>
                  </div>
                  <div className="text-sm leading-6 text-[#484057]">
                    <MarkdownRenderer content={message.content} />
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#716a80]">暂无持久化对话记录。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MirrorError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-2xl border border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 leading-6">{message || "请刷新后重试。"}</p>
    </div>
  );
}

function displayDuration(value?: number | null) {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return "执行中或未记录";
  const seconds = Math.round((value ?? 0) / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} 分 ${remainder} 秒`;
}

function MirrorEmpty({ title }: { title: string }) {
  return (
    <section className="page-shell">
      <header className="page-header">
        <span className="eyebrow">MindPromise智诺</span>
        <h2>{title}</h2>
        <p>当前客户账号尚未发布这一分区的正式内容。</p>
      </header>
      <section className="panel">
        <div className="empty-state">
          <Database size={24} />
          <p>发布后，管理员、工程师和客户会在同一位置看到结果。</p>
        </div>
      </section>
    </section>
  );
}
