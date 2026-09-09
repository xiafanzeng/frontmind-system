import {
  AdminDisclosure,
  AdminRecordIdentity,
} from "@/components/AdminRecordPresentation";
import {
  Activity,
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Database,
  Eye,
  KeyRound,
  Landmark,
  Plus,
  RefreshCw,
  ServerCog,
  UsersRound,
} from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  formatCnyTenThousandths,
  sumMoneyTenThousandths,
  yuanInputToTenThousandths,
} from "../billingView";
import Modal from "../components/Modal";
import {
  formatDateTime,
  runStatusLabel,
  type ProviderModel,
  type RunStatus,
} from "../domain";

export type AdminUser = {
  id: string;
  username: string;
  active: boolean;
  role: "user" | "admin";
  projects?: number;
  granted: number;
  reserved: number;
  consumed: number;
  balanceTenThousandths?: string;
  reservedTenThousandths?: string;
  totalSpentTenThousandths?: string;
  mediaBalanceTenThousandths?: string;
  mediaReservedTenThousandths?: string;
  mediaFrozenTenThousandths?: string;
  mediaSpentTenThousandths?: string;
  lastSeenAt?: string;
};

export type AdminWalletScope = "monitoring" | "media_publishing";

export type AdminBankTransfer = {
  id: string;
  orderId: string;
  username: string;
  amountTenThousandths: string;
  payerName: string;
  transferredAt?: string;
  remittanceReference: string;
  status: "pending" | "approved" | "rejected";
  submittedAt?: string;
};

