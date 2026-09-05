import {
  WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
  type DeliverySiteCheckStatus,
  type DeliveryTicketQuota,
  type DeliveryTicketStatus,
  type WebsiteOperationCategory,
} from "@shared/delivery-ticket";
import {
  deliveryCategoryLabel as localizedDeliveryCategoryLabel,
  deliveryTicketPresentationTopic,
} from "@shared/delivery-ticket-presentation";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileClock,
  FileText,
  LockKeyhole,
  Loader2,
  Paperclip,
  Send,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import CustomerRequestHistoryDialog from "@/components/CustomerRequestHistoryDialog";
import AliyunIcpGuide, { type AliyunGuideScenario } from "./AliyunIcpGuide";
import type { ServicePlanCode } from "./service-portal";
import "./ai-website-management-workspace.css";

/*
 * Keep the customer website surface narrow even when it receives an older
 * unscoped workspace payload. Server-side list pagination applies the same
 * whitelist before the cursor and limit.
 */
const WEBSITE_HISTORY_CATEGORIES = new Set<string>(
  WEBSITE_MANAGEMENT_HISTORY_CATEGORIES,
);

/**
 * `domain_application` is included locally while older API clients still expose
 * the previous WebsiteOperationCategory union. The server schema owns the final
 * category list.
 */
export type AiWebsiteWorkOrderCategory =
  | WebsiteOperationCategory
  | "domain_application";

export type AiWebsiteSiteProfile = {
  domain: string;
  revision?: number;
  siteMode?: "managed" | "external" | "unknown";
  domainVerified?: boolean;
  domainStatus?: string | null;
  domainApplicationStatus?: string | null;
  icpVerified?: boolean;
  icpNumber?: string | null;
  icpStatus?: string | null;
  updatedAt?: string | number | Date | null;
};

export type AiWebsiteSiteCheck = {
  id: string;
  key: string;
  label: string;
  status: DeliverySiteCheckStatus;
  summary?: string | null;
  evidence?: string | null;
  source?: string | null;
  checkedAt?: string | number | Date | null;
  revision?: number;
  updatedAt?: string | number | Date | null;
};

export type AiWebsiteTicket = {
  id: string;
  type: "website_operation";
  category?: string | null;
  categoryLabel?: string | null;
  topic?: string | null;
  title?: string | null;
  status?: DeliveryTicketStatus;
  statusLabel?: string | null;
  publicStatus?: "pending" | "completed" | null;
  quotaState?: "reserved" | "consumed" | "released";
  revision?: number;
  submittedAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  resolvedAt?: string | number | Date | null;
  publicSummary?: string | null;
  adminPublicSummary?: string | null;
  completionSummary?: string | null;
  latestPublicMessage?: string | null;
  attachmentCount?: number;
  deliveryLinks?: Array<{
    id?: string;
    label: string;
    url: string;
  }>;
};

export type AiWebsiteWorkOrderSubmission = {
  category: AiWebsiteWorkOrderCategory | null;
  topic: string;
  description: string;
  /** Kept for compatibility with the current adapter; the new form never sets it. */
  targetPage: string;
  materialUrls: string[];
  attachmentFiles: File[];
  icpDeclarations?: {
    icpNumber: string;
  };
};

export type AiWebsiteWorkflowState = {
  domainApplication?: "not_started" | "pending" | "completed";
  icpFiling?: "locked" | "not_started" | "pending" | "completed";
  contentOperation?: "locked" | "available";
};

export type AiWebsiteWorkflowMetadata = {
  domainStatus?: string | null;
  icpStatus?: string | null;
  domainCompleted?: boolean;
  icpCompleted?: boolean;
  canSubmitDomain?: boolean;
  canSubmitIcp?: boolean;
  canSubmitContent?: boolean;
  styleState?:
    | "locked"
    | "waiting_samples"
    | "awaiting_selection"
    | "revision_requested"
    | "confirmed"
    | "legacy_confirmed";
  styleRevision?: number;
  styleBatch?: {
    id: string;
    ordinal: number;
    engineerNote?: string | null;
    publishedAt?: string | number | Date | null;
    samples: Array<{
      id: string;
      label: string;
      note?: string | null;
      imageUrl: string;
      filename: string;
    }>;
  } | null;
  selectedStyleSampleId?: string | null;
  styleConfirmed?: boolean;
  websiteBuildStatus?: "locked" | "pending" | "completed";
  canSelectStyle?: boolean;
  canRequestStyleRevision?: boolean;
  lockReason?: string | null;
  domainLockReason?: string | null;
  icpLockReason?: string | null;
  contentLockReason?: string | null;
};

export type AiWebsiteQuota = Pick<
  DeliveryTicketQuota,
  "allowed" | "limit" | "remaining" | "reason"
>;

