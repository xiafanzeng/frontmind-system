import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  LoaderCircle,
  RefreshCw,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "wouter";

import type {
  MediaResource,
  PublicationBatchStatus,
  PublicationFundStatus,
  PublicationItemStatus,
} from "../types";

export function PublishingPage({
  title,
  description,
  actions,
  children,
  busy,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <main className="publishing-page" aria-busy={busy || undefined}>
      <header className="publishing-page-heading">
        <div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? (
          <div className="publishing-page-actions">{actions}</div>
        ) : null}
      </header>
      {children}
    </main>
  );
}

export function PublishingLoading({
  label = "正在读取媒体发布数据…",
}: {
  label?: string;
}) {
  return (
    <div className="publishing-state" role="status" aria-live="polite">
      <LoaderCircle className="publishing-spin" size={22} />
      <strong>{label}</strong>
    </div>
  );
}

export function PublishingError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <div className="publishing-state publishing-state-error" role="alert">
      <AlertCircle size={22} />
      <div>
        <strong>暂时无法读取</strong>
        <p>{error.message}</p>
      </div>
      {onRetry ? (
        <button
          className="publishing-button publishing-button-secondary"
          type="button"
          onClick={onRetry}
        >
          <RefreshCw size={16} />
          重试
        </button>
      ) : null}
    </div>
  );
}