export type AdminRun = {
  id: string;
  userId?: string;
  username: string;
  monitorName: string;
  status: RunStatus;
  expected: number;
  completed: number;
  failed: number;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AdminRunFilters = {
  userId: string;
  status: string;
  from: string;
  to: string;
};

export type AdminAuditFilters = {
  actorId: string;
  action: string;
  domain: string;
  from: string;
  to: string;
};

export type AdminRunSummary = {
  total: number;
  active: number;
  completed: number;
  attention: number;
};

export type AdminSection =
  | "accounts"
  | "models"
  | "operations"
  | "content-review"
  | "audit-log";

export type AdminAuditEntry = {
  id: string;
  actorId?: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetIdHash?: string;
  createdAt?: string;
};

type AdminPageProps = {
  titleInShell?: boolean;
  section?: AdminSection;
  error?: string;
  users: AdminUser[];
  models?: ProviderModel[];
  acceptancePanel?: ReactNode;
  runs?: AdminRun[];
  audit?: AdminAuditEntry[];
  auditHasMore?: boolean;
  auditLoading?: boolean;
  auditLoadingMore?: boolean;
  runsHasMore?: boolean;
  runsLoadingMore?: boolean;
  runSummary?: AdminRunSummary;
  runFilters?: AdminRunFilters;
  auditFilters?: AdminAuditFilters;
  bankTransfers?: AdminBankTransfer[];
  bankTransfersLoading?: boolean;
  walletScope?: AdminWalletScope;
  mediaWalletAvailable?: boolean;
  provider: {
    executionStatus?: "online" | "offline" | "never_started";
    heartbeatThresholdSeconds?: number;
    staleForSeconds?: number;
    enabledModels: number;
    discoveredModels: number;
    activeRuns: number;
    queueDepth: number;
    unknownSubmissions?: number;
    mediaFailures?: number;
    providerAuthStatus?: "healthy" | "unhealthy" | "unknown";
    recentErrors?: Array<{
      id: string;
      type: string;
      code: string;
      message: string;
      updatedAt: string;
    }>;
    oldestReadyAt?: string;
    latestHeartbeatAt?: string;
    observedAt?: string;
  };
  onCreateUser?: (input: {
    username: string;
    password: string;
    quota: number;
  }) => void | Promise<void>;
  onSetUserStatus?: (id: string, active: boolean) => void | Promise<void>;
  onAdjustBalance?: (
    walletScope: AdminWalletScope,
    id: string,
    amount: string,
    reason: string,
    idempotencyKey: string,
    publicationItemId?: string,
  ) => void | Promise<void>;
  onWalletScopeChange?: (scope: AdminWalletScope) => void;
  onReviewBankTransfer?: (
    reviewId: string,
    decision: "approve" | "reject",
    reason: string,
    providerTradeNo?: string,
  ) => void | Promise<void>;
  onResetPassword?: (id: string, password: string) => void | Promise<void>;
  onSyncModels?: () => void | Promise<void>;
  onUpdateModel?: (model: ProviderModel) => void | Promise<void>;
  onInspectRun?: (id: string) => void;
  onInspectExecution?: (id: string) => void;
  onRunFiltersChange?: (filters: AdminRunFilters) => void;
  onAuditFiltersChange?: (filters: AdminAuditFilters) => void;
  onLoadOlderRuns?: () => void | Promise<void>;
  onLoadOlderAudit?: () => void | Promise<void>;
};

const SECTION_COPY: Record<
  AdminSection,
  { title: string; description: string }
> = {
  accounts: {
    title: "账号与余额",
    description: "管理客户登录账号、人民币余额和企业转账审核。",
  },
  models: {
    title: "模型能力",
    description: "核验供应商模型能力，并控制客户可用范围。",
  },
  operations: {
    title: "任务运行",
    description: "查看本系统提交的运行、执行队列和供应商提交元数据。",
  },
  "content-review": {
    title: "内容查阅",
    description: "在客服、质量或合规排查时只读核验客户内容。",
  },
  "audit-log": {
    title: "操作记录",
    description: "追踪管理操作和敏感内容访问，记录保留 365 天。",
  },
};

const EMPTY_RUN_FILTERS: AdminRunFilters = {
  userId: "",
  status: "",
  from: "",
  to: "",
};

const EMPTY_AUDIT_FILTERS: AdminAuditFilters = {
  actorId: "",
  action: "",
  domain: "",
  from: "",
  to: "",
};

function compactIdentifier(value?: string) {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function addMoneyStrings(left?: string, right?: string) {
  return ((left ? BigInt(left) : 0n) + (right ? BigInt(right) : 0n)).toString();
}

function auditRoleLabel(role?: string) {
  if (role === "admin") return "管理员";
  if (role === "user") return "客户";
  return "系统";
}

const auditActionLabels: Record<string, string> = {
  "admin.password_reset": "重置客户密码",
  "auth.password_changed": "修改登录密码",
  "admin.user_created": "创建客户账号",
  "admin.user_active": "启用客户账号",
  "admin.user_disabled": "停用客户账号",
  "admin.quota_adjusted": "历史使用量调整",
  "admin.balance_adjusted": "调整客户余额",
  "admin.bank_transfer_approved": "批准企业转账",
  "admin.bank_transfer_rejected": "驳回企业转账",
  "admin.platform_upserted": "更新模型能力",
  "admin.platform_sync_requested": "同步模型目录",
  "admin.content_viewed": "查阅客户内容",
  "admin.media_viewed": "查看客户媒体",
  "admin.run_exported": "导出运行结果",
  "admin.user.status.set": "变更账号状态",
  "project.created": "创建项目",
  "project.updated": "更新项目",
  "project.deleted": "删除项目",
  "project.restored": "恢复项目",
  "monitor.created": "创建问题监控",
  "monitor.version_created": "更新问题监控配置",
  "monitor.paused": "暂停问题监控",
  "monitor.resumed": "启用问题监控",
  "monitor.deleted": "删除问题监控",
  "monitor.restored": "恢复问题监控",
  "run.cancel_requested": "申请停止运行",
  "run.deleted": "删除运行",
  "run.restored": "恢复运行",
  "publisher.provider_price_mismatch_detected": "供应商订单价与客户快照不一致",
  "admin.publisher_customer_compensated": "补偿已消费媒体发布项目",
};

const auditTargetLabels: Record<string, string> = {
  user: "客户账号",
  platform: "模型",
  run: "运行",
  attempt: "供应商提交",
  media: "媒体文件",
  monitor: "问题监控",
  project: "项目",
  provider: "供应商",
  bank_transfer_review: "企业转账审核",
  billing_account: "资金账户",
  publication_item: "媒体发布项目",
  publisher_runtime: "媒体发布运行门禁",
  publisher_media: "媒体目录资源",
};

const jobTypeLabels: Record<string, string> = {
  submit_attempt: "提交问题",
  fetch_result: "获取结果",
  stop_attempt: "停止提交",
  poll_attempt: "轮询结果",
  sync_provider_catalog: "同步模型目录",
  archive_media: "归档媒体",
  schedule_catch_up: "补齐计划运行",
  dispatch_occurrences: "派发计划运行",
  purge_soft_deleted: "清理已删除数据",
  reconcile_billing: "核对供应商账单",
};

export function auditActionLabel(value: string) {
  return auditActionLabels[value] || "其他操作";
}

export function auditTargetLabel(value: string) {
  return auditTargetLabels[value] || "其他对象";
}

export function jobTypeLabel(value: string) {
  return jobTypeLabels[value] || "后台任务";
}

function executionStatusLabel(
  status: AdminPageProps["provider"]["executionStatus"],
) {
  if (status === "online") return "在线";
  if (status === "offline") return "离线";
  return "从未启动";
}

export default function AdminPage({
  titleInShell = false,
  section = "accounts",
  error,
  users,
  models = [],
  acceptancePanel,
  runs = [],
  audit = [],
  auditHasMore = false,
  auditLoading = false,
  auditLoadingMore = false,
  runsHasMore = false,
  runsLoadingMore = false,
  runSummary,
  runFilters = EMPTY_RUN_FILTERS,
  auditFilters = EMPTY_AUDIT_FILTERS,
  bankTransfers = [],
  bankTransfersLoading = false,
  walletScope = "monitoring",
  mediaWalletAvailable = false,
  provider,
  onCreateUser,
  onSetUserStatus,
  onAdjustBalance,
  onWalletScopeChange,
  onReviewBankTransfer,
  onResetPassword,
  onSyncModels,
  onUpdateModel,
  onInspectRun,
  onInspectExecution,
  onRunFiltersChange,
  onAuditFiltersChange,
  onLoadOlderRuns,
  onLoadOlderAudit,
}: AdminPageProps) {
  const [modal, setModal] = useState<
    "create" | "balance" | "password" | "transfer-review" | null
  >(null);
  const [selectedUser, setSelectedUser] = useState<AdminUser>();
  const [selectedTransfer, setSelectedTransfer] = useState<AdminBankTransfer>();
  const [transferDecision, setTransferDecision] = useState<
    "approve" | "reject"
  >("approve");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const pendingModelIdsRef = useRef(new Set<string>());
  const [pendingModelIds, setPendingModelIds] = useState<string[]>([]);
  const sectionCopy = SECTION_COPY[section];
  const mediaWalletSelected = walletScope === "media_publishing";

  const withSubmit = async (operation: () => void | Promise<void>) => {
    setSubmitting(true);
    setActionError("");
    try {
      await operation();
      setModal(null);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "管理操作失败，请稍后重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };
  const runAction = async (operation: () => void | Promise<void>) => {
    setActionError("");
    try {
      await operation();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "管理操作失败，请稍后重试。",
      );
    }
  };
  const updateModel = async (model: ProviderModel) => {
    if (!onUpdateModel || pendingModelIdsRef.current.has(model.id)) return;
    pendingModelIdsRef.current.add(model.id);
    setPendingModelIds([...pendingModelIdsRef.current]);
    try {
      await runAction(() => onUpdateModel(model));
    } finally {
      pendingModelIdsRef.current.delete(model.id);
      setPendingModelIds([...pendingModelIdsRef.current]);
    }
  };
  return (
    <div className="page-content admin-page">
      {(error || actionError) && (
        <p className="form-error" role="alert">
          {error || actionError}
        </p>
      )}
      <section className="page-heading">
        <div>
          {titleInShell ? (
            <AdminDisclosure label="使用说明">
              {sectionCopy.description}
            </AdminDisclosure>
          ) : (
            <>
              <h1>{sectionCopy.title}</h1>
              <p>{sectionCopy.description}</p>
            </>
          )}
        </div>
        {section === "accounts" && (
          <button
            type="button"
            className="primary-button"
            onClick={() => window.location.assign("/admin/users")}
          >
            <Plus size={16} />
            管理统一账号
          </button>
        )}
      </section>
      {section === "accounts" && mediaWalletAvailable && (
        <div className="segmented-control" aria-label="选择客户资金钱包">
          <button
            type="button"
            className={walletScope === "monitoring" ? "active" : ""}
            aria-pressed={walletScope === "monitoring"}
            onClick={() => onWalletScopeChange?.("monitoring")}
          >
            问题监控钱包
          </button>
          <button
            type="button"
            className={mediaWalletSelected ? "active" : ""}
            aria-pressed={mediaWalletSelected}
            onClick={() => onWalletScopeChange?.("media_publishing")}
          >
            媒体发布钱包
          </button>
        </div>
      )}
      {section === "accounts" && (
        <section className="admin-health-grid account-metrics">
          <article>
            <span>
              <UsersRound size={16} />
              客户账号
            </span>
            <strong>
              {users.filter((user) => user.role === "user").length}
            </strong>
            <small>
              {
                users.filter((user) => user.role === "user" && user.active)
                  .length
              }{" "}
              个客户账号已启用
            </small>
          </article>
          <article>
            <span>
              <Banknote size={16} />
              客户余额
            </span>
            <strong>
              {formatCnyTenThousandths(
                sumMoneyTenThousandths(
                  users
                    .filter((user) => user.role === "user")
                    .map((user) =>
                      mediaWalletSelected
                        ? user.mediaBalanceTenThousandths
                        : user.balanceTenThousandths,
                    ),
                ),
              )}
            </strong>
            <small>
              所有客户{mediaWalletSelected ? "媒体发布" : "问题监控"}
              钱包可用余额
            </small>
          </article>
          <article>
            <span>冻结金额</span>
            <strong>
              {formatCnyTenThousandths(
                sumMoneyTenThousandths(
                  users
                    .filter((user) => user.role === "user")
                    .map((user) =>
                      mediaWalletSelected
                        ? addMoneyStrings(
                            user.mediaReservedTenThousandths,
                            user.mediaFrozenTenThousandths,
                          )
                        : user.reservedTenThousandths,
                    ),
                ),
              )}
            </strong>
            <small>
              {mediaWalletSelected
                ? "含发布预占与 UNKNOWN 待对账冻结"
                : "运行预估费用在完成结算前冻结"}
            </small>
          </article>
        </section>
      )}

      {section === "models" && (
        <section className="admin-health-grid model-metrics">
          <article>
            <span>
              <CheckCircle2 size={16} />
              已开放模型
            </span>
            <strong>{provider.enabledModels}</strong>
            <small>已验收并对客户开放</small>
          </article>
          <article>
            <span>已发现模型</span>
            <strong>{provider.discoveredModels}</strong>
            <small>新发现模型默认关闭</small>
          </article>
          <article>
            <span>待验收模型</span>
            <strong>{models.filter((model) => !model.verified).length}</strong>
            <small>依据真实运行结果更新能力</small>
          </article>
        </section>
      )}

      {section === "accounts" && (
        <section className="content-card admin-table-card">
          <div className="card-heading">
            <div>
              <h2>账号与统一余额</h2>
              <p>
                问题监控、媒体发布与智能体共用账户余额；每次资金操作必须填写原因。
              </p>
            </div>
          </div>
          <div
            className="admin-user-table"
            role="table"
            aria-label="账号与余额"
          >
            <div className="admin-user-head" role="row">
              <span role="columnheader">账号</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">角色</span>
              <span role="columnheader">可用余额</span>
              <span role="columnheader">冻结金额</span>
              <span role="columnheader">操作</span>
            </div>
            {users.length ? (
              users.map((user) => (
                <div className="admin-user-row" key={user.id} role="row">
                  <span data-label="账号" role="cell">
                    <strong>@{user.username}</strong>
                    <small>
                      {user.lastSeenAt
                        ? `最近登录 ${formatDateTime(user.lastSeenAt)}`
                        : "尚未登录"}
                    </small>
                  </span>
                  <span data-label="状态" role="cell">
                    <i
                      className={user.active ? "active" : "disabled"}
                      aria-hidden="true"
                    />
                    {user.active ? "已启用" : "已停用"}
                  </span>
                  <span data-label="角色" role="cell">
                    {user.role === "admin" ? "管理员" : "客户"}
                  </span>
                  <span data-label="可用余额" role="cell">
                    <strong>
                      {mediaWalletSelected
                        ? formatCnyTenThousandths(
                            user.mediaBalanceTenThousandths,
                          )
                        : formatCnyTenThousandths(user.balanceTenThousandths)}
                    </strong>
                  </span>
                  <span data-label="冻结金额" role="cell">
                    {mediaWalletSelected ? (
                      <>
                        <strong>
                          预占{" "}
                          {formatCnyTenThousandths(
                            user.mediaReservedTenThousandths,
                          )}
                        </strong>
                        <small>
                          待对账{" "}
                          {formatCnyTenThousandths(
                            user.mediaFrozenTenThousandths,
                          )}
                        </small>
                      </>
                    ) : (
                      formatCnyTenThousandths(user.reservedTenThousandths)
                    )}
                  </span>
                  <span
                    className="admin-row-buttons"
                    data-label="操作"
                    role="cell"
                  >
                    <button
                      type="button"
                      aria-label={
                        mediaWalletSelected
                          ? `调整 @${user.username} 的媒体发布钱包余额`
                          : `调整 @${user.username} 的余额`
                      }
                      disabled={!onAdjustBalance}
                      title={onAdjustBalance ? undefined : "余额服务暂不可用"}
                      onClick={() => {
                        setSelectedUser(user);
                        setModal("balance");
                      }}
                    >
                      调整余额
                    </button>
                    <button
                      type="button"
                      aria-label={`重置 @${user.username} 的密码`}
                      onClick={() => window.location.assign("/admin/users")}
                    >
                      账号管理
                    </button>
                    {onSetUserStatus && user.role !== "admin" && (
                      <button
                        type="button"
                        aria-label={`${user.active ? "停用" : "启用"} @${user.username}`}
                        onClick={() =>
                          void runAction(() =>
                            onSetUserStatus?.(user.id, !user.active),
                          )
                        }
                      >
                        {user.active ? "停用" : "启用"}
                      </button>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <div className="panel-state">
                <strong>尚无账号</strong>
              </div>
            )}
          </div>
        </section>
      )}

      {section === "accounts" && (
        <section className="content-card admin-table-card admin-transfer-card">
          <div className="card-heading">
            <div>
              <h2>企业转账审核</h2>
              <p>
                核对企业银行转账流水，批准后只计入
                {mediaWalletSelected ? "媒体发布" : "问题监控"}
                钱包；订单归属不可切换。
              </p>
            </div>
            {bankTransfersLoading && <span>正在刷新…</span>}
          </div>
          <div
            className="admin-transfer-table"
            role="table"
            aria-label="企业转账审核"
            aria-busy={bankTransfersLoading || undefined}
          >
            <div className="admin-transfer-head" role="row">
              <span role="columnheader">客户</span>
              <span role="columnheader">订单</span>
              <span role="columnheader">金额</span>
              <span role="columnheader">银行流水号</span>
              <span role="columnheader">提交时间</span>
              <span role="columnheader">操作</span>
            </div>
            {bankTransfers.length ? (
              bankTransfers.map((transfer) => (
                <div
                  className="admin-transfer-row"
                  key={transfer.id}
                  role="row"
                >
                  <span data-label="客户" role="cell">
                    <strong>@{transfer.username}</strong>
                    <small>付款方：{transfer.payerName}</small>
                  </span>
                  <span data-label="订单" role="cell" title={transfer.orderId}>
                    {compactIdentifier(transfer.orderId)}
                  </span>
                  <strong data-label="金额" role="cell">
                    {formatCnyTenThousandths(transfer.amountTenThousandths)}
                  </strong>
                  <span data-label="银行流水号" role="cell">
                    {transfer.remittanceReference}
                  </span>
                  <span data-label="提交时间" role="cell">
                    {formatDateTime(transfer.submittedAt)}
                    <small>
                      转账：{formatDateTime(transfer.transferredAt)}
                    </small>
                  </span>
                  <span
                    className="admin-row-buttons"
                    data-label="操作"
                    role="cell"
                  >
                    {transfer.status === "pending" ? (
                      <>
                        <button
                          type="button"
                          disabled={!onReviewBankTransfer}
                          onClick={() => {
                            setSelectedTransfer(transfer);
                            setTransferDecision("approve");
                            setModal("transfer-review");
                          }}
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={!onReviewBankTransfer}
                          onClick={() => {
                            setSelectedTransfer(transfer);
                            setTransferDecision("reject");
                            setModal("transfer-review");
                          }}
                        >
                          驳回
                        </button>
                      </>
                    ) : (
                      <span>
                        {transfer.status === "approved" ? "已批准" : "已驳回"}
                      </span>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <div className="panel-state">
                <Landmark size={28} />
                <strong>暂无待审核企业转账</strong>
              </div>
            )}
          </div>
        </section>
      )}

      {section === "models" && (
        <section className="content-card admin-model-card">
          <div className="card-heading">
            <div>
              <h2>模型目录与能力矩阵</h2>
              <p>
                同步后通过真实运行验收各项能力，系统依据结果更新能力，再由管理员开放模型。
              </p>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => onSyncModels && void runAction(onSyncModels)}
            >
              <RefreshCw size={15} />
              同步官方模型
            </button>
          </div>
          <div
            className="admin-model-table"
            role="table"
            aria-label="模型能力矩阵"
            tabIndex={0}
          >
            <div className="admin-model-head" role="row">
              <span role="columnheader">模型</span>
              <span role="columnheader">客户端</span>
              <span role="columnheader">验收</span>
              <span role="columnheader">能力矩阵</span>
              <span role="columnheader">区域</span>
              <span role="columnheader">开放状态</span>
            </div>
            {models.map((model) => {
              const modelPending = pendingModelIds.includes(model.id);
              return (
                <div
                  className={`admin-model-row ${modelPending ? "pending" : ""}`}
                  key={model.id}
                  aria-busy={modelPending}
                  role="row"
                >
                  <strong role="cell">
                    {model.name}
                    <small>{model.code}</small>
                  </strong>
                  <span role="cell">
                    <button
                      type="button"
                      className="capability-chip on"
                      disabled={modelPending || model.acceptanceRequired}
                      aria-label={`${model.name}客户端类型：${model.clientType === "web" ? "网页版" : "手机版"}`}
                      title="客户端类型来自同步目录"
                      onClick={() =>
                        void updateModel({
                          ...model,
                          clientType:
                            model.clientType === "web" ? "mobile" : "web",
                          capabilities:
                            model.clientType === "web"
                              ? {
                                  ...model.capabilities,
                                  region: false,
                                  overseas: false,
                                }
                              : model.capabilities,
                        })
                      }
                    >
                      {model.clientType === "web" ? "网页版" : "手机版"}
                    </button>
                  </span>
                  <span role="cell">
                    <button
                      type="button"
                      className={`capability-chip ${model.verified ? "on" : ""}`}
                      disabled={modelPending || model.acceptanceRequired}
                      aria-label={`${model.name}验收状态`}
                      aria-pressed={model.verified}
                      onClick={() =>
                        void updateModel({
                          ...model,
                          verified: !model.verified,
                          enabled: model.verified ? false : model.enabled,
                        })
                      }
                    >
                      {model.verified
                        ? "已验收"
                        : model.acceptance?.searchDefault === "running"
                          ? "验收中"
                          : "待验收"}
                    </button>
                  </span>
                  <span className="capability-actions" role="cell">
                    <button
                      type="button"
                      className={model.capabilities.reasoning ? "on" : ""}
                      disabled={modelPending || model.acceptanceRequired}
                      aria-label={`${model.name}思考能力`}
                      aria-pressed={model.capabilities.reasoning}
                      onClick={() =>
                        void updateModel({
                          ...model,
                          capabilities: {
                            ...model.capabilities,
                            reasoning: !model.capabilities.reasoning,
                          },
                        })
                      }
                    >
                      思考
                    </button>
                    {model.acceptanceRequired ? (
                      <>
                        <button
                          type="button"
                          className={
                            model.capabilities.screenshotMention ? "on" : ""
                          }
                          disabled
                          aria-label={`${model.name}提及时截图验收`}
                          aria-pressed={Boolean(
                            model.capabilities.screenshotMention,
                          )}
                        >
                          提及截图
                        </button>
                        <button
                          type="button"
                          className={
                            model.capabilities.screenshotAll ? "on" : ""
                          }
                          disabled
                          aria-label={`${model.name}全部截图验收`}
                          aria-pressed={Boolean(
                            model.capabilities.screenshotAll,
                          )}
                        >
                          全部截图
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={model.capabilities.screenshot ? "on" : ""}
                        disabled={modelPending}
                        aria-label={`${model.name}截图能力`}
                        aria-pressed={model.capabilities.screenshot}
                        onClick={() =>
                          void updateModel({
                            ...model,
                            capabilities: {
                              ...model.capabilities,
                              screenshot: !model.capabilities.screenshot,
                            },
                          })
                        }
                      >
                        截图
                      </button>
                    )}
                  </span>
                  <span className="capability-actions" role="cell">
                    <button
                      type="button"
                      className={model.capabilities.region ? "on" : ""}
                      disabled={
                        modelPending ||
                        model.clientType === "mobile" ||
                        model.acceptanceRequired
                      }
                      aria-label={`${model.name}国内区域能力`}
                      aria-pressed={model.capabilities.region}
                      onClick={() =>
                        void updateModel({
                          ...model,
                          capabilities: {
                            ...model.capabilities,
                            region: !model.capabilities.region,
                          },
                        })
                      }
                    >
                      国内
                    </button>
                    <button
                      type="button"
                      className={model.capabilities.overseas ? "on" : ""}
                      disabled={
                        modelPending ||
                        model.clientType === "mobile" ||
                        model.acceptanceRequired
                      }
                      aria-label={`${model.name}海外区域能力`}
                      aria-pressed={model.capabilities.overseas}
                      onClick={() =>
                        void updateModel({
                          ...model,
                          capabilities: {
                            ...model.capabilities,
                            overseas: !model.capabilities.overseas,
                          },
                        })
                      }
                    >
                      海外
                    </button>
                  </span>
                  <span role="cell">
                    <button
                      type="button"
                      className={`mini-toggle ${model.enabled && model.verified ? "on" : ""}`}
                      disabled={modelPending || !model.verified}
                      aria-label={`${model.name}开放状态`}
                      aria-pressed={model.enabled && model.verified}
                      onClick={() =>
                        void updateModel({ ...model, enabled: !model.enabled })
                      }
                    >
                      <i aria-hidden="true" />
                      {model.verified
                        ? model.enabled
                          ? "已开放"
                          : "已关闭"
                        : "先完成验收"}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {section === "models" && acceptancePanel}

      {section === "operations" && (
        <>
          <section className="admin-health-grid operations-metrics">
            <article>
              <span>
                <ServerCog size={16} />
                执行服务
              </span>
              <strong
                className={
                  provider.executionStatus === "online"
                    ? "healthy"
                    : "unhealthy"
                }
              >
                {executionStatusLabel(provider.executionStatus)}
              </strong>
              <small>
                {provider.latestHeartbeatAt
                  ? `最近心跳 ${formatDateTime(provider.latestHeartbeatAt)}`
                  : "尚未收到执行服务心跳"}
              </small>
            </article>
            <article>
              <span>
                <Database size={16} />
                队列积压
              </span>
              <strong>{provider.queueDepth}</strong>
              <small>
                {provider.oldestReadyAt
                  ? `最早 ${formatDateTime(provider.oldestReadyAt)}`
                  : "当前无等待任务"}
              </small>
            </article>
            <article>
              <span>
                <Activity size={16} />
                活动运行
              </span>
              <strong>{provider.activeRuns}</strong>
              <small>等待、执行中或需要复核</small>
            </article>
            <article>
              <span>
                <AlertTriangle size={16} />
                提交待确认
              </span>
              <strong>{provider.unknownSubmissions || 0}</strong>
              <small>
                尚未确认供应商是否受理 · 媒体归档失败{" "}
                {provider.mediaFailures || 0}
              </small>
            </article>
          </section>
          <section className="content-card admin-module operations-overview">
            <div className="module-icon">
              <Activity />
            </div>
            <h2>执行状态</h2>
            <p>
              持久队列、执行服务心跳、提交待确认和媒体归档失败均来自真实数据库状态。
            </p>
            <div
              className="observability-status-list"
              aria-label="运行状态判断"
            >
              <span
                className={
                  provider.executionStatus === "online"
                    ? "healthy"
                    : "unhealthy"
                }
              >
                <b>执行服务心跳</b>
                {provider.executionStatus === "online"
                  ? `心跳在 ${provider.heartbeatThresholdSeconds || 90} 秒有效窗口内`
                  : provider.executionStatus === "never_started"
                    ? "从未收到执行服务心跳"
                    : `已失联 ${provider.staleForSeconds || 0} 秒`}
              </span>
              <span
                className={
                  provider.providerAuthStatus === "unhealthy"
                    ? "unhealthy"
                    : provider.providerAuthStatus === "healthy"
                      ? "healthy"
                      : "unknown"
                }
              >
                <b>供应商认证</b>
                {provider.executionStatus !== "online"
                  ? "执行服务离线，暂无法判断"
                  : provider.providerAuthStatus === "unhealthy"
                    ? "近期不可恢复任务中存在认证错误"
                    : provider.providerAuthStatus === "healthy"
                      ? "近期未发现认证错误"
                      : "暂无法判断"}
              </span>
            </div>
            <small className="observability-observed-at">
              {provider.observedAt
                ? `观测刷新 ${formatDateTime(provider.observedAt)}`
                : "等待首次观测刷新"}
            </small>
            {provider.recentErrors?.length ? (
              <div className="dead-job-list">
                <h3>最近不可恢复任务</h3>
                {provider.recentErrors.map((item) => (
                  <article key={item.id}>
                    <strong>
                      {jobTypeLabel(item.type)} · {item.code}
                    </strong>
                    <span>{item.message}</span>
                    <small>{formatDateTime(item.updatedAt)}</small>
                  </article>
                ))}
              </div>
            ) : (
              <div className="compact-empty admin-compact-empty">
                没有不可恢复任务。
              </div>
            )}
          </section>
          <OperationsRunList
            users={users}
            runs={runs}
            filters={runFilters}
            summary={runSummary}
            hasMore={runsHasMore}
            loadingMore={runsLoadingMore}
            onFiltersChange={onRunFiltersChange}
            onInspect={onInspectExecution}
            onLoadMore={onLoadOlderRuns}
          />
        </>
      )}

      {section === "content-review" && (
        <OperationsRunList
          mode="content"
          users={users}
          runs={runs}
          filters={runFilters}
          summary={runSummary}
          hasMore={runsHasMore}
          loadingMore={runsLoadingMore}
          onFiltersChange={onRunFiltersChange}
          onInspect={onInspectRun}
          onLoadMore={onLoadOlderRuns}
        />
      )}

      {section === "audit-log" && (
        <section className="content-card">
          <div className="card-heading">
            <div>
              <h2>管理与访问记录</h2>
              <p aria-live="polite">
                记录保留 365
                天；不记录密码、供应商访问令牌或回答正文。当前已加载{" "}
                {audit.length} 条
                {auditLoading
                  ? "，正在读取操作记录。"
                  : auditHasMore
                    ? "。"
                    : "，已无更多记录。"}
              </p>
            </div>
            {auditHasMore && onLoadOlderAudit && (
              <button
                type="button"
                className="secondary-button"
                disabled={auditLoadingMore}
                onClick={() => void runAction(onLoadOlderAudit)}
              >
                {auditLoadingMore ? "正在加载…" : "加载更早"}
              </button>
            )}
          </div>
          <AdminAuditFiltersForm
            users={users}
            filters={auditFilters}
            onChange={onAuditFiltersChange}
          />
          <div className="audit-table" role="table" aria-label="操作记录">
            {audit.length ? (
              <>
                <div className="audit-table-head" role="row">
                  <span role="columnheader">时间</span>
                  <span role="columnheader">动作</span>
                  <span role="columnheader">操作者</span>
                  <span role="columnheader">目标</span>
                </div>
                {audit.map((entry) => (
                  <div className="audit-table-row" key={entry.id} role="row">
                    <span data-label="时间" role="cell">
                      {formatDateTime(entry.createdAt)}
                    </span>
                    <strong data-label="动作" role="cell">
                      {auditActionLabel(entry.action)}
                    </strong>
                    <span data-label="操作者" role="cell">
                      <b>{auditRoleLabel(entry.actorRole)}</b>
                      <small title={entry.actorId}>
                        {compactIdentifier(entry.actorId)}
                      </small>
                    </span>
                    <span data-label="目标" role="cell">
                      <b>{auditTargetLabel(entry.targetType)}</b>
                      <small title={entry.targetIdHash}>
                        {compactIdentifier(entry.targetIdHash)}
                      </small>
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <div className="panel-state">
                <strong>尚无操作记录</strong>
              </div>
            )}
          </div>
        </section>
      )}

      <Modal
        open={modal === "create"}
        onClose={() => setModal(null)}
        title="创建账号"
        description="管理员设置长期密码；密码不会在创建响应中回显。"
      >
        {actionError && (
          <p className="form-error modal-error" role="alert">
            {actionError}
          </p>
        )}
        <CreateUserForm
          submitting={submitting}
          onSubmit={(input) =>
            onCreateUser && withSubmit(() => onCreateUser(input))
          }
        />
      </Modal>
      <Modal
        open={modal === "balance"}
        onClose={() => setModal(null)}
        title={`调整 @${selectedUser?.username || ""} 的余额`}
        description={
          mediaWalletSelected
            ? "媒体发布仅允许对已消费发布项目做正向客户补偿，不能扣减或任意加款。"
            : "请输入人民币金额，负数表示扣减；每次调整都会记录原因。"
        }
      >
        {actionError && (
          <p className="form-error modal-error" role="alert">
            {actionError}
          </p>
        )}
        {selectedUser && (
          <BalanceAdjustmentForm
            userId={selectedUser.id}
            walletScope={walletScope}
            submitting={submitting}
            onSubmit={(amount, reason, idempotencyKey, publicationItemId) =>
              withSubmit(() =>
                onAdjustBalance?.(
                  walletScope,
                  selectedUser.id,
                  amount,
                  reason,
                  idempotencyKey,
                  publicationItemId,
                ),
              )
            }
          />
        )}
      </Modal>
      <Modal
        open={modal === "password"}
        onClose={() => setModal(null)}
        title={`重置 @${selectedUser?.username || ""} 的密码`}
        description="重置后该账号的全部会话立即撤销。"
      >
        {actionError && (
          <p className="form-error modal-error" role="alert">
            {actionError}
          </p>
        )}
        <PasswordResetForm
          submitting={submitting}
          onSubmit={(password) =>
            selectedUser &&
            withSubmit(() => onResetPassword?.(selectedUser.id, password))
          }
        />
      </Modal>
      <Modal
        open={modal === "transfer-review"}
        onClose={() => setModal(null)}
        title={`${transferDecision === "approve" ? "批准" : "驳回"}企业转账`}
        description={
          selectedTransfer
            ? `@${selectedTransfer.username} · ${formatCnyTenThousandths(selectedTransfer.amountTenThousandths)}`
            : undefined
        }
      >
        {actionError && (
          <p className="form-error modal-error" role="alert">
            {actionError}
          </p>
        )}
        {selectedTransfer && (
          <TransferReviewForm
            transfer={selectedTransfer}
            decision={transferDecision}
            submitting={submitting}
            onSubmit={(reason, providerTradeNo) =>
              withSubmit(() =>
                onReviewBankTransfer?.(
                  selectedTransfer.id,
                  transferDecision,
                  reason,
                  providerTradeNo,
                ),
              )
            }
          />
        )}
      </Modal>
    </div>
  );
}

function OperationsRunList({
  mode = "operations",
  users,
  runs,
  filters,
  summary,
  hasMore,
  loadingMore,
  onFiltersChange,
  onInspect,
  onLoadMore,
}: {
  mode?: "operations" | "content";
  users: AdminUser[];
  runs: AdminRun[];
  filters: AdminRunFilters;
  summary?: AdminRunSummary;
  hasMore: boolean;
  loadingMore: boolean;
  onFiltersChange?: (filters: AdminRunFilters) => void;
  onInspect?: (id: string) => void;
  onLoadMore?: () => void | Promise<void>;
}) {
  const updateFilter = (patch: Partial<AdminRunFilters>) =>
    onFiltersChange?.({ ...filters, ...patch });
  return (
    <section className="content-card admin-operations-card">
      <div className="card-heading">
        <div>
          <h2>
            {mode === "content" ? "回答与引用来源只读查阅" : "本系统任务"}
          </h2>
          <AdminDisclosure
            label={mode === "content" ? "查阅范围与操作记录" : "数据范围"}
          >
            {mode === "content"
              ? "仅用于客服、质量与合规排查；每次打开客户内容都会写入操作记录。"
              : "这里只展示本系统所有用户创建的任务，不包含使用同一供应商凭证从其他系统提交的任务。"}
          </AdminDisclosure>
        </div>
        {summary && (
          <div className="admin-inline-summary" aria-label="运行汇总">
            <span>共 {summary.total}</span>
            <span>活动 {summary.active}</span>
            <span>需关注 {summary.attention}</span>
          </div>
        )}
      </div>
      <div className="admin-filter-bar" aria-label="筛选任务运行">
        <label>
          <span>用户</span>
          <select
            aria-label="按用户筛选任务运行"
            value={filters.userId}
            onChange={(event) => updateFilter({ userId: event.target.value })}
          >
            <option value="">全部用户</option>
            {users
              .filter((user) => user.role === "user")
              .map((user) => (
                <option key={user.id} value={user.id}>
                  @{user.username}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            aria-label="按状态筛选任务运行"
            value={filters.status}
            onChange={(event) => updateFilter({ status: event.target.value })}
          >
            <option value="">全部状态</option>
            <option value="queued">等待执行</option>
            <option value="waiting_quota">等待余额</option>
            <option value="running">执行中</option>
            <option value="completed">已完成</option>
            <option value="partial_completed">部分完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
            <option value="review_required">需要复核</option>
          </select>
        </label>
        <label>
          <span>开始日期</span>
          <input
            type="date"
            aria-label="任务运行开始日期"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(event) => updateFilter({ from: event.target.value })}
          />
        </label>
        <label>
          <span>结束日期</span>
          <input
            type="date"
            aria-label="任务运行结束日期"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(event) => updateFilter({ to: event.target.value })}
          />
        </label>
        {(filters.userId || filters.status || filters.from || filters.to) && (
          <button
            type="button"
            className="text-button"
            onClick={() => onFiltersChange?.(EMPTY_RUN_FILTERS)}
          >
            清除筛选
          </button>
        )}
      </div>
      <div
        className="admin-run-table operations-run-table"
        role="table"
        aria-label="任务运行"
      >
        <div className="admin-run-head" role="row">
          <span role="columnheader">运行</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">执行进度</span>
          <span role="columnheader">操作</span>
        </div>
        {runs.length ? (
          runs.map((run) => (
            <div key={run.id} role="row">
              <span data-label="运行" role="cell">
                <AdminRecordIdentity
                  name={run.monitorName}
                  account={run.username}
                />
                <small>{formatDateTime(run.createdAt)}</small>
              </span>
              <span data-label="状态" role="cell">
                <i className={`status-chip ${run.status}`}>
                  {runStatusLabel(run.status)}
                </i>
              </span>
              <span data-label="执行进度" role="cell">
                成功 {run.completed} · 失败 {run.failed} · 总计 {run.expected}
              </span>
              <span data-label="操作" role="cell">
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={
                    mode === "content"
                      ? `查阅 @${run.username} 的“${run.monitorName}”运行内容`
                      : undefined
                  }
                  onClick={() => onInspect?.(run.id)}
                >
                  {mode === "content" ? "查阅内容" : "查看执行详情"}
                </button>
              </span>
            </div>
          ))
        ) : (
          <div className="panel-state">
            <strong>
              {mode === "content" ? "尚无可查阅运行" : "没有符合筛选条件的运行"}
            </strong>
          </div>
        )}
      </div>
      {hasMore && onLoadMore && (
        <div className="admin-load-more">
          <button
            type="button"
            className="secondary-button"
            disabled={loadingMore}
            onClick={() => void onLoadMore()}
          >
            {loadingMore ? "正在加载…" : "加载更多运行"}
          </button>
        </div>
      )}
    </section>
  );
}

function AdminAuditFiltersForm({
  users,
  filters,
  onChange,
}: {
  users: AdminUser[];
  filters: AdminAuditFilters;
  onChange?: (filters: AdminAuditFilters) => void;
}) {
  const updateFilter = (patch: Partial<AdminAuditFilters>) =>
    onChange?.({ ...filters, ...patch });
  return (
    <div className="admin-filter-bar" aria-label="筛选操作记录">
      <label>
        <span>操作者</span>
        <select
          aria-label="按操作者筛选操作记录"
          value={filters.actorId}
          onChange={(event) => updateFilter({ actorId: event.target.value })}
        >
          <option value="">全部操作者</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              @{user.username}（{user.role === "admin" ? "管理员" : "客户"}）
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>业务领域</span>
        <select
          aria-label="按业务领域筛选操作记录"
          value={filters.domain}
          onChange={(event) => updateFilter({ domain: event.target.value })}
        >
          <option value="">全部领域</option>
          <option value="monitoring">问题监控</option>
          <option value="media_publishing">媒体发布</option>
        </select>
      </label>
      <label>
        <span>操作类型</span>
        <select
          aria-label="按操作类型筛选操作记录"
          value={filters.action}
          onChange={(event) => updateFilter({ action: event.target.value })}
        >
          <option value="">全部操作</option>
          {Object.entries(auditActionLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>开始日期</span>
        <input
          type="date"
          aria-label="操作记录开始日期"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(event) => updateFilter({ from: event.target.value })}
        />
      </label>
      <label>
        <span>结束日期</span>
        <input
          type="date"
          aria-label="操作记录结束日期"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(event) => updateFilter({ to: event.target.value })}
        />
      </label>
      {(filters.actorId ||
        filters.action ||
        filters.domain ||
        filters.from ||
        filters.to) && (
        <button
          type="button"
          className="text-button"
          onClick={() => onChange?.(EMPTY_AUDIT_FILTERS)}
        >
          清除筛选
        </button>
      )}
    </div>
  );
}

function CreateUserForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (input: {
    username: string;
    password: string;
    quota: number;
  }) => void | Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="admin-action-form"
      aria-busy={submitting || undefined}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSubmit({ username: username.trim(), password, quota: 0 });
      }}
    >
      <label className="field">
        <span>用户名</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          minLength={3}
          required
        />
      </label>
      <label className="field">
        <span>长期密码</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={12}
          required
        />
      </label>
      <button type="submit" className="primary-button" disabled={submitting}>
        {submitting ? "正在创建…" : "创建账号"}
      </button>
    </form>
  );
}

function BalanceAdjustmentForm({
  userId,
  walletScope,
  submitting,
  onSubmit,
}: {
  userId: string;
  walletScope: AdminWalletScope;
  submitting: boolean;
  onSubmit: (
    amountTenThousandths: string,
    reason: string,
    idempotencyKey: string,
    publicationItemId?: string,
  ) => void | Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [publicationItemId, setPublicationItemId] = useState("");
  const [error, setError] = useState("");
  const submitInFlight = useRef(false);
  const intent = useRef<{ fingerprint: string; idempotencyKey: string } | null>(
    null,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || submitInFlight.current) return;
    const amountTenThousandths = yuanInputToTenThousandths(amount, {
      allowNegative: walletScope === "monitoring",
    });
    if (!amountTenThousandths || amountTenThousandths === "0") {
      setError("请输入非零人民币金额，最多保留两位小数。");
      return;
    }
    const normalizedItemId = publicationItemId.trim();
    if (walletScope === "media_publishing" && !normalizedItemId) {
      setError("媒体发布补偿必须填写已消费的发布项目 ID。");
      return;
    }
    const normalizedReason = reason.trim();
    setError("");
    const fingerprint = JSON.stringify([
      userId,
      amountTenThousandths,
      normalizedReason,
      walletScope,
      normalizedItemId,
    ]);
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = {
        fingerprint,
        idempotencyKey: `ui:${crypto.randomUUID()}`,
      };
    }
    submitInFlight.current = true;
    try {
      await onSubmit(
        amountTenThousandths,
        normalizedReason,
        intent.current.idempotencyKey,
        normalizedItemId || undefined,
      );
    } finally {
      submitInFlight.current = false;
    }
  };
  return (
    <form
      className="admin-action-form"
      aria-busy={submitting || undefined}
      onSubmit={(event: FormEvent) => void submit(event)}
    >
      <label className="field">
        <span>
          {walletScope === "media_publishing"
            ? "补偿金额（人民币，仅正数）"
            : "调整金额（人民币，负数为扣减）"}
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder={
            walletScope === "media_publishing"
              ? "例如 20.00"
              : "例如 500.00 或 -20.00"
          }
          required
        />
      </label>
      {walletScope === "media_publishing" ? (
        <label className="field">
          <span>已消费发布项目 ID</span>
          <input
            value={publicationItemId}
            onChange={(event) => setPublicationItemId(event.target.value)}
            placeholder="publication item UUID"
            required
          />
        </label>
      ) : null}
      <label className="field">
        <span>调整原因</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={3}
          maxLength={240}
          required
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={submitting}>
        写入资金明细
      </button>
    </form>
  );
}

function TransferReviewForm({
  transfer,
  decision,
  submitting,
  onSubmit,
}: {
  transfer: AdminBankTransfer;
  decision: "approve" | "reject";
  submitting: boolean;
  onSubmit: (reason: string, providerTradeNo?: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [providerTradeNo, setProviderTradeNo] = useState("");
  return (
    <form
      className="admin-action-form transfer-review-form"
      aria-busy={submitting || undefined}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSubmit(reason.trim(), providerTradeNo.trim() || undefined);
      }}
    >
      <dl className="transfer-review-summary">
        <div>
          <dt>订单编号</dt>
          <dd>{transfer.orderId}</dd>
        </div>
        <div>
          <dt>银行流水号</dt>
          <dd>{transfer.remittanceReference}</dd>
        </div>
        <div>
          <dt>付款方</dt>
          <dd>{transfer.payerName}</dd>
        </div>
        <div>
          <dt>实际转账时间</dt>
          <dd>{formatDateTime(transfer.transferredAt)}</dd>
        </div>
      </dl>
      {decision === "approve" && (
        <label className="field">
          <span>银行入账流水号</span>
          <input
            value={providerTradeNo}
            onChange={(event) => setProviderTradeNo(event.target.value)}
            minLength={3}
            maxLength={191}
            required
          />
        </label>
      )}
      <label className="field">
        <span>审核说明</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={3}
          maxLength={240}
          placeholder={
            decision === "approve" ? "例如：已核对到账" : "请说明驳回原因"
          }
          required
        />
      </label>
      <button
        type="submit"
        className={`primary-button ${decision === "reject" ? "danger-button" : ""}`}
        disabled={submitting}
      >
        {submitting
          ? "正在提交…"
          : decision === "approve"
            ? "确认批准并入账"
            : "确认驳回"}
      </button>
    </form>
  );
}

function PasswordResetForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (password: string) => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="admin-action-form"
      aria-busy={submitting || undefined}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSubmit(password);
      }}
    >
      <label className="field">
        <span>新长期密码</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={12}
          required
        />
      </label>
      <button type="submit" className="primary-button" disabled={submitting}>
        <KeyRound size={15} />
        重置密码
      </button>
    </form>
  );
}
