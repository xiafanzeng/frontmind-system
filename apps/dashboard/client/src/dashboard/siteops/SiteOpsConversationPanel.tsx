import type {
  SiteOpsExecutionStep,
  SiteOpsMessageProjection,
  SiteOpsObservationV1,
  SiteOpsPublicVisualCandidate,
} from "@shared/siteops-contract";
import type {
  SiteOpsActInput,
  SiteOpsVisualFailureCategory,
} from "@shared/siteops";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { copyToClipboard } from "@/lib/utils";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./siteops-conversation-panel.css";

type SiteOpsActionContext = Pick<
  SiteOpsActInput,
  "action" | "input" | "messageId" | "cardKind"
>;

export type SiteOpsSelectVisualAck = {
  schemaVersion: 1;
  accepted: true;
  clientRequestId: string;
  operationId: string;
  projectRevision: number;
  latestSequence: number;
  interactionState: "building";
};

export type SiteOpsSelectVisualState = {
  sampleId: string;
  label: string;
  clientRequestId: string;
  phase: "submitting" | "observing" | "polling" | "failed" | "confirmed";
  ack: SiteOpsSelectVisualAck | null;
};

export function siteOpsSelectVisualFailureMessage(label: string) {
  return `建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择 ${label}。`;
}

export type SiteOpsConversationPanelProps = {
  observation: SiteOpsObservationV1 | null;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  notice?: string | null;
  interactionPending?: boolean;
  selectVisual?: SiteOpsSelectVisualState | null;
  onRefresh?: () => Promise<void> | void;
  onAction?: (input: SiteOpsActionContext) => Promise<void> | void;
  onRetrySelectVisual?: () => Promise<void> | void;
  onSubmitRevision?: (input: {
    text: string;
    files: File[];
    onProgress: (fileIndex: number, percent: number) => void;
  }) => Promise<void> | void;
  onBeginAliyun?: () => Promise<{
    authorizationUrl: string;
    expiresAt: string;
  }>;
  aliyunDomains?: ReadonlyArray<{ domain: string; displayDomain: string }>;
  aliyunDomainsLoading?: boolean;
  aliyunDomainsError?: string | null;
  onRefreshAliyunDomains?: () => Promise<void> | void;
  onDisconnectAliyun?: () => Promise<void> | void;
  onSubmitIcpFiling?: (input: {
    domain: string;
    icpNumber: string;
  }) => Promise<void> | void;
};

const BUILD_STATUS_LABELS: Record<string, string> = {
  preparing: "整理建站资料",
  visual_searching: "生成视觉候选",
  awaiting_visual_selection: "等待选择视觉方案",
  design_compiling: "正在制作官网",
  contract_ready: "正在制作官网",
  building: "正在制作官网",
  qa_running: "正在检查官网",
  preview_ready: "官网已完成",
  approved: "官网已完成",
  failed: "需要协助",
  attention_required: "需要协助",
  cancelled: "已取消",
  superseded: "已被新版本替代",
};

const BUILD_PHASE_LABELS: Record<string, string> = {
  source_waiting: "正在等待内容结果",
  source_repairing: "正在修复源码",
  provider_sync_delayed: "正在同步建站结果",
  source_validating: "正在校验源码",
  compiling: "正在构建预览",
  persisting_preview: "正在保存预览",
};

const CARD_LABELS: Record<string, string> = {
  brief_question: "建站资料",
  visual_board: "视觉方向",
  visual_choice: "视觉选择",
  build_progress: "制作进度",
  build_preview: "官网预览",
  qa_failed: "官网检查",
  publish_options: "发布选择",
  domain_status: "域名状态",
  icp_status: "ICP 状态",
  content_review: "内容核对",
  social_package: "内容包",
  release_status: "发布状态",
};

const PRIVATE_PREVIEW_WINDOW_NAME = "frontmind-siteops-preview";
const ALIYUN_AUTHORIZATION_WINDOW_NAME = "frontmind-aliyun-authorization";
const ALIYUN_OAUTH_COMPLETION_MESSAGE =
  "frontmind:siteops:aliyun-oauth" as const;
type AliyunOAuthCompletionStatus = "success" | "cancelled" | "failed";

type AliyunOAuthWindowState = "checking" | "completing" | "failed";

type AliyunFlowPhase = "idle" | "oauth" | "completing";

const ALIYUN_OAUTH_WINDOW_COPY: Record<
  AliyunOAuthWindowState,
  { title: string; description: string }
> = {
  checking: {
    title: "正在检查阿里云授权配置",
    description: "请稍候，FrontMind 正在确认安全的授权入口。",
  },
  completing: {
    title: "正在完成阿里云连接",
    description: "授权已经返回，FrontMind 正在读取您账号中的域名。",
  },
  failed: {
    title: "暂时无法打开阿里云授权",
    description: "请返回 FrontMind 页面查看处理提示，配置更新后再重试。",
  },
};

function renderAliyunOAuthWindowState(
  authorizationWindow: Window,
  state: AliyunOAuthWindowState,
) {
  try {
    const copy = ALIYUN_OAUTH_WINDOW_COPY[state];
    const popupDocument = authorizationWindow.document;
    popupDocument.documentElement.lang = "zh-CN";
    popupDocument.title = copy.title;

    const main = popupDocument.createElement("main");
    main.setAttribute("role", state === "failed" ? "alert" : "status");
    main.setAttribute("aria-live", state === "failed" ? "assertive" : "polite");
    main.style.fontFamily =
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    main.style.maxWidth = "32rem";
    main.style.margin = "12vh auto";
    main.style.padding = "2rem";
    main.style.lineHeight = "1.65";
    main.style.color = "#25222d";

    const heading = popupDocument.createElement("h1");
    heading.textContent = copy.title;
    heading.style.fontSize = "1.35rem";
    heading.style.margin = "0 0 .75rem";
    main.appendChild(heading);

    const description = popupDocument.createElement("p");
    description.textContent = copy.description;
    description.style.margin = "0";
    main.appendChild(description);

    if (state === "failed") {
      const closeButton = popupDocument.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "关闭窗口";
      closeButton.style.marginTop = "1.25rem";
      closeButton.style.padding = ".65rem 1rem";
      closeButton.addEventListener("click", () => authorizationWindow.close());
      main.appendChild(closeButton);
    }

    popupDocument.body.replaceChildren(main);
  } catch {
    // A popup may be closed between window.open and rendering. The parent page
    // remains the authoritative, accessible error surface in that case.
  }
}

function aliyunOAuthCompletionStatus(
  event: MessageEvent,
  authorizationWindow: Window | null,
): AliyunOAuthCompletionStatus | null {
  if (
    event.origin !== window.location.origin ||
    !authorizationWindow ||
    event.source !== authorizationWindow ||
    typeof event.data !== "object" ||
    event.data === null ||
    event.data.type !== ALIYUN_OAUTH_COMPLETION_MESSAGE
  ) {
    return null;
  }
  return ["success", "cancelled", "failed"].includes(event.data.status)
    ? (event.data.status as AliyunOAuthCompletionStatus)
    : null;
}

function isTrustedAliyunOAuthUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["signin.aliyun.com", "oauth.aliyun.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function activeCardMessage(
  messages: SiteOpsMessageProjection[],
  kind: SiteOpsActionContext["cardKind"],
  currentRevision: number,
) {
  return [...messages].reverse().find((message) => {
    const card = message.metadata?.siteOps;
    return Boolean(
      card &&
        card.kind === kind &&
        card.status === "active" &&
        card.revision === currentRevision,
    );
  });
}

function actionFromCard(
  observation: SiteOpsObservationV1,
  cardKind: SiteOpsActionContext["cardKind"],
  action: SiteOpsActionContext["action"],
  input: Record<string, unknown>,
): SiteOpsActionContext {
  const message = activeCardMessage(
    observation.messages,
    cardKind,
    observation.project.revision,
  );
  return {
    action,
    input,
    ...(message ? { messageId: message.id, cardKind } : {}),
  };
}

function providerMessage(observation: SiteOpsObservationV1) {
  const provider = observation.serviceReadiness.visuals;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "视觉参考服务尚未配置，暂时不能检索视觉方向。"
    : "视觉参考服务暂时不可用，请稍后重试或联系系统管理员。";
}

function aiBuilderMessage(observation: SiteOpsObservationV1) {
  const provider = observation.serviceReadiness.website;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "AI 建站服务尚未就绪，请联系 FrontMind。"
    : "AI 建站服务暂时不可用，请稍后重试或联系 FrontMind。";
}

function visualCandidatePresentation(candidate: SiteOpsPublicVisualCandidate) {
  const family = candidate.visualFamily;
  const familyLabels: Record<string, string> = {
    floating_orbit: "浮动轨道式",
    split_media: "分屏媒体式",
    editorial: "编辑杂志式",
    bento: "Bento 模块式",
    feature_grid: "功能网格式",
    centered_dual_cta: "极简双按钮式",
    immersive_visual: "沉浸视觉式",
    product_stage: "产品舞台式",
    full_bleed_statement: "全幅宣言式",
  };
  const familyLabel = (family ? familyLabels[family] : null) || "首页视觉";
  return {
    badge: `首页 · ${familyLabel}`,
    title: family ? familyLabel : candidate.title,
    note:
      candidate.note && candidate.note !== candidate.title
        ? candidate.note
        : null,
  };
}

