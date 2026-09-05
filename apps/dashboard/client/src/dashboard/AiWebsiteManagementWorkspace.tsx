import type {
  DeliverySiteCheckStatus,
  DeliveryTicketQuota,
  DeliveryTicketStatus,
  WebsiteOperationCategory,
} from "@shared/delivery-ticket";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  LockKeyhole,
  Loader2,
  Paperclip,
  RefreshCw,
  Send,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import AliyunIcpGuide, { type AliyunGuideScenario } from "./AliyunIcpGuide";
import type { ServicePlanCode } from "./service-portal";
import "./ai-website-management-workspace.css";

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
  publicStage?:
    | "awaiting_service"
    | "processing"
    | "action_required"
    | "completed"
    | "closed"
    | null;
  publicStageLabel?: string | null;
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
  label: "域名申请",
};

const ICP_FILING: WorkOrderTypeDefinition = {
  id: "icp_filing",
  label: "域名注册与 ICP 备案结果",
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
  return (
    ticket.categoryLabel?.trim() ||
    [DOMAIN_APPLICATION, ICP_FILING, ...contentCatalog].find(
      (item) => item.id === ticket.category,
    )?.label ||
    "官网内容需求"
  );
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
    tickets.filter(ticketIsCompleted).map((ticket) => ticket.category),
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
  const [icpNumber, setIcpNumber] = useState("");
  const [details, setDetails] = useState("");
  const [referenceLinks, setReferenceLinks] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submitMessage, setSubmitMessage] = useState("");
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleMessage, setStyleMessage] = useState("");
  const [styleRevisionReason, setStyleRevisionReason] = useState("");
  const overseasAccount = marketEdition === "overseas";

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
        tickets,
      }),
    [siteProfile, tickets, websiteWorkflow, workflowState],
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
  const styleGateActive = workflow.icpCompleted && !styleConfirmed;
  const phase: WorkflowPhase = !workflow.domainCompleted
    ? "domain"
    : !workflow.icpCompleted
      ? "icp"
      : "content";
  const phaseTicketPending =
    phase === "domain"
      ? workflow.domainPending
      : phase === "icp"
        ? workflow.icpPending
        : false;
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
  const fixedPhaseType = phaseDefinition(phase);
  const contentTypes = useMemo(
    () =>
      contentCatalog.map((item) => ({
        id: item.value,
        label: item.label,
      })),
    [contentCatalog],
  );
  const effectiveType = fixedPhaseType?.id ?? selectedType;
  const serviceAllowed = Boolean(quota?.allowed);
  const quotaExhausted =
    phase === "content" &&
    Boolean(quota && quota.limit > 0 && quota.remaining <= 0);
  const submitting = submitState === "submitting";
  const submitDisabled =
    submitting ||
    phaseTicketPending ||
    !phaseAllowedByWorkflow ||
    quotaExhausted ||
    !serviceAllowed ||
    !onSubmit;

  if (readOnlyPreview) {
    return (
      <EngineerWebsiteCustomerPreview
        siteProfile={siteProfile}
        websiteWorkflow={websiteWorkflow}
        workflow={workflow}
        styleState={styleState}
        contentTypes={contentTypes}
        tickets={tickets}
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTopic = topic.trim();
    if (!effectiveType) {
      setSubmitState("error");
      setSubmitMessage("请选择一项官网内容需求类型。");
      return;
    }
    if (!normalizedTopic) {
      setSubmitState("error");
      setSubmitMessage(
        phase === "domain"
          ? "请填写已经在阿里云购买并显示“正常”的域名。"
          : phase === "icp"
            ? "请填写已完成备案的域名。"
            : "请填写需要处理的话题。",
      );
      return;
    }
    if (phase === "icp" && !icpNumber.trim()) {
      setSubmitState("error");
      setSubmitMessage("请填写阿里云备案通过后获得的 ICP 主体备案号。");
      return;
    }
    if (submitDisabled || !onSubmit) return;

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
          phase === "content"
            ? details.trim()
            : phase === "domain"
              ? guideScenario === "existing_filing"
                ? "备案场景：国内版 · 企业已有 ICP 备案（已有主体下新增网站）。"
                : guideScenario === "overseas"
                  ? "部署场景：海外版 · 中国香港或海外节点；无需工信部 ICP 备案。"
                  : "备案场景：国内版 · 企业首次备案。"
              : "",
        targetPage: "",
        materialUrls: phase === "content" ? parsedLinks.urls : [],
        attachmentFiles: phase === "content" ? attachments : [],
        ...(phase === "icp"
          ? {
              icpDeclarations: {
                icpNumber: icpNumber.trim(),
              },
            }
          : {}),
      });
      setTopic("");
      setIcpNumber("");
      setDetails("");
      setReferenceLinks("");
      setAttachments([]);
      setSelectedType(null);
      setSubmitState("success");
      setSubmitMessage(
        phase === "domain"
          ? overseasAccount
            ? "海外版域名已提交，AI 运维工单已创建。无需办理 ICP 备案。"
            : "域名已提交，AI 运维工单已创建。请等待工单返回备案服务码。"
          : phase === "icp"
            ? "备案结果已提交，等待平台确认。"
            : "工单已提交。",
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

  return (
    <section
      className="ai-website-workspace"
      aria-labelledby="ai-website-title"
    >
      <header className="ai-website-header">
        <p className="ai-website-eyebrow">AI 友好内容资产</p>
        <h1 id="ai-website-title">AI 友好官网管理</h1>
        <p className="ai-website-intro">
          {overseasAccount
            ? "先注册企业实名域名，再回到这里提交域名创建 AI 运维工单。香港或海外节点无需办理工信部 ICP 备案。"
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
            label="阿里云域名注册与 ICP 备案"
            state={
              workflow.icpCompleted
                ? "completed"
                : workflow.domainPending || workflow.icpPending
                  ? "pending"
                  : "current"
            }
          />
          <WorkflowStep
            index={2}
            label="AI专用官网构建与内容运营"
            state={workflow.icpCompleted ? "current" : "locked"}
          />
        </ol>
      </section>

      {!serviceAllowed ? (
        <section className="ai-website-locked" aria-label="官网运营功能未开放">
          <LockKeyhole size={24} aria-hidden="true" />
          <div>
            <h2>当前不能提交新的官网工单</h2>
            <p>{quota?.reason || "当前服务暂未开放官网运营工单。"}</p>
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
                备案已经确认。工程师会先提供三张图片样例，确认风格后再开始官网构建与内容运营。
              </p>
            </div>
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
                              `确认选择“${sample.label}”作为官网图片风格？确认后将解锁官网构建与内容运营。`,
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
                              "风格已确认，官网构建与内容运营已解锁。",
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
        <form className="ai-website-form" onSubmit={handleSubmit} noValidate>
          <div className="ai-website-section-heading">
            <div>
              <h2>
                {phase === "domain"
                  ? "阿里云企业域名注册图文教程"
                  : phase === "icp"
                    ? "领取服务码并完成 ICP 备案"
                    : "提交官网内容运营工单"}
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

          {phaseTicketPending || !phaseAllowedByWorkflow ? (
            <div className="ai-website-inline-state" role="status">
              {phaseTicketPending
                ? phase === "domain"
                  ? overseasAccount
                    ? "海外版域名已提交，AI 运维正在配置香港或海外节点、DNS 与 HTTPS，请勿重复提交。"
                    : "域名已提交，AI 运维工单正在处理。备案服务码会在工单完成后返回，请勿重复提交。"
                  : "域名与 ICP 备案结果已提交，平台确认后会自动开放内容运营。"
                : workflowLockReason || "当前阶段暂未开放。"}
            </div>
          ) : (
            <>
              {phase === "content" && (
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
              )}

              {phase !== "content" && (
                <>
                  <AliyunIcpGuide
                    currentPhase={phase}
                    marketEdition={marketEdition}
                    onContactAdvisor={onContactAdvisor}
                    scenario={guideScenario}
                    onScenarioChange={setGuideScenario}
                    stageThreeContent={
                      phase === "domain" ? (
                        <div
                          className="ai-website-guide-stage-submission"
                          id="ai-website-domain-form"
                          tabIndex={-1}
                        >
                          <div className="ai-website-result-heading">
                            <strong>
                              {guideScenario === "overseas"
                                ? "海外版域名购买完成后，在这里提交"
                                : "域名购买完成后，在这里提交"}
                            </strong>
                            <p>
                              {guideScenario === "overseas"
                                ? "只提交域名列表中状态为“正常”的主域名。系统会把香港或海外节点场景写入 AI 运维工单；无需备案服务码和 ICP 备案号。"
                                : "只提交阿里云域名列表中状态为“正常”的主域名。提交后会自动创建 AI 运维工单，并在工单完成时返回备案服务码。"}
                            </p>
                          </div>

                          <label className="ai-website-form-field">
                            <span>已购买域名</span>
                            <input
                              type="text"
                              aria-label="已购买域名"
                              aria-required="true"
                              value={topic}
                              onChange={(event) => setTopic(event.target.value)}
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
                              工单提交服务暂时不可用。
                            </div>
                          )}

                          <div className="ai-website-form-actions">
                            <p
                              className={`ai-website-submit-message ${submitState}`}
                              aria-live="polite"
                            >
                              {submitMessage}
                            </p>
                            <button
                              type="submit"
                              className="ai-website-primary-button"
                              disabled={submitDisabled}
                            >
                              <Send size={17} aria-hidden="true" />
                              {submitting
                                ? "正在提交…"
                                : "提交域名，创建 AI 运维工单"}
                            </button>
                          </div>
                        </div>
                      ) : undefined
                    }
                    filingSubmissionContent={
                      phase === "icp" ? (
                        <div
                          className="ai-website-guide-stage-submission"
                          id="ai-website-result-form"
                          tabIndex={-1}
                        >
                          <div className="ai-website-result-heading">
                            <strong>提交备案信息工单</strong>
                            <p>
                              请确认阿里云备案状态已显示通过，仅填写已备案域名与
                              ICP 主体备案号。提交后会创建工单供平台确认。
                            </p>
                          </div>

                          <label className="ai-website-form-field">
                            <span>已备案域名</span>
                            <input
                              type="text"
                              aria-label="已备案域名"
                              aria-required="true"
                              value={topic}
                              onChange={(event) => setTopic(event.target.value)}
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
                              onChange={(event) =>
                                setIcpNumber(event.target.value)
                              }
                              placeholder="例如 京ICP备12345678号"
                            />
                            <small className="ai-website-field-help">
                              请填写备案主体编号，不要填写密码、证件号码、负责人照片或其他备案材料。
                            </small>
                          </label>

                          {!onSubmit && (
                            <div
                              className="ai-website-inline-state"
                              role="status"
                            >
                              工单提交服务暂时不可用。
                            </div>
                          )}

                          <div className="ai-website-form-actions">
                            <p
                              className={`ai-website-submit-message ${submitState}`}
                              aria-live="polite"
                            >
                              {submitMessage}
                            </p>
                            <button
                              type="submit"
                              className="ai-website-primary-button"
                              disabled={submitDisabled}
                            >
                              <Send size={17} aria-hidden="true" />
                              {submitting ? "正在提交…" : "提交备案结果"}
                            </button>
                          </div>
                        </div>
                      ) : undefined
                    }
                  />
                </>
              )}

              {phase === "content" && (
                <>
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
                      onChange={(event) =>
                        setReferenceLinks(event.target.value)
                      }
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
                        aria-label="上传官网工单附件"
                      />
                    </label>
                  </div>

                  {attachments.length > 0 && (
                    <ul
                      className="ai-website-file-list"
                      aria-label="待上传文件"
                    >
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
                    <div
                      className="ai-website-inline-state warning"
                      role="alert"
                    >
                      当前官网内容发布额度已用完，暂时不能提交新的内容运营工单。
                    </div>
                  )}
                  {!onSubmit && (
                    <div className="ai-website-inline-state" role="status">
                      工单提交服务暂时不可用。
                    </div>
                  )}

                  <div className="ai-website-form-actions">
                    <p
                      className={`ai-website-submit-message ${submitState}`}
                      aria-live="polite"
                    >
                      {submitMessage}
                    </p>
                    <button
                      type="submit"
                      className="ai-website-primary-button"
                      disabled={submitDisabled}
                    >
                      <Send size={17} aria-hidden="true" />
                      {submitting ? "正在提交…" : "提交工单"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </form>
      )}

      <section
        className="ai-website-orders"
        aria-labelledby="ai-website-orders-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-orders-title">官网历史与交付记录</h2>
            <p>备案服务码、备案结果确认与官网内容工单统一显示在这里。</p>
          </div>
          {onRefresh && (
            <button
              type="button"
              className="ai-website-secondary-button"
              onClick={() => void onRefresh()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              刷新
            </button>
          )}
        </div>

        {loading ? (
          <div className="ai-website-orders-state" role="status">
            正在载入官网历史记录…
          </div>
        ) : error ? (
          <div className="ai-website-orders-state error" role="alert">
            <AlertCircle size={19} aria-hidden="true" />
            {error}
          </div>
        ) : tickets.length === 0 ? (
          <div className="ai-website-orders-state">
            <FileText size={22} aria-hidden="true" />
            <strong>暂无官网历史记录</strong>
            <span>提交工单后，记录会显示在这里。</span>
          </div>
        ) : (
          <div className="ai-website-order-list">
            {tickets.map((ticket) => {
              const terminal = ticketIsCompleted(ticket);
              const delivered =
                ticket.publicStage === "completed" ||
                (!ticket.publicStage && terminal);
              const expanded =
                !onOpenTicket && terminal && expandedTicketId === ticket.id;
              const summary = ticketSummary(ticket);
              const canOpen = Boolean(onOpenTicket || terminal);
              return (
                <article className="ai-website-order-row" key={ticket.id}>
                  <button
                    type="button"
                    className="ai-website-order-toggle"
                    disabled={!canOpen}
                    aria-expanded={
                      !onOpenTicket && terminal ? expanded : undefined
                    }
                    onClick={() => {
                      if (onOpenTicket) {
                        onOpenTicket(ticket.id);
                        return;
                      }
                      if (terminal) {
                        setExpandedTicketId((current) =>
                          current === ticket.id ? null : ticket.id,
                        );
                      }
                    }}
                  >
                    <span className="ai-website-order-main">
                      <small>{categoryLabel(ticket, contentTypes)}</small>
                      <strong>
                        {ticket.topic || ticket.title || "官网内容需求"}
                      </strong>
                    </span>
                    <span
                      className="ai-website-order-status"
                      data-status={
                        ticket.publicStage ||
                        (terminal ? "completed" : "awaiting_service")
                      }
                    >
                      {delivered ? (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      ) : null}
                      {ticket.publicStageLabel ||
                        (terminal ? "已完成" : "已提交")}
                    </span>
                    {!onOpenTicket && terminal && (
                      <ChevronDown
                        className={expanded ? "expanded" : undefined}
                        size={17}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {expanded && (
                    <div className="ai-website-order-summary">
                      <strong>
                        {ticket.category === "domain_application"
                          ? "备案服务码"
                          : "处理结果"}
                      </strong>
                      <p>
                        {summary ||
                          (ticket.category === "domain_application"
                            ? "该工单尚未返回备案服务码，请联系服务专员核对。"
                            : "暂无公开处理结果。")}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {hasMore && onLoadMore && (
          <div className="ai-website-load-more">
            <button
              type="button"
              className="ai-website-secondary-button"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              <RefreshCw
                className={loadingMore ? "animate-spin" : undefined}
                size={16}
                aria-hidden="true"
              />
              {loadingMore ? "正在载入…" : "加载更多"}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

function EngineerWebsiteCustomerPreview({
  siteProfile,
  websiteWorkflow,
  workflow,
  styleState,
  contentTypes,
  tickets,
  loading,
  error,
}: {
  siteProfile: AiWebsiteSiteProfile | null;
  websiteWorkflow: AiWebsiteWorkflowMetadata | null;
  workflow: ReturnType<typeof deriveWorkflow>;
  styleState: NonNullable<AiWebsiteWorkflowMetadata["styleState"]>;
  contentTypes: WorkOrderTypeDefinition[];
  tickets: AiWebsiteTicket[];
  loading: boolean;
  error: string | null;
}) {
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

  return (
    <section
      className="ai-website-workspace"
      aria-labelledby="engineer-website-preview-title"
    >
      <header className="ai-website-header">
        <p className="ai-website-eyebrow">客户真实交互内容</p>
        <h1 id="engineer-website-preview-title">客户官网结果预览</h1>
        <p className="ai-website-intro">
          这里只呈现客户实际收到的官网状态、可选风格样例和公开交付结果。域名与
          ICP 教程、客户提交表单及内部流程不进入客户内容核对区。
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
            label={`域名配置 · ${domainStatus}`}
            state={
              workflow.domainCompleted
                ? "completed"
                : workflow.domainPending
                  ? "pending"
                  : "current"
            }
          />
          <WorkflowStep
            index={2}
            label={`ICP 备案 · ${icpStatus}`}
            state={
              workflow.icpCompleted
                ? "completed"
                : workflow.icpPending
                  ? "pending"
                  : workflow.domainCompleted
                    ? "current"
                    : "locked"
            }
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
                仅核对已经发布给客户选择的样例；发布或重做请使用上方对应工单的修改入口。
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
            <p>这里只显示客户可见的工单状态、公开摘要和交付链接。</p>
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
            <span>通过对应工单发布后，客户可见结果会显示在这里。</span>
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
                        {ticket.topic || ticket.title || "官网内容需求"}
                      </strong>
                    </span>
                    <span
                      className="ai-website-order-status"
                      data-status={
                        ticket.publicStage ||
                        (terminal ? "completed" : "awaiting_service")
                      }
                    >
                      {terminal && (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      )}
                      {ticket.publicStageLabel ||
                        (terminal ? "已完成" : "处理中")}
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
}: {
  index: number;
  label: string;
  state: "completed" | "pending" | "current" | "locked";
}) {
  const stateLabel = {
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