export function PublishingEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="publishing-state publishing-empty">
      <span className="publishing-empty-icon" aria-hidden="true">
        文
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function PublishingBreadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>;
}) {
  return (
    <nav className="publishing-breadcrumbs" aria-label="面包屑">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`}>
          {index ? <ChevronRight size={14} aria-hidden="true" /> : null}
          {item.href ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PublishingSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const labels = ["稿件", "媒体", "标题", "预检"];
  return (
    <ol className="publishing-steps" aria-label="发布步骤">
      {labels.map((label, index) => {
        const number = index + 1;
        const active = number === current;
        const done = number < current;
        return (
          <li
            key={label}
            className={active ? "is-current" : done ? "is-done" : ""}
            aria-current={active ? "step" : undefined}
          >
            <span>{done ? <Check size={14} /> : number}</span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );
}

export function MediaMark({
  name,
  id,
  logoUrl,
  logoSource,
  logoResolutionStatus,
}: {
  name: string;
  id: string;
  logoUrl?: string;
  logoSource?: MediaResource["logoSource"];
  logoResolutionStatus?: MediaResource["logoResolutionStatus"];
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const colors = [
    "#b71424",
    "#db1f25",
    "#191921",
    "#2457d6",
    "#6f2da8",
    "#137d68",
  ];
  const index =
    [...id].reduce((sum, value) => sum + value.charCodeAt(0), 0) %
    colors.length;
  const safeLogoUrl =
    logoUrl &&
    /^\/api\/publisher\/media-logos\/[0-9a-f-]{36}\/[a-f0-9]{64}$/iu.test(
      logoUrl,
    )
      ? logoUrl
      : undefined;
  const showImage = Boolean(
    safeLogoUrl &&
    failedUrl !== safeLogoUrl &&
    (!logoResolutionStatus || logoResolutionStatus === "archived"),
  );
  const resolvedSource = showImage
    ? (logoSource ?? "provider_logo")
    : "generated_fallback";
  const isSiteFavicon = showImage && resolvedSource === "site_favicon";
  const isGeneratedFallback =
    showImage && resolvedSource === "generated_fallback";
  const secondaryColor = colors[(index + 2) % colors.length];
  const monogram = name.replace(/[·（）()\s]/g, "").slice(0, 3) || "媒体";
  const sourceLabel = {
    provider_logo: "供应商 Logo",
    provider_icon: "供应商 Icon",
    site_favicon: "站点 Favicon",
    web_search_verified: "名称检索验证 Logo",
    manual_verified: "人工核验 Logo",
    generated_fallback: "本地占位字标",
  }[resolvedSource];
  const statusLabel = {
    pending: "待归档",
    archived: "已归档",
    pending_review: "搜索结果待人工核验",
    missing: "未找到真实 Logo",
    failed: "真实 Logo 归档失败",
  }[logoResolutionStatus ?? (showImage ? "archived" : "missing")];
  return (
    <span
      className={`publishing-media-mark ${showImage ? "has-image" : "is-placeholder"} ${isGeneratedFallback ? "is-generated-fallback" : ""}`}
      style={
        {
          "--publishing-mark": colors[index],
          "--publishing-mark-secondary": secondaryColor,
        } as CSSProperties
      }
      role="img"
      aria-label={
        isGeneratedFallback
          ? `${name}暂无可验证真实 Logo，显示服务端生成的本地占位图片`
          : isSiteFavicon
            ? `${name}站点图标（非品牌 Logo），来源：${sourceLabel}`
            : showImage
              ? `${name}真实媒体标识，来源：${sourceLabel}`
              : `${name}暂无可验证真实 Logo，显示本地占位字标，状态：${statusLabel}`
      }
      title={
        isGeneratedFallback
          ? `${sourceLabel}（仅保证图片展示，不计入真实 Logo 覆盖率）`
          : isSiteFavicon
            ? `${sourceLabel}（仅作站点识别，不计入真实 Logo 覆盖率）`
            : showImage
              ? `${sourceLabel}（真实、已归档）`
              : `占位：${statusLabel}`
      }
      data-logo-source={resolvedSource}
      data-logo-status={
        logoResolutionStatus ?? (showImage ? "archived" : "missing")
      }
    >
      {showImage ? (
        <>
          <img
            src={safeLogoUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(safeLogoUrl)}
          />
          {isGeneratedFallback ? (
            <small className="publishing-media-mark-label">占位</small>
          ) : null}
        </>
      ) : (
        <>
          <b>{monogram}</b>
          <small>占位</small>
        </>
      )}
    </span>
  );
}

type StatusTone = "success" | "danger" | "warning" | "info" | "neutral";

const itemStatus: Record<
  PublicationItemStatus,
  { label: string; tone: StatusTone; icon: LucideIcon }
> = {
  queued: { label: "排队中", tone: "info", icon: Clock3 },
  submitting: { label: "提交中", tone: "info", icon: LoaderCircle },
  processing: { label: "媒体处理中", tone: "info", icon: Clock3 },
  success: { label: "发布成功", tone: "success", icon: CheckCircle2 },
  failed: { label: "已拒稿", tone: "danger", icon: XCircle },
  auth_blocked: { label: "门禁阻断", tone: "warning", icon: AlertCircle },
  submission_unknown: { label: "状态未知", tone: "warning", icon: CircleHelp },
  action_required: {
    label: "需要人工处理",
    tone: "warning",
    icon: AlertCircle,
  },
};

const batchStatus: Record<
  PublicationBatchStatus,
  { label: string; tone: StatusTone; icon: LucideIcon }
> = {
  queued: { label: "等待发布", tone: "info", icon: Clock3 },
  processing: { label: "发布中", tone: "info", icon: LoaderCircle },
  success: { label: "全部成功", tone: "success", icon: CheckCircle2 },
  failed: { label: "全部失败", tone: "danger", icon: XCircle },
  partial_success: { label: "部分成功", tone: "warning", icon: AlertCircle },
  action_required: { label: "需要人工处理", tone: "warning", icon: CircleHelp },
};

const fundStatus: Record<
  PublicationFundStatus,
  { label: string; tone: StatusTone }
> = {
  reserved: { label: "已预占", tone: "info" },
  frozen: { label: "待对账冻结", tone: "warning" },
  consumed: { label: "已扣款", tone: "success" },
  released: { label: "金额已退回", tone: "success" },
};

export function ItemStatusBadge({ status }: { status: PublicationItemStatus }) {
  const config = itemStatus[status];
  const Icon = config.icon;
  return (
    <span className={`publishing-status is-${config.tone}`}>
      <Icon
        className={status === "submitting" ? "publishing-spin" : undefined}
        size={14}
      />
      {config.label}
    </span>
  );
}

export function BatchStatusBadge({
  status,
}: {
  status: PublicationBatchStatus;
}) {
  const config = batchStatus[status];
  const Icon = config.icon;
  return (
    <span className={`publishing-status is-${config.tone}`}>
      <Icon
        className={status === "processing" ? "publishing-spin" : undefined}
        size={14}
      />
      {config.label}
    </span>
  );
}

export function FundStatusBadge({ status }: { status: PublicationFundStatus }) {
  const config = fundStatus[status];
  return (
    <span className={`publishing-status is-${config.tone}`}>
      {config.label}
    </span>
  );
}

export function PublishingPagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  const normalizedPageCount = Math.max(pageCount, 1);
  const [jumpPage, setJumpPage] = useState(String(page));
  useEffect(() => setJumpPage(String(page)), [page]);
  const nearbyPages = [
    ...new Set([1, page - 1, page, page + 1, normalizedPageCount]),
  ]
    .filter((candidate) => candidate >= 1 && candidate <= normalizedPageCount)
    .sort((left, right) => left - right);
  const submitJump = () => {
    const target = Number(jumpPage);
    if (!Number.isInteger(target)) {
      setJumpPage(String(page));
      return;
    }
    onChange(Math.min(Math.max(target, 1), normalizedPageCount));
  };
  return (
    <nav className="publishing-pagination" aria-label="媒体分页">
      <button
        className="publishing-pagination-edge"
        type="button"
        onClick={() => onChange(1)}
        disabled={page <= 1}
        aria-label="首页"
      >
        首页
      </button>
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="上一页"
      >
        <ChevronLeft size={18} />
      </button>
      <span className="publishing-pagination-pages">
        {nearbyPages.map((candidate, index) => (
          <span key={candidate}>
            {index > 0 && candidate - nearbyPages[index - 1]! > 1 ? (
              <i aria-hidden="true">…</i>
            ) : null}
            <button
              className={candidate === page ? "is-active" : ""}
              type="button"
              aria-label={`第 ${candidate} 页`}
              aria-current={candidate === page ? "page" : undefined}
              onClick={() => onChange(candidate)}
            >
              {candidate}
            </button>
          </span>
        ))}
      </span>
      <span className="publishing-pagination-summary">
        第 {page} / {normalizedPageCount} 页
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label="下一页"
      >
        <ChevronRight size={18} />
      </button>
      <button
        className="publishing-pagination-edge"
        type="button"
        onClick={() => onChange(normalizedPageCount)}
        disabled={page >= normalizedPageCount}
        aria-label="末页"
      >
        末页
      </button>
      <form
        className="publishing-pagination-jump"
        onSubmit={(event) => {
          event.preventDefault();
          submitJump();
        }}
      >
        <label>
          <span className="publishing-visually-hidden">跳转页码</span>
          <input
            inputMode="numeric"
            value={jumpPage}
            onChange={(event) =>
              setJumpPage(event.target.value.replace(/\D/gu, ""))
            }
            aria-label="跳转页码"
          />
        </label>
        <button type="submit" aria-label="跳转">
          跳转
        </button>
      </form>
    </nav>
  );
}

export function PublishingConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  confirmDisabled,
  wide,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  wide?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const getFocusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    document.body.style.overflow = "hidden";
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
    closeRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="publishing-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className={`publishing-dialog ${wide ? "is-wide" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button
          ref={closeRef}
          className="publishing-dialog-close"
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label="关闭确认对话框"
        >
          <X size={18} />
        </button>
        <div className="publishing-dialog-body">
          <span className="publishing-dialog-icon" aria-hidden="true">
            <AlertCircle size={25} />
          </span>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {children}
        </div>
        <footer>
          <button
            className="publishing-button publishing-button-secondary"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            返回检查
          </button>
          <button
            className="publishing-button publishing-button-primary"
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? (
              <LoaderCircle className="publishing-spin" size={16} />
            ) : null}
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