function customerFacingMessage(content: string) {
  if (
    /(?:invalid_client|app\s+not\s+exists|appsecret|client[\s_-]*id)/iu.test(
      content,
    )
  ) {
    return "阿里云连接配置需要 FrontMind 管理员更新。";
  }
  const sanitized = content
    .replace(
      /(?:错误码|任务编号|operation(?:\s*id)?|task(?:\s*id)?)\s*[:：]\s*[A-Za-z0-9_-]+/giu,
      "",
    )
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu, "")
    .replace(/21st/giu, "视觉服务")
    .replace(/SiteOps/giu, SITEOPS_CUSTOMER_DISPLAY_NAME)
    .replace(/(?:原生\s*)?Astro/giu, "官网")
    .replace(/React(?:\s*静态)?/giu, "官网")
    .replace(/API\s*Key/giu, "服务配置")
    .replace(/frontmind-(?:base|pro)/giu, "建站模式")
    .replace(/\b(?:Base|Pro)\b/giu, "建站模式")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (
    /(?:\bESA\b|AliDNS|\bDNS\b|RecordId|\bCNAME\b|\bTXT\b|\bTLS\b|\bSTS\b|ExternalId|RAM\s*Role|Role\s*ARN|principal\s*ARN|\bARN\b|\bUID\b|canonical\s+hostname|global_excluding_cn|mainland_cn|\bHero\b|归档哈希|\bhash\b|record\s*tuple|remark\s*marker|provider)/iu.test(
      sanitized,
    )
  ) {
    return "FrontMind 正在处理当前任务；如长时间未完成，请提交工单获取协助。";
  }
  return sanitized || "任务需要协助，请稍后重试或提交工单。";
}

const SITEOPS_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