export type AiWebsiteManagementWorkspaceProps = {
  planCode: ServicePlanCode;
  marketEdition?: "domestic" | "overseas";
  siteProfile?: AiWebsiteSiteProfile | null;
  /** Historical check data is accepted for API compatibility but is never rendered. */
  siteChecks?: AiWebsiteSiteCheck[];
  websiteWorkflow?: AiWebsiteWorkflowMetadata | null;
  contentCatalog?: ReadonlyArray<{
    value: AiWebsiteWorkOrderCategory;
    label: string;
  }>;
  workflowState?: AiWebsiteWorkflowState | null;
  quota?: AiWebsiteQuota | null;
  tickets?: AiWebsiteTicket[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  error?: string | null;
  readOnlyPreview?: boolean;
  /** New SiteOps keeps build and preview independent from the legacy domain/ICP gate. */
  siteOpsMode?: boolean;
  siteOpsPanel?: ReactNode;
  onSubmit?: (input: AiWebsiteWorkOrderSubmission) => Promise<void> | void;
  onSelectStyle?: (input: {
    sampleId: string;
    expectedRevision: number;
  }) => Promise<void> | void;
  onRequestStyleRevision?: (input: {
    reason: string;
    expectedRevision: number;
  }) => Promise<void> | void;
  /** Opens the customer-visible timeline and supplement dialogue for a work order. */
  onOpenTicket?: (ticketId: string) => void;
  onRefresh?: () => Promise<void> | void;
  onLoadMore?: () => Promise<void> | void;
  onUpgrade?: () => void;
  onContactAdvisor?: () => void;
};

type WorkOrderTypeDefinition = {
  id: AiWebsiteWorkOrderCategory;
  label: string;
};

const DOMAIN_APPLICATION: WorkOrderTypeDefinition = {
  id: "domain_application",
  label: "域名核验与备案准备",
};

const ICP_FILING: WorkOrderTypeDefinition = {
  id: "icp_filing",
  label: "ICP 备案结果核验",
};

const CLOSED_TICKET_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

const VERIFIED_PROFILE_STATUSES = new Set([
  "active",
  "approved",
  "completed",
  "not_required",
  "passed",
  "verified",
]);

type WorkflowPhase = "domain" | "icp" | "content";

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseReferenceLinks(value: string) {
  const candidates = Array.from(
    new Set(
      value
        .split(/[\r\n,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const invalid: string[] = [];
  const urls = candidates.filter((candidate) => {
    const valid = isHttpUrl(candidate);
    if (!valid) invalid.push(candidate);
    return valid;
  });
  return { urls, invalid };
}

function ticketIsCompleted(ticket: AiWebsiteTicket) {
  if (ticket.publicStatus) return ticket.publicStatus === "completed";
  return Boolean(ticket.status && CLOSED_TICKET_STATUSES.has(ticket.status));
}

function ticketWasDelivered(ticket: AiWebsiteTicket) {
  if (ticket.status === "rejected" || ticket.status === "cancelled") {
    return false;
  }
  return ticket.status === "completed" || ticket.publicStatus === "completed";
}

function icpServiceCodeFromTicket(ticket: AiWebsiteTicket) {
  const match = ticket.publicSummary
    ?.trim()
    .match(/^备案服务码\s*[：:]\s*(.+)$/u);
  return match?.[1]?.trim() || "";
}

function ticketSummary(ticket: AiWebsiteTicket) {
  return (
    ticket.publicSummary?.trim() ||
    ticket.adminPublicSummary?.trim() ||
    ticket.completionSummary?.trim() ||
    ""
  );
}

function categoryLabel(
  ticket: AiWebsiteTicket,
  contentCatalog: WorkOrderTypeDefinition[],
) {
  const catalogLabel = [DOMAIN_APPLICATION, ICP_FILING, ...contentCatalog].find(
    (item) => item.id === ticket.category,
  )?.label;
  return localizedDeliveryCategoryLabel({
    type: ticket.type,
    category: ticket.category,
    providedLabel: ticket.categoryLabel?.trim() || catalogLabel,
  });
}

function profileStatusCompleted(value: string | null | undefined) {
  return Boolean(value && VERIFIED_PROFILE_STATUSES.has(value.toLowerCase()));
}

function activeTicketFor(
  tickets: AiWebsiteTicket[],
  category: AiWebsiteWorkOrderCategory,
) {
  return tickets.find(
    (ticket) => ticket.category === category && !ticketIsCompleted(ticket),
  );
}

function deriveWorkflow({
  websiteWorkflow,
  workflowState,
  siteProfile,
  tickets,
}: {
  websiteWorkflow?: AiWebsiteWorkflowMetadata | null;
  workflowState?: AiWebsiteWorkflowState | null;
  siteProfile?: AiWebsiteSiteProfile | null;
  tickets: AiWebsiteTicket[];
}) {
  const completedCategories = new Set(
    tickets.filter(ticketWasDelivered).map((ticket) => ticket.category),
  );
  const domainPending = Boolean(activeTicketFor(tickets, "domain_application"));
  const icpPending = Boolean(activeTicketFor(tickets, "icp_filing"));
  const domainCompleted = websiteWorkflow
    ? websiteWorkflow.domainCompleted === true ||
      websiteWorkflow.canSubmitContent === true ||
      profileStatusCompleted(websiteWorkflow.domainStatus)
    : workflowState?.domainApplication === "completed" ||
      siteProfile?.domainVerified === true ||
      profileStatusCompleted(siteProfile?.domainStatus) ||
      profileStatusCompleted(siteProfile?.domainApplicationStatus) ||
      completedCategories.has("domain_application");
  const icpCompleted =
    domainCompleted &&
    (websiteWorkflow
      ? websiteWorkflow.icpCompleted === true ||
        websiteWorkflow.canSubmitContent === true ||
        profileStatusCompleted(websiteWorkflow.icpStatus)
      : workflowState?.icpFiling === "completed" ||
        siteProfile?.icpVerified === true ||
        Boolean(siteProfile?.icpNumber?.trim()) ||
        profileStatusCompleted(siteProfile?.icpStatus) ||
        completedCategories.has("icp_filing"));

  return {
    domainCompleted,
    domainPending:
      !domainCompleted &&
      (websiteWorkflow?.domainStatus === "pending" ||
        workflowState?.domainApplication === "pending" ||
        domainPending),
    icpCompleted,
    icpPending:
      !icpCompleted &&
      (websiteWorkflow?.icpStatus === "pending" ||
        websiteWorkflow?.icpStatus === "preparing" ||
        workflowState?.icpFiling === "pending" ||
        icpPending ||
        domainPending),
  };
}

function phaseDefinition(phase: WorkflowPhase) {
  if (phase === "domain") return DOMAIN_APPLICATION;
  if (phase === "icp") return ICP_FILING;
  return null;
}

export default function AiWebsiteManagementWorkspace({
  marketEdition = "domestic",
  siteProfile = null,
  websiteWorkflow = null,
  contentCatalog = [],
  workflowState = null,
  quota = null,
  tickets = [],
  loading = false,
  loadingMore = false,
  hasMore = false,
  error = null,
  readOnlyPreview = false,
  siteOpsMode = false,
  siteOpsPanel = null,
  onSubmit,
  onSelectStyle,
  onRequestStyleRevision,
  onOpenTicket,
  onRefresh,
  onLoadMore,
  onUpgrade,
  onContactAdvisor,
}: AiWebsiteManagementWorkspaceProps) {
  const [guideScenario, setGuideScenario] = useState<AliyunGuideScenario>(
    marketEdition === "overseas" ? "overseas" : "first_filing",
  );
  const [selectedType, setSelectedType] =
    useState<AiWebsiteWorkOrderCategory | null>(null);
  const [topic, setTopic] = useState("");
  const [purchasedDomain, setPurchasedDomain] = useState("");
  const [filedDomain, setFiledDomain] = useState("");
  const [icpNumber, setIcpNumber] = useState("");
  const [details, setDetails] = useState("");
  const [referenceLinks, setReferenceLinks] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submissionPhase, setSubmissionPhase] = useState<WorkflowPhase | null>(
    null,
  );
  const [submitMessage, setSubmitMessage] = useState("");
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleMessage, setStyleMessage] = useState("");
  const [styleRevisionReason, setStyleRevisionReason] = useState("");
  const overseasAccount = marketEdition === "overseas";
  const websiteTickets = useMemo(
    () =>
      tickets.filter((ticket) =>
        WEBSITE_HISTORY_CATEGORIES.has(ticket.category?.trim() || ""),
      ),
    [tickets],
  );

  useEffect(() => {
    setGuideScenario(
      marketEdition === "overseas" ? "overseas" : "first_filing",
    );
  }, [marketEdition]);

  const workflow = useMemo(
    () =>
      deriveWorkflow({
        websiteWorkflow,
        workflowState,
        siteProfile,
        tickets: websiteTickets,
      }),
    [siteProfile, websiteTickets, websiteWorkflow, workflowState],
  );
  const styleState =
    websiteWorkflow?.styleState ??
    (websiteWorkflow?.canSubmitContent === true
      ? "legacy_confirmed"
      : workflow.icpCompleted
        ? "waiting_samples"
        : "locked");
  const styleConfirmed =
    websiteWorkflow?.styleConfirmed === true ||
    styleState === "confirmed" ||
    styleState === "legacy_confirmed";
  const websiteBuildStatus =
    websiteWorkflow?.websiteBuildStatus ??
    (websiteWorkflow?.canSubmitContent === true
      ? "completed"
      : styleConfirmed
        ? "pending"
        : "locked");
  const styleGateActive = workflow.icpCompleted && !styleConfirmed;
  const prerequisiteStepLabel = overseasAccount
    ? "企业域名注册与确认"
    : "阿里云域名注册与 ICP 备案";
  const prerequisiteStepStatus = overseasAccount
    ? workflow.domainCompleted
      ? "域名已确认"
      : workflow.domainPending
        ? "域名确认中"
        : "待提交域名"
    : workflow.icpCompleted
      ? "域名与备案已确认"
      : workflow.domainPending
        ? "域名确认中"
        : workflow.icpPending
          ? "备案确认中"
          : workflow.domainCompleted
            ? "待提交备案"
            : "待提交域名";
  const contentStepState = !workflow.icpCompleted
    ? "locked"
    : styleConfirmed && websiteBuildStatus === "completed"
      ? "current"
      : "pending";
  const contentStepStatus = !workflow.icpCompleted
    ? overseasAccount
      ? "待域名确认"
      : "待域名与备案确认"
    : !styleConfirmed
      ? "待风格确认"
      : websiteBuildStatus === "completed"
        ? "已开放"
        : "官网构建中";
  const phase: WorkflowPhase = !workflow.domainCompleted
    ? "domain"
    : !workflow.icpCompleted
      ? "icp"
      : "content";
  const phaseAllowedByWorkflow =
    !websiteWorkflow ||
    (phase === "domain"
      ? websiteWorkflow.canSubmitDomain !== false
      : phase === "icp"
        ? websiteWorkflow.canSubmitIcp !== false
        : websiteWorkflow.canSubmitContent !== false);
  const workflowLockReason =
    phase === "domain"
      ? websiteWorkflow?.domainLockReason || websiteWorkflow?.lockReason
      : phase === "icp"
        ? websiteWorkflow?.icpLockReason || websiteWorkflow?.lockReason
        : phase === "content"
          ? websiteWorkflow?.contentLockReason || websiteWorkflow?.lockReason
          : websiteWorkflow?.lockReason;
  const contentTypes = useMemo(
    () =>
      contentCatalog.map((item) => ({
        id: item.value,
        label: item.label,
      })),
    [contentCatalog],
  );
  const localizedWebsiteHistoryTickets = useMemo(
    () =>
      websiteTickets.map((ticket) => {
        const localizedCategoryLabel = categoryLabel(ticket, contentTypes);
        const localizedTopic = deliveryTicketPresentationTopic({
          ...ticket,
          fallbackLabel: localizedCategoryLabel,
        });
        return {
          ...ticket,
          categoryLabel: localizedCategoryLabel,
          topic:
            localizedTopic === localizedCategoryLabel ? null : localizedTopic,
        };
      }),
    [contentTypes, websiteTickets],
  );
  const serviceAllowed = Boolean(quota?.allowed);
  const quotaExhausted =
    phase === "content" &&
    Boolean(quota && quota.limit > 0 && quota.remaining <= 0);
  const submitting = submitState === "submitting";
  const completedDomainTicket = useMemo(
    () =>
      websiteTickets.find(
        (ticket) =>
          ticket.category === "domain_application" &&
          ticketWasDelivered(ticket),
      ) ?? null,
    [websiteTickets],
  );
  const domainServiceCode = completedDomainTicket
    ? icpServiceCodeFromTicket(completedDomainTicket)
    : "";
  function openWebsiteHistory(_category: string | null) {
    setHistoryOpen(true);
  }

  useEffect(() => {
    if (filedDomain.trim()) return;
    const knownDomain =
      siteProfile?.domain?.trim() ||
      completedDomainTicket?.topic?.trim() ||
      purchasedDomain.trim();
    if (workflow.domainCompleted && knownDomain) setFiledDomain(knownDomain);
  }, [
    completedDomainTicket?.topic,
    filedDomain,
    purchasedDomain,
    siteProfile?.domain,
    workflow.domainCompleted,
  ]);

  function phaseIsPending(targetPhase: WorkflowPhase) {
    if (targetPhase === "domain") return workflow.domainPending;
    if (targetPhase === "icp") return workflow.icpPending;
    return false;
  }

  function phaseIsCompleted(targetPhase: WorkflowPhase) {
    if (targetPhase === "domain") return workflow.domainCompleted;
    if (targetPhase === "icp") return workflow.icpCompleted;
    return false;
  }

  function workflowAllowsPhase(targetPhase: WorkflowPhase) {
    if (!websiteWorkflow) {
      return targetPhase !== "icp" || workflow.domainCompleted;
    }
    if (targetPhase === "domain") {
      return websiteWorkflow.canSubmitDomain !== false;
    }
    if (targetPhase === "icp") {
      return workflow.domainCompleted && websiteWorkflow.canSubmitIcp !== false;
    }
    return websiteWorkflow.canSubmitContent !== false;
  }

  function submissionDisabled(targetPhase: WorkflowPhase) {
    return (
      submitting ||
      phaseIsPending(targetPhase) ||
      phaseIsCompleted(targetPhase) ||
      (submissionPhase === targetPhase && submitState === "success") ||
      !workflowAllowsPhase(targetPhase) ||
      (targetPhase === "content" && quotaExhausted) ||
      !serviceAllowed ||
      !onSubmit
    );
  }

  function submissionStateFor(targetPhase: WorkflowPhase) {
    return submissionPhase === targetPhase ? submitState : "idle";
  }

  function submissionMessageFor(targetPhase: WorkflowPhase) {
    return submissionPhase === targetPhase ? submitMessage : "";
  }

  if (readOnlyPreview) {
    return (
      <EngineerWebsiteCustomerPreview
        marketEdition={marketEdition}
        siteProfile={siteProfile}
        websiteWorkflow={websiteWorkflow}
        workflow={workflow}
        styleState={styleState}
        contentTypes={contentTypes}
        tickets={localizedWebsiteHistoryTickets}
        loading={loading}
        error={error}
      />
    );
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setAttachments((current) => [...current, ...nextFiles]);
    event.target.value = "";
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
    targetPhase: WorkflowPhase,
  ) {
    event.preventDefault();
    setSubmissionPhase(targetPhase);
    if (submissionDisabled(targetPhase) || !onSubmit) return;
    const normalizedTopic =
      targetPhase === "domain"
        ? purchasedDomain.trim()
        : targetPhase === "icp"
          ? filedDomain.trim()
          : topic.trim();
    const effectiveType = phaseDefinition(targetPhase)?.id ?? selectedType;
    if (!effectiveType) {
      setSubmitState("error");
      setSubmitMessage("请选择一项官网内容需求类型。");
      return;
    }
    if (!normalizedTopic) {
      setSubmitState("error");
      setSubmitMessage(
        targetPhase === "domain"
          ? "请填写已经在阿里云购买并显示“正常”的域名。"
          : targetPhase === "icp"
            ? "请填写已完成备案的域名。"
            : "请填写需要处理的话题。",
      );
      return;
    }
    if (targetPhase === "icp" && !icpNumber.trim()) {
      setSubmitState("error");
      setSubmitMessage("请填写阿里云备案通过后获得的 ICP 主体备案号。");
      return;
    }
    const parsedLinks = parseReferenceLinks(referenceLinks);
    if (parsedLinks.invalid.length > 0) {
      setSubmitState("error");
      setSubmitMessage(
        `以下参考链接格式不正确：${parsedLinks.invalid.slice(0, 3).join("、")}`,
      );
      return;
    }

    setSubmitState("submitting");
    setSubmitMessage("");
    try {
      await onSubmit({
        category: effectiveType,
        topic: normalizedTopic,
        description:
          targetPhase === "content"
            ? details.trim()
            : targetPhase === "domain"
              ? guideScenario === "existing_filing"
                ? "备案场景：国内版 · 企业已有 ICP 备案（已有主体下新增网站）。"
                : guideScenario === "overseas"
                  ? "部署场景：海外版 · 中国香港或海外节点；无需工信部 ICP 备案。"
                  : "备案场景：国内版 · 企业首次备案。"
              : "",
        targetPage: "",
        materialUrls: targetPhase === "content" ? parsedLinks.urls : [],
        attachmentFiles: targetPhase === "content" ? attachments : [],
        ...(targetPhase === "icp"
          ? {
              icpDeclarations: {
                icpNumber: icpNumber.trim(),
              },
            }
          : {}),
      });
      if (targetPhase === "domain") {
        setFiledDomain((current) => current.trim() || normalizedTopic);
      } else if (targetPhase === "icp") {
        setIcpNumber("");
      } else if (targetPhase === "content") {
        setTopic("");
        setDetails("");
        setReferenceLinks("");
        setAttachments([]);
        setSelectedType(null);
      }
      setSubmitState("success");
      setSubmitMessage(
        targetPhase === "domain"
          ? overseasAccount
            ? "海外版域名已提交，AI 运维需求已创建。无需办理 ICP 备案。"
            : "域名已提交，AI 运维需求已创建。请等待需求返回备案服务码。"
          : targetPhase === "icp"
            ? "备案结果已提交，等待平台确认。"
            : "需求已提交。",
      );
    } catch (submissionError) {
      setSubmitState("error");
      setSubmitMessage(
        submissionError instanceof Error && submissionError.message
          ? submissionError.message
          : "提交失败，请稍后重试。",
      );
    }
  }

  if (siteOpsMode) {
    return (
      <section
        className="ai-website-workspace"
        aria-labelledby="ai-website-title"
        data-workflow="site-ops"
      >
        <header className="ai-website-header">
          <p className="ai-website-eyebrow">企业知识库驱动</p>
          <h1 id="ai-website-title">{SITEOPS_CUSTOMER_DISPLAY_NAME}</h1>
          <p className="ai-website-intro">
            选择企业知识库和视觉方案，即可完成官网制作、预览、域名配置与发布。
          </p>
        </header>
        {siteOpsPanel || (
          <section className="ai-website-inline-state" role="status">
            正在连接 AI 建站会话…
          </section>
        )}
      </section>
    );
  }

  return (
    <section
      className="ai-website-workspace"
      aria-labelledby="ai-website-title"
    >
      <header className="ai-website-header">
        <p className="ai-website-eyebrow">AI 友好内容资产</p>
        <h1 id="ai-website-title">{SITEOPS_CUSTOMER_DISPLAY_NAME}</h1>
        <p className="ai-website-intro">
          {overseasAccount
            ? "先注册企业实名域名，再回到这里提交域名创建 AI 运维需求。香港或海外节点无需办理工信部 ICP 备案。"
            : "先在阿里云购买企业实名域名，再按图文教程逐步完成域名提交和 ICP 备案。"}
        </p>
      </header>

      <section
        className="ai-website-prerequisites"
        aria-labelledby="ai-website-prerequisites-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-prerequisites-title">官网开通进度</h2>
            <p>
              {overseasAccount
                ? "域名提交后由 AI 运维完成香港或海外节点、DNS 与 HTTPS 配置。"
                : "先完成企业域名注册，再按当前进度继续办理。"}
            </p>
          </div>
        </div>
        <ol className="ai-website-stepper">
          <WorkflowStep
            index={1}
            label={prerequisiteStepLabel}
            state={
              workflow.icpCompleted
                ? "completed"
                : workflow.domainPending || workflow.icpPending
                  ? "pending"
                  : "current"
            }
            statusLabel={prerequisiteStepStatus}
          />
          <WorkflowStep
            index={2}
            label="AI专用官网构建与内容运营"
            state={contentStepState}
            statusLabel={contentStepStatus}
          />
        </ol>
      </section>

      {!serviceAllowed ? (
        <section className="ai-website-locked" aria-label="官网运营功能未开放">
          <LockKeyhole size={24} aria-hidden="true" />
          <div>
            <h2>当前不能提交新的官网需求</h2>
            <p>{quota?.reason || "当前服务暂未开放官网运营需求。"}</p>
          </div>
          {onUpgrade && (
            <button
              type="button"
              className="ai-website-primary-button"
              onClick={onUpgrade}
            >
              查看服务方式
            </button>
          )}
        </section>
      ) : styleGateActive ? (
        <section className="ai-website-form" aria-label="官网图片风格选择">
          <div className="ai-website-section-heading">
            <div>
              <h2>选择 AI 专用官网图片风格</h2>
              <p>
                {overseasAccount
                  ? "域名已经确认。工程师会先提供三张图片样例；确认风格后系统会自动创建官网构建工单。"
                  : "域名与备案已经确认。工程师会先提供三张图片样例；确认风格后系统会自动创建官网构建工单。"}
              </p>
            </div>
            <button
              type="button"
              className="ai-website-secondary-button"
              onClick={() => openWebsiteHistory("website_style_samples")}
            >
              <FileClock size={16} aria-hidden="true" />
              需求记录
            </button>
          </div>
          {styleState === "waiting_samples" ||
          styleState === "revision_requested" ? (
            <div className="ai-website-inline-state" role="status">
              {styleState === "revision_requested"
                ? "已提交调整意见，正在等待工程师返回新一批三张图片样例。"
                : "正在等待工程师返回三张图片风格样例，无需重复提交。"}
            </div>
          ) : websiteWorkflow?.styleBatch?.samples?.length === 3 ? (
            <>
              {websiteWorkflow.styleBatch.engineerNote && (
                <div className="ai-website-inline-state">
                  工程师说明：{websiteWorkflow.styleBatch.engineerNote}
                </div>
              )}
              <div className="ai-website-style-grid">
                {websiteWorkflow.styleBatch.samples.map((sample) => (
                  <article className="ai-website-style-card" key={sample.id}>
                    <img src={sample.imageUrl} alt={sample.label} />
                    <div>
                      <strong>{sample.label}</strong>
                      {sample.note && <p>{sample.note}</p>}
                      <button
                        type="button"
                        className="ai-website-primary-button"
                        disabled={
                          styleBusy ||
                          websiteWorkflow.canSelectStyle === false ||
                          !onSelectStyle
                        }
                        onClick={async () => {
                          if (
                            !onSelectStyle ||
                            !window.confirm(
                              `确认选择“${sample.label}”作为官网图片风格？确认后系统将创建官网构建工单，工程师完成构建后再开放内容运营。`,
                            )
                          ) {
                            return;
                          }
                          setStyleBusy(true);
                          setStyleMessage("");
                          try {
                            await onSelectStyle({
                              sampleId: sample.id,
                              expectedRevision:
                                websiteWorkflow.styleRevision || 1,
                            });
                            setStyleMessage(
                              "风格已确认，官网构建工单已创建；工程师完成构建后开放内容运营。",
                            );
                          } catch (selectionError) {
                            setStyleMessage(
                              selectionError instanceof Error
                                ? selectionError.message
                                : "风格确认失败，请稍后重试。",
                            );
                          } finally {
                            setStyleBusy(false);
                          }
                        }}
                      >
                        {styleBusy && <Loader2 size={16} aria-hidden="true" />}
                        选择此风格
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="ai-website-style-revision">
                <label className="ai-website-form-field">
                  <span>三张都不合适？请说明需要调整的方向</span>
                  <textarea
                    rows={3}
                    value={styleRevisionReason}
                    onChange={(event) =>
                      setStyleRevisionReason(event.target.value)
                    }
                    placeholder="例如：希望更克制、减少科技蓝、增加真实业务场景照片"
                  />
                </label>
                <button
                  type="button"
                  className="ai-website-secondary-button"
                  disabled={
                    styleBusy ||
                    !styleRevisionReason.trim() ||
                    websiteWorkflow.canRequestStyleRevision === false ||
                    !onRequestStyleRevision
                  }
                  onClick={async () => {
                    if (!onRequestStyleRevision) return;
                    setStyleBusy(true);
                    setStyleMessage("");
                    try {
                      await onRequestStyleRevision({
                        reason: styleRevisionReason.trim(),
                        expectedRevision: websiteWorkflow.styleRevision || 1,
                      });
                      setStyleRevisionReason("");
                      setStyleMessage("调整意见已提交，等待工程师重做样例。");
                    } catch (revisionError) {
                      setStyleMessage(
                        revisionError instanceof Error
                          ? revisionError.message
                          : "提交调整意见失败，请稍后重试。",
                      );
                    } finally {
                      setStyleBusy(false);
                    }
                  }}
                >
                  退回工程师重做
                </button>
              </div>
              {styleMessage && (
                <p className="ai-website-submit-message" aria-live="polite">
                  {styleMessage}
                </p>
              )}
            </>
          ) : (
            <div className="ai-website-inline-state" role="status">
              样例数据正在同步，请稍后刷新。
            </div>
          )}
        </section>
      ) : (
        <div className="ai-website-form">
          <div className="ai-website-section-heading">
            <div>
              <h2>
                {phase === "domain"
                  ? "阿里云企业域名注册图文教程"
                  : phase === "icp"
                    ? "领取服务码并完成 ICP 备案"
                    : "提交官网内容运营需求"}
              </h2>
              {phase !== "content" && (
                <p>
                  本站不接收营业执照、身份证、授权书、负责人照片或人脸核验信息。
                </p>
              )}
            </div>
            {phase === "content" && quota && (
              <span className="ai-website-quota-copy">
                剩余 {quota.remaining} / {quota.limit}
              </span>
            )}
          </div>

          {phase !== "content" ? (
            <AliyunIcpGuide
              currentPhase={phase}
              marketEdition={marketEdition}
              onContactAdvisor={onContactAdvisor}
              scenario={guideScenario}
              onScenarioChange={setGuideScenario}
              stageThreeContent={
                <div
                  className="ai-website-guide-stage-flow"
                  id="ai-website-domain-form"
                  tabIndex={-1}
                >
                  {!workflow.domainCompleted &&
                    (phaseIsPending("domain") ? (
                      <div
                        className="ai-website-guide-stage-submission"
                        role="status"
                      >
                        <div className="ai-website-result-heading">
                          <strong>域名已提交，等待 AI 运维处理</strong>
                          <p>
                            {overseasAccount
                              ? "正在配置香港或海外节点、DNS 与 HTTPS，请勿重复提交。"
                              : "备案服务码会在域名需求完成后显示在下方接收处，请勿重复提交。"}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="ai-website-secondary-button"
                          onClick={() =>
                            openWebsiteHistory("domain_application")
                          }
                        >
                          <FileClock size={16} aria-hidden="true" />
                          需求记录
                        </button>
                      </div>
                    ) : workflowAllowsPhase("domain") ? (
                      <form
                        className="ai-website-guide-stage-submission"
                        onSubmit={(event) => handleSubmit(event, "domain")}
                        noValidate
                      >
                        <div className="ai-website-result-heading">
                          <strong>
                            {guideScenario === "overseas"
                              ? "海外版域名购买完成后，在这里提交"
                              : "域名购买完成后，在这里提交"}
                          </strong>
                          <p>
                            {guideScenario === "overseas"
                              ? "只提交域名列表中状态为“正常”的主域名。系统会把香港或海外节点场景写入 AI 运维需求；无需备案服务码和 ICP 备案号。"
                              : "只提交阿里云域名列表中状态为“正常”的主域名。提交后会自动创建 AI 运维需求，并在需求完成时返回备案服务码。"}
                          </p>
                        </div>

                        <label className="ai-website-form-field">
                          <span>已购买域名</span>
                          <input
                            type="text"
                            aria-label="已购买域名"
                            aria-required="true"
                            value={purchasedDomain}
                            onChange={(event) =>
                              setPurchasedDomain(event.target.value)
                            }
                            placeholder="例如 example.com"
                          />
                          <small className="ai-website-field-help">
                            不要填写
                            www、http、https、订单号或页面路径；此处无需备案服务码。
                          </small>
                        </label>

                        {!onSubmit && (
                          <div
                            className="ai-website-inline-state"
                            role="status"
                          >
                            需求提交服务暂时不可用。
                          </div>
                        )}

                        <div className="ai-website-form-actions">
                          <p
                            className={`ai-website-submit-message ${submissionStateFor("domain")}`}
                            aria-live="polite"
                          >
                            {submissionMessageFor("domain")}
                          </p>
                          <div className="ai-website-action-buttons">
                            <button
                              type="button"
                              className="ai-website-secondary-button"
                              onClick={() =>
                                openWebsiteHistory("domain_application")
                              }
                            >
                              <FileClock size={16} aria-hidden="true" />
                              需求记录
                            </button>
                            <button
                              type="submit"
                              className="ai-website-primary-button"
                              disabled={submissionDisabled("domain")}
                            >
                              <Send size={17} aria-hidden="true" />
                              {submissionStateFor("domain") === "submitting"
                                ? "正在提交…"
                                : "提交域名，创建 AI 运维需求"}
                            </button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <div
                        className="ai-website-guide-stage-submission"
                        role="status"
                      >
                        {websiteWorkflow?.domainLockReason ||
                          websiteWorkflow?.lockReason ||
                          "当前暂不能提交域名。"}
                      </div>
                    ))}

                  {workflow.domainCompleted && (
                    <div
                      className="ai-website-guide-stage-submission"
                      role="status"
                    >
                      <div className="ai-website-result-heading">
                        <strong>域名需求已完成</strong>
                        <p>
                          {completedDomainTicket?.topic ||
                            siteProfile?.domain ||
                            "已购买域名已经平台确认。"}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="ai-website-secondary-button"
                        onClick={() => openWebsiteHistory("domain_application")}
                      >
                        <FileClock size={16} aria-hidden="true" />
                        需求记录
                      </button>
                    </div>
                  )}

                  {!overseasAccount && (
                    <section
                      className="ai-website-service-code-receipt"
                      aria-labelledby="ai-website-service-code-title"
                    >
                      <div>
                        <strong id="ai-website-service-code-title">
                          备案服务码接收处
                        </strong>
                        <p>
                          域名提交后，AI
                          运维返回的备案服务码会直接显示在这里；复制后继续下一步
                          ICP 备案。
                        </p>
                      </div>
                      {domainServiceCode ? (
                        <div
                          className="ai-website-service-code-value"
                          role="status"
                        >
                          <span>备案服务码</span>
                          <code>{domainServiceCode}</code>
                          <small>
                            复制服务码，然后展开下一步“进入 ICP
                            备案系统并完成基础信息校验”继续办理。
                          </small>
                        </div>
                      ) : (
                        <div className="ai-website-inline-state" role="status">
                          等待 AI 运维工程师在域名需求内提供备案服务码。
                        </div>
                      )}
                    </section>
                  )}
                </div>
              }
              filingSubmissionContent={
                <form
                  className="ai-website-guide-stage-submission"
                  id="ai-website-result-form"
                  tabIndex={-1}
                  onSubmit={(event) => handleSubmit(event, "icp")}
                  noValidate
                >
                  <div className="ai-website-result-heading">
                    <strong>备案信息回填处</strong>
                    <p>
                      这里直接填写已备案域名与 ICP
                      主体备案号。备案服务码返回前可以先填写，取得服务码并完成阿里云备案后即可提交。
                    </p>
                  </div>

                  <label className="ai-website-form-field">
                    <span>已备案域名</span>
                    <input
                      type="text"
                      aria-label="已备案域名"
                      aria-required="true"
                      value={filedDomain}
                      onChange={(event) => setFiledDomain(event.target.value)}
                      placeholder="例如 example.com"
                    />
                  </label>

                  <label className="ai-website-form-field">
                    <span>ICP 主体备案号</span>
                    <input
                      type="text"
                      aria-label="ICP 主体备案号"
                      aria-required="true"
                      value={icpNumber}
                      onChange={(event) => setIcpNumber(event.target.value)}
                      placeholder="例如 京ICP备12345678号"
                    />
                    <small className="ai-website-field-help">
                      请填写备案主体编号，不要填写密码、证件号码、负责人照片或其他备案材料。
                    </small>
                  </label>

                  {workflow.icpPending ? (
                    <div className="ai-website-inline-state" role="status">
                      备案结果已提交，等待平台确认，请勿重复提交。
                    </div>
                  ) : !workflow.domainCompleted ? (
                    <div className="ai-website-inline-state" role="status">
                      回填项已开放；域名需求完成后，提交按钮会自动开放。
                    </div>
                  ) : null}
                  {!onSubmit && (
                    <div className="ai-website-inline-state" role="status">
                      需求提交服务暂时不可用。
                    </div>
                  )}

                  <div className="ai-website-form-actions">
                    <p
                      className={`ai-website-submit-message ${submissionStateFor("icp")}`}
                      aria-live="polite"
                    >
                      {submissionMessageFor("icp")}
                    </p>
                    <div className="ai-website-action-buttons">
                      <button
                        type="button"
                        className="ai-website-secondary-button"
                        onClick={() => openWebsiteHistory("icp_filing")}
                      >
                        <FileClock size={16} aria-hidden="true" />
                        需求记录
                      </button>
                      <button
                        type="submit"
                        className="ai-website-primary-button"
                        disabled={submissionDisabled("icp")}
                      >
                        <Send size={17} aria-hidden="true" />
                        {submissionStateFor("icp") === "submitting"
                          ? "正在提交…"
                          : "提交备案结果"}
                      </button>
                    </div>
                  </div>
                </form>
              }
            />
          ) : !phaseAllowedByWorkflow ? (
            <div className="ai-website-inline-state" role="status">
              {workflowLockReason || "当前阶段暂未开放。"}
            </div>
          ) : (
            <form
              className="ai-website-content-request-form"
              onSubmit={(event) => handleSubmit(event, "content")}
              noValidate
            >
              <label className="ai-website-form-field">
                <span>需求类型</span>
                <select
                  aria-label="需求类型"
                  aria-required="true"
                  value={selectedType ?? ""}
                  onChange={(event) =>
                    setSelectedType(
                      (event.target.value as AiWebsiteWorkOrderCategory) ||
                        null,
                    )
                  }
                >
                  <option value="">请选择需求类型</option>
                  {contentTypes.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ai-website-form-field">
                <span>话题</span>
                <input
                  type="text"
                  aria-label="话题"
                  aria-required="true"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="填写本次需要更新的官网话题"
                />
              </label>

              <label className="ai-website-form-field">
                <span>内容说明（选填）</span>
                <textarea
                  rows={5}
                  value={details}
                  onChange={(event) => setDetails(event.target.value)}
                  placeholder="补充本次需求的背景、范围和需要管理员关注的事项"
                />
              </label>

              <label className="ai-website-form-field">
                <span>参考资料（选填）</span>
                <textarea
                  rows={3}
                  value={referenceLinks}
                  onChange={(event) => setReferenceLinks(event.target.value)}
                  placeholder="每行一个公开参考链接"
                />
              </label>

              <div className="ai-website-upload">
                <div>
                  <strong>附件（选填）</strong>
                  <span>可上传与本次官网内容需求有关的资料。</span>
                </div>
                <label className="ai-website-upload-button">
                  <Upload size={17} aria-hidden="true" />
                  选择文件
                  <input
                    type="file"
                    multiple
                    onChange={handleFiles}
                    aria-label="上传官网需求附件"
                  />
                </label>
              </div>

              {attachments.length > 0 && (
                <ul className="ai-website-file-list" aria-label="待上传文件">
                  {attachments.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${index}`}>
                      <Paperclip size={15} aria-hidden="true" />
                      <span>{file.name}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${file.name}`}
                        onClick={() =>
                          setAttachments((current) =>
                            current.filter(
                              (_, fileIndex) => fileIndex !== index,
                            ),
                          )
                        }
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {quotaExhausted && (
                <div className="ai-website-inline-state warning" role="alert">
                  当前官网内容发布额度已用完，暂时不能提交新的内容运营需求。
                </div>
              )}
              {!onSubmit && (
                <div className="ai-website-inline-state" role="status">
                  需求提交服务暂时不可用。
                </div>
              )}

              <div className="ai-website-form-actions">
                <p
                  className={`ai-website-submit-message ${submissionStateFor("content")}`}
                  aria-live="polite"
                >
                  {submissionMessageFor("content")}
                </p>
                <div className="ai-website-action-buttons">
                  <button
                    type="button"
                    className="ai-website-secondary-button"
                    onClick={() => openWebsiteHistory(selectedType)}
                  >
                    <FileClock size={16} aria-hidden="true" />
                    需求记录
                  </button>
                  <button
                    type="submit"
                    className="ai-website-primary-button"
                    disabled={submissionDisabled("content")}
                  >
                    <Send size={17} aria-hidden="true" />
                    {submissionStateFor("content") === "submitting"
                      ? "正在提交…"
                      : "提交需求"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      <CustomerRequestHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="官网需求记录"
        description="域名、备案、图片风格与官网内容需求统一显示在这里。"
        tickets={localizedWebsiteHistoryTickets}
        loading={loading}
        refreshing={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        error={error}
        onRefresh={onRefresh}
        onLoadMore={onLoadMore}
        onOpenTicket={onOpenTicket}
        preview={!onOpenTicket}
        emptyText="暂无官网需求记录。"
      />
    </section>
  );
}

function EngineerWebsiteCustomerPreview({
  marketEdition,
  siteProfile,
  websiteWorkflow,
  workflow,
  styleState,
  contentTypes,
  tickets,
  loading,
  error,
}: {
  marketEdition: "domestic" | "overseas";
  siteProfile: AiWebsiteSiteProfile | null;
  websiteWorkflow: AiWebsiteWorkflowMetadata | null;
  workflow: ReturnType<typeof deriveWorkflow>;
  styleState: NonNullable<AiWebsiteWorkflowMetadata["styleState"]>;
  contentTypes: WorkOrderTypeDefinition[];
  tickets: AiWebsiteTicket[];
  loading: boolean;
  error: string | null;
}) {
  const overseasAccount = marketEdition === "overseas";
  const styleBatch = websiteWorkflow?.styleBatch;
  const domainStatus = workflow.domainCompleted
    ? "已完成"
    : workflow.domainPending
      ? "处理中"
      : "尚未提交";
  const icpStatus = workflow.icpCompleted
    ? "已完成"
    : workflow.icpPending
      ? "处理中"
      : workflow.domainCompleted
        ? "尚未提交"
        : "等待域名完成";
  const styleConfirmed =
    websiteWorkflow?.styleConfirmed === true ||
    styleState === "confirmed" ||
    styleState === "legacy_confirmed";
  const websiteBuildStatus =
    websiteWorkflow?.websiteBuildStatus ??
    (websiteWorkflow?.canSubmitContent === true
      ? "completed"
      : styleConfirmed
        ? "pending"
        : "locked");
  const prerequisitesComplete = overseasAccount
    ? workflow.domainCompleted
    : workflow.icpCompleted;
  const websiteStageStatus = !prerequisitesComplete
    ? overseasAccount
      ? "待域名确认"
      : "待域名与备案确认"
    : !styleConfirmed
      ? "待风格确认"
      : websiteBuildStatus === "completed"
        ? "已开放"
        : "官网构建中";

  return (
    <section
      className="ai-website-workspace"
      aria-labelledby="engineer-website-preview-title"
    >
      <header className="ai-website-header">
        <p className="ai-website-eyebrow">客户真实交互内容</p>
        <h1 id="engineer-website-preview-title">客户官网结果预览</h1>
        <p className="ai-website-intro">
          {overseasAccount
            ? "这里只呈现客户实际收到的官网状态、可选风格样例和公开交付结果。域名教程、客户提交表单及内部流程不进入客户内容核对区。"
            : "这里只呈现客户实际收到的官网状态、可选风格样例和公开交付结果。域名与 ICP 教程、客户提交表单及内部流程不进入客户内容核对区。"}
        </p>
      </header>

      <section
        className="ai-website-prerequisites"
        aria-labelledby="engineer-website-status-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="engineer-website-status-title">客户当前可见状态</h2>
            <p>
              {siteProfile?.domain
                ? `当前域名：${siteProfile.domain}`
                : "客户页面尚未显示正式域名。"}
            </p>
          </div>
        </div>
        <ol className="ai-website-stepper">
          <WorkflowStep
            index={1}
            label={
              overseasAccount
                ? "企业域名注册与确认"
                : "阿里云域名注册与 ICP 备案"
            }
            state={
              prerequisitesComplete
                ? "completed"
                : workflow.domainPending || workflow.icpPending
                  ? "pending"
                  : "current"
            }
            statusLabel={overseasAccount ? domainStatus : icpStatus}
          />
          <WorkflowStep
            index={2}
            label="AI专用官网构建与内容运营"
            state={
              !prerequisitesComplete
                ? "locked"
                : websiteBuildStatus === "completed"
                  ? "current"
                  : "pending"
            }
            statusLabel={websiteStageStatus}
          />
        </ol>
      </section>

      {(styleBatch?.samples?.length || styleState !== "legacy_confirmed") && (
        <section
          className="ai-website-form"
          aria-labelledby="engineer-style-preview-title"
        >
          <div className="ai-website-section-heading">
            <div>
              <h2 id="engineer-style-preview-title">客户收到的官网图片风格</h2>
              <p>
                仅核对已经发布给客户选择的样例；发布或重做请使用上方对应需求的修改入口。
              </p>
            </div>
          </div>
          {styleBatch?.samples?.length ? (
            <>
              {styleBatch.engineerNote && (
                <div className="ai-website-inline-state">
                  客户可见说明：{styleBatch.engineerNote}
                </div>
              )}
              <div className="ai-website-style-grid">
                {styleBatch.samples.map((sample) => {
                  const selected =
                    websiteWorkflow?.selectedStyleSampleId === sample.id;
                  return (
                    <article className="ai-website-style-card" key={sample.id}>
                      <img src={sample.imageUrl} alt={sample.label} />
                      <div>
                        <strong>{sample.label}</strong>
                        {sample.note && <p>{sample.note}</p>}
                        <span
                          className="ai-website-order-status"
                          data-status={
                            selected ? "completed" : "awaiting_service"
                          }
                        >
                          {selected ? "客户已选择" : "待客户选择"}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="ai-website-inline-state" role="status">
              {styleState === "revision_requested"
                ? "客户已退回本批风格，当前等待工程师发布新的三张样例。"
                : styleState === "waiting_samples"
                  ? "客户当前看到的是等待工程师发布三张风格样例。"
                  : "客户尚未收到可选择的官网图片风格。"}
            </div>
          )}
        </section>
      )}

      <section
        className="ai-website-orders"
        aria-labelledby="engineer-website-results-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="engineer-website-results-title">客户收到的公开交付结果</h2>
            <p>这里只显示客户可见的需求状态、公开摘要和交付链接。</p>
          </div>
        </div>

        {loading ? (
          <div className="ai-website-orders-state" role="status">
            正在载入客户可见结果…
          </div>
        ) : error ? (
          <div className="ai-website-orders-state error" role="alert">
            <AlertCircle size={19} aria-hidden="true" />
            {error}
          </div>
        ) : tickets.length === 0 ? (
          <div className="ai-website-orders-state">
            <FileText size={22} aria-hidden="true" />
            <strong>客户尚未收到官网交付结果</strong>
            <span>通过对应需求发布后，客户可见结果会显示在这里。</span>
          </div>
        ) : (
          <div className="ai-website-order-list">
            {tickets.map((ticket) => {
              const terminal = ticketIsCompleted(ticket);
              const summary = ticketSummary(ticket);
              return (
                <article className="ai-website-order-row" key={ticket.id}>
                  <div className="ai-website-order-toggle">
                    <span className="ai-website-order-main">
                      <small>{categoryLabel(ticket, contentTypes)}</small>
                      <strong>
                        {deliveryTicketPresentationTopic({
                          ...ticket,
                          fallbackLabel: "官网内容需求",
                        })}
                      </strong>
                    </span>
                    <span
                      className="ai-website-order-status"
                      data-status={terminal ? "completed" : "pending"}
                    >
                      {terminal && (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      )}
                      {terminal ? "已完成" : "待处理"}
                    </span>
                  </div>
                  {(summary || ticket.deliveryLinks?.length) && (
                    <div className="ai-website-order-summary">
                      {summary && <p>{summary}</p>}
                      {ticket.deliveryLinks?.map((link) => (
                        <a
                          key={link.id || `${ticket.id}-${link.url}`}
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {link.label}
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function WorkflowStep({
  index,
  label,
  state,
  statusLabel,
}: {
  index: number;
  label: string;
  state: "completed" | "pending" | "current" | "locked";
  statusLabel?: string;
}) {
  const stateLabel =
    statusLabel ||
    {
      completed: "已完成",
      pending: "处理中",
      current: "可提交",
      locked: "未开放",
    }[state];
  return (
    <li data-state={state}>
      <span className="ai-website-step-index">
        {state === "completed" ? (
          <Check size={16} aria-hidden="true" />
        ) : state === "locked" ? (
          <LockKeyhole size={14} aria-hidden="true" />
        ) : (
          index
        )}
      </span>
      <strong>{label}</strong>
      <small>{stateLabel}</small>
    </li>
  );
}
