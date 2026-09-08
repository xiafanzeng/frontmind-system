import type { AppRouter } from "@frontmind/monitoring-api";
import type { inferRouterOutputs } from "@trpc/server";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { trpc } from "../../../trpc";
import "../publishing.tokens.css";
import "../publishing.core.css";
import "../publishing.workflow.css";
import "../publishing.admin.css";
import {
  MediaMark,
  PublishingConfirmDialog,
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import { formatPublishingMoney, publishingDateTime } from "../types";

type PublisherAdminOutputs = inferRouterOutputs<AppRouter>["publisherAdmin"];
type RuntimeView = PublisherAdminOutputs["runtime"];
type CatalogRunView = PublisherAdminOutputs["catalogRuns"][number];
type CapabilityView = PublisherAdminOutputs["capabilities"][number];
type UnknownItemView = PublisherAdminOutputs["unknownItems"][number];

export type PublishingAdminSection =
  "integration" | "catalog" | "capabilities" | "reconciliation";

type PendingAction =
  | {
      kind: "runtime";
      title: string;
      description: string;
      update: {
        mode?: "mock" | "test" | "live";
        featureEnabled?: boolean;
        publishEnabled?: boolean;
        imagePublishEnabled?: boolean;
        webhookEnabled?: boolean;
        emergencyStop?: boolean;
      };
    }
  | {
      kind: "capability";
      title: string;
      description: string;
      mediaResourceId: string;
      imageSupport: "verified" | "unsupported";
    }
  | {
      kind: "whitelist";
      title: string;
      description: string;
      mediaResourceId: string;
      enabled: boolean;
      imageAllowed: boolean;
    }
  | {
      kind: "bind";
      title: string;
      description: string;
      itemId: string;
      candidateId: string;
    }
  | {
      kind: "resubmit";
      title: string;
      description: string;
      itemId: string;
    };

const sectionCopy: Record<
  PublishingAdminSection,
  { title: string; description: string }
> = {
  integration: {
    title: "媒体发布集成",
    description: "检查服务端凭据、运行模式、全局门禁与紧急停止状态。",
  },
  catalog: {
    title: "媒体目录同步",
    description: "查看完整目录同步、原子激活结果与当前新鲜度。",
  },
  capabilities: {
    title: "图文能力证据",
    description: "逐家保存图片发布证据；未验证媒体不能进入图片 LIVE。",
  },
  reconciliation: {
    title: "UNKNOWN 对账",
    description: "人工核对可能越过发送边界的订单，候选不会自动绑定。",
  },
};

export default function PublishingAdminLivePage({
  section,
}: {
  section: PublishingAdminSection;
}) {
  const utils = trpc.useUtils();
  const [activeSyncRunId, setActiveSyncRunId] = useState<string>();
  const runtimeQuery = trpc.publisherAdmin.runtime.useQuery(undefined, {
    enabled: section === "integration" || section === "catalog",
  });
  const catalogRunsQuery = trpc.publisherAdmin.catalogRuns.useQuery(
    { limit: 50 },
    {
      enabled: section === "catalog",
      refetchInterval: (query) =>
        activeSyncRunId || query.state.data?.some((run) => run.status === "running")
          ? 5_000
          : 30_000,
    },
  );
  const capabilitiesQuery = trpc.publisherAdmin.capabilities.useQuery(
    { limit: 100 },
    { enabled: section === "capabilities" },
  );
  const unknownItemsQuery = trpc.publisherAdmin.unknownItems.useQuery(
    { limit: 100 },
    { enabled: section === "reconciliation" },
  );
  const updateRuntime = trpc.publisherAdmin.updateRuntime.useMutation();
  const emergencyStop = trpc.publisherAdmin.emergencyStop.useMutation();
  const requestCatalogSync =
    trpc.publisherAdmin.requestCatalogSync.useMutation();
  const setCapability = trpc.publisherAdmin.setCapability.useMutation();
  const setLiveWhitelist = trpc.publisherAdmin.setLiveWhitelist.useMutation();
  const bindUnknown = trpc.publisherAdmin.bindUnknown.useMutation();
  const authorizeResubmit = trpc.publisherAdmin.authorizeResubmit.useMutation();
  const [pending, setPending] = useState<PendingAction>();
  const [reason, setReason] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [verified, setVerified] = useState(false);
  const [operationError, setOperationError] = useState("");
  const syncing =
    requestCatalogSync.isPending ||
    Boolean(activeSyncRunId) ||
    Boolean(catalogRunsQuery.data?.some((run) => run.status === "running"));
  const copy = sectionCopy[section];
  const busy =
    updateRuntime.isPending ||
    emergencyStop.isPending ||
    setCapability.isPending ||
    setLiveWhitelist.isPending ||
    bindUnknown.isPending ||
    authorizeResubmit.isPending;
  const activeQueries =
    section === "integration"
      ? [runtimeQuery]
      : section === "catalog"
        ? [runtimeQuery, catalogRunsQuery]
        : section === "capabilities"
          ? [capabilitiesQuery]
          : [unknownItemsQuery];
  const queryError = activeQueries.map((query) => query.error).find(Boolean);
  const loading = activeQueries.some((query) => query.isPending);
  const confirmDisabled =
    !pending ||
    reason.trim().length < 3 ||
    !verified ||
    (pending.kind === "capability" &&
      pending.imageSupport === "verified" &&
      !isHttpsUrl(evidenceUrl));

  useEffect(() => {
    if (!activeSyncRunId) return;
    const run = catalogRunsQuery.data?.find(
      (candidate) => candidate.id === activeSyncRunId,
    );
    if (!run || run.status === "running") return;
    setActiveSyncRunId(undefined);
    void runtimeQuery.refetch();
  }, [activeSyncRunId, catalogRunsQuery.data, runtimeQuery]);

  const openAction = (action: PendingAction) => {
    setOperationError("");
    setReason("");
    setEvidenceUrl("");
    setVerified(false);
    setPending(action);
  };

  const completeAction = async () => {
    if (!pending || confirmDisabled) return;
    setOperationError("");
    try {
      if (pending.kind === "runtime") {
        if (pending.update.emergencyStop !== undefined) {
          await emergencyStop.mutateAsync({
            enabled: pending.update.emergencyStop,
            reason: reason.trim(),
          });
        } else {
          await updateRuntime.mutateAsync(pending.update);
        }
      } else if (pending.kind === "capability") {
        await setCapability.mutateAsync({
          mediaResourceId: pending.mediaResourceId,
          imageSupport: pending.imageSupport,
          contentProfile:
            pending.imageSupport === "verified"
              ? "image_verified"
              : "text_only",
          evidenceUrl:
            pending.imageSupport === "verified" ? evidenceUrl.trim() : null,
          notes: reason.trim(),
        });
      } else if (pending.kind === "whitelist") {
        await setLiveWhitelist.mutateAsync({
          mediaResourceId: pending.mediaResourceId,
          enabled: pending.enabled,
          imageAllowed: pending.imageAllowed,
          reason: reason.trim(),
        });
      } else if (pending.kind === "bind") {
        await bindUnknown.mutateAsync({
          itemId: pending.itemId,
          candidateId: pending.candidateId,
          reason: reason.trim(),
        });
      } else {
        await authorizeResubmit.mutateAsync({
          itemId: pending.itemId,
          reason: reason.trim(),
        });
      }
      await utils.publisherAdmin.invalidate();
      setPending(undefined);
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : "操作失败，请重新核验证据。",
      );
    }
  };

  const syncCatalog = async () => {
    if (syncing) return;
    setOperationError("");
    try {
      const result = await requestCatalogSync.mutateAsync();
      setActiveSyncRunId(result.syncRunId);
      await utils.publisherAdmin.catalogRuns.invalidate();
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : "目录同步请求失败。",
      );
    }
  };

  return (
    <PublishingPage
      title={copy.title}
      description={copy.description}
      busy={busy}
    >
      {loading ? <PublishingLoading label="正在读取媒体发布管理状态…" /> : null}
      {queryError ? (
        <PublishingError
          error={new Error(queryError.message)}
          onRetry={() => void utils.publisherAdmin.invalidate()}
        />
      ) : null}
      {operationError ? (
        <p className="publishing-form-error" role="alert">
          {operationError}
        </p>
      ) : null}

      {section === "integration" && runtimeQuery.data ? (
        <IntegrationSection
          runtime={runtimeQuery.data}
          busy={busy}
          onAction={openAction}
        />
      ) : null}
      {section === "catalog" && runtimeQuery.data && catalogRunsQuery.data ? (
        <CatalogSection
          runtime={runtimeQuery.data}
          runs={catalogRunsQuery.data}
          syncing={syncing}
          onSync={() => void syncCatalog()}
        />
      ) : null}
      {section === "capabilities" && capabilitiesQuery.data ? (
        <CapabilitiesSection
          items={capabilitiesQuery.data}
          busy={busy}
          onAction={openAction}
        />
      ) : null}
      {section === "reconciliation" && unknownItemsQuery.data ? (
        <ReconciliationSection
          items={unknownItemsQuery.data}
          busy={busy}
          onAction={openAction}
        />
      ) : null}

      <PublishingConfirmDialog
        open={Boolean(pending)}
        title={pending?.title ?? "确认敏感操作"}
        description={pending?.description ?? "请核验证据后继续。"}
        confirmLabel="确认并写入审计记录"
        busy={busy}
        confirmDisabled={confirmDisabled}
        onCancel={() => !busy && setPending(undefined)}
        onConfirm={() => void completeAction()}
      >
        <label className="publishing-title-field">
          <span>核验说明</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={240}
            placeholder="说明核验依据和操作原因（至少 3 个字符）"
          />
        </label>
        {pending?.kind === "capability" &&
        pending.imageSupport === "verified" ? (
          <label className="publishing-title-field">
            <span>最终发布证据 HTTPS 地址</span>
            <input
              type="url"
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
        ) : null}
        <label className="publishing-acknowledgement">
          <input
            type="checkbox"
            checked={verified}
            onChange={(event) => setVerified(event.target.checked)}
          />
          <span>
            我已在供应商后台或最终发布页核验，不会依赖候选自动匹配；此操作会写入高风险审计。
          </span>
        </label>
      </PublishingConfirmDialog>
    </PublishingPage>
  );
}