function formatSiteOpsDuration(
  startedAt: string,
  completedAt: string | null,
  now: number,
) {
  const started = Date.parse(startedAt);
  const completed = completedAt ? Date.parse(completedAt) : now;
  const totalSeconds = Math.max(0, Math.floor((completed - started) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function SiteOpsMessageBubble({ item }: { item: SiteOpsMessageProjection }) {
  const [copied, setCopied] = useState(false);
  const content = customerFacingMessage(item.content);
  return (
    <article className="siteops-message" data-role={item.role}>
      <span className="siteops-message-avatar" aria-hidden="true">
        {item.role === "user" ? <UserRound size={17} /> : <Bot size={17} />}
      </span>
      <div className="siteops-message-bubble">
        <div className="siteops-message-meta">
          <strong>
            {item.role === "user" ? "你" : SITEOPS_CUSTOMER_DISPLAY_NAME}
          </strong>
          {item.metadata?.siteOps && (
            <span data-status={item.metadata.siteOps.status}>
              {CARD_LABELS[item.metadata.siteOps.kind] || "任务状态"}
            </span>
          )}
        </div>
        {item.role === "assistant" ? (
          <MarkdownRenderer
            content={content}
            className="siteops-message-markdown"
          />
        ) : (
          <p>{content}</p>
        )}
        <footer className="siteops-message-footer">
          <time dateTime={item.sentAt}>
            {SITEOPS_TIME_FORMATTER.format(new Date(item.sentAt))}
          </time>
          {item.role === "assistant" && (
            <button
              type="button"
              aria-label={copied ? "已复制消息" : "复制消息"}
              title={copied ? "已复制" : "复制"}
              onClick={() => {
                void copyToClipboard(content).then((ok) => setCopied(ok));
              }}
            >
              {copied ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <Copy size={13} aria-hidden="true" />
              )}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}

function visualGenerationProgressPage(item: SiteOpsMessageProjection) {
  const card = item.metadata?.siteOps;
  if (
    item.role !== "assistant" ||
    card?.kind !== "build_progress" ||
    card.payload.stage !== "visual_searching"
  ) {
    return null;
  }
  const numberedPage = item.content.match(/正在生成第\s*(\d+)\s*组/u);
  if (numberedPage) return Number(numberedPage[1]);
  return item.content.includes("正在生成 9 个视觉候选") ? 1 : null;
}

function visualGenerationFailureCopy(
  category: SiteOpsVisualFailureCategory | null | undefined,
  hasExistingCandidates: boolean,
  usesStaticTemplateCatalog = false,
) {
  if (usesStaticTemplateCatalog) {
    if (category === "catalog_unavailable") {
      return hasExistingCandidates
        ? "建站模板目录的本地资产尚未就绪或未通过完整性校验。当前已加载的候选仍可选择；服务恢复后也可重新载入建站模板。"
        : "建站模板目录的本地资产尚未就绪或未通过完整性校验。服务恢复后可直接重新载入建站模板；刷新页面只会更新当前状态。";
    }
    if (category === "persistence_failed") {
      return hasExistingCandidates
        ? "建站模板资产已经就绪，但候选列表未能完整保存。当前已加载的候选仍可选择，也可重新载入建站模板。"
        : "建站模板资产已经就绪，但候选列表未能安全保存。可以直接重新载入建站模板，无需重置知识库。";
    }
    return hasExistingCandidates
      ? "建站模板未能完整载入。当前已加载的候选仍可选择，也可重新载入建站模板。"
      : "建站模板未能完整载入。可以直接重新载入建站模板，无需重置知识库。";
  }
  const suffix = hasExistingCandidates
    ? "当前候选仍可选择，也可稍后重试。"
    : "建站资料已保留，可以直接重试，无需重置。";

  const message = (() => {
    switch (category) {
      case "catalog_unavailable":
        return "完整官网模板目录暂时不可用。";
      case "entitlement_required":
        return "完整官网模板下载权限需要 FrontMind 管理员更新。";
      case "download_failed":
        return "完整官网模板暂时无法下载。";
      case "dependency_unsupported":
        return "本次实时模板需要当前构建环境尚未支持的依赖。";
      case "compile_failed":
        return "本次实时模板未能完成安全编译。";
      case "browser_unavailable":
      case "render_failed":
        return "本次实时模板暂时无法生成本地预览。";
      case "deadline_exhausted":
        return "本次实时模板生成超过安全时间限制。";
      case "insufficient_live_templates":
        return "本次实时目录未能凑齐 9 个互不重复的完整官网源码模板。";
      default:
        return hasExistingCandidates
          ? "本次未能生成完整的新一组。"
          : "本次未能生成完整的 9 个视觉候选。";
    }
  })();

  return `${message}${suffix}`;
}

function SiteOpsExecutionTimeline({
  steps,
}: {
  steps: SiteOpsExecutionStep[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const operationId = useMemo(() => {
    const active = steps.find((step) =>
      ["queued", "running"].includes(step.status),
    );
    const selected = active ?? steps[0];
    return selected?.id.split(":", 1)[0] ?? null;
  }, [steps]);
  const visibleSteps = useMemo(
    () =>
      operationId
        ? steps.filter((step) => step.id.startsWith(`${operationId}:`))
        : [],
    [operationId, steps],
  );
  const isRunning = visibleSteps.some((step) => step.status === "running");

  useEffect(() => {
    if (!isRunning) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRunning, operationId]);

  if (visibleSteps.length === 0) return null;
  return (
    <section
      className="siteops-execution-timeline"
      aria-labelledby="siteops-timeline-title"
    >
      <div className="siteops-timeline-heading">
        <div>
          <Clock3 size={17} aria-hidden="true" />
          <h3 id="siteops-timeline-title">执行时间线</h3>
        </div>
        {isRunning && <span>运行中 · 每秒更新</span>}
      </div>
      <ol>
        {visibleSteps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="siteops-timeline-icon" aria-hidden="true">
              {step.status === "running" ? (
                <Loader2 className="siteops-spin" size={15} />
              ) : step.status === "succeeded" ? (
                <Check size={15} />
              ) : ["failed", "attention_required"].includes(step.status) ? (
                <AlertCircle size={15} />
              ) : (
                <Clock3 size={14} />
              )}
            </span>
            <div>
              <strong>{step.label}</strong>
              <time dateTime={step.startedAt}>
                {SITEOPS_TIME_FORMATTER.format(new Date(step.startedAt))}
              </time>
            </div>
            <span className="siteops-timeline-duration">
              {step.status === "queued"
                ? "等待开始"
                : formatSiteOpsDuration(step.startedAt, step.completedAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function customerDomainStateLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    verified: "已完成",
    approved: "已通过",
    active: "正常",
    pending: "处理中",
    preparing: "准备中",
    submitted: "审核中",
    not_submitted: "未提交",
    not_verified: "待验证",
    failed: "需要协助",
    conflict: "需要协助",
  };
  return value ? labels[value] || "处理中" : "待同步";
}

function VisualCandidateCard({
  candidate,
  disabled,
  selecting,
  onSelect,
}: {
  candidate: SiteOpsPublicVisualCandidate;
  disabled: boolean;
  selecting: boolean;
  onSelect: () => void;
}) {
  const presentation = visualCandidatePresentation(candidate);
  return (
    <article
      className="siteops-visual-card"
      data-selected={candidate.selected ? "true" : "false"}
    >
      <div className="siteops-visual-preview">
        <img
          src={candidate.previewUrl}
          alt={`${candidate.label}：${presentation.title}`}
        />
        <span>{candidate.label}</span>
      </div>
      <div className="siteops-visual-copy">
        <div>
          <strong>{presentation.title}</strong>
          <small className="siteops-hero-badge">{presentation.badge}</small>
        </div>
        {presentation.note && <p>{presentation.note}</p>}
        {candidate.executionAdmitted === false && (
          <p className="siteops-visual-unavailable" role="status">
            {candidate.executionUnavailableReason ??
              "该模板尚未完成执行准入，当前不可选择。"}
          </p>
        )}
        <button
          type="button"
          className="siteops-primary-button"
          disabled={disabled || candidate.selected}
          onClick={onSelect}
        >
          {selecting ? (
            <Loader2 className="siteops-spin" size={15} aria-hidden="true" />
          ) : (
            candidate.selected && <Check size={15} aria-hidden="true" />
          )}
          {candidate.executionAdmitted === false
            ? "暂不可选择"
            : selecting
              ? `正在选择 ${candidate.label}`
              : candidate.selected
                ? "已选择"
                : `选择 ${candidate.label}`}
        </button>
      </div>
    </article>
  );
}

export default function SiteOpsConversationPanel({
  observation,
  loading = false,
  refreshing = false,
  error = null,
  notice = null,
  interactionPending = false,
  selectVisual = null,
  onRefresh,
  onAction,
  onRetrySelectVisual,
  onSubmitRevision,
  onBeginAliyun,
  aliyunDomains = [],
  aliyunDomainsLoading = false,
  aliyunDomainsError = null,
  onRefreshAliyunDomains,
  onDisconnectAliyun,
  onSubmitIcpFiling,
}: SiteOpsConversationPanelProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [aliyunConnectionError, setAliyunConnectionError] = useState<
    string | null
  >(null);
  const [aliyunProvisioningMessage, setAliyunProvisioningMessage] = useState<
    string | null
  >(null);
  const [aliyunFlowPhase, setAliyunFlowPhase] =
    useState<AliyunFlowPhase>("idle");
  const [previewOpenError, setPreviewOpenError] = useState<string | null>(null);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildReason, setRebuildReason] = useState("");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [selectedAliyunDomain, setSelectedAliyunDomain] = useState("");
  const [failedAutomaticDomainKey, setFailedAutomaticDomainKey] = useState<
    string | null
  >(null);
  const [icpNumber, setIcpNumber] = useState("");
  const [activeVisualPage, setActiveVisualPage] = useState(1);
  const [revisionText, setRevisionText] = useState("");
  const [revisionFiles, setRevisionFiles] = useState<File[]>([]);
  const [revisionProgress, setRevisionProgress] = useState<number[]>([]);
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const revisionPreviewUrls = useMemo(
    () =>
      revisionFiles.map((file) =>
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : null,
      ),
    [revisionFiles],
  );
  useEffect(
    () => () => {
      for (const url of revisionPreviewUrls) {
        if (url) URL.revokeObjectURL(url);
      }
    },
    [revisionPreviewUrls],
  );
  const aliyunAuthorizationWindow = useRef<Window | null>(null);
  const aliyunFlowPhaseRef = useRef<AliyunFlowPhase>("idle");
  const aliyunFlowGenerationRef = useRef(0);
  const automaticallyConnectedDomainRef = useRef<string | null>(null);
  const completeAliyunOAuthRef = useRef<() => void>(() => undefined);
  const stopAliyunFlowRef = useRef<
    (generation: number, authorizationWindow: Window, message: string) => void
  >(() => undefined);
  const aliyunRefreshRef = useRef(onRefresh);
  aliyunRefreshRef.current = onRefresh;
  const previousVisualPageCount = useRef(0);
  const previousStaticCatalogVersion = useRef<string | null>(null);
  const latestAttempt = useMemo(() => {
    const visibleBuilds = observation?.builds.filter(
      (build) => !["cancelled", "superseded"].includes(build.status),
    );
    return (
      visibleBuilds?.reduce(
        (latest, build) =>
          !latest || build.ordinal > latest.ordinal ? build : latest,
        visibleBuilds[0],
      ) ?? null
    );
  }, [observation?.builds]);
  const latestBuild = useMemo(() => {
    if (!latestAttempt || latestAttempt.previewUrl) return latestAttempt;
    const completedBuilds = observation?.builds.filter(
      (build) =>
        Boolean(build.previewUrl) &&
        ["preview_ready", "approved"].includes(build.status),
    );
    return (
      completedBuilds?.reduce(
        (latest, build) =>
          !latest || build.ordinal > latest.ordinal ? build : latest,
        completedBuilds[0],
      ) ?? latestAttempt
    );
  }, [latestAttempt, observation?.builds]);
  const revisionImageHistory = useMemo(
    () =>
      (observation?.builds ?? [])
        .flatMap((build) =>
          (build.revisionInputs ?? []).map((asset) => ({
            ...asset,
            buildOrdinal: build.ordinal,
          })),
        )
        .sort((left, right) => right.buildOrdinal - left.buildOrdinal),
    [observation?.builds],
  );
  const hasSuccessfulBuild = useMemo(
    () =>
      observation?.builds.some((build) =>
        ["preview_ready", "approved"].includes(build.status),
      ) || observation?.deployments.some((item) => item.status === "active"),
    [observation?.builds, observation?.deployments],
  );
  const visualPages = useMemo(() => {
    if (observation?.visualCandidatePages?.length) {
      return observation.visualCandidatePages;
    }
    return observation?.visualCandidates.length
      ? [
          {
            batchId: "legacy-current-page",
            page: 1,
            candidates: observation.visualCandidates,
          },
        ]
      : [];
  }, [observation?.visualCandidatePages, observation?.visualCandidates]);
  const usesStaticTemplateCatalog = ["2.8.0", "2.9.0"].includes(
    observation?.visualGeneration.workflowVersion ?? "",
  );
  const staticCatalogVersion = usesStaticTemplateCatalog
    ? (observation?.visualGeneration.catalogVersion ?? "static-catalog-pending")
    : null;

  useEffect(() => {
    const count = visualPages.length;
    if (usesStaticTemplateCatalog) {
      if (previousStaticCatalogVersion.current !== staticCatalogVersion) {
        setActiveVisualPage(1);
      } else if (count === 0) {
        setActiveVisualPage(1);
      } else {
        setActiveVisualPage((current) => Math.min(Math.max(current, 1), count));
      }
      previousStaticCatalogVersion.current = staticCatalogVersion;
    } else if (count > previousVisualPageCount.current) {
      setActiveVisualPage(count);
    } else if (count === 0) {
      setActiveVisualPage(1);
    } else {
      setActiveVisualPage((current) => Math.min(Math.max(current, 1), count));
    }
    if (!usesStaticTemplateCatalog) {
      previousStaticCatalogVersion.current = null;
    }
    previousVisualPageCount.current = count;
  }, [staticCatalogVersion, usesStaticTemplateCatalog, visualPages.length]);

  useEffect(() => {
    setPreviewOpenError(null);
  }, [latestBuild?.previewUrl]);

  function openPrivatePreview(previewUrl: string) {
    setPreviewOpenError(null);
    const previewWindow = window.open(
      "about:blank",
      PRIVATE_PREVIEW_WINDOW_NAME,
    );
    if (!previewWindow) {
      setPreviewOpenError(
        "预览标签页被浏览器阻止，请允许此站点打开弹窗后重试。",
      );
      return;
    }
    try {
      previewWindow.opener = null;
      if (previewWindow.opener !== null) {
        previewWindow.close();
        throw new Error("SITEOPS_PREVIEW_OPENER_NOT_SEVERED");
      }
      previewWindow.location.replace(previewUrl);
      previewWindow.focus();
    } catch {
      setPreviewOpenError("预览标签页未能安全打开，请使用下方安全链接重试。");
    }
  }

  function chooseRevisionFiles(files: File[]) {
    const supported = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (files.length > 8) {
      setRevisionError("一次最多上传 8 张图片。");
      return;
    }
    if (files.some((file) => !supported.has(file.type))) {
      setRevisionError("仅支持 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (files.some((file) => file.size < 1 || file.size > 8 * 1024 * 1024)) {
      setRevisionError("每张图片必须小于 8 MiB。");
      return;
    }
    if (
      files.reduce((total, file) => total + file.size, 0) >
      32 * 1024 * 1024
    ) {
      setRevisionError("本次图片总大小不能超过 32 MiB。");
      return;
    }
    setRevisionFiles(files);
    setRevisionProgress(files.map(() => 0));
    setRevisionError(null);
  }

  function addRevisionFiles(files: File[]) {
    const merged = [...revisionFiles];
    for (const file of files) {
      const duplicate = merged.some(
        (candidate) =>
          candidate.name === file.name &&
          candidate.size === file.size &&
          candidate.type === file.type &&
          candidate.lastModified === file.lastModified,
      );
      if (!duplicate) merged.push(file);
    }
    chooseRevisionFiles(merged);
  }

  async function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = revisionText.trim();
    if (
      !text ||
      !onSubmitRevision ||
      revisionSubmitting ||
      interactionPending
    ) {
      return;
    }
    setRevisionSubmitting(true);
    setRevisionError(null);
    setRevisionProgress(revisionFiles.map(() => 0));
    try {
      await onSubmitRevision({
        text,
        files: revisionFiles,
        onProgress: (fileIndex, percent) => {
          setRevisionProgress((current) => {
            const next = [...current];
            next[fileIndex] = Math.max(0, Math.min(100, Math.round(percent)));
            return next;
          });
        },
      });
      setRevisionText("");
      setRevisionFiles([]);
      setRevisionProgress([]);
    } catch (revisionFailure) {
      setRevisionError(
        revisionFailure instanceof Error
          ? customerFacingMessage(revisionFailure.message)
          : "修改需求没有提交成功，请重试。",
      );
    } finally {
      setRevisionSubmitting(false);
    }
  }

  async function runAction(key: string, input: SiteOpsActionContext) {
    if (!onAction || busyAction || interactionPending) return;
    setBusyAction(key);
    setLocalError(null);
    try {
      await onAction(input);
    } catch (actionError) {
      if (input.action !== "select_visual" || !onRetrySelectVisual) {
        setLocalError(
          actionError instanceof Error
            ? customerFacingMessage(actionError.message)
            : "操作没有完成，请刷新后重试。",
        );
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function retrySelectVisual() {
    if (
      !onRetrySelectVisual ||
      busyAction ||
      selectVisual?.phase !== "failed"
    ) {
      return;
    }
    setBusyAction(`visual-retry:${selectVisual.sampleId}`);
    setLocalError(null);
    try {
      await onRetrySelectVisual();
    } catch {
      // The connected selection state owns the exact, card-adjacent failure
      // copy and preserves the original idempotency key for another retry.
    } finally {
      setBusyAction(null);
    }
  }

  async function requestRebuild() {
    if (
      !onAction ||
      busyAction ||
      interactionPending ||
      !observation?.rebuildRequest.allowed
    ) {
      return;
    }
    setBusyAction("request_rebuild");
    setLocalError(null);
    setRebuildError(null);
    try {
      await onAction({
        action: "request_rebuild",
        input: {
          ...(rebuildReason.trim() ? { reason: rebuildReason.trim() } : {}),
        },
      });
      setRebuildReason("");
      setRebuildDialogOpen(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? customerFacingMessage(requestError.message)
          : "重置申请没有提交成功，请稍后重试。";
      setRebuildError(message);
      setLocalError(message);
    } finally {
      setBusyAction(null);
    }
  }

  function setAliyunPhase(phase: AliyunFlowPhase) {
    aliyunFlowPhaseRef.current = phase;
    setAliyunFlowPhase(phase);
  }

  function isCurrentAliyunFlow(
    generation: number,
    authorizationWindow: Window,
  ) {
    return (
      aliyunFlowGenerationRef.current === generation &&
      aliyunAuthorizationWindow.current === authorizationWindow
    );
  }

  function beginAliyunFlow(
    phase: Exclude<AliyunFlowPhase, "idle">,
    authorizationWindow: Window,
  ) {
    const generation = aliyunFlowGenerationRef.current + 1;
    aliyunFlowGenerationRef.current = generation;
    aliyunAuthorizationWindow.current = authorizationWindow;
    setAliyunPhase(phase);
    setAliyunConnectionError(null);
    setAliyunProvisioningMessage(null);
    setLocalError(null);
    return generation;
  }

  function stopAliyunFlow(
    generation: number,
    authorizationWindow: Window,
    message: string,
  ) {
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    setAliyunPhase("idle");
    setAliyunProvisioningMessage(null);
    setAliyunConnectionError(message);
    renderAliyunOAuthWindowState(authorizationWindow, "failed");
    if (authorizationWindow.closed === true) {
      aliyunAuthorizationWindow.current = null;
    }
  }

  async function completeAliyunOAuth(
    generation: number,
    authorizationWindow: Window,
  ) {
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    setAliyunPhase("completing");
    setAliyunProvisioningMessage("正在读取阿里云域名");
    renderAliyunOAuthWindowState(authorizationWindow, "completing");
    try {
      await aliyunRefreshRef.current?.();
    } catch {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "阿里云授权已生效，但连接状态暂时无法刷新，请稍后重试。",
      );
      return;
    }
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    try {
      authorizationWindow.close();
    } catch {
      // The connection is already active. A browser denying close is harmless.
    }
    aliyunAuthorizationWindow.current = null;
    setAliyunPhase("idle");
    setAliyunConnectionError(null);
    setAliyunProvisioningMessage("阿里云已连接");
  }

  async function beginAliyunConnection() {
    if (
      !onBeginAliyun ||
      busyAction ||
      interactionPending ||
      aliyunFlowPhaseRef.current !== "idle"
    ) {
      return;
    }
    const authorizationWindow = window.open(
      "",
      ALIYUN_AUTHORIZATION_WINDOW_NAME,
    );
    setAliyunConnectionError(null);
    setLocalError(null);
    if (!authorizationWindow) {
      setAliyunConnectionError(
        "阿里云授权页面被浏览器阻止，请允许此站点打开弹窗后重试。",
      );
      return;
    }
    const generation = beginAliyunFlow("oauth", authorizationWindow);
    automaticallyConnectedDomainRef.current = null;
    setFailedAutomaticDomainKey(null);
    renderAliyunOAuthWindowState(authorizationWindow, "checking");
    authorizationWindow.focus();
    setBusyAction("aliyun_begin");
    try {
      const result = await onBeginAliyun();
      if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
      if (!isTrustedAliyunOAuthUrl(result.authorizationUrl)) {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          "暂时无法打开安全的阿里云授权页面，请稍后重试。",
        );
        return;
      }
      if (authorizationWindow.closed === true) {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          "阿里云授权窗口已关闭，请重新连接。",
        );
        return;
      }
      authorizationWindow.location.href = result.authorizationUrl;
      authorizationWindow.focus();
    } catch (connectionError) {
      if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
      stopAliyunFlow(
        generation,
        authorizationWindow,
        connectionError instanceof Error
          ? customerFacingMessage(connectionError.message)
          : "暂时无法打开阿里云授权页面，请稍后重试。",
      );
      authorizationWindow.focus();
    } finally {
      if (aliyunFlowGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  }

  async function runConnectionAction(
    key: string,
    action: (() => Promise<void> | void) | undefined,
  ) {
    if (!action || busyAction || interactionPending) return;
    setBusyAction(key);
    setLocalError(null);
    try {
      await action();
      if (key === "aliyun_disconnect") {
        setSelectedAliyunDomain("");
        automaticallyConnectedDomainRef.current = null;
        setFailedAutomaticDomainKey(null);
        setAliyunProvisioningMessage(null);
      }
    } catch (connectionError) {
      setLocalError(
        connectionError instanceof Error
          ? customerFacingMessage(connectionError.message)
          : "阿里云连接操作没有完成。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function submitIcpFiling(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = observation?.domainState?.domain;
    const number = icpNumber.trim();
    if (
      !domain ||
      !number ||
      !onSubmitIcpFiling ||
      busyAction ||
      interactionPending
    ) {
      return;
    }
    setBusyAction("icp_filing");
    setLocalError(null);
    try {
      await onSubmitIcpFiling({ domain, icpNumber: number });
      setIcpNumber("");
    } catch (filingError) {
      setLocalError(
        filingError instanceof Error
          ? customerFacingMessage(filingError.message)
          : "ICP 备案结果工单没有提交成功。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  completeAliyunOAuthRef.current = () => {
    const authorizationWindow = aliyunAuthorizationWindow.current;
    if (!authorizationWindow) return;
    void completeAliyunOAuth(
      aliyunFlowGenerationRef.current,
      authorizationWindow,
    );
  };
  stopAliyunFlowRef.current = stopAliyunFlow;

  function syncOnlyAliyunDomain(domain: string, key: string) {
    if (
      !observation ||
      observation.rebuildRequest.resetPending ||
      !onAction ||
      interactionPending ||
      busyAction
    ) {
      return;
    }
    automaticallyConnectedDomainRef.current = key;
    setFailedAutomaticDomainKey(null);
    setBusyAction("domain_sync_auto");
    setLocalError(null);
    void Promise.resolve(
      onAction(
        actionFromCard(observation, "domain_status", "domain_sync", { domain }),
      ),
    )
      .catch((actionError) => {
        setFailedAutomaticDomainKey(key);
        setLocalError(
          actionError instanceof Error
            ? customerFacingMessage(actionError.message)
            : "域名自动接入没有完成，请点击重试。",
        );
      })
      .finally(() => setBusyAction(null));
  }

  useEffect(() => {
    function handleAliyunOAuthCompletion(event: MessageEvent) {
      const authorizationWindow = aliyunAuthorizationWindow.current;
      const status = aliyunOAuthCompletionStatus(event, authorizationWindow);
      if (
        !status ||
        !authorizationWindow ||
        aliyunFlowPhaseRef.current !== "oauth"
      ) {
        return;
      }
      const generation = aliyunFlowGenerationRef.current;
      if (status === "success") {
        setAliyunConnectionError(null);
        setLocalError(null);
        completeAliyunOAuthRef.current();
        return;
      }
      stopAliyunFlowRef.current(
        generation,
        authorizationWindow,
        status === "cancelled"
          ? "你已取消阿里云授权，未产生任何连接。"
          : "阿里云连接配置需要 FrontMind 管理员更新。",
      );
    }

    function handleWindowFocus() {
      const authorizationWindow = aliyunAuthorizationWindow.current;
      if (!authorizationWindow) return;
      if (
        aliyunFlowPhaseRef.current === "oauth" &&
        authorizationWindow.closed === true
      ) {
        stopAliyunFlowRef.current(
          aliyunFlowGenerationRef.current,
          authorizationWindow,
          "你已关闭阿里云授权窗口，未产生任何连接。",
        );
        return;
      }
    }

    window.addEventListener("message", handleAliyunOAuthCompletion);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("message", handleAliyunOAuthCompletion);
      window.removeEventListener("focus", handleWindowFocus);
      aliyunFlowGenerationRef.current += 1;
      aliyunFlowPhaseRef.current = "idle";
    };
  }, []);

  useEffect(() => {
    if (
      !observation ||
      observation.aliyunConnection.status !== "active" ||
      observation.domainState?.domain ||
      aliyunDomains.length !== 1 ||
      observation.rebuildRequest.resetPending ||
      !onAction ||
      interactionPending ||
      busyAction
    ) {
      return;
    }
    const domain = aliyunDomains[0].domain;
    const key = `${observation.project.conversationId}:${observation.project.revision}:${domain}`;
    if (
      automaticallyConnectedDomainRef.current === key ||
      failedAutomaticDomainKey === key
    ) {
      return;
    }
    syncOnlyAliyunDomain(domain, key);
  }, [
    aliyunDomains,
    busyAction,
    failedAutomaticDomainKey,
    interactionPending,
    observation,
    onAction,
  ]);

  if (loading && !observation) {
    return (
      <section
        className="siteops-panel siteops-panel-state"
        aria-label={SITEOPS_CUSTOMER_DISPLAY_NAME}
      >
        <Loader2 className="siteops-spin" size={22} aria-hidden="true" />
        正在打开{SITEOPS_CUSTOMER_DISPLAY_NAME}…
      </section>
    );
  }

  if (!observation) {
    return (
      <section
        className="siteops-panel siteops-panel-state"
        aria-label={SITEOPS_CUSTOMER_DISPLAY_NAME}
      >
        <AlertCircle size={22} aria-hidden="true" />
        <div>
          <strong>{SITEOPS_CUSTOMER_DISPLAY_NAME}暂时不可用</strong>
          <p>{error ? customerFacingMessage(error) : "请稍后刷新重试。"}</p>
        </div>
        {onRefresh && (
          <button type="button" onClick={() => onRefresh()}>
            重新载入
          </button>
        )}
      </section>
    );
  }

  const upstreamMessage = usesStaticTemplateCatalog
    ? null
    : providerMessage(observation);
  const builderMessage = aiBuilderMessage(observation);
  const aiBuilderConfigured =
    observation.serviceReadiness.website.status === "configured";
  const interactionLocked = Boolean(
    busyAction || interactionPending || !onAction,
  );
  const selectVisualInFlight = Boolean(
    selectVisual &&
      ["submitting", "observing", "polling"].includes(selectVisual.phase),
  );
  const externalResetPending = observation.rebuildRequest.resetPending;
  const visualGeneration = observation.visualGeneration ?? {
    status: "idle" as const,
    targetPage: null,
    generatedPages: visualPages.length,
    availablePages: visualPages.length,
    reservedPages: 0,
    maxPages: 3 as const,
    canGenerateMore: false,
    canSelectExisting: true,
    retryAction: null,
    failureCategory: null,
  };
  const publishedVisualPages = Math.max(
    visualPages.length,
    visualGeneration.generatedPages,
  );
  const frozenVisualPages = Math.max(
    publishedVisualPages,
    visualGeneration.availablePages ?? publishedVisualPages,
  );
  const remainingFrozenVisualPages = Math.max(
    0,
    frozenVisualPages - publishedVisualPages,
  );
  const visualGenerationPending =
    visualGeneration.status === "generating" ||
    busyAction === "reselect_visual";
  const visualGenerationTargetPage =
    visualGeneration.targetPage ??
    Math.min(visualGeneration.generatedPages + 1, visualGeneration.maxPages);
  const visualSelectionOpen =
    observation.interactionState === "awaiting_visual_selection";
  const totalVisualCandidates = visualPages.reduce(
    (total, page) => total + page.candidates.length,
    0,
  );
  const displayedVisualCandidateCount = usesStaticTemplateCatalog
    ? totalVisualCandidates
    : visualPages.length * 9;
  const visualSelectionDisabled =
    interactionLocked ||
    selectVisualInFlight ||
    visualGenerationPending ||
    !visualGeneration.canSelectExisting ||
    !visualSelectionOpen ||
    !aiBuilderConfigured;
  const currentVisualPage =
    visualPages.find((page) => page.page === activeVisualPage) ??
    visualPages[visualPages.length - 1];
  const currentVisualGenerationMessage = observation.messages
    .filter(
      (item) =>
        visualGenerationProgressPage(item) === visualGeneration.targetPage,
    )
    .reduce<SiteOpsMessageProjection | null>(
      (latest, item) =>
        !latest || item.sequence > latest.sequence ? item : latest,
      null,
    );
  const visibleMessages = observation.messages.filter((item) => {
    if (visualGenerationProgressPage(item) === null) return true;
    return (
      visualGeneration.status === "generating" &&
      item.id === currentVisualGenerationMessage?.id
    );
  });
  const currentSnapshotId = observation.project.currentKnowledgeSnapshotId;
  const managedDomain = observation.domainState?.domain ?? "";
  const deploymentStateFor = (
    target: "global_excluding_cn" | "mainland_cn",
  ) => {
    const pending = observation.deployments.find(
      (deployment) =>
        deployment.target === target &&
        ["reserved", "deploying", "verifying"].includes(deployment.status),
    );
    const active = observation.deployments.find(
      (deployment) =>
        deployment.target === target && deployment.status === "active",
    );
    return { pending, active };
  };
  const globalDeployment = deploymentStateFor("global_excluding_cn");
  const mainlandDeployment = deploymentStateFor("mainland_cn");
  const dnsReady = observation.domainState?.dnsStatus === "active";
  const mainlandReady =
    dnsReady && observation.domainState?.icpStatus === "approved";
  const rebuildRequestActive = Boolean(
    observation.rebuildRequest.ticketId &&
      observation.rebuildRequest.status &&
      !["completed", "rejected", "cancelled"].includes(
        observation.rebuildRequest.status,
      ),
  );
  const rebuildRequestPending = Boolean(
    rebuildRequestActive && !observation.rebuildRequest.allowed,
  );
  const rebuildRequestLabel = observation.rebuildRequest.resetPending
    ? "正在下线旧官网"
    : rebuildRequestPending
      ? "重置申请处理中"
      : rebuildRequestActive && observation.rebuildRequest.resetApplied
        ? "重置已批准，可从当前知识库重新开始"
        : "申请重置并全新开始";
  const hideExistingBuildDuringActiveRebuild = Boolean(
    rebuildRequestActive &&
      observation.rebuildRequest.resetApplied &&
      latestBuild?.id === observation.rebuildRequest.resetSourceBuildId,
  );
  return (
    <section className="siteops-panel" aria-labelledby="siteops-panel-title">
      <header className="siteops-panel-header">
        <div>
          <h2 id="siteops-panel-title" className="siteops-panel-title">
            <Sparkles size={15} aria-hidden="true" />
            {SITEOPS_CUSTOMER_DISPLAY_NAME}
          </h2>
          <span>
            从企业知识库开始，选择视觉方案后由 FrontMind 完成官网制作与检查。
          </span>
        </div>
        <div className="siteops-header-controls">
          <div className="siteops-header-actions">
            {onRefresh && (
              <button
                type="button"
                className="siteops-icon-button"
                aria-label={`刷新${SITEOPS_CUSTOMER_DISPLAY_NAME}`}
                disabled={refreshing}
                onClick={() => onRefresh()}
              >
                <RefreshCw
                  className={refreshing ? "siteops-spin" : undefined}
                  size={17}
                  aria-hidden="true"
                />
              </button>
            )}
            {(observation.rebuildRequest.allowed || rebuildRequestActive) && (
              <button
                type="button"
                className="siteops-icon-button"
                aria-label={rebuildRequestLabel}
                disabled={Boolean(
                  busyAction ||
                    interactionPending ||
                    !observation.rebuildRequest.allowed,
                )}
                title={rebuildRequestLabel}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </header>

      <AlertDialog
        open={rebuildDialogOpen}
        onOpenChange={(open) => {
          if (busyAction === "request_rebuild") return;
          setRebuildDialogOpen(open);
          if (open) setRebuildError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{rebuildRequestLabel}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="siteops-reset-description">
                <p>提交后将由 FrontMind 人工受理；受理前不会改动当前官网。</p>
                <ul>
                  <li>批准后，当前线上官网会进入下线流程。</li>
                  <li>当前企业知识库会保留，并作为全新建站的资料来源。</li>
                  <li>旧视觉方案和生成任务不会继续使用。</li>
                  <li>域名、备案和阿里云连接会保留。</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="siteops-rebuild-reason">
            <span>重置原因与期望（选填）</span>
            <textarea
              value={rebuildReason}
              maxLength={2_000}
              rows={5}
              placeholder="例如：希望保留当前企业知识库并重新生成官网。"
              onChange={(event) => setRebuildReason(event.target.value)}
            />
          </label>
          {rebuildError && (
            <p className="siteops-reset-error" role="alert">
              {rebuildError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "request_rebuild"}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={interactionPending || busyAction === "request_rebuild"}
              onClick={(event) => {
                event.preventDefault();
                void requestRebuild();
              }}
            >
              {busyAction === "request_rebuild" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              提交重置申请
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {upstreamMessage && (
        <div className="siteops-notice warning" role="status">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{upstreamMessage}</span>
        </div>
      )}
      {notice && (
        <div className="siteops-notice warning" role="status">
          <Clock3 size={18} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}
      {(error || localError) && (
        <div className="siteops-notice error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{customerFacingMessage(localError || error || "")}</span>
        </div>
      )}

      <SiteOpsExecutionTimeline steps={observation.executionSteps ?? []} />

      {observation.project.status === "draft" &&
        observation.interactionState === "select_snapshot" && (
          <section
            className="siteops-snapshot-card"
            aria-labelledby="siteops-snapshot-title"
          >
            <div>
              <FileArchive size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-snapshot-title">从知识库开始建站</h3>
                <p>
                  FrontMind 将自动读取当前企业知识库，无需选择或重新上传版本。
                </p>
              </div>
            </div>
            <button
              type="button"
              className="siteops-primary-button"
              disabled={interactionLocked}
              onClick={() =>
                runAction(
                  "select_snapshot",
                  actionFromCard(
                    observation,
                    "brief_question",
                    "select_snapshot",
                    {},
                  ),
                )
              }
            >
              {busyAction === "select_snapshot" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              从知识库开始建站
            </button>
          </section>
        )}

      {currentSnapshotId &&
        observation.interactionState === "collecting_brief" && (
          <section
            className="siteops-snapshot-card siteops-brief-card"
            aria-labelledby="siteops-brief-title"
          >
            <div>
              <FileArchive size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-brief-title">建站资料核对</h3>
                <p>
                  {observation.brief
                    ? `${observation.brief.companyName} · ${observation.brief.primaryLanguage}`
                    : "正在整理知识库中的可公开事实。"}
                </p>
              </div>
            </div>
            {observation.brief && (
              <div className="siteops-brief-summary">
                <p>
                  <strong>转化目标：</strong>
                  {observation.brief.conversionGoal}
                </p>
                <p>
                  <strong>目标受众：</strong>
                  {observation.brief.audience.join("、")}
                </p>
                <p>
                  <strong>页面：</strong>
                  {observation.brief.routes
                    .map((route) => route.title)
                    .join("、")}
                </p>
                <p>
                  <strong>已确认联系方式：</strong>
                  {observation.brief.contacts.length > 0
                    ? observation.brief.contacts
                        .map((contact) => contact.value)
                        .join("、")
                    : "暂无"}
                </p>
                {observation.brief.unknowns.length > 0 && (
                  <p>
                    <strong>仍可补充：</strong>
                    {observation.brief.unknowns.join("；")}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

      {currentSnapshotId &&
        observation.interactionState === "collecting_brief" && (
          <section
            className="siteops-snapshot-card"
            aria-labelledby="siteops-visual-search-title"
          >
            <div>
              <Sparkles size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-visual-search-title">生成视觉候选</h3>
                <p>
                  {usesStaticTemplateCatalog
                    ? "可先在下方补充转化目标；准备好后将展示固定目录中的 32 个完整 Template。"
                    : "可先在下方补充转化目标；准备好后将生成九种不同风格的官网方案。"}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="siteops-primary-button"
              disabled={interactionLocked || Boolean(upstreamMessage)}
              onClick={() =>
                runAction(
                  "start_visual_search",
                  actionFromCard(
                    observation,
                    "brief_question",
                    "start_visual_search",
                    {},
                  ),
                )
              }
            >
              {busyAction === "start_visual_search" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              {usesStaticTemplateCatalog ? "查看建站模板" : "生成 9 个视觉候选"}
            </button>
          </section>
        )}

      <div
        className="siteops-message-list"
        aria-label={`${SITEOPS_CUSTOMER_DISPLAY_NAME}对话记录`}
      >
        {visibleMessages.length === 0 ? (
          <div className="siteops-empty-copy">
            点击“从知识库开始建站”后，FrontMind 会在这里整理建站资料。
          </div>
        ) : (
          visibleMessages.map((item) => (
            <SiteOpsMessageBubble item={item} key={item.id} />
          ))
        )}
      </div>

      {visualPages.length === 0 &&
        visualGeneration.status === "retryable_error" &&
        (usesStaticTemplateCatalog ||
          visualGeneration.retryAction === "start") && (
          <section
            className="siteops-snapshot-card"
            aria-labelledby="siteops-visual-retry-title"
          >
            <div>
              <AlertCircle size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-visual-retry-title">
                  {usesStaticTemplateCatalog
                    ? visualGeneration.failureCategory === "catalog_unavailable"
                      ? "建站模板目录暂时不可用"
                      : visualGeneration.failureCategory ===
                          "persistence_failed"
                        ? "建站模板列表保存失败"
                        : "建站模板载入未完成"
                    : "视觉候选生成未完成"}
                </h3>
                <p>
                  {visualGenerationFailureCopy(
                    visualGeneration.failureCategory,
                    false,
                    usesStaticTemplateCatalog,
                  )}
                </p>
              </div>
            </div>
            {usesStaticTemplateCatalog ? (
              <button
                type="button"
                className="siteops-primary-button"
                disabled={
                  interactionLocked ||
                  visualGenerationPending ||
                  Boolean(upstreamMessage)
                }
                onClick={() =>
                  runAction("reselect_visual", {
                    action: "reselect_visual",
                    input: {},
                  })
                }
              >
                {visualGenerationPending && (
                  <Loader2
                    className="siteops-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
                重新载入建站模板
              </button>
            ) : (
              <button
                type="button"
                className="siteops-primary-button"
                disabled={
                  interactionLocked ||
                  visualGenerationPending ||
                  Boolean(upstreamMessage)
                }
                onClick={() =>
                  runAction("reselect_visual", {
                    action: "reselect_visual",
                    input: {},
                  })
                }
              >
                {visualGenerationPending && (
                  <Loader2
                    className="siteops-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
                重新生成 9 个视觉候选
              </button>
            )}
          </section>
        )}

      {visualPages.length > 0 && currentVisualPage && (
        <section
          className="siteops-visual-board"
          data-catalog-layout={
            usesStaticTemplateCatalog ? "static-32" : "legacy"
          }
          aria-labelledby="siteops-visual-title"
        >
          <div className="siteops-board-heading">
            <div>
              <h3 id="siteops-visual-title">
                {visualSelectionOpen
                  ? usesStaticTemplateCatalog
                    ? `${totalVisualCandidates} 个 Template 候选`
                    : `${displayedVisualCandidateCount} 个视觉候选`
                  : "已选择的视觉方案"}
              </h3>
              <p>
                {usesStaticTemplateCatalog
                  ? "以下为固定目录中的完整 Template 参考；选中后 FrontMind 将把精确模板源码与企业资料交给 AI 完成适配。"
                  : "以下为真实视觉参考；示例图片与文案不会复制到官网，FrontMind 将按所选构图与视觉语言使用企业资料完成制作。"}
              </p>
            </div>
            {visualSelectionOpen && !usesStaticTemplateCatalog && (
              <div className="siteops-inline-actions">
                <button
                  type="button"
                  className="siteops-primary-button"
                  disabled={
                    interactionLocked ||
                    visualGenerationPending ||
                    !aiBuilderConfigured ||
                    !visualGeneration.canGenerateMore
                  }
                  onClick={() =>
                    runAction(
                      "reselect_visual",
                      actionFromCard(
                        observation,
                        "visual_board",
                        "reselect_visual",
                        {},
                      ),
                    )
                  }
                >
                  {visualGenerationPending && (
                    <Loader2
                      className="siteops-spin"
                      size={15}
                      aria-hidden="true"
                    />
                  )}
                  {visualGenerationPending
                    ? `正在生成第 ${visualGenerationTargetPage} 组`
                    : visualGeneration.canGenerateMore
                      ? remainingFrozenVisualPages > 0
                        ? "显示下一组 9 个视觉候选"
                        : "获取并冻结下一组视觉候选"
                      : `已冻结全部 ${publishedVisualPages * 9} 个候选`}
                </button>
              </div>
            )}
          </div>
          {selectVisual?.phase === "failed" && (
            <div
              className="siteops-notice error siteops-visual-selection-error"
              role="alert"
            >
              <AlertCircle size={17} aria-hidden="true" />
              <span>
                {siteOpsSelectVisualFailureMessage(selectVisual.label)}
              </span>
              <button
                type="button"
                className="siteops-primary-button"
                disabled={
                  busyAction === `visual-retry:${selectVisual.sampleId}`
                }
                onClick={() => void retrySelectVisual()}
              >
                {busyAction === `visual-retry:${selectVisual.sampleId}` && (
                  <Loader2
                    className="siteops-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
                重试选择 {selectVisual.label}
              </button>
            </div>
          )}
          {visualGeneration.status === "retryable_error" && (
            <div className="siteops-notice error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>
                {visualGenerationFailureCopy(
                  visualGeneration.failureCategory,
                  true,
                  usesStaticTemplateCatalog,
                )}
              </span>
            </div>
          )}
          {builderMessage && (
            <div className="siteops-builder-key-warning" role="status">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{builderMessage}</span>
            </div>
          )}
          {visualSelectionOpen && (
            <div
              className="siteops-visual-pagination"
              aria-label="视觉候选分组"
            >
              <button
                type="button"
                aria-label={
                  usesStaticTemplateCatalog
                    ? "上一页视觉候选"
                    : "上一组视觉候选"
                }
                disabled={activeVisualPage <= 1}
                onClick={() =>
                  setActiveVisualPage((page) => Math.max(1, page - 1))
                }
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <div>
                {visualPages.map((page) => (
                  <button
                    type="button"
                    key={page.batchId}
                    data-active={page.page === activeVisualPage}
                    aria-current={
                      page.page === activeVisualPage ? "page" : undefined
                    }
                    onClick={() => setActiveVisualPage(page.page)}
                  >
                    第 {page.page} {usesStaticTemplateCatalog ? "页" : "组"}
                  </button>
                ))}
              </div>
              <span>
                {usesStaticTemplateCatalog
                  ? `第 ${activeVisualPage} / ${visualGeneration.pageCount} 页 · 共 ${totalVisualCandidates} 个`
                  : visualGeneration.canGenerateMore
                    ? remainingFrozenVisualPages > 0
                      ? `已冻结 ${frozenVisualPages} 组；还可显示 ${remainingFrozenVisualPages} 组`
                      : "下一组将在完整冻结后显示"
                    : `${displayedVisualCandidateCount} 选 1`}
              </span>
              <button
                type="button"
                aria-label={
                  usesStaticTemplateCatalog
                    ? "下一页视觉候选"
                    : "下一组视觉候选"
                }
                disabled={activeVisualPage >= visualPages.length}
                onClick={() =>
                  setActiveVisualPage((page) =>
                    Math.min(visualPages.length, page + 1),
                  )
                }
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          <div
            className="siteops-visual-grid"
            data-catalog-layout={
              usesStaticTemplateCatalog ? "static-32" : "legacy"
            }
          >
            {currentVisualPage.candidates.map((candidate) => (
              <VisualCandidateCard
                key={candidate.id}
                candidate={candidate}
                disabled={
                  visualSelectionDisabled ||
                  candidate.executionAdmitted === false ||
                  Boolean(
                    selectVisual?.phase === "failed" &&
                      selectVisual.sampleId === candidate.id,
                  )
                }
                selecting={Boolean(
                  selectVisualInFlight &&
                    selectVisual?.sampleId === candidate.id,
                )}
                onSelect={() =>
                  runAction(
                    `visual:${candidate.id}`,
                    actionFromCard(
                      observation,
                      "visual_board",
                      "select_visual",
                      {
                        sampleId: candidate.id,
                      },
                    ),
                  )
                }
              />
            ))}
          </div>
        </section>
      )}

      {!hideExistingBuildDuringActiveRebuild &&
        latestAttempt?.recoverable &&
        latestBuild?.id !== latestAttempt.id && (
          <div className="siteops-notice warning" role="status">
            <AlertCircle size={18} aria-hidden="true" />
            <span>
              {latestAttempt.previewWarning ?? "新版本仍在同一任务内安全恢复。"}
              上一版成功预览仍可继续查看和使用。
            </span>
          </div>
        )}

      {!hideExistingBuildDuringActiveRebuild &&
        latestAttempt?.needsHelp &&
        !latestAttempt.recoverable &&
        latestBuild?.id !== latestAttempt.id && (
          <div className="siteops-notice warning" role="status">
            <AlertCircle size={18} aria-hidden="true" />
            <span>
              重置申请尚未完成；在批准并执行下线前，当前官网仍可继续预览和使用。
            </span>
          </div>
        )}

      {!hideExistingBuildDuringActiveRebuild &&
        latestAttempt &&
        latestBuild?.previewUrl &&
        latestAttempt.id !== latestBuild.id &&
        ["preparing", "design_compiling", "building", "qa_running"].includes(
          latestAttempt.status,
        ) && (
          <div className="siteops-notice warning" role="status">
            <Clock3 size={18} aria-hidden="true" />
            <span>修改版本正在生成；完成前继续保留并展示上一版预览。</span>
          </div>
        )}

      {latestBuild && !hideExistingBuildDuringActiveRebuild && (
        <section
          className="siteops-build-card"
          aria-labelledby="siteops-build-title"
        >
          <div>
            <h3 id="siteops-build-title">
              {(latestBuild.buildPhase &&
                BUILD_PHASE_LABELS[latestBuild.buildPhase]) ||
                BUILD_STATUS_LABELS[latestBuild.status] ||
                "正在处理"}
            </h3>
            {latestBuild.previewWarning &&
              (latestBuild.recoverable ||
                latestBuild.buildDelivery?.renderMode === "content_patch") && (
                <p>{latestBuild.previewWarning}</p>
              )}
            {latestBuild.previewUrl &&
              latestBuild.buildDelivery?.renderMode === "trusted_fallback" && (
                <p>
                  基础预览已生成，可以查看并继续完善；FrontMind
                  已记录主样式渲染的待优化项。
                </p>
              )}
            {latestBuild.previewUrl &&
              latestBuild.buildDelivery &&
              latestBuild.buildDelivery.renderMode !== "trusted_fallback" &&
              latestBuild.buildDelivery.qaStatus !== "passed" && (
                <p>
                  官网预览已生成，质量检查中的非阻断建议已记录，不影响查看和后续发布。
                </p>
              )}
            {latestBuild.needsHelp &&
              !latestBuild.recoverable &&
              !latestBuild.previewUrl && (
                <p>
                  本次没有生成可安全展示的版本。可以申请重置；批准并完成旧站下线后，可从当前企业知识库重新开始建站。
                </p>
              )}
          </div>
          <div className="siteops-build-actions">
            {latestBuild.previewUrl && (
              <button
                type="button"
                className="siteops-secondary-button"
                onClick={() => openPrivatePreview(latestBuild.previewUrl!)}
              >
                <ExternalLink size={15} aria-hidden="true" />
                在新标签页打开预览
              </button>
            )}
            {latestBuild.sourceUrl && (
              <a href={latestBuild.sourceUrl}>
                <Download size={15} aria-hidden="true" />
                下载网站源码
              </a>
            )}
            {hasSuccessfulBuild && !latestAttempt?.recoverable && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={Boolean(
                  busyAction ||
                    interactionPending ||
                    !observation.rebuildRequest.allowed,
                )}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={15} aria-hidden="true" />
                {rebuildRequestLabel}
              </button>
            )}
            {latestBuild.needsHelp &&
              !latestBuild.recoverable &&
              !latestBuild.previewUrl && (
                <button
                  type="button"
                  className="siteops-primary-button"
                  disabled={Boolean(
                    busyAction ||
                      interactionPending ||
                      !observation.rebuildRequest.allowed,
                  )}
                  onClick={() => {
                    setRebuildError(null);
                    setRebuildDialogOpen(true);
                  }}
                >
                  <Wrench size={15} aria-hidden="true" />
                  {rebuildRequestLabel}
                </button>
              )}
            {["preview_ready", "approved"].includes(latestBuild.status) && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled
                title="即将上线"
              >
                发布博客与行业近况（即将上线）
              </button>
            )}
            {previewOpenError && latestBuild.previewUrl && (
              <div
                className="siteops-notice error siteops-preview-open-error"
                role="alert"
              >
                <AlertCircle size={18} aria-hidden="true" />
                <span>{previewOpenError}</span>
                <a
                  href={latestBuild.previewUrl}
                  target={PRIVATE_PREVIEW_WINDOW_NAME}
                  onClick={(event) => {
                    event.preventDefault();
                    openPrivatePreview(latestBuild.previewUrl!);
                  }}
                >
                  重试打开预览
                </a>
              </div>
            )}
            {latestBuild.status === "approved" && (
              <>
                <button
                  type="button"
                  className="siteops-primary-button"
                  disabled={
                    interactionLocked ||
                    externalResetPending ||
                    !dnsReady ||
                    Boolean(globalDeployment.pending) ||
                    globalDeployment.active?.buildId === latestBuild.id
                  }
                  onClick={() =>
                    runAction(
                      "publish_global",
                      actionFromCard(
                        observation,
                        "publish_options",
                        "publish_global",
                        {
                          buildId: latestBuild.id,
                          expectedHeadDeploymentId: globalDeployment.active?.id,
                        },
                      ),
                    )
                  }
                >
                  {globalDeployment.pending
                    ? "海外站点发布中"
                    : globalDeployment.active?.buildId === latestBuild.id
                      ? "海外站点已在线"
                      : "发布海外站点"}
                </button>
                <button
                  type="button"
                  className="siteops-secondary-button"
                  disabled={
                    interactionLocked ||
                    externalResetPending ||
                    !mainlandReady ||
                    Boolean(mainlandDeployment.pending) ||
                    mainlandDeployment.active?.buildId === latestBuild.id
                  }
                  onClick={() =>
                    runAction(
                      "publish_mainland",
                      actionFromCard(
                        observation,
                        "publish_options",
                        "publish_mainland",
                        {
                          buildId: latestBuild.id,
                          expectedHeadDeploymentId:
                            mainlandDeployment.active?.id,
                        },
                      ),
                    )
                  }
                >
                  {mainlandDeployment.pending
                    ? "大陆站点发布中"
                    : mainlandDeployment.active?.buildId === latestBuild.id
                      ? "大陆站点已在线"
                      : "发布大陆站点"}
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {onSubmitRevision &&
        observation.visualGeneration.workflowVersion === "2.9.0" &&
        latestBuild?.previewUrl &&
        latestAttempt?.id === latestBuild.id &&
        ["preview_ready", "approved"].includes(latestBuild.status) && (
          <section
            className="siteops-revision-composer"
            aria-labelledby="siteops-revision-title"
          >
            <div>
              <span>继续完善官网</span>
              <h3 id="siteops-revision-title">告诉 FrontMind 需要怎么修改</h3>
              <p>
                当前预览会保留到新版本完成。可以补充文字要求，并上传最多 8
                张图片。
              </p>
            </div>
            <form
              onSubmit={submitRevision}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length < 1) return;
                event.preventDefault();
                addRevisionFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <label>
                <span>修改要求</span>
                <textarea
                  value={revisionText}
                  maxLength={20_000}
                  rows={5}
                  disabled={revisionSubmitting || interactionPending}
                  placeholder="例如：把第一张产品图加入产品与服务页，保留现有配色和其他页面内容。"
                  onChange={(event) => setRevisionText(event.target.value)}
                  onPaste={(event) => {
                    const pastedImages = Array.from(
                      event.clipboardData.files,
                    ).filter((file) => file.type.startsWith("image/"));
                    if (pastedImages.length > 0) addRevisionFiles(pastedImages);
                  }}
                />
              </label>
              <div className="siteops-revision-file-control">
                <label className="siteops-secondary-button">
                  <ImagePlus size={16} aria-hidden="true" />
                  选择图片
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    disabled={revisionSubmitting || interactionPending}
                    onChange={(event) => {
                      addRevisionFiles(Array.from(event.target.files ?? []));
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <span>
                  可点击、拖放或粘贴；PNG / JPEG / WebP；单张 8 MiB，总计 32 MiB
                </span>
              </div>
              {revisionFiles.length > 0 && (
                <ul className="siteops-revision-files" aria-label="待上传图片">
                  {revisionFiles.map((file, index) => (
                    <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                      {revisionPreviewUrls[index] && (
                        <img
                          src={revisionPreviewUrls[index]!}
                          alt={`${file.name} 本地预览`}
                        />
                      )}
                      <div>
                        <strong>{file.name}</strong>
                        <span>
                          {(file.size / 1024 / 1024).toFixed(2)} MiB
                          {revisionSubmitting
                            ? ` · ${revisionProgress[index] ?? 0}%`
                            : ""}
                        </span>
                      </div>
                      {!revisionSubmitting && (
                        <button
                          type="button"
                          aria-label={`移除 ${file.name}`}
                          onClick={() =>
                            chooseRevisionFiles(
                              revisionFiles.filter(
                                (_candidate, candidateIndex) =>
                                  candidateIndex !== index,
                              ),
                            )
                          }
                        >
                          <X size={15} aria-hidden="true" />
                        </button>
                      )}
                      {revisionSubmitting && (
                        <progress
                          max={100}
                          value={revisionProgress[index] ?? 0}
                          aria-label={`${file.name} 上传进度`}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {revisionImageHistory.length > 0 && (
                <div className="siteops-revision-history">
                  <strong>已用于历史修改版本的图片</strong>
                  <ul>
                    {revisionImageHistory.map((asset) => (
                      <li
                        key={`${asset.buildOrdinal}:${asset.publicPath}`}
                        title={asset.publicPath}
                      >
                        第 {asset.buildOrdinal} 版 · {asset.filename}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {revisionError && (
                <p className="siteops-revision-error" role="alert">
                  {revisionError}
                </p>
              )}
              <div className="siteops-revision-submit">
                <button
                  type="submit"
                  className="siteops-primary-button"
                  disabled={Boolean(
                    !revisionText.trim() ||
                      revisionSubmitting ||
                      interactionPending,
                  )}
                >
                  {revisionSubmitting && (
                    <Loader2
                      className="siteops-spin"
                      size={15}
                      aria-hidden="true"
                    />
                  )}
                  {revisionSubmitting
                    ? "正在提交修改"
                    : revisionError
                      ? "重试提交"
                      : "生成修改版本"}
                </button>
              </div>
            </form>
          </section>
        )}

      {currentSnapshotId &&
        ["preview_ready", "approved", "live"].includes(
          observation.interactionState,
        ) && (
          <section className="siteops-build-card" aria-label="企业内容包">
            <div>
              <span>可下载交付</span>
              <h3>企业社媒内容包</h3>
              <p>生成、预览与下载，不连接社媒账号，也不会定时发布。</p>
            </div>
            <div className="siteops-build-actions">
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "create_wechat_package",
                    actionFromCard(
                      observation,
                      "content_review",
                      "create_wechat_package",
                      {},
                    ),
                  )
                }
              >
                生成微信内容包
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "create_xiaohongshu_package",
                    actionFromCard(
                      observation,
                      "content_review",
                      "create_xiaohongshu_package",
                      {},
                    ),
                  )
                }
              >
                生成小红书内容包
              </button>
              {observation.socialPackages
                .filter((item) => item.archiveUrl)
                .map((item) => (
                  <a key={item.id} href={item.archiveUrl!}>
                    <Download size={15} aria-hidden="true" />
                    下载{item.channel === "wechat" ? "微信" : "小红书"} ZIP
                  </a>
                ))}
            </div>
          </section>
        )}

      <section
        className="siteops-domain-card"
        aria-labelledby="siteops-domain-title"
      >
        <div className="siteops-domain-heading">
          <div>
            <p className="siteops-eyebrow">
              <Cloud size={15} aria-hidden="true" />
              域名与发布
            </p>
            <h3 id="siteops-domain-title">连接阿里云</h3>
            <p>授权后读取您已购买的域名，并自动完成网站解析。</p>
            <p className="siteops-aliyun-security-note">
              FrontMind 只管理域名解析，不会购买、续费或从阿里云账号扣款。
            </p>
          </div>
          <span
            className="siteops-status-pill"
            data-status={observation.aliyunConnection.status ?? "none"}
          >
            {observation.aliyunConnection.status === "active"
              ? "阿里云已连接"
              : observation.aliyunConnection.status === "attention_required"
                ? "需要协助"
                : "尚未连接"}
          </span>
        </div>

        {aliyunConnectionError && (
          <div
            className="siteops-notice error"
            role="alert"
            aria-live="assertive"
          >
            <AlertCircle size={18} aria-hidden="true" />
            <span>{aliyunConnectionError}</span>
          </div>
        )}

        {aliyunProvisioningMessage && !aliyunConnectionError && (
          <div
            className="siteops-notice siteops-aliyun-progress"
            role="status"
            aria-live="polite"
          >
            {aliyunProvisioningMessage === "阿里云已连接" ? (
              <Check size={18} aria-hidden="true" />
            ) : (
              <Loader2 className="siteops-spin" size={18} aria-hidden="true" />
            )}
            <span>{aliyunProvisioningMessage}</span>
          </div>
        )}

        <div className="siteops-domain-actions">
          {observation.aliyunConnection.status !== "active" && (
            <button
              type="button"
              className="siteops-primary-button"
              disabled={
                !onBeginAliyun ||
                Boolean(busyAction) ||
                interactionPending ||
                aliyunFlowPhase !== "idle"
              }
              onClick={() => void beginAliyunConnection()}
            >
              {busyAction === "aliyun_begin" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              {observation.aliyunConnection.status === "not_connected"
                ? "一键连接阿里云"
                : "重新授权阿里云"}
            </button>
          )}
          {observation.aliyunConnection.status === "active" && (
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !onDisconnectAliyun ||
                !observation.aliyunConnection.canDisconnect ||
                interactionPending ||
                Boolean(busyAction)
              }
              onClick={() =>
                runConnectionAction("aliyun_disconnect", onDisconnectAliyun)
              }
            >
              解除连接
            </button>
          )}
        </div>

        {observation.aliyunConnection.status === "attention_required" && (
          <div
            className="siteops-notice warning"
            role="alert"
            aria-live="assertive"
          >
            阿里云授权已失效，请重新授权。域名无需重复购买或重新填写。
          </div>
        )}
        {!observation.aliyunConnection.canDisconnect && (
          <div className="siteops-notice warning">
            当前解析操作尚未完成，完成后才能解除连接。
          </div>
        )}

        <div className="siteops-domain-divider" />
        {observation.aliyunConnection.status === "active" && !managedDomain && (
          <div className="siteops-domain-form">
            {aliyunDomainsLoading ? (
              <div className="siteops-notice" role="status">
                <Loader2
                  className="siteops-spin"
                  size={18}
                  aria-hidden="true"
                />
                <span>正在读取您已购买的域名…</span>
              </div>
            ) : aliyunDomainsError ? (
              <div className="siteops-notice error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <span>{customerFacingMessage(aliyunDomainsError)}</span>
              </div>
            ) : aliyunDomains.length === 0 ? (
              <div className="siteops-domain-result">
                <strong>这个阿里云账号中还没有可接入的域名</strong>
                <span>
                  请先在阿里云购买域名，返回后刷新即可，无需重新授权。
                </span>
                <div className="siteops-domain-actions">
                  <a
                    href="https://wanwang.aliyun.com/domain/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                    前往阿里云购买域名
                  </a>
                  <button
                    type="button"
                    className="siteops-secondary-button"
                    disabled={!onRefreshAliyunDomains || Boolean(busyAction)}
                    onClick={() =>
                      runConnectionAction(
                        "aliyun_domains_refresh",
                        onRefreshAliyunDomains,
                      )
                    }
                  >
                    <RefreshCw size={15} aria-hidden="true" />
                    已购买，刷新域名
                  </button>
                </div>
              </div>
            ) : aliyunDomains.length === 1 ? (
              failedAutomaticDomainKey ===
              `${observation.project.conversationId}:${observation.project.revision}:${aliyunDomains[0].domain}` ? (
                <div className="siteops-domain-result">
                  <strong>域名自动接入没有完成</strong>
                  <span>原有解析没有被覆盖，可以安全重试。</span>
                  <div className="siteops-domain-actions">
                    <button
                      type="button"
                      className="siteops-secondary-button"
                      disabled={externalResetPending || Boolean(busyAction)}
                      onClick={() =>
                        syncOnlyAliyunDomain(
                          aliyunDomains[0].domain,
                          `${observation.project.conversationId}:${observation.project.revision}:${aliyunDomains[0].domain}`,
                        )
                      }
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      重试接入
                    </button>
                  </div>
                </div>
              ) : (
                <div className="siteops-notice" role="status">
                  {busyAction === "domain_sync_auto" ? (
                    <Loader2
                      className="siteops-spin"
                      size={18}
                      aria-hidden="true"
                    />
                  ) : (
                    <Check size={18} aria-hidden="true" />
                  )}
                  <span>
                    已找到 {aliyunDomains[0].displayDomain}，正在自动配置解析。
                  </span>
                </div>
              )
            ) : (
              <>
                <label>
                  <span>选择要上线的域名</span>
                  <select
                    value={selectedAliyunDomain}
                    onChange={(event) =>
                      setSelectedAliyunDomain(event.target.value)
                    }
                  >
                    <option value="">请选择</option>
                    {aliyunDomains.map((item) => (
                      <option key={item.domain} value={item.domain}>
                        {item.displayDomain}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="siteops-domain-actions">
                  <button
                    type="button"
                    className="siteops-primary-button"
                    disabled={
                      !selectedAliyunDomain ||
                      interactionLocked ||
                      externalResetPending
                    }
                    onClick={() =>
                      runAction(
                        "domain_sync",
                        actionFromCard(
                          observation,
                          "domain_status",
                          "domain_sync",
                          { domain: selectedAliyunDomain },
                        ),
                      )
                    }
                  >
                    连接并配置解析
                  </button>
                  <button
                    type="button"
                    className="siteops-secondary-button"
                    disabled={!onRefreshAliyunDomains || Boolean(busyAction)}
                    onClick={() =>
                      runConnectionAction(
                        "aliyun_domains_refresh",
                        onRefreshAliyunDomains,
                      )
                    }
                  >
                    刷新域名
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {observation.domainState && (
          <div className="siteops-domain-state">
            <strong>
              {observation.domainState.displayDomain ||
                observation.domainState.domain}
            </strong>
            <span>
              所有权：
              {customerDomainStateLabel(
                observation.domainState.ownershipStatus,
              )}
            </span>
            <span>
              解析：
              {observation.domainState.dnsStatus === "active"
                ? "已生效"
                : observation.domainState.dnsStatus === "attention_required"
                  ? "需要处理"
                  : "正在自动配置"}
            </span>
            <span>
              备案：
              {customerDomainStateLabel(observation.domainState.icpStatus)}
            </span>
            {observation.domainState.icpStatus !== "approved" && (
              <div className="siteops-icp-filing">
                <p className="siteops-icp-note">
                  中国大陆发布需要当前域名版本的 ICP
                  审核通过；海外发布不受影响。
                </p>
                <a
                  href="https://beian.aliyun.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  前往阿里云 ICP 备案系统
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
                <form onSubmit={submitIcpFiling}>
                  <label>
                    <span>当前域名版本的 ICP 主体备案号</span>
                    <input
                      value={icpNumber}
                      maxLength={128}
                      placeholder="例如 京ICP备12345678号"
                      required
                      onChange={(event) => setIcpNumber(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="siteops-secondary-button"
                    disabled={
                      !onSubmitIcpFiling ||
                      !icpNumber.trim() ||
                      Boolean(busyAction)
                    }
                  >
                    提交现有 ICP 核验工单
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
