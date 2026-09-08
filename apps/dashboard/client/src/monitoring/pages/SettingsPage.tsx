import {
  BadgeCheck,
  CircleAlert,
  CircleDollarSign,
  Clock3,
  FileText,
  Info,
  KeyRound,
  Landmark,
  ListChecks,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import Modal from "../components/Modal";
import {
  formatCnyTenThousandths,
  isTopupAmount,
  yuanInputToTenThousandths,
} from "../billingView";
import { formatDateTime } from "../domain";

export type BillingSummaryView = {
  availableTenThousandths: string;
  reservedTenThousandths: string;
  totalSpentTenThousandths: string;
  frozenTenThousandths?: string;
  consumptionBySource?: Record<"monitoring"|"media_publishing"|"ai",{totalTenThousandths:string;last30DaysTenThousandths:string}>;
};
export type MediaPublishingBillingSummaryView = BillingSummaryView & {
  frozenTenThousandths: string;
};
export type WalletScope = "monitoring" | "media_publishing";
export type BillingActivityFilter = "all" | "monitoring" | "media_publishing" | "ai";
export type BillingPricingView = {
  id: string;
  platformType: string;
  answerMode: string;
  withoutScreenshotTenThousandths?: string;
  withScreenshotTenThousandths?: string;
  available: boolean;
};
export type BillingLedgerEntryView = {
  id: string;
  type: "topup" | "spend" | "freeze" | "release" | "adjustment";
  balanceDeltaTenThousandths: string;
  status: "pending" | "under_review" | "paid" | "completed" | "rejected";
  description: string;
  relatedRun?: string;
  walletScope?: WalletScope;
  source?: "monitoring" | "media_publishing" | "ai";
  createdAt?: string;
};
export type BillingPaymentMethod = "alipay" | "wxpay" | "bank_transfer";
export type BillingTopupStatus =
  | "unconfigured"
  | "pending_payment"
  | "under_review"
  | "paid"
  | "expired"
  | "cancelled"
  | "rejected";
export type BillingTopupView = {
  id: string;
  amountTenThousandths: string;
  method: BillingPaymentMethod;
  status: BillingTopupStatus;
  checkout?: {
    action: string;
    httpMethod: "POST";
    fields: Record<string, string>;
  };
  bankInstructions?: string;
  statusMessage?: string;
};

type SettingsPageProps = {
  loading?: boolean;
  billingLoading?: boolean;
  billingError?: string;
  summary?: BillingSummaryView;
  mediaPublishingSummary?: MediaPublishingBillingSummaryView;
  pricing?: BillingPricingView[];
  activity?: BillingLedgerEntryView[];
  activityTotal?: number;
  activityPage?: number;
  activityLoading?: boolean;
  activityFilter?: BillingActivityFilter;
  onActivityPageChange?: (page: number) => void;
  onActivityFilterChange?: (filter: BillingActivityFilter) => void;
  paymentMethods?: BillingPaymentMethodView[];
  activeTopup?: BillingTopupView;
  mediaPublishingActiveTopup?: BillingTopupView;
  onCreateTopup?: (
    amountTenThousandths: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView>;
  onSwitchTopupMethod?: (
    topupId: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView>;
  onSubmitBankTransfer?: (
    topupId: string,
    input: BankTransferSubmissionView,
  ) => Promise<BillingTopupView>;
  onClearActiveTopup?: () => void;
  onCreateMediaPublishingTopup?: (
    amountTenThousandths: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView>;
  onSwitchMediaPublishingTopupMethod?: (
    topupId: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView>;
  onSubmitMediaPublishingBankTransfer?: (
    topupId: string,
    input: BankTransferSubmissionView,
  ) => Promise<BillingTopupView>;
  onClearMediaPublishingActiveTopup?: () => void;
  onChangePassword?: (
    currentPassword: string,
    newPassword: string,
  ) => void | Promise<void>;
};

const TOPUP_PRESETS = [100, 500, 1000, 3000] as const;
const PAYMENT_METHOD_COPY: Array<{
  id: BillingPaymentMethod;
  label: string;
  description: string;
}> = [
  { id: "alipay", label: "支付宝", description: "安全快捷" },
  { id: "wxpay", label: "微信支付", description: "安全快捷" },
  {
    id: "bank_transfer",
    label: "企业银行转账",
    description: "提交转账信息后人工审核",
  },
];

export type BillingPaymentMethodView = {
  id: BillingPaymentMethod;
  configured: boolean;
  unavailableReason?: string;
};

export type BankTransferSubmissionView = {
  payerName: string;
  transferredAt: string;
  remittanceReference: string;
};

export function formatCny(value: string | undefined) {
  return formatCnyTenThousandths(value);
}

function ledgerTypeLabel(type: BillingLedgerEntryView["type"]) {
  return {
    topup: "充值",
    spend: "消费",
    freeze: "冻结",
    release: "释放",
    adjustment: "余额调整",
  }[type];
}

function billingStatusLabel(status: BillingLedgerEntryView["status"]) {
  return {
    pending: "待支付",
    under_review: "审核中",
    paid: "已支付",
    completed: "已完成",
    rejected: "已驳回",
  }[status];
}

function compactBillingReference(value?: string) {
  if (!value) return "—";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-5)}`;
}

export default function SettingsPage({
  loading,
  billingLoading,
  billingError,
  summary,
  mediaPublishingSummary,
  pricing = [],
  activity = [],
  activityTotal = 0,
  activityPage = 1,
  activityLoading = false,
  activityFilter = "all",
  onActivityPageChange,
  onActivityFilterChange,
  paymentMethods = [],
  activeTopup,
  mediaPublishingActiveTopup,
  onCreateTopup,
  onSwitchTopupMethod,
  onSubmitBankTransfer,
  onClearActiveTopup,
  onCreateMediaPublishingTopup,
  onSwitchMediaPublishingTopupMethod,
  onSubmitMediaPublishingBankTransfer,
  onClearMediaPublishingActiveTopup,
  onChangePassword,
}: SettingsPageProps) {
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupWalletScope, setTopupWalletScope] = useState<WalletScope>(() => {
    if (typeof window === "undefined") return "monitoring";
    return new URLSearchParams(window.location.search).get("wallet") ===
      "media_publishing"
      ? "media_publishing"
      : "monitoring";
  });
  const selectedActiveTopup =
    topupWalletScope === "media_publishing"
      ? mediaPublishingActiveTopup
      : activeTopup;
  const [currentTopup, setCurrentTopup] = useState(selectedActiveTopup);
  const activityPages = Math.max(1, Math.ceil(activityTotal / 10));
  useEffect(() => setCurrentTopup(selectedActiveTopup), [selectedActiveTopup]);

  const openTopup = (scope: WalletScope) => {
    setTopupWalletScope(scope);
    const topup =
      scope === "media_publishing" ? mediaPublishingActiveTopup : activeTopup;
    setCurrentTopup(
      topup &&
        ["pending_payment", "under_review", "unconfigured"].includes(
          topup.status,
        )
        ? topup
        : undefined,
    );
    setTopupOpen(true);
  };

  return (
    <div className="page-content settings-page account-settings-page">
      <section className="page-heading account-settings-heading">
        <div>
          <h1>账号与余额</h1>
          <p>一个账户余额，用于问题监控、媒体投放和智能体。</p>
        </div>
      </section>
      {billingError && (
        <p className="form-error" role="alert">
          账户数据加载失败：{billingError}
        </p>
      )}
      <section
        className="content-card account-balance-panel"
        aria-busy={billingLoading || undefined}
      >
        <SectionTitle icon={<WalletCards size={20} />} title="账户余额" />
        <div className="wallet-account-grid" style={{gridTemplateColumns:"1fr"}}>
          <WalletSummaryCard scope="monitoring" title="账户余额" summary={summary}
            frozenTenThousandths={summary?.frozenTenThousandths}
            note="所有企业项目共用，按实际用量结算" actionLabel="账户充值" onTopup={()=>openTopup("monitoring")} />
        </div>
        <div className="account-consumption-grid">
          {([["monitoring","问题监控消耗"],["media_publishing","媒体投放消耗"],["ai","智能体消耗"]] as const).map(([source,label])=>(
            <article className="account-consumption-card" key={source}>
              <span>{label}</span>
              <strong>{formatCny(summary?.consumptionBySource?.[source].last30DaysTenThousandths??"0")}</strong>
              <small>近 30 天 · 累计 {formatCny(summary?.consumptionBySource?.[source].totalTenThousandths??"0")}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="content-card account-settings-section">
        <SectionTitle icon={<FileText size={20} />} title="资费说明" />
        <PricingTable rows={pricing} />
        <small className="billing-section-note">
          <Info size={13} />
          问题监控以任务创建时的资费为准；媒体发布以提交前确认的价格为准；智能体按实际用量结算。
        </small>
      </section>

      <section className="content-card account-settings-section">
        <SectionTitle icon={<ListChecks size={20} />} title="资金明细" />
        <div className="account-consumption-filters" aria-label="消费分类">
          {([["all","全部收支"],["monitoring","问题监控消耗"],["media_publishing","媒体投放消耗"],["ai","智能体消耗"]] as const).map(([value,label])=>(
            <button type="button" key={value} aria-pressed={activityFilter===value} onClick={()=>onActivityFilterChange?.(value)}>{label}</button>
          ))}
        </div>
        <div aria-busy={activityLoading || undefined}>
          {activityLoading && activity.length === 0
            ? <p role="status">正在读取资金明细…</p>
            : <LedgerTable rows={activity} />}
        </div>
        <nav className="source-pagination" aria-label="资金明细分页">
          <p>共 {activityTotal} 条 · 第 {activityPage} / {activityPages} 页 · 每页 10 条</p>
          <div>
            <button type="button" disabled={activityLoading || activityPage <= 1} onClick={()=>onActivityPageChange?.(activityPage - 1)}>上一页</button>
            <button type="button" disabled={activityLoading || activityPage >= activityPages} onClick={()=>onActivityPageChange?.(activityPage + 1)}>下一页</button>
          </div>
        </nav>
      </section>

      {onChangePassword && (
        <PasswordSection
          loading={loading}
          onChangePassword={onChangePassword}
        />
      )}

      <Modal
        open={topupOpen}
        onClose={() => setTopupOpen(false)}
        title="账户充值"
        size="large"
      >
        <TopupForm
          currentTopup={currentTopup}
          methods={paymentMethods}
          onCreateTopup={async (amount, method) => {
            const next =
              topupWalletScope === "media_publishing"
                ? await onCreateMediaPublishingTopup?.(amount, method)
                : await onCreateTopup?.(amount, method);
            if (next) setCurrentTopup(next);
            return next;
          }}
          onSwitchMethod={async (topupId, method) => {
            const next =
              topupWalletScope === "media_publishing"
                ? await onSwitchMediaPublishingTopupMethod?.(topupId, method)
                : await onSwitchTopupMethod?.(topupId, method);
            if (next) setCurrentTopup(next);
            return next;
          }}
          onSubmitBankTransfer={async (topupId, input) => {
            const next =
              topupWalletScope === "media_publishing"
                ? await onSubmitMediaPublishingBankTransfer?.(topupId, input)
                : await onSubmitBankTransfer?.(topupId, input);
            if (next) setCurrentTopup(next);
          }}
          onStartNewTopup={() => {
            setCurrentTopup(undefined);
            if (topupWalletScope === "media_publishing")
              onClearMediaPublishingActiveTopup?.();
            else onClearActiveTopup?.();
          }}
          onClose={() => setTopupOpen(false)}
        />
      </Modal>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="account-section-title">
      <span className="account-section-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
    </div>
  );
}

function WalletSummaryCard({
  scope,
  title,
  summary,
  frozenTenThousandths,
  note,
  actionLabel,
  onTopup,
  disabled,
}: {
  scope: WalletScope;
  title: string;
  summary?: BillingSummaryView;
  frozenTenThousandths?: string;
  note: string;
  actionLabel: string;
  onTopup: () => void;
  disabled?: boolean;
}) {
  return (
    <article className={`wallet-account-card ${scope}`}>
      <header>
        <span aria-hidden="true">
          {scope === "monitoring" ? (
            <CircleDollarSign size={18} />
          ) : (
            <FileText size={18} />
          )}
        </span>
        <h3>{title}</h3>
      </header>
      <div className="account-balance-primary">
        <strong>{formatCny(summary?.availableTenThousandths)}</strong>
        <small>
          <Info size={14} />
          {note}
        </small>
      </div>
      <dl className="account-balance-stats">
        <div>
          <dt>预占金额</dt>
          <dd>{formatCny(summary?.reservedTenThousandths)}</dd>
        </div>
        {frozenTenThousandths !== undefined && (
          <div>
            <dt>待对账冻结</dt>
            <dd>{formatCny(frozenTenThousandths)}</dd>
          </div>
        )}
        <div>
          <dt>累计支出</dt>
          <dd>{formatCny(summary?.totalSpentTenThousandths)}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="primary-button account-topup-button"
        onClick={onTopup}
        disabled={disabled}
        title={disabled ? "媒体发布充值服务尚未开放" : undefined}
      >
        {actionLabel}
      </button>
    </article>
  );
}

function PricingTable({ rows }: { rows: BillingPricingView[] }) {
  return (
    <div
      className="billing-pricing-table"
      role="region"
      aria-label="FrontMind 资费，可横向滚动"
      tabIndex={0}
    >
      <div className="billing-pricing-head" role="row">
        <span role="columnheader">平台类型</span>
        <span role="columnheader">问答模式</span>
        <span role="columnheader">不含截图</span>
        <span role="columnheader">包含截图</span>
        <span role="columnheader">可用状态</span>
      </div>
      {rows.length ? (
        rows.map((item) => (
          <div className="billing-pricing-row" key={item.id} role="row">
            <span role="cell">{item.platformType}</span>
            <span role="cell">{item.answerMode}</span>
            <strong role="cell">
              {item.withoutScreenshotTenThousandths
                ? formatCnyTenThousandths(
                    item.withoutScreenshotTenThousandths,
                    { maximumFractionDigits: 4 },
                  )
                : "—"}
            </strong>
            <strong role="cell">
              {item.withScreenshotTenThousandths
                ? formatCnyTenThousandths(item.withScreenshotTenThousandths, {
                    maximumFractionDigits: 4,
                  })
                : "—"}
            </strong>
            <span role="cell">
              <i className={item.available ? "available" : "unavailable"}>
                {item.available ? "当前可用" : "暂未开放"}
              </i>
            </span>
          </div>
        ))
      ) : (
        <div className="billing-table-empty">暂无可展示资费</div>
      )}
    </div>
  );
}

function LedgerTable({ rows }: { rows: BillingLedgerEntryView[] }) {
  return (
    <div className="billing-ledger" role="table" aria-label="资金明细">
      <div className="billing-ledger-head" role="row">
        <span role="columnheader">时间</span>
        <span role="columnheader">类型</span>
        <span role="columnheader">金额</span>
        <span role="columnheader">状态</span>
        <span role="columnheader">关联任务</span>
      </div>
      {rows.length ? (
        rows.map((entry) => {
          const signedAmount = entry.balanceDeltaTenThousandths;
          const positive =
            !signedAmount.startsWith("-") && signedAmount !== "0";
          return (
            <div className="billing-ledger-row" key={`${entry.source ?? entry.walletScope}:${entry.id}`} role="row">
              <span data-label="时间" role="cell">
                {formatDateTime(entry.createdAt)}
              </span>
              <span data-label="类型" role="cell">
                <strong>{ledgerTypeLabel(entry.type)}</strong>
                <small className="billing-ledger-scope">
                  {entry.type === "topup" || entry.type === "adjustment" ? "账户收支" :
                    (entry.source??entry.walletScope)==="ai"?"智能体消耗":
                    (entry.source??entry.walletScope)==="media_publishing"?"媒体投放消耗":"问题监控消耗"}
                </small>
                <small>{entry.description}</small>
              </span>
              <strong
                data-label="金额"
                role="cell"
                className={positive ? "positive" : "negative"}
              >
                {positive ? "+" : ""}
                {formatCny(signedAmount)}
              </strong>
              <span data-label="状态" role="cell">
                <i className={`billing-status ${entry.status}`}>
                  {billingStatusLabel(entry.status)}
                </i>
              </span>
              <span data-label="关联任务" role="cell">
                <span title={entry.relatedRun}>
                  {compactBillingReference(entry.relatedRun)}
                </span>
              </span>
            </div>
          );
        })
      ) : (
        <div className="billing-ledger-empty">
          <ListChecks size={34} />
          <strong>暂无资金记录</strong>
        </div>
      )}
    </div>
  );
}

function PasswordSection({
  loading,
  onChangePassword,
}: Pick<SettingsPageProps, "loading" | "onChangePassword">) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 12) return setError("新密码至少需要 12 位。");
    if (newPassword !== confirmation)
      return setError("两次输入的新密码不一致。");
    if (newPassword === currentPassword)
      return setError("新密码不能与当前密码相同。");
    setError("");
    await onChangePassword?.(currentPassword, newPassword);
  };
  return (
    <section className="content-card account-settings-section login-security-section">
      <div className="account-section-title">
        <span className="account-section-icon" aria-hidden="true">
          <ShieldCheck size={20} />
        </span>
        <div>
          <h2>登录安全</h2>
          <p>修改密码后，包含当前会话在内的全部会话都会撤销。</p>
        </div>
      </div>
      <form
        className="password-form account-password-form"
        onSubmit={(event) => void submit(event)}
      >
        <PasswordField
          label="当前密码"
          value={currentPassword}
          autoComplete="current-password"
          onChange={setCurrentPassword}
        />
        <PasswordField
          label="新密码"
          value={newPassword}
          autoComplete="new-password"
          onChange={setNewPassword}
        />
        <PasswordField
          label="确认新密码"
          value={confirmation}
          autoComplete="new-password"
          onChange={setConfirmation}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={loading}>
          <KeyRound size={15} />
          {loading ? "正在修改…" : "修改密码"}
        </button>
      </form>
    </section>
  );
}

function PasswordField({
  label,
  value,
  autoComplete,
  onChange,
}: {
  label: string;
  value: string;
  autoComplete: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete={autoComplete}
        minLength={12}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`请输入${label}`}
        required
      />
    </label>
  );
}

function AlipayBrandMark() {
  return (
    <svg
      className="payment-brand-icon alipay-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-payment-brand="alipay"
    >
      <path d="M2.541 0H13.5a2.55 2.55 0 0 1 2.54 2.563v8.297c-.006 0-.531-.046-2.978-.813-.412-.14-.916-.327-1.479-.536q-.456-.17-.957-.353a13 13 0 0 0 1.325-3.373H8.822V4.649h3.831v-.634h-3.83V2.121H7.26c-.274 0-.274.273-.274.273v1.621H3.11v.634h3.875v1.136h-3.2v.634H9.99c-.227.789-.532 1.53-.894 2.202-2.013-.67-4.161-1.212-5.51-.878-.864.214-1.42.597-1.746.998-1.499 1.84-.424 4.633 2.741 4.633 1.872 0 3.675-1.053 5.072-2.787 2.08 1.008 6.37 2.738 6.387 2.745v.105A2.55 2.55 0 0 1 13.5 16H2.541A2.55 2.55 0 0 1 0 13.437V2.563A2.55 2.55 0 0 1 2.541 0" />
      <path d="M2.309 9.27c-1.22 1.073-.49 3.034 1.978 3.034 1.434 0 2.868-.925 3.994-2.406-1.602-.789-2.959-1.353-4.425-1.207-.397.04-1.14.217-1.547.58Z" />
    </svg>
  );
}

function WechatPayBrandMark() {
  return (
    <svg
      className="payment-brand-icon wechat-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-payment-brand="wxpay"
    >
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  );
}

function PaymentMethodIcon({ method }: { method: BillingPaymentMethod }) {
  if (method === "alipay") return <AlipayBrandMark />;
  if (method === "wxpay") return <WechatPayBrandMark />;
  return <Landmark className="bank-icon" />;
}

const PAYMENT_WINDOW_TARGET = "frontmind-topup-payment";

function openPaymentWindow(method: BillingPaymentMethod) {
  if (method === "bank_transfer") return null;
  return window.open("about:blank", PAYMENT_WINDOW_TARGET);
}

function deliverCheckout(
  topup: BillingTopupView | undefined,
  paymentWindow: Window | null,
) {
  if (!topup?.checkout) {
    paymentWindow?.close();
    if (
      topup?.method !== "bank_transfer" &&
      topup?.status === "pending_payment"
    )
      throw new Error("支付订单缺少收银台信息，请稍后重试。");
    return;
  }
  if (!paymentWindow)
    throw new Error("支付窗口被浏览器拦截，请允许弹窗后重试。");
  const form = document.createElement("form");
  form.method = topup.checkout.httpMethod;
  form.action = topup.checkout.action;
  form.target = PAYMENT_WINDOW_TARGET;
  form.hidden = true;
  for (const [name, value] of Object.entries(topup.checkout.fields)) {
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

function TopupForm({
  currentTopup,
  methods,
  onCreateTopup,
  onSwitchMethod,
  onSubmitBankTransfer,
  onStartNewTopup,
  onClose,
}: {
  currentTopup?: BillingTopupView;
  methods: BillingPaymentMethodView[];
  onCreateTopup: (
    amountTenThousandths: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView | undefined>;
  onSwitchMethod: (
    topupId: string,
    method: BillingPaymentMethod,
  ) => Promise<BillingTopupView | undefined>;
  onSubmitBankTransfer: (
    topupId: string,
    input: BankTransferSubmissionView,
  ) => Promise<void>;
  onStartNewTopup: () => void;
  onClose: () => void;
}) {
  const methodOptions = PAYMENT_METHOD_COPY.map((copy) => ({
    ...copy,
    configured:
      methods.find((candidate) => candidate.id === copy.id)?.configured ===
      true,
    unavailableReason: methods.find((candidate) => candidate.id === copy.id)
      ?.unavailableReason,
  }));
  const [preset, setPreset] = useState<number>(500);
  const [customAmount, setCustomAmount] = useState("");
  const [method, setMethod] = useState<BillingPaymentMethod>(
    methodOptions.find((item) => item.configured)?.id || "alipay",
  );
  const [bankTransfer, setBankTransfer] = useState<BankTransferSubmissionView>({
    payerName: "",
    transferredAt: "",
    remittanceReference: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const amountYuan = useMemo(
    () => (customAmount ? customAmount : String(preset)),
    [customAmount, preset],
  );
  const amountTenThousandths = yuanInputToTenThousandths(amountYuan) || "0";
  const validAmount = isTopupAmount(amountTenThousandths);
  const selectedMethodConfigured =
    methodOptions.find((item) => item.id === method)?.configured === true;

  if (currentTopup)
    return (
      <TopupStatus
        topup={currentTopup}
        methods={methodOptions}
        bankTransfer={bankTransfer}
        submitting={submitting}
        error={error}
        onBankTransferChange={(patch) =>
          setBankTransfer((current) => ({ ...current, ...patch }))
        }
        onSwitchMethod={async (nextMethod) => {
          const paymentWindow = openPaymentWindow(nextMethod);
          setSubmitting(true);
          setError("");
          try {
            const next = await onSwitchMethod(currentTopup.id, nextMethod);
            deliverCheckout(next, paymentWindow);
          } catch (cause) {
            paymentWindow?.close();
            setError(
              cause instanceof Error ? cause.message : "支付方式切换失败。",
            );
          } finally {
            setSubmitting(false);
          }
        }}
        onSubmitBankTransfer={async () => {
          if (!bankTransfer.payerName.trim())
            return setError("请填写付款人姓名或企业名称。");
          if (!bankTransfer.transferredAt)
            return setError("请选择实际转账时间。");
          if (!bankTransfer.remittanceReference.trim())
            return setError("请填写银行流水号。");
          setSubmitting(true);
          setError("");
          try {
            await onSubmitBankTransfer(currentTopup.id, {
              payerName: bankTransfer.payerName.trim(),
              transferredAt: bankTransfer.transferredAt,
              remittanceReference: bankTransfer.remittanceReference.trim(),
            });
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "转账信息提交失败。",
            );
          } finally {
            setSubmitting(false);
          }
        }}
        onStartNewTopup={onStartNewTopup}
        onClose={onClose}
      />
    );

  const create = async () => {
    if (!validAmount) return setError("充值金额需在 ¥10–¥50,000 之间。");
    if (!selectedMethodConfigured)
      return setError("当前支付方式尚未配置，请选择可用方式。");
    const paymentWindow = openPaymentWindow(method);
    setSubmitting(true);
    setError("");
    try {
      const next = await onCreateTopup(amountTenThousandths, method);
      deliverCheckout(next, paymentWindow);
    } catch (cause) {
      paymentWindow?.close();
      setError(cause instanceof Error ? cause.message : "充值订单创建失败。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="topup-form">
      <section>
        <h3>1. 充值金额</h3>
        <div className="topup-presets">
          {TOPUP_PRESETS.map((value) => (
            <button
              type="button"
              key={value}
              className={!customAmount && preset === value ? "selected" : ""}
              aria-pressed={!customAmount && preset === value}
              onClick={() => {
                setPreset(value);
                setCustomAmount("");
              }}
            >
              ¥{value}
            </button>
          ))}
        </div>
        <label className="topup-custom-amount">
          <span>自定义金额</span>
          <div>
            <b>¥</b>
            <input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onChange={(event) => setCustomAmount(event.target.value)}
              placeholder="请输入金额"
            />
          </div>
          <small>¥10–¥50,000</small>
        </label>
      </section>
      <section>
        <h3>2. 支付方式</h3>
        <div className="payment-method-grid">
          {methodOptions.map((item) => (
            <button
              type="button"
              key={item.id}
              className={method === item.id ? "selected" : ""}
              aria-pressed={method === item.id}
              disabled={!item.configured}
              title={item.unavailableReason}
              onClick={() => setMethod(item.id)}
            >
              <PaymentMethodIcon method={item.id} />
              <span>
                <strong>{item.label}</strong>
                <small>
                  {item.configured
                    ? item.description
                    : item.unavailableReason || "暂未配置"}
                </small>
              </span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>3. 订单信息</h3>
        <dl className="topup-order-summary">
          {[
            ["充值金额", amountTenThousandths],
            ["实付金额", amountTenThousandths],
            ["到账金额", amountTenThousandths],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt>{label}</dt>
              <dd>{formatCny(String(value))}</dd>
            </div>
          ))}
        </dl>
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary-button topup-submit"
        disabled={submitting || !validAmount || !selectedMethodConfigured}
        onClick={() => void create()}
      >
        {submitting
          ? "正在创建订单…"
          : method === "bank_transfer"
            ? `提交转账申请 ${formatCny(amountTenThousandths)}`
            : `前往支付 ${formatCny(amountTenThousandths)}`}
      </button>
      <small className="topup-security-note">
        <ShieldCheck size={14} />
        支付结果由服务端核验，请勿重复支付
      </small>
    </div>
  );
}

function TopupStatus({
  topup,
  methods,
  bankTransfer,
  submitting,
  error,
  onBankTransferChange,
  onSwitchMethod,
  onSubmitBankTransfer,
  onStartNewTopup,
  onClose,
}: {
  topup: BillingTopupView;
  methods: Array<
    (typeof PAYMENT_METHOD_COPY)[number] & BillingPaymentMethodView
  >;
  bankTransfer: BankTransferSubmissionView;
  submitting: boolean;
  error: string;
  onBankTransferChange: (patch: Partial<BankTransferSubmissionView>) => void;
  onSwitchMethod: (method: BillingPaymentMethod) => Promise<void>;
  onSubmitBankTransfer: () => Promise<void>;
  onStartNewTopup: () => void;
  onClose: () => void;
}) {
  const [checkoutError, setCheckoutError] = useState("");
  const states = {
    unconfigured: ["支付通道未配置", "当前方式暂不可用，请切换支付方式。"],
    pending_payment: ["等待支付", "订单已创建，完成支付后余额会自动更新。"],
    under_review: ["转账审核中", "已收到转账信息，管理员审核后入账。"],
    paid: ["充值已到账", "支付已由服务端核验，账户余额已更新。"],
    expired: ["充值订单已过期", "该订单不能继续支付，请新建充值。"],
    cancelled: ["充值订单已取消", "该订单已终止，请新建充值。"],
    rejected: ["转账审核未通过", "请核对审核原因后新建充值。"],
  } as const;
  const [title, copy] = states[topup.status];
  const currentMethodConfigured =
    methods.find((item) => item.id === topup.method)?.configured === true;
  const StateIcon =
    topup.status === "paid"
      ? BadgeCheck
      : topup.status === "under_review" || topup.status === "pending_payment"
        ? Clock3
        : CircleAlert;
  return (
    <div className="topup-status-view">
      <div className={`topup-state ${topup.status}`}>
        <span>
          <StateIcon />
        </span>
        <div>
          <h3>{title}</h3>
          <p>{topup.statusMessage || copy}</p>
        </div>
      </div>
      <dl className="topup-order-summary">
        <div>
          <dt>订单编号</dt>
          <dd>{topup.id}</dd>
        </div>
        <div>
          <dt>充值金额</dt>
          <dd>{formatCny(topup.amountTenThousandths)}</dd>
        </div>
        <div>
          <dt>支付方式</dt>
          <dd>
            {
              PAYMENT_METHOD_COPY.find((item) => item.id === topup.method)
                ?.label
            }
          </dd>
        </div>
      </dl>
      {topup.method === "bank_transfer" &&
        topup.status === "pending_payment" &&
        currentMethodConfigured && (
          <div className="bank-transfer-submit">
            {topup.bankInstructions && <p>{topup.bankInstructions}</p>}
            <label className="field">
              <span>付款人姓名 / 企业名称</span>
              <input
                value={bankTransfer.payerName}
                onChange={(event) =>
                  onBankTransferChange({ payerName: event.target.value })
                }
                placeholder="请输入转账账户名称"
              />
            </label>
            <label className="field">
              <span>实际转账时间</span>
              <input
                type="datetime-local"
                value={bankTransfer.transferredAt}
                onChange={(event) =>
                  onBankTransferChange({ transferredAt: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>银行流水号</span>
              <input
                value={bankTransfer.remittanceReference}
                onChange={(event) =>
                  onBankTransferChange({
                    remittanceReference: event.target.value,
                  })
                }
                placeholder="请输入企业转账流水号"
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={submitting}
              onClick={() => void onSubmitBankTransfer()}
            >
              <Landmark size={16} />
              提交审核
            </button>
          </div>
        )}
      {topup.status === "pending_payment" && !currentMethodConfigured && (
        <p className="topup-method-unavailable" role="alert">
          当前支付通道已停用，请切换到可用方式后继续。
        </p>
      )}
      {topup.checkout &&
        topup.status === "pending_payment" &&
        currentMethodConfigured && (
          <button
            type="button"
            className="primary-button topup-payment-link"
            onClick={() => {
              setCheckoutError("");
              try {
                const paymentWindow = openPaymentWindow(topup.method);
                deliverCheckout(topup, paymentWindow);
              } catch (cause) {
                setCheckoutError(
                  cause instanceof Error ? cause.message : "支付窗口打开失败。",
                );
              }
            }}
          >
            <CircleDollarSign size={16} />
            继续支付
          </button>
        )}
      {!topup.checkout &&
        topup.method !== "bank_transfer" &&
        topup.status === "pending_payment" &&
        currentMethodConfigured && (
          <button
            type="button"
            className="primary-button topup-payment-link"
            disabled={submitting}
            onClick={() => void onSwitchMethod(topup.method)}
          >
            <CircleDollarSign size={16} />
            {submitting ? "正在准备收银台…" : "继续支付"}
          </button>
        )}
      {["unconfigured", "pending_payment"].includes(topup.status) && (
        <div className="topup-switch-methods">
          <span>切换支付方式</span>
          {methods
            .filter((item) => item.id !== topup.method && item.configured)
            .map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={submitting}
                onClick={() => void onSwitchMethod(item.id)}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {checkoutError && (
        <p className="form-error" role="alert">
          {checkoutError}
        </p>
      )}
      {["expired", "cancelled", "rejected"].includes(topup.status) && (
        <button
          type="button"
          className="primary-button topup-submit"
          onClick={onStartNewTopup}
        >
          新建充值
        </button>
      )}
      {topup.status === "paid" && (
        <button
          type="button"
          className="secondary-button topup-submit"
          onClick={onClose}
        >
          关闭
        </button>
      )}
    </div>
  );
}