export function IntegrationSection({
  runtime,
  busy,
  onAction,
}: {
  runtime: RuntimeView;
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  const [selectedMode, setSelectedMode] = useState<RuntimeView["mode"]>(
    runtime.mode,
  );
  useEffect(() => setSelectedMode(runtime.mode), [runtime.mode]);
  if (!runtime) return null;
  const catalogFresh =
    runtime.catalogSyncedAt &&
    Date.now() - new Date(runtime.catalogSyncedAt).getTime() <=
      12 * 60 * 60_000;
  const gates = [
    ["环境客户入口", runtime.environmentEnabled],
    ["环境真实模式", runtime.environmentRealEnabled],
    ["环境供应商 POST", runtime.environmentPublishEnabled],
    ["环境图片发布", runtime.environmentImageEnabled],
    ["环境公开资产", runtime.environmentPublicAssetsEnabled],
    ["环境 Webhook 验签", runtime.environmentWebhookEnabled],
    ["数据库客户入口", runtime.databaseFeatureEnabled],
    ["客户入口双门禁", runtime.featureEnabled],
    ["数据库发布门禁", runtime.publishEnabled],
    ["数据库图片门禁", runtime.imagePublishEnabled],
    ["Webhook 双门禁", runtime.webhookEnabled],
    ["供应商凭据健康", runtime.credentialStatus === "healthy"],
    ["目录新鲜度", Boolean(catalogFresh)],
    ["紧急停止未启用", !runtime.emergencyStop],
  ] as const;
  return (
    <>
      <section className="publishing-admin-health-grid">
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.credentialStatus === "healthy" ? "is-success" : "is-warning"}`}
          >
            <KeyRound size={21} />
          </span>
          <div>
            <p>凭据健康</p>
            <strong>{credentialLabel(runtime.credentialStatus)}</strong>
            <small>
              {runtime.credentialVerifiedAt
                ? `验证于 ${publishingDateTime(runtime.credentialVerifiedAt)}`
                : "仅 Worker 环境可访问"}
            </small>
          </div>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.mode === "live" ? "is-warning" : ""}`}
          >
            <PlayCircle size={21} />
          </span>
          <div>
            <p>服务端运行模式</p>
            <strong>{runtime.mode.toUpperCase()}</strong>
            <small>客户浏览器不能选择运行模式</small>
          </div>
          <div className="publishing-admin-mode-control">
            <label>
              <span className="publishing-visually-hidden">
                选择服务端运行模式
              </span>
              <select
                value={selectedMode}
                onChange={(event) =>
                  setSelectedMode(event.target.value as RuntimeView["mode"])
                }
                disabled={busy}
              >
                <option value="mock">MOCK</option>
                <option value="test">TEST</option>
                <option value="live">LIVE</option>
              </select>
            </label>
            <button
              type="button"
              disabled={busy || selectedMode === runtime.mode}
              onClick={() =>
                onAction({
                  kind: "runtime",
                  title: `切换为 ${selectedMode.toUpperCase()} 运行模式`,
                  description:
                    selectedMode === "live"
                      ? "LIVE 仍须通过环境、数据库、凭据、目录、白名单、价格、图文证据和 canary 约束。"
                      : "模式由服务端保存，客户浏览器不会获得模式参数。",
                  update: { mode: selectedMode },
                })
              }
            >
              应用模式
            </button>
          </div>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.publishEnabled ? "is-success" : ""}`}
          >
            <PlayCircle size={21} />
          </span>
          <div>
            <p>数据库发布门禁</p>
            <strong>{runtime.publishEnabled ? "已开启" : "已关闭"}</strong>
            <small>
              当前模式 {runtime.mode.toUpperCase()} · 环境 POST{" "}
              {runtime.environmentPublishEnabled ? "已开" : "已关"}
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAction({
                kind: "runtime",
                title: runtime.publishEnabled
                  ? "关闭数据库发布门禁"
                  : "开启数据库发布门禁",
                description:
                  "该门禁仍受环境硬开关、白名单、凭据和目录新鲜度约束。",
                update: { publishEnabled: !runtime.publishEnabled },
              })
            }
          >
            {runtime.publishEnabled ? (
              <PauseCircle size={16} />
            ) : (
              <PlayCircle size={16} />
            )}
            {runtime.publishEnabled ? "关闭" : "开启"}
          </button>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.imagePublishEnabled ? "is-success" : ""}`}
          >
            <ImageIcon size={21} />
          </span>
          <div>
            <p>数据库图片门禁</p>
            <strong>{runtime.imagePublishEnabled ? "已开启" : "已关闭"}</strong>
            <small>
              环境图片 {runtime.environmentImageEnabled ? "已开" : "已关"} ·
              开启前要求真实图文 canary
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAction({
                kind: "runtime",
                title: runtime.imagePublishEnabled
                  ? "关闭图片发布门禁"
                  : "开启图片发布门禁",
                description:
                  "开启后仍逐项检查媒体能力证据、LIVE 白名单和冻结图片资产；未满足 canary 证据时服务端会拒绝。",
                update: { imagePublishEnabled: !runtime.imagePublishEnabled },
              })
            }
          >
            {runtime.imagePublishEnabled ? (
              <PauseCircle size={16} />
            ) : (
              <ImageIcon size={16} />
            )}
            {runtime.imagePublishEnabled ? "关闭" : "开启"}
          </button>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.webhookEnabled ? "is-success" : ""}`}
          >
            <RefreshCw size={21} />
          </span>
          <div>
            <p>Webhook 双门禁</p>
            <strong>{runtime.webhookEnabled ? "已开启" : "已关闭"}</strong>
            <small>
              环境验签 {runtime.environmentWebhookEnabled ? "已开" : "已关"} ·
              回调只作唤醒
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAction({
                kind: "runtime",
                title: runtime.webhookEnabled
                  ? "关闭 Webhook 门禁"
                  : "开启 Webhook 门禁",
                description:
                  "只有环境验签开关和数据库门禁同时开启时回调才可用；回调不会直接写终态。",
                update: { webhookEnabled: !runtime.webhookEnabled },
              })
            }
          >
            {runtime.webhookEnabled ? (
              <PauseCircle size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            {runtime.webhookEnabled ? "关闭" : "开启"}
          </button>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${runtime.emergencyStop ? "is-warning" : "is-success"}`}
          >
            <ShieldAlert size={21} />
          </span>
          <div>
            <p>紧急停止</p>
            <strong>{runtime.emergencyStop ? "已启用" : "未启用"}</strong>
            <small>已创建订单仍会继续权威轮询</small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAction({
                kind: "runtime",
                title: runtime.emergencyStop
                  ? "解除媒体发布紧急停止"
                  : "启用媒体发布紧急停止",
                description:
                  "只影响尚未发送的任务，不会撤回已创建的供应商订单。",
                update: { emergencyStop: !runtime.emergencyStop },
              })
            }
          >
            <ShieldAlert size={16} />
            {runtime.emergencyStop ? "解除" : "启用"}
          </button>
        </article>
      </section>
      <section className="publishing-panel publishing-admin-table">
        <header className="publishing-panel-heading">
          <div>
            <h2>运行门禁</h2>
            <p>显示服务端当前值，不使用前端推测或演示数据</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAction({
                kind: "runtime",
                title: runtime.databaseFeatureEnabled
                  ? "隐藏客户媒体发布入口"
                  : "开放客户媒体发布入口",
                description:
                  "此开关只控制数据库客户入口；真实 POST 仍需通过全部 LIVE 门禁。",
                update: { featureEnabled: !runtime.databaseFeatureEnabled },
              })
            }
          >
            {runtime.databaseFeatureEnabled ? "关闭客户入口" : "开放客户入口"}
          </button>
        </header>
        {gates.map(([gate, passed]) => (
          <div className="publishing-admin-row" key={gate}>
            <span>{gate}</span>
            <span
              className={`publishing-status ${passed ? "is-success" : "is-warning"}`}
            >
              {passed ? (
                <CheckCircle2 size={14} />
              ) : (
                <AlertTriangle size={14} />
              )}
              {passed ? "通过" : "未通过"}
            </span>
            <small>
              {runtime.catalogSyncedAt
                ? publishingDateTime(runtime.catalogSyncedAt)
                : "尚无目录证据"}
            </small>
          </div>
        ))}
      </section>
    </>
  );
}

function CatalogSection({
  runtime,
  runs,
  syncing,
  onSync,
}: {
  runtime: RuntimeView;
  runs: CatalogRunView[];
  syncing: boolean;
  onSync: () => void;
}) {
  const latest = runs[0];
  const activeCatalogRun = runs.find(
    (run) =>
      run.status === "success" &&
      run.catalogRevision === runtime.catalogRevision,
  );
  const running = runs.find((run) => run.status === "running");
  return (
    <>
      <section className="publishing-admin-health-grid">
        <article className="publishing-panel">
          <span className="publishing-admin-health-icon is-success">
            <Database size={21} />
          </span>
          <div>
            <p>激活目录</p>
            <strong>
              {activeCatalogRun?.recordsChanged.toLocaleString("zh-CN") ?? "0"}{" "}
              家媒体
            </strong>
            <small>{runtime.catalogRevision ?? "尚未激活"}</small>
          </div>
        </article>
        <article className="publishing-panel">
          <span
            className={`publishing-admin-health-icon ${latest?.status === "success" ? "is-success" : "is-warning"}`}
          >
            <CheckCircle2 size={21} />
          </span>
          <div>
            <p>最近完整同步</p>
            <strong>
              {runtime.catalogSyncedAt
                ? publishingDateTime(runtime.catalogSyncedAt)
                : "尚无"}
            </strong>
            <small>
              {latest?.isComplete
                ? "完整性检查已通过"
                : (latest?.stopReason ?? "等待完整目录")}
            </small>
          </div>
        </article>
        <article className="publishing-panel">
          <span className="publishing-admin-health-icon">
            <RefreshCw size={21} />
          </span>
          <div>
            <p>固定计划</p>
            <strong>02:00 · 10:00 · 18:00</strong>
            <small>Asia/Shanghai</small>
          </div>
          <button type="button" onClick={onSync} disabled={syncing}>
            {syncing ? (
              <LoaderCircle className="publishing-spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            立即同步
          </button>
        </article>
        {running ? (
          <article className="publishing-panel">
            <span className="publishing-admin-health-icon">
              <LoaderCircle className="publishing-spin" size={21} />
            </span>
            <div>
              <p>当前同步进度</p>
              <strong>
                {running.pagesFetched.toLocaleString("zh-CN")} /{" "}
                {running.pagesExpected
                  ? running.pagesExpected.toLocaleString("zh-CN")
                  : "?"}{" "}
                页
              </strong>
              <small>
                已读取 {running.recordsSeen.toLocaleString("zh-CN")} 条 · 软文{" "}
                {running.newsRecords.toLocaleString("zh-CN")} · 自媒体{" "}
                {running.selfMediaRecords.toLocaleString("zh-CN")}
              </small>
            </div>
          </article>
        ) : null}
      </section>
      <section className="publishing-panel publishing-admin-table">
        <header className="publishing-panel-heading">
          <div>
            <h2>同步记录</h2>
            <p>每 2.5 秒读取真实 staging 进度；完整校验通过后才原子激活</p>
          </div>
        </header>
        {runs.length ? (
          runs.map((run) => (
            <div
              className="publishing-admin-row publishing-catalog-run"
              key={run.id}
            >
              <span>
                <strong>{run.id}</strong>
                <small>{publishingDateTime(run.startedAt)}</small>
              </span>
              <span>
                <strong>
                  {run.pagesFetched.toLocaleString("zh-CN")} /{" "}
                  {run.pagesExpected
                    ? run.pagesExpected.toLocaleString("zh-CN")
                    : "?"}{" "}
                  页
                </strong>
                <small>
                  {run.recordsSeen.toLocaleString("zh-CN")} 条已读取
                </small>
              </span>
              <span>
                <strong>
                  软文 {run.newsRecords.toLocaleString("zh-CN")} · 自媒体{" "}
                  {run.selfMediaRecords.toLocaleString("zh-CN")}
                </strong>
                <small
                  className={
                    run.invalidRecords || run.duplicateRecords
                      ? "is-warning-text"
                      : undefined
                  }
                >
                  非法 {run.invalidRecords.toLocaleString("zh-CN")} · 重复{" "}
                  {run.duplicateRecords.toLocaleString("zh-CN")} · 跨类{" "}
                  {run.crossKindDuplicateRecords.toLocaleString("zh-CN")}
                </small>
              </span>
              <span>
                <strong>
                  真实 Logo{" "}
                  {(
                    run.logoProviderArchived +
                    run.logoIconArchived +
                    run.logoWebSearchVerifiedArchived +
                    run.logoManualVerifiedArchived
                  ).toLocaleString("zh-CN")}{" "}
                  · 覆盖率 {(run.logoRealCoverageBasisPoints / 100).toFixed(2)}%
                </strong>
                <small>
                  供应商 Logo {run.logoProviderArchived.toLocaleString("zh-CN")}{" "}
                  · 供应商 Icon {run.logoIconArchived.toLocaleString("zh-CN")} ·
                  站点 Favicon（非真实 Logo）{" "}
                  {run.logoSiteFaviconArchived.toLocaleString("zh-CN")}
                </small>
                <small>
                  名称检索已验证{" "}
                  {run.logoWebSearchVerifiedArchived.toLocaleString("zh-CN")} ·
                  人工已验证{" "}
                  {run.logoManualVerifiedArchived.toLocaleString("zh-CN")} ·
                  待人工核验 {run.logoPendingReview.toLocaleString("zh-CN")}
                </small>
                <small
                  className={
                    run.logoRealMissing ? "is-warning-text" : undefined
                  }
                >
                  真实缺口 {run.logoRealMissing.toLocaleString("zh-CN")} ·
                  本地占位 {run.logoGeneratedFallback.toLocaleString("zh-CN")} ·
                  待归档 {run.logoPending.toLocaleString("zh-CN")} · 明确缺失{" "}
                  {run.logoMissing.toLocaleString("zh-CN")} · 失败{" "}
                  {run.logoFailed.toLocaleString("zh-CN")}
                </small>
              </span>
              <span
                className={`publishing-status ${run.status === "success" ? "is-success" : run.status === "running" ? "is-neutral" : "is-warning"}`}
              >
                {run.status === "success"
                  ? "已完成"
                  : run.status === "running"
                    ? "同步中"
                    : run.status === "partial"
                      ? "不完整"
                      : "失败"}
              </span>
              {run.stopReason ? (
                <small className="publishing-catalog-stop-reason">
                  {run.stopReason}
                </small>
              ) : null}
            </div>
          ))
        ) : (
          <PublishingEmpty
            title="还没有目录同步记录"
            description="保持 LIVE 关闭，先执行一次完整目录同步。"
          />
        )}
      </section>
    </>
  );
}

export function CapabilitiesSection({
  items,
  busy,
  onAction,
}: {
  items: CapabilityView[];
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  return (
    <section className="publishing-panel publishing-admin-capabilities">
      <header className="publishing-panel-heading">
        <div>
          <h2>媒体图文证据</h2>
          <p>仅最终可访问的 HTTPS 发布页可作为支持图片证据</p>
        </div>
      </header>
      {items.length ? (
        items.map((media) => (
          <article key={media.mediaResourceId}>
            <span className="publishing-media-name">
              <MediaMark id={media.mediaResourceId} name={media.mediaName} />
              <span>
                <strong>{media.mediaName}</strong>
                <small>
                  ID: {media.externalResourceId} · 市场单价{" "}
                  {formatPublishingMoney(media.priceTenThousandths)}
                </small>
              </span>
            </span>
            <span
              className={`publishing-status ${media.imageSupport === "verified" ? "is-success" : media.imageSupport === "unsupported" ? "is-neutral" : "is-warning"}`}
            >
              <ImageIcon size={14} />
              {media.imageSupport === "verified"
                ? "支持图片"
                : media.imageSupport === "unsupported"
                  ? "仅纯文字"
                  : "图片待验证"}
            </span>
            <span className="publishing-admin-capability-evidence">
              {media.evidenceUrl ? (
                <a href={media.evidenceUrl} target="_blank" rel="noreferrer">
                  查看最终图文证据
                </a>
              ) : (
                "尚无可核验的最终回链"
              )}
              <small
                className={`publishing-status ${media.liveWhitelisted ? "is-success" : "is-neutral"}`}
              >
                {media.liveWhitelisted
                  ? `LIVE 白名单${media.liveImageAllowed ? " · 允许图片" : " · 仅文字"}`
                  : "未加入 LIVE 白名单"}
              </small>
            </span>
            <span className="publishing-admin-inline-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onAction({
                    kind: "capability",
                    title: `记录 ${media.mediaName} 支持图片`,
                    description:
                      "证据地址必须是实际图文发布的最终 HTTPS 回链。",
                    mediaResourceId: media.mediaResourceId,
                    imageSupport: "verified",
                  })
                }
              >
                <SearchCheck size={16} />
                记录图片证据
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onAction({
                    kind: "capability",
                    title: `标记 ${media.mediaName} 仅支持文字`,
                    description:
                      "图片 LIVE 将被服务端阻断，后续可通过新证据重新验证。",
                    mediaResourceId: media.mediaResourceId,
                    imageSupport: "unsupported",
                  })
                }
              >
                仅纯文字
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onAction({
                    kind: "whitelist",
                    title: media.liveWhitelisted
                      ? `移出 ${media.mediaName} 的 LIVE 白名单`
                      : `将 ${media.mediaName} 加入 LIVE 白名单`,
                    description: media.liveWhitelisted
                      ? "移出后该媒体的真实投稿会在 API 预检和 Worker 发送前同时阻断。"
                      : `加入后仍须通过其余 LIVE 门禁；${media.imageSupport === "verified" ? "该媒体将允许已验证的图片投稿。" : "该媒体当前只允许纯文字投稿。"}`,
                    mediaResourceId: media.mediaResourceId,
                    enabled: !media.liveWhitelisted,
                    imageAllowed:
                      !media.liveWhitelisted &&
                      media.imageSupport === "verified",
                  })
                }
              >
                {media.liveWhitelisted
                  ? "移出 LIVE 白名单"
                  : "加入 LIVE 白名单"}
              </button>
              {media.liveWhitelisted && media.imageSupport === "verified" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onAction({
                      kind: "whitelist",
                      title: media.liveImageAllowed
                        ? `禁止 ${media.mediaName} 的 LIVE 图片`
                        : `允许 ${media.mediaName} 的 LIVE 图片`,
                      description:
                        "此设置仅改变该媒体的图片白名单，服务端仍核验最终 HTTPS 图文证据和冻结资产。",
                      mediaResourceId: media.mediaResourceId,
                      enabled: true,
                      imageAllowed: !media.liveImageAllowed,
                    })
                  }
                >
                  {media.liveImageAllowed ? "禁止 LIVE 图片" : "允许 LIVE 图片"}
                </button>
              ) : null}
            </span>
          </article>
        ))
      ) : (
        <PublishingEmpty
          title="目录中没有可验证媒体"
          description="先完成一次完整媒体目录同步。"
        />
      )}
    </section>
  );
}

export function ReconciliationSection({
  items,
  busy,
  onAction,
}: {
  items: UnknownItemView[];
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  const frozenTotal = useMemo(
    () =>
      items
        .filter((item) => item.fundsStatus === "frozen")
        .reduce((sum, item) => sum + BigInt(item.priceTenThousandths), 0n)
        .toString(),
    [items],
  );
  return (
    <>
      <div className="publishing-notice is-warning">
        <AlertTriangle size={20} />
        <div>
          <strong>候选订单不会自动绑定</strong>
          <p>必须先在供应商后台核验；没有订单时才可签发一次性重投授权。</p>
        </div>
      </div>
      <section className="publishing-panel publishing-admin-reconciliation">
        <header className="publishing-panel-heading">
          <div>
            <h2>等待人工对账</h2>
            <p>
              {items.length} 个项目 · 待对账冻结{" "}
              {formatPublishingMoney(frozenTotal)}
            </p>
          </div>
        </header>
        {items.length ? (
          items.map((item) => (
            <article key={item.itemId}>
              <div>
                <strong>{item.mediaName}</strong>
                <span>
                  {item.batchId} / {item.itemId} · {item.ownerUsername}
                </span>
              </div>
              <dl>
                <div>
                  <dt>发送边界</dt>
                  <dd>{item.actionRequiredReason ?? "结果不明确"}</dd>
                </div>
                <div>
                  <dt>资金状态</dt>
                  <dd>
                    {item.fundsStatus === "frozen"
                      ? `待对账冻结 ${formatPublishingMoney(item.priceTenThousandths)}`
                      : item.fundsStatus}
                  </dd>
                </div>
                <div>
                  <dt>候选外部订单</dt>
                  <dd>
                    {
                      item.candidates.filter(
                        (candidate) =>
                          !candidate.boundAt && !candidate.rejectedAt,
                      ).length
                    }{" "}
                    条（需人工核验）
                  </dd>
                </div>
              </dl>
              <footer>
                {item.candidates
                  .filter(
                    (candidate) => !candidate.boundAt && !candidate.rejectedAt,
                  )
                  .map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      disabled={busy}
                      onClick={() =>
                        onAction({
                          kind: "bind",
                          title: `绑定已核验订单 ${candidate.externalOrderId}`,
                          description: `候选置信度 ${(candidate.confidenceBasisPoints / 100).toFixed(2)}%。绑定后系统只会权威轮询，不会重新 POST。`,
                          itemId: item.itemId,
                          candidateId: candidate.id,
                        })
                      }
                    >
                      <SearchCheck size={16} />
                      绑定 {candidate.externalOrderId}
                    </button>
                  ))}
                {item.status === "submission_unknown" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onAction({
                        kind: "resubmit",
                        title: "签发一次性重投授权",
                        description:
                          "仅当供应商后台确认没有创建订单时使用；恢复时服务端会重新核价并重新预占。",
                        itemId: item.itemId,
                      })
                    }
                  >
                    <RefreshCw size={16} />
                    确认无订单并授权重投
                  </button>
                ) : (
                  <span className="publishing-status is-warning">
                    <RefreshCw size={16} />
                    {item.fundsStatus === "frozen"
                      ? "已知外部订单持续权威轮询，禁止重投"
                      : "当前状态不可签发重投授权"}
                  </span>
                )}
              </footer>
            </article>
          ))
        ) : (
          <PublishingEmpty
            title="当前没有 UNKNOWN 项目"
            description="所有发布项目都已获得权威状态。"
          />
        )}
      </section>
    </>
  );
}

function credentialLabel(
  value: "unconfigured" | "healthy" | "auth_blocked" | "unknown",
) {
  if (value === "healthy") return "已配置 · 最近验证成功";
  if (value === "auth_blocked") return "认证失败 · LIVE 已阻断";
  if (value === "unknown") return "状态未知 · LIVE 已阻断";
  return "尚未配置 · LIVE 已阻断";
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
