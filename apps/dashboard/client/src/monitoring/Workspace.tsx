import { useAuth } from "@/_core/hooks/useAuth";
import "./styles.css";
import "./integration.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppRouter } from "@frontmind/monitoring-api";
import type { inferRouterOutputs } from "@trpc/server";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";

import {
  bankTransferInputForApi,
  mapAdminBankTransfer,
  mapAdminBillingUser,
  mapBillingLedgerViews,
  mapBillingActivityViews,
  mapBillingPaymentMethodViews,
  mapBillingPricingViews,
  mapBillingSummaryView,
  mapBillingTopupView,
  mapMediaPublishingBillingSummaryView,
  mapMediaPublishingLedgerViews,
} from "./billingAdapters";
import { formatCnyTenThousandths } from "./billingView";
import {
  mapAdminRun,
  mapAdminOperationRun,
  mapAdminUser,
  mapAudit,
  mapMonitor,
  mapMonitorDetailSummary,
  monitorInputToConfiguration,
  mapProject,
  mapProviderModel,
  mapRegion,
  mapRunDetail,
  mapRunSummary,
  mapSession,
  monitorDetailToInput,
} from "./apiMappers";
import AppShell from "./components/AppShell";
import PlatformAcceptancePanel from "./components/PlatformAcceptancePanel";
import RunConfirmationDialog from "./components/RunConfirmationDialog";
import type {
  MonitorInput,
  MonitorRun,
  MonitorSummary,
  ProjectSummary,
  ProviderModel,
  RegionOption,
  SessionUser,
} from "./domain";
import type {
  AdminAuditFilters,
  AdminRunFilters,
  AdminSection,
} from "./pages/AdminPage";
import type { PublishingAdminSection } from "./features/publishing/pages/PublishingAdminLivePage";
import type { BillingTopupView } from "./pages/SettingsPage";
import type {
  QuoteMonitorRunCost,
  QuoteRunCost,
  RunCostQuoteInput,
  RunCostQuoteView,
} from "./runBilling";
import {
  buildRunCostQuoteInput,
  summarizeScreenshotPolicies,
} from "./runBilling";
import { shouldPollRun } from "./runtimeState";
import { createTrpcClient, trpc } from "./trpc";
import {
  monitoringProjectIdFromSearch,
  writeMonitoringProjectSelection,
} from "./features/monitoring/queryState";

const AdminPage = lazy(() => import("./pages/AdminPage"));
const AdminOperationDetailPage = lazy(
  () => import("./pages/AdminOperationDetailPage"),
);
const MonitorDetailPage = lazy(() => import("./pages/MonitorDetailPage"));
const MonitoringPage = lazy(() => import("./pages/MonitoringPage"));
const RunDetailPage = lazy(() => import("./pages/RunDetailPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ServerPublishingEntry = lazy(
  () => import("./features/publishing/ServerBackedPublishingEntry"),
);
const PublishingAdminPage = lazy(
  () => import("./features/publishing/pages/PublishingAdminLivePage"),
);

let monitorEditorModules:
  | Promise<
      [
        typeof import("./components/Modal"),
        typeof import("./components/MonitorForm"),
      ]
    >
  | undefined;

function loadMonitorEditorModules() {
  monitorEditorModules ??= Promise.all([
    import("./components/Modal"),
    import("./components/MonitorForm"),
  ]);
  return monitorEditorModules;
}

const Modal = lazy(() =>
  loadMonitorEditorModules().then(([modalModule]) => modalModule),
);
const MonitorForm = lazy(() =>
  loadMonitorEditorModules().then(([, formModule]) => formModule),
);

export function MonitorEditorSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<MonitorEditorLoading />}>{children}</Suspense>;
}

function MonitorEditorLoading() {
  return (
    <>
      <div className="modal-backdrop" aria-hidden="true" />
      <section
        className="modal-card modal-wide"
        role="status"
        aria-live="polite"
        aria-label="正在读取问题监控编辑器"
      >
        <header className="modal-header">
          <div>
            <h2>编辑问题监控</h2>
            <p>正在准备编辑器…</p>
          </div>
        </header>
        <div className="panel-state">正在读取问题、模型与执行计划…</div>
      </section>
    </>
  );
}

function createModuleQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 20_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

function scheduleLabel(schedule: MonitorInput["schedule"]): string {
  if (schedule.type === "none") return "手动执行";
  if (schedule.type === "daily") return `每日 ${schedule.localTime || "09:30"}`;
  return `每周${WEEKDAYS[(schedule.weekday || 1) - 1] || "一"} ${schedule.localTime || "09:30"}`;
}

type ApiOutputs = inferRouterOutputs<AppRouter>;

const ADMIN_AUDIT_PAGE_SIZE = 100;

export function mergeUniqueAuditPages<T extends { id: string }>(
  pages: readonly (readonly T[])[] | undefined,
): T[] {
  const seen = new Set<string>();
  return (pages || []).flatMap((page) =>
    page.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }),
  );
}

export function firstUndismissedTopup<T extends { id: string }>(
  candidates: readonly (T | undefined)[],
  dismissedTopupId?: string,
): T | undefined {
  for (const candidate of candidates) {
    if (candidate && candidate.id !== dismissedTopupId) return candidate;
  }
  return undefined;
}

function useMonitoringProjectSelection(
  projects: readonly ProjectSummary[],
  initialProjectId?: string,
) {
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(
    () =>
      typeof window === "undefined"
        ? initialProjectId
        : monitoringProjectIdFromSearch(
            window.location.search,
            projects,
            initialProjectId,
          ),
  );

  useEffect(() => {
    const syncFromLocation = () => {
      if (!projects.length) {
        setActiveProjectId(undefined);
        return;
      }
      if (window.location.pathname === "/monitoring-system") {
        const next = monitoringProjectIdFromSearch(
          window.location.search,
          projects,
          activeProjectId,
        );
        const requested = new URLSearchParams(window.location.search).get(
          "project",
        );
        if (next && requested !== null && requested !== next) {
          writeMonitoringProjectSelection(next, "replace");
        }
        setActiveProjectId(next);
        return;
      }
      setActiveProjectId(
        projects.some((project) => project.id === activeProjectId)
          ? activeProjectId
          : projects[0]?.id,
      );
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [activeProjectId, projects]);

  const selectProject = useCallback((projectId: string) => {
    if (window.location.pathname === "/monitoring-system") {
      writeMonitoringProjectSelection(projectId);
    }
    setActiveProjectId(projectId);
  }, []);

  return [activeProjectId, selectProject] as const;
}

function ServerBackedWorkspace({
  user,
  initialBilling,
  publishingEnabled,
  legalRegistration,
  localServerBacked,
  questionSources,
}: {
  user: SessionUser;
  initialBilling: ApiOutputs["auth"]["me"]["billing"];
  publishingEnabled: boolean;
  legalRegistration?: { number: string; link: string };
  localServerBacked: boolean;
  questionSources?: Record<string, string[]>;
}) {
  const [location, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [selectedMonitorId, setSelectedMonitorId] = useState<string>();
  const [selectedLatestRunId, setSelectedLatestRunId] = useState<string>();
  const [activeTopup, setActiveTopup] = useState<BillingTopupView>();
  const [dismissedTopupId, setDismissedTopupId] = useState<string>();
  const [mediaPublishingActiveTopup, setMediaPublishingActiveTopup] =
    useState<BillingTopupView>();
  const [dismissedMediaPublishingTopupId, setDismissedMediaPublishingTopupId] =
    useState<string>();
  const [operationError, setOperationError] = useState("");
  const selectedMonitorIdRef = useRef<string | undefined>(undefined);
  const selectedRunLockedRef = useRef(false);
  const inFlightRuns = useRef(new Map<string, Promise<string>>());
  const runIntentKeys = useRef(new Map<string, string>());
  const topupIntent = useRef<
    { fingerprint: string; idempotencyKey: string } | undefined
  >(undefined);
  const mediaPublishingTopupIntent = useRef<
    { fingerprint: string; idempotencyKey: string } | undefined
  >(undefined);
  const customerEnabled = user.role === "user";
  const monitoringEnabled = customerEnabled && location.startsWith("/monitoring-system");
  const projectsQuery = trpc.projects.list.useQuery(undefined, {
    enabled: monitoringEnabled,
  });
  const projects = useMemo(
    () => (projectsQuery.data || []).map(mapProject),
    [projectsQuery.data],
  );
  const [activeProjectId, selectActiveProject] =
    useMonitoringProjectSelection(projects);
  const platformQuery = trpc.platforms.list.useQuery(undefined, {
    enabled: monitoringEnabled,
  });
  const regionQuery = trpc.regions.list.useQuery(undefined, {
    enabled: monitoringEnabled,
  });
  const billingSummaryQuery = trpc.billing.summary.useQuery(undefined, {
    enabled: customerEnabled,
    refetchInterval: customerEnabled ? 10_000 : false,
    initialData: initialBilling,
  });
  const mediaPublishingSummaryQuery =
    trpc.mediaPublishing.billing.summary.useQuery(undefined, {
      enabled: customerEnabled && publishingEnabled,
      refetchInterval: customerEnabled && publishingEnabled ? 10_000 : false,
    });
  const settingsEnabled =
    customerEnabled && ["/account", "/monitoring-system/settings"].includes(location);
  const billingActivityQuery = trpc.billing.activity.useQuery({ limit: 100 }, { enabled: settingsEnabled, refetchInterval: settingsEnabled ? 10_000 : false });
  const billingPricingQuery = trpc.billing.pricing.useQuery(undefined, {
    enabled: settingsEnabled,
  });
  const billingMethodsQuery = trpc.billing.methods.useQuery(undefined, {
    enabled: settingsEnabled,
  });
  const billingLedgerQuery = trpc.billing.ledger.useQuery(
    { limit: 100 },
    { enabled: settingsEnabled },
  );
  const topupOrdersQuery = trpc.billing.topups.list.useQuery(
    { limit: 10 },
    { enabled: settingsEnabled },
  );
  const mediaPublishingLedgerQuery =
    trpc.mediaPublishing.billing.ledger.useQuery(
      { limit: 100 },
      { enabled: settingsEnabled && publishingEnabled },
    );
  const mediaPublishingTopupOrdersQuery =
    trpc.mediaPublishing.billing.topups.list.useQuery(
      { limit: 10 },
      { enabled: settingsEnabled && publishingEnabled },
    );
  const listedTopupSource = topupOrdersQuery.data?.find(
    (order) =>
      order.id !== dismissedTopupId &&
      ["pending", "review_required"].includes(order.state),
  );
  const activeTopupId =
    (activeTopup?.id === dismissedTopupId ? undefined : activeTopup?.id) ||
    listedTopupSource?.id ||
    "00000000-0000-0000-0000-000000000000";
  const listedMediaPublishingTopupSource =
    mediaPublishingTopupOrdersQuery.data?.items.find(
      (order) =>
        order.id !== dismissedMediaPublishingTopupId &&
        ["pending", "review_required"].includes(order.state),
    );
  const activeMediaPublishingTopupId =
    (mediaPublishingActiveTopup?.id === dismissedMediaPublishingTopupId
      ? undefined
      : mediaPublishingActiveTopup?.id) ||
    listedMediaPublishingTopupSource?.id ||
    "00000000-0000-0000-0000-000000000000";
  const topupStatusQuery = trpc.billing.topups.status.useQuery(
    { orderId: activeTopupId },
    {
      enabled:
        settingsEnabled &&
        activeTopupId !== "00000000-0000-0000-0000-000000000000",
      refetchInterval: (query) => {
        const order = query.state.data?.order;
        if (
          !order ||
          order.state !== "pending" ||
          order.paymentMethod === "bank_transfer"
        )
          return false;
        const cutoff = Math.min(
          new Date(order.checkoutExpiresAt).getTime(),
          new Date(order.createdAt).getTime() + 30 * 60 * 1_000,
        );
        return cutoff > Date.now() ? 5_000 : false;
      },
    },
  );
  const mediaPublishingTopupStatusQuery =
    trpc.mediaPublishing.billing.topups.status.useQuery(
      { orderId: activeMediaPublishingTopupId },
      {
        enabled:
          settingsEnabled &&
          publishingEnabled &&
          activeMediaPublishingTopupId !==
            "00000000-0000-0000-0000-000000000000",
        refetchInterval: (query) => {
          const order = query.state.data?.order;
          if (
            !order ||
            order.state !== "pending" ||
            order.paymentMethod === "bank_transfer"
          )
            return false;
          const cutoff = Math.min(
            new Date(order.checkoutExpiresAt).getTime(),
            new Date(order.createdAt).getTime() + 30 * 60 * 1_000,
          );
          return cutoff > Date.now() ? 5_000 : false;
        },
      },
    );
  const monitorsQuery = trpc.monitors.list.useQuery(
    activeProjectId ? { projectId: activeProjectId } : undefined,
    {
      enabled: Boolean(activeProjectId && monitoringEnabled),
      refetchInterval: activeProjectId && monitoringEnabled ? 10_000 : false,
    },
  );
  const deletedMonitorsQuery = trpc.monitors.listDeleted.useQuery(undefined, {
    enabled: monitoringEnabled,
  });
  const recentRunsQuery = trpc.runs.list.useQuery(
    {
      monitorId: selectedMonitorId || "00000000-0000-0000-0000-000000000000",
      limit: 100,
    },
    {
      enabled: Boolean(selectedMonitorId && monitoringEnabled),
      refetchInterval: selectedMonitorId && monitoringEnabled ? 15_000 : false,
    },
  );
  const latestRunQuery = trpc.runs.get.useQuery(
    {
      runId: selectedLatestRunId || "00000000-0000-0000-0000-000000000000",
    },
    {
      enabled: Boolean(selectedLatestRunId && monitoringEnabled),
      refetchInterval: (state) =>
        monitoringEnabled && state.state.data && shouldPollRun(state.state.data.run.status)
          ? 3_000
          : false,
    },
  );
  const models = (platformQuery.data || []).map(mapProviderModel);
  const regions = (regionQuery.data || []).map(mapRegion);
  const billing = mapBillingSummaryView(
    billingSummaryQuery.data || initialBilling,
  );
  const mediaPublishingBilling = mediaPublishingSummaryQuery.data
    ? mapMediaPublishingBillingSummaryView(mediaPublishingSummaryQuery.data)
    : undefined;
  const queryError = [
    projectsQuery.error,
    platformQuery.error,
    regionQuery.error,
    billingSummaryQuery.error,
    mediaPublishingSummaryQuery.error,
    deletedMonitorsQuery.error,
    recentRunsQuery.error,
    latestRunQuery.error,
  ].find(Boolean)?.message;

  const monitors = (monitorsQuery.data || []).map(mapMonitor);
  const latestRun = latestRunQuery.data
    ? mapRunDetail(latestRunQuery.data)
    : undefined;
  const selectedMonitor = monitors.find(
    (monitor) => monitor.id === selectedMonitorId,
  );
  const recentRuns = (recentRunsQuery.data || []).map((run) =>
    mapRunSummary(run, selectedMonitor?.name || "问题监控"),
  );
  const selectMonitorForAnswerPreview = useCallback(
    (monitor?: MonitorSummary) => {
      const monitorChanged = selectedMonitorIdRef.current !== monitor?.id;
      if (monitorChanged) {
        selectedMonitorIdRef.current = monitor?.id;
        selectedRunLockedRef.current = false;
        setSelectedMonitorId(monitor?.id);
      }
      if (monitorChanged || !selectedRunLockedRef.current) {
        setSelectedLatestRunId(monitor?.lastRun?.id);
      }
    },
    [],
  );
  const selectHistoricalRun = useCallback(
    (runId: string) => {
      selectedRunLockedRef.current = runId !== selectedMonitor?.lastRun?.id;
      setSelectedLatestRunId(runId);
    },
    [selectedMonitor?.lastRun?.id],
  );
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const createProject = trpc.projects.create.useMutation();
  const updateProject = trpc.projects.update.useMutation();
  const createMonitor = trpc.monitors.create.useMutation();
  const updateMonitor = trpc.monitors.update.useMutation();
  const runNow = trpc.monitors.runNow.useMutation();
  const pauseMonitor = trpc.monitors.pause.useMutation();
  const resumeMonitor = trpc.monitors.resume.useMutation();
  const removeMonitor = trpc.monitors.remove.useMutation();
  const restoreMonitor = trpc.monitors.restore.useMutation();
  const billingQuote = trpc.billing.quote.useMutation();
  const createTopup = trpc.billing.topups.create.useMutation();
  const switchTopupMethod = trpc.billing.topups.switchMethod.useMutation();
  const submitBankTransfer =
    trpc.billing.topups.submitBankTransfer.useMutation();
  const createMediaPublishingTopup =
    trpc.mediaPublishing.billing.topups.create.useMutation();
  const switchMediaPublishingTopupMethod =
    trpc.mediaPublishing.billing.topups.switchMethod.useMutation();
  const submitMediaPublishingBankTransfer =
    trpc.mediaPublishing.billing.topups.submitBankTransfer.useMutation();
  const quoteRunCost = useCallback<QuoteRunCost>(
    async (input) => {
      const quote = await billingQuote.mutateAsync(input);
      return {
        totalAmountTenThousandths: quote.totalAmountTenThousandths,
      };
    },
    [billingQuote.mutateAsync],
  );
  const quoteMonitorRunCost = useCallback<QuoteMonitorRunCost>(
    async (monitorId) => {
      const quote = await utils.billing.quoteMonitor.fetch({ monitorId });
      return {
        totalAmountTenThousandths: quote.totalAmountTenThousandths,
      };
    },
    [utils.billing.quoteMonitor],
  );

  const refreshMonitoring = async () => {
    await Promise.all([
      utils.projects.list.invalidate(),
      utils.monitors.list.invalidate(),
      utils.monitors.listDeleted.invalidate(),
      utils.platforms.list.invalidate(),
      utils.regions.list.invalidate(),
      utils.billing.summary.invalidate(),
      utils.runs.list.invalidate(),
      utils.runs.get.invalidate(),
    ]);
  };
  const refreshBilling = async () => {
    await Promise.all([
      utils.billing.summary.invalidate(),
      utils.billing.ledger.invalidate(),
      utils.billing.topups.list.invalidate(),
      activeTopup?.id
        ? utils.billing.topups.status.invalidate({ orderId: activeTopup.id })
        : Promise.resolve(),
    ]);
  };
  const refreshMediaPublishingBilling = async () => {
    await Promise.all([
      utils.mediaPublishing.billing.summary.invalidate(),
      utils.mediaPublishing.billing.ledger.invalidate(),
      utils.mediaPublishing.billing.topups.list.invalidate(),
      mediaPublishingActiveTopup?.id
        ? utils.mediaPublishing.billing.topups.status.invalidate({
            orderId: mediaPublishingActiveTopup.id,
          })
        : Promise.resolve(),
    ]);
  };
  const execute = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setOperationError("");
    try {
      return await operation();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "操作失败，请稍后重试。";
      setOperationError(message);
      throw new Error(message);
    }
  };
  const triggerRun = (monitorId: string): Promise<string> => {
    const existing = inFlightRuns.current.get(monitorId);
    if (existing) return existing;
    const idempotencyKey =
      runIntentKeys.current.get(monitorId) ?? `ui:${crypto.randomUUID()}`;
    runIntentKeys.current.set(monitorId, idempotencyKey);
    const operation = execute(async () => {
      const created = await runNow.mutateAsync({ monitorId, idempotencyKey });
      await Promise.all([
        refreshMonitoring(),
        utils.monitors.get.invalidate({ monitorId }),
        utils.runs.list.invalidate({ monitorId, limit: 100 }),
      ]);
      runIntentKeys.current.delete(monitorId);
      return created.run.id;
    }).finally(() => inFlightRuns.current.delete(monitorId));
    inFlightRuns.current.set(monitorId, operation);
    return operation;
  };

  const paymentMethodViews = billingMethodsQuery.data
    ? mapBillingPaymentMethodViews(billingMethodsQuery.data)
    : [];
  const statusTopup =
    topupStatusQuery.data && topupStatusQuery.data.order.id !== dismissedTopupId
      ? mapBillingTopupView(
          {
            order: topupStatusQuery.data.order,
            checkout:
              activeTopup?.id === topupStatusQuery.data.order.id
                ? activeTopup.checkout || null
                : null,
          },
          billingMethodsQuery.data,
        )
      : undefined;
  const listedTopup = listedTopupSource
    ? mapBillingTopupView(
        { order: listedTopupSource, checkout: null },
        billingMethodsQuery.data,
      )
    : undefined;
  const settingsTopup = firstUndismissedTopup(
    [statusTopup, activeTopup, listedTopup],
    dismissedTopupId,
  );
  const mediaPublishingStatusTopup =
    mediaPublishingTopupStatusQuery.data &&
    mediaPublishingTopupStatusQuery.data.order.id !==
      dismissedMediaPublishingTopupId
      ? mapBillingTopupView(
          {
            order: mediaPublishingTopupStatusQuery.data.order,
            checkout:
              mediaPublishingActiveTopup?.id ===
              mediaPublishingTopupStatusQuery.data.order.id
                ? mediaPublishingActiveTopup.checkout || null
                : null,
          },
          billingMethodsQuery.data,
        )
      : undefined;
  const listedMediaPublishingTopup = listedMediaPublishingTopupSource
    ? mapBillingTopupView(
        { order: listedMediaPublishingTopupSource, checkout: null },
        billingMethodsQuery.data,
      )
    : undefined;
  const settingsMediaPublishingTopup = firstUndismissedTopup(
    [
      mediaPublishingStatusTopup,
      mediaPublishingActiveTopup,
      listedMediaPublishingTopup,
    ],
    dismissedMediaPublishingTopupId,
  );
  const settingsBillingError = [
    billingSummaryQuery.error,
    billingPricingQuery.error,
    billingMethodsQuery.error,
    billingLedgerQuery.error,
    topupOrdersQuery.error,
    topupStatusQuery.error,
    mediaPublishingSummaryQuery.error,
    mediaPublishingLedgerQuery.error,
    mediaPublishingTopupOrdersQuery.error,
    mediaPublishingTopupStatusQuery.error,
  ].find(Boolean)?.message;

  const { logout, user: dashboardUser } = useAuth();
  const renderPublisherAdmin = (section: PublishingAdminSection) =>
    user.role === "admin" ? (
      <PublishingAdminPage section={section} />
    ) : (
      <Redirect to="/monitoring-system" />
    );

  return (
    <AppShell
      user={user}
      accountBalance={formatCnyTenThousandths(billing.availableTenThousandths)}
      walletBalances={{
        monitoring: formatCnyTenThousandths(billing.availableTenThousandths),
        mediaPublishing: formatCnyTenThousandths(
          mediaPublishingBilling?.availableTenThousandths,
        ),
      }}
      publishingEnabled={publishingEnabled}
      projects={projects}
      activeProjectId={activeProjectId}
      onProjectChange={selectActiveProject}
      onLogout={() => {
        void logout().catch((error: unknown) =>
          setOperationError(
            error instanceof Error
              ? error.message
              : "未能确认会话已退出，当前页面保持不变，请重试。",
          ),
        );
      }}
      legalRegistration={legalRegistration}
      environmentLabel={
        localServerBacked ? "本地真实联调 · Server-backed" : undefined
      }
    >
      {location === "/account" && <div className="operator-account-info"><div><strong>{dashboardUser?.displayName || dashboardUser?.username}</strong><small>@{dashboardUser?.username} · 客户账号</small></div><button onClick={() => void logout().catch(error => setOperationError(error instanceof Error ? error.message : "退出失败，请重试。"))}>退出登录</button></div>}
      {(operationError || queryError) && (
        <div className="operation-banner" role="alert">
          {operationError || `数据加载失败：${queryError}`}
          <button
            type="button"
            onClick={() => {
              setOperationError("");
              if (queryError)
                void Promise.all([
                  projectsQuery.refetch(),
                  platformQuery.refetch(),
                  regionQuery.refetch(),
                  billingSummaryQuery.refetch(),
                  deletedMonitorsQuery.refetch(),
                ]);
            }}
          >
            {queryError ? "重试" : "关闭"}
          </button>
        </div>
      )}
      <Suspense fallback={<div className="boot-state">正在读取页面…</div>}>
        <Switch>
          <Route path="/publishing/*">
            {user.role === "user" && publishingEnabled ? (
              <ServerPublishingEntry client={utils.client} />
            ) : (
              <Redirect
                to={
                  user.role === "admin"
                    ? "/admin/monitoring/accounts"
                    : "/monitoring-system"
                }
              />
            )}
          </Route>
          <Route path="/publishing">
            {user.role === "user" && publishingEnabled ? (
              <ServerPublishingEntry client={utils.client} />
            ) : (
              <Redirect
                to={
                  user.role === "admin"
                    ? "/admin/monitoring/accounts"
                    : "/monitoring-system"
                }
              />
            )}
          </Route>
          <Route path={/^\/(?:account|monitoring-system\/settings)$/}>
            <SettingsPage
              billingLoading={
                billingSummaryQuery.isPending ||
                billingPricingQuery.isPending ||
                billingMethodsQuery.isPending ||
                billingLedgerQuery.isPending
              }
              billingError={settingsBillingError}
              summary={billing}
              mediaPublishingSummary={mediaPublishingBilling}
              pricing={mapBillingPricingViews(
                billingPricingQuery.data?.items || [],
              )}
              ledger={mapBillingLedgerViews(billingLedgerQuery.data || [])}
              activity={billingActivityQuery.data ? mapBillingActivityViews(billingActivityQuery.data) : undefined}
              mediaPublishingLedger={mapMediaPublishingLedgerViews(
                mediaPublishingLedgerQuery.data || [],
              )}
              paymentMethods={paymentMethodViews}
              activeTopup={settingsTopup}
              mediaPublishingActiveTopup={settingsMediaPublishingTopup}
              onClearActiveTopup={() => {
                if (settingsTopup) setDismissedTopupId(settingsTopup.id);
                setActiveTopup(undefined);
              }}
              onClearMediaPublishingActiveTopup={() => {
                if (settingsMediaPublishingTopup)
                  setDismissedMediaPublishingTopupId(
                    settingsMediaPublishingTopup.id,
                  );
                setMediaPublishingActiveTopup(undefined);
              }}
              onCreateTopup={async (amountTenThousandths, paymentMethod) => {
                const fingerprint = `${amountTenThousandths}:${paymentMethod}`;
                if (topupIntent.current?.fingerprint !== fingerprint) {
                  topupIntent.current = {
                    fingerprint,
                    idempotencyKey: `ui:${crypto.randomUUID()}`,
                  };
                }
                const created = await createTopup.mutateAsync({
                  amountTenThousandths,
                  paymentMethod,
                  idempotencyKey: topupIntent.current.idempotencyKey,
                });
                const view = mapBillingTopupView(
                  created,
                  billingMethodsQuery.data,
                );
                setDismissedTopupId(undefined);
                setActiveTopup(view);
                topupIntent.current = undefined;
                await refreshBilling();
                return view;
              }}
              onSwitchTopupMethod={async (orderId, paymentMethod) => {
                const current = settingsTopup;
                if (!current || current.id !== orderId)
                  throw new Error("充值订单状态已变化，请刷新后重试。");
                const changed = await switchTopupMethod.mutateAsync({
                  orderId,
                  expectedPaymentMethod: current.method,
                  paymentMethod,
                });
                const view = mapBillingTopupView(
                  changed,
                  billingMethodsQuery.data,
                );
                setActiveTopup(view);
                await refreshBilling();
                return view;
              }}
              onSubmitBankTransfer={async (orderId, input) => {
                const submitted = await submitBankTransfer.mutateAsync({
                  orderId,
                  ...bankTransferInputForApi(input),
                });
                const view = mapBillingTopupView(
                  { order: submitted.order, checkout: null },
                  billingMethodsQuery.data,
                );
                setActiveTopup(view);
                await refreshBilling();
                return view;
              }}
              onCreateMediaPublishingTopup={
                publishingEnabled
                  ? async (amountTenThousandths, paymentMethod) => {
                      const fingerprint = `${amountTenThousandths}:${paymentMethod}`;
                      if (
                        mediaPublishingTopupIntent.current?.fingerprint !==
                        fingerprint
                      ) {
                        mediaPublishingTopupIntent.current = {
                          fingerprint,
                          idempotencyKey: `ui:${crypto.randomUUID()}`,
                        };
                      }
                      const created =
                        await createMediaPublishingTopup.mutateAsync({
                          walletScope: "media_publishing",
                          amountTenThousandths,
                          paymentMethod,
                          idempotencyKey:
                            mediaPublishingTopupIntent.current.idempotencyKey,
                        });
                      const view = mapBillingTopupView(
                        created,
                        billingMethodsQuery.data,
                      );
                      setDismissedMediaPublishingTopupId(undefined);
                      setMediaPublishingActiveTopup(view);
                      mediaPublishingTopupIntent.current = undefined;
                      await refreshMediaPublishingBilling();
                      return view;
                    }
                  : undefined
              }
              onSwitchMediaPublishingTopupMethod={async (
                orderId,
                paymentMethod,
              ) => {
                const current = settingsMediaPublishingTopup;
                if (!current || current.id !== orderId)
                  throw new Error("媒体发布充值订单状态已变化，请刷新后重试。");
                const changed =
                  await switchMediaPublishingTopupMethod.mutateAsync({
                    orderId,
                    expectedPaymentMethod: current.method,
                    paymentMethod,
                  });
                const view = mapBillingTopupView(
                  changed,
                  billingMethodsQuery.data,
                );
                setMediaPublishingActiveTopup(view);
                await refreshMediaPublishingBilling();
                return view;
              }}
              onSubmitMediaPublishingBankTransfer={async (orderId, input) => {
                const submitted =
                  await submitMediaPublishingBankTransfer.mutateAsync({
                    orderId,
                    ...bankTransferInputForApi(input),
                  });
                const view = mapBillingTopupView(
                  { order: submitted.order, checkout: null },
                  billingMethodsQuery.data,
                );
                setMediaPublishingActiveTopup(view);
                await refreshMediaPublishingBilling();
                return view;
              }}
            />
          </Route>
          <Route path="/monitoring-system/:monitorId/runs/:runId">
            {(params) =>
              user.role === "user" ? (
                <UserRunRoute runId={params.runId} />
              ) : (
                <Redirect to="/admin/monitoring/accounts" />
              )
            }
          </Route>
          <Route path="/monitoring-system/:monitorId">
            {(params) =>
              user.role === "user" ? (
                <UserMonitorRoute
                  monitorId={params.monitorId}
                  monitor={monitors.find(
                    (item) => item.id === params.monitorId,
                  )}
                  projects={projects}
                  models={models}
                  regions={regions}
                  availableBalanceTenThousandths={
                    billing.availableTenThousandths
                  }
                  quoteRunCost={quoteRunCost}
                  quoteMonitorRunCost={quoteMonitorRunCost}
                  onRun={async () => {
                    const runId = await triggerRun(params.monitorId);
                    navigate(
                      `/monitoring-system/${params.monitorId}/runs/${runId}`,
                    );
                  }}
                  onToggle={async (paused) => {
                    await execute(() =>
                      paused
                        ? pauseMonitor.mutateAsync({
                            monitorId: params.monitorId,
                          })
                        : resumeMonitor.mutateAsync({
                            monitorId: params.monitorId,
                          }),
                    );
                    await refreshMonitoring();
                  }}
                  onDelete={async () => {
                    if (
                      !window.confirm(
                        "删除后保留 30 天且可恢复。确认删除这个监控？",
                      )
                    )
                      return;
                    await execute(() =>
                      removeMonitor.mutateAsync({
                        monitorId: params.monitorId,
                      }),
                    );
                    await refreshMonitoring();
                    navigate("/monitoring-system");
                  }}
                />
              ) : (
                <Redirect to="/admin/monitoring/accounts" />
              )
            }
          </Route>
          <Route path="/monitoring-system">
            {user.role === "user" ? (
              <MonitoringPage
                seedQuestions={activeProject ? questionSources?.[activeProject.id] : undefined}
                serverData
                project={activeProject}
                monitors={monitors}
                deletedMonitors={(deletedMonitorsQuery.data || [])
                  .filter(
                    (item) =>
                      !activeProject || item.projectId === activeProject.id,
                  )
                  .map((item) => ({
                    id: item.id,
                    name: item.name,
                    deletedAt: item.deletedAt,
                    purgeAfter: item.purgeAfter,
                  }))}
                models={models}
                regions={regions}
                availableBalanceTenThousandths={billing.availableTenThousandths}
                quoteRunCost={quoteRunCost}
                quoteMonitorRunCost={quoteMonitorRunCost}
                latestRun={latestRun}
                recentRuns={recentRuns}
                selectedRunId={selectedLatestRunId}
                onSelectedRunChange={selectHistoricalRun}
                onSelectedMonitorChange={selectMonitorForAnswerPreview}
                loading={
                  !projectsQuery.isSuccess ||
                  projectsQuery.isFetching ||
                  (projects.length > 0 && !activeProject) ||
                  (Boolean(activeProjectId) && monitorsQuery.isPending) ||
                  monitorsQuery.isFetching
                }
                onCreateProject={async (value) => {
                  const created = await execute(() =>
                    createProject.mutateAsync({
                      name: value.name,
                      mainBrand: value.brandName,
                      aliases: value.brandAliases,
                      competitors: value.competitors,
                      timezone: value.timezone,
                    }),
                  );
                  await refreshMonitoring();
                  if (created && typeof created === "object" && "id" in created)
                    selectActiveProject(String(created.id));
                }}
                onUpdateProject={async (value) => {
                  if (!activeProject) return;
                  await execute(() =>
                    updateProject.mutateAsync({
                      projectId: activeProject.id,
                      name: value.name,
                      timezone: value.timezone,
                      mainBrand: value.brandName,
                      aliases: value.brandAliases,
                      competitors: value.competitors,
                    }),
                  );
                  await refreshMonitoring();
                }}
                onSaveMonitor={async (
                  value,
                  runImmediately,
                  idempotencyKey,
                ) => {
                  if (!activeProject) throw new Error("请先创建项目。");
                  if (runImmediately && !idempotencyKey)
                    throw new Error("立即执行缺少幂等键，请重试。");
                  const created = await execute(() =>
                    createMonitor.mutateAsync({
                      projectId: activeProject.id,
                      configuration: monitorInputToConfiguration(
                        value,
                        activeProject,
                        models,
                      ),
                      runImmediately,
                      ...(runImmediately ? { idempotencyKey } : {}),
                    }),
                  );
                  await refreshMonitoring();
                  return {
                    monitorId: created.monitorId,
                    runId: created.run?.run.id,
                  };
                }}
                onLoadMonitor={async (id) => {
                  const detail = await utils.monitors.get.fetch({
                    monitorId: id,
                  });
                  return monitorDetailToInput(detail, models);
                }}
                onUpdateMonitor={async (
                  id,
                  value,
                  runImmediately,
                  idempotencyKey,
                ) => {
                  if (!activeProject) throw new Error("请先选择项目。");
                  if (runImmediately && !idempotencyKey)
                    throw new Error("立即执行缺少幂等键，请重试。");
                  const updated = await execute(() =>
                    updateMonitor.mutateAsync({
                      monitorId: id,
                      configuration: monitorInputToConfiguration(
                        value,
                        activeProject,
                        models,
                      ),
                      runImmediately,
                      ...(runImmediately ? { idempotencyKey } : {}),
                    }),
                  );
                  await Promise.all([
                    refreshMonitoring(),
                    utils.monitors.get.invalidate({ monitorId: id }),
                    utils.billing.summary.invalidate(),
                  ]);
                  return {
                    monitorId: id,
                    runId: updated.run?.run.id,
                  };
                }}
                onRunMonitor={async (id) => {
                  const runId = await triggerRun(id);
                  return { runId };
                }}
                onToggleMonitor={async (id, paused) => {
                  await execute(() =>
                    paused
                      ? pauseMonitor.mutateAsync({ monitorId: id })
                      : resumeMonitor.mutateAsync({ monitorId: id }),
                  );
                  await refreshMonitoring();
                }}
                onDeleteMonitor={async (id) => {
                  await execute(() =>
                    removeMonitor.mutateAsync({ monitorId: id }),
                  );
                  await refreshMonitoring();
                }}
                onRestoreMonitor={async (id) => {
                  await execute(() =>
                    restoreMonitor.mutateAsync({ monitorId: id }),
                  );
                  await refreshMonitoring();
                }}
                onRefresh={refreshMonitoring}
              />
            ) : (
              <Redirect to="/admin/monitoring/accounts" />
            )}
          </Route>
          <Route path="/admin/monitoring/media-publishing/integration">
            {renderPublisherAdmin("integration")}
          </Route>
          <Route path="/admin/monitoring/media-publishing/catalog">
            {renderPublisherAdmin("catalog")}
          </Route>
          <Route path="/admin/monitoring/media-publishing/capabilities">
            {renderPublisherAdmin("capabilities")}
          </Route>
          <Route path="/admin/monitoring/media-publishing/reconciliation">
            {renderPublisherAdmin("reconciliation")}
          </Route>
          <Route path="/admin/monitoring/content-review/runs/:runId">
            {(params) =>
              user.role === "admin" ? (
                <AdminRunAuditRoute runId={params.runId} />
              ) : (
                <Redirect to="/monitoring-system" />
              )
            }
          </Route>
          <Route path="/admin/monitoring/operations/runs/:runId">
            {(params) =>
              user.role === "admin" ? (
                <AdminOperationRoute runId={params.runId} />
              ) : (
                <Redirect to="/monitoring-system" />
              )
            }
          </Route>
          <Route path="/admin/monitoring/runs/:runId">
            {(params) => (
              <Redirect
                to={`/admin/monitoring/content-review/runs/${params.runId}`}
              />
            )}
          </Route>
          <Route path="/admin/monitoring/accounts">
            {user.role === "admin" ? (
              <AdminWorkspace
                section="accounts"
                publishingEnabled={publishingEnabled}
              />
            ) : (
              <Redirect to="/monitoring-system" />
            )}
          </Route>
          <Route path="/admin/monitoring/models">
            {user.role === "admin" ? (
              <AdminWorkspace
                section="models"
                publishingEnabled={publishingEnabled}
              />
            ) : (
              <Redirect to="/monitoring-system" />
            )}
          </Route>
          <Route path="/admin/monitoring/operations">
            {user.role === "admin" ? (
              <AdminWorkspace
                section="operations"
                publishingEnabled={publishingEnabled}
                onInspectExecution={(id) =>
                  navigate(`/admin/monitoring/operations/runs/${id}`)
                }
              />
            ) : (
              <Redirect to="/monitoring-system" />
            )}
          </Route>
          <Route path="/admin/monitoring/content-review">
            {user.role === "admin" ? (
              <AdminWorkspace
                section="content-review"
                publishingEnabled={publishingEnabled}
                onInspectRun={(id) =>
                  navigate(`/admin/monitoring/content-review/runs/${id}`)
                }
              />
            ) : (
              <Redirect to="/monitoring-system" />
            )}
          </Route>
          <Route path="/admin/monitoring/audit-log">
            {user.role === "admin" ? (
              <AdminWorkspace
                section="audit-log"
                publishingEnabled={publishingEnabled}
              />
            ) : (
              <Redirect to="/monitoring-system" />
            )}
          </Route>
          <Route path="/admin/monitoring">
            <Redirect
              to={
                user.role === "admin"
                  ? "/admin/monitoring/accounts"
                  : "/monitoring-system"
              }
            />
          </Route>
          <Route path="/login">
            <Redirect
              to={
                user.role === "admin"
                  ? "/admin/monitoring/accounts"
                  : "/monitoring-system"
              }
            />
          </Route>
          <Route>
            <Redirect
              to={
                user.role === "admin"
                  ? "/admin/monitoring/accounts"
                  : "/monitoring-system"
              }
            />
          </Route>
        </Switch>
      </Suspense>
    </AppShell>
  );
}

function UserMonitorRoute({
  monitorId,
  monitor,
  projects,
  models,
  regions,
  availableBalanceTenThousandths,
  quoteRunCost,
  quoteMonitorRunCost,
  onRun,
  onToggle,
  onDelete,
}: {
  monitorId: string;
  monitor?: MonitorSummary;
  projects: ProjectSummary[];
  models: ProviderModel[];
  regions: RegionOption[];
  availableBalanceTenThousandths: string;
  quoteRunCost: QuoteRunCost;
  quoteMonitorRunCost: QuoteMonitorRunCost;
  onRun: () => Promise<void>;
  onToggle: (paused: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const detailQuery = trpc.monitors.get.useQuery({ monitorId });
  const runsQuery = trpc.runs.list.useQuery(
    { monitorId, limit: 100 },
    {
      refetchInterval: (query) =>
        (query.state.data || []).some((run) => shouldPollRun(run.status))
          ? 5_000
          : false,
    },
  );
  const update = trpc.monitors.update.useMutation();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pendingImmediateUpdate, setPendingImmediateUpdate] = useState<{
    value: MonitorInput;
    idempotencyKey?: string;
    quote?: RunCostQuoteView;
  }>();
  const monitorName =
    monitor?.name || detailQuery.data?.version.name || "问题监控";
  const runs = (runsQuery.data || []).map((run) =>
    mapRunSummary(run, monitorName, detailQuery.data?.version.version || 1),
  );
  const resolvedMonitor =
    monitor ||
    (detailQuery.data
      ? mapMonitorDetailSummary(detailQuery.data, runs[0])
      : undefined);
  const project = detailQuery.data
    ? projects.find(
        (candidate) => candidate.id === detailQuery.data.monitor.projectId,
      )
    : undefined;
  const initial = detailQuery.data
    ? monitorDetailToInput(detailQuery.data, models)
    : undefined;
  const saveMonitorUpdate = async (
    value: MonitorInput,
    runImmediately: boolean,
    idempotencyKey?: string,
  ) => {
    setError("");
    try {
      if (runImmediately && !idempotencyKey)
        throw new Error("立即执行缺少幂等键，请重试。");
      const updated = await update.mutateAsync({
        monitorId,
        configuration: monitorInputToConfiguration(value, project!, models),
        runImmediately,
        ...(runImmediately ? { idempotencyKey } : {}),
      });
      await Promise.all([
        utils.monitors.get.invalidate({ monitorId }),
        utils.monitors.list.invalidate(),
        utils.runs.list.invalidate({ monitorId, limit: 100 }),
        utils.billing.summary.invalidate(),
      ]);
      setEditing(false);
      setPendingImmediateUpdate(undefined);
      if (updated.run)
        navigate(`/monitoring-system/${monitorId}/runs/${updated.run.run.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "保存失败，请稍后重试。",
      );
    }
  };
  if (detailQuery.isLoading && !monitor)
    return <main className="boot-state">正在读取监控配置…</main>;
  if (detailQuery.error)
    return (
      <div className="page-content">
        <div className="panel-state">
          <strong>监控配置加载失败</strong>
          <span>{detailQuery.error.message}</span>
        </div>
      </div>
    );
  return (
    <>
      {runsQuery.error && (
        <div className="operation-banner" role="alert">
          运行历史加载失败：{runsQuery.error.message}
        </div>
      )}
      <MonitorDetailPage
        monitor={resolvedMonitor}
        runs={runs}
        availableBalanceTenThousandths={availableBalanceTenThousandths}
        quoteMonitorRunCost={quoteMonitorRunCost}
        onRun={onRun}
        onToggle={() => onToggle(resolvedMonitor?.status !== "paused")}
        onEdit={() => setEditing(true)}
        onDelete={onDelete}
      />
      {editing && project && initial && (
        <MonitorEditorSuspense>
          <Modal
            open
            onClose={() => setEditing(false)}
            title="编辑问题监控"
            description="保存会创建新的不可变配置版本，历史运行保持原样。"
            size="wide"
          >
            {error && <p className="form-error modal-error">{error}</p>}
            <MonitorForm
              project={project}
              models={models}
              regions={regions}
              availableBalanceTenThousandths={availableBalanceTenThousandths}
              quoteRunCost={quoteRunCost}
              initial={initial}
              submitting={update.isPending}
              onCancel={() => setEditing(false)}
              onSubmit={async (
                value,
                runImmediately,
                idempotencyKey,
                quote,
              ) => {
                if (runImmediately) {
                  setPendingImmediateUpdate({ value, idempotencyKey, quote });
                  return;
                }
                await saveMonitorUpdate(value, false, idempotencyKey);
              }}
            />
          </Modal>
        </MonitorEditorSuspense>
      )}
      {pendingImmediateUpdate && (
        <RunConfirmationDialog
          open
          monitorName={pendingImmediateUpdate.value.name}
          questionCount={pendingImmediateUpdate.value.questions.length}
          platformCount={pendingImmediateUpdate.value.platforms.length}
          repetitions={pendingImmediateUpdate.value.repetitions}
          availableBalanceTenThousandths={availableBalanceTenThousandths}
          estimatedCostTenThousandths={
            pendingImmediateUpdate.quote?.totalAmountTenThousandths
          }
          scheduleSummary={scheduleLabel(pendingImmediateUpdate.value.schedule)}
          screenshotPolicy={summarizeScreenshotPolicies(
            pendingImmediateUpdate.value.platforms,
          )}
          loading={update.isPending}
          onCancel={() => setPendingImmediateUpdate(undefined)}
          onConfirm={() =>
            saveMonitorUpdate(
              pendingImmediateUpdate.value,
              true,
              pendingImmediateUpdate.idempotencyKey,
            )
          }
        />
      )}
    </>
  );
}

function UserRunRoute({ runId }: { runId: string }) {
  const utils = trpc.useUtils();
  const query = trpc.runs.get.useQuery(
    { runId },
    {
      refetchInterval: (state) =>
        state.state.data && shouldPollRun(state.state.data.run.status)
          ? 5_000
          : false,
    },
  );
  const monitorId = query.data?.run.monitorId;
  const comparisons = trpc.runs.list.useQuery(
    {
      monitorId: monitorId || "00000000-0000-0000-0000-000000000000",
      limit: 100,
    },
    {
      enabled: Boolean(monitorId),
      refetchInterval: monitorId ? 15_000 : false,
    },
  );
  const cancel = trpc.runs.cancel.useMutation();
  if (query.isLoading)
    return <main className="boot-state">正在读取运行结果…</main>;
  if (query.error)
    return (
      <div className="page-content">
        <div className="panel-state">
          <strong>运行结果加载失败</strong>
          <span>{query.error.message}</span>
        </div>
      </div>
    );
  const run = query.data ? mapRunDetail(query.data) : undefined;
  const comparisonRuns = (comparisons.data || []).map((candidate) =>
    mapRunSummary(candidate, run?.monitorName || "问题监控", run?.version || 1),
  );
  return (
    <RunDetailPage
      run={run}
      comparisonRuns={comparisonRuns}
      onCancel={async () => {
        await cancel.mutateAsync({ runId });
        await Promise.all([
          utils.runs.get.invalidate({ runId }),
          utils.billing.summary.invalidate(),
        ]);
      }}
    />
  );
}

function AdminWorkspace({
  section,
  publishingEnabled = false,
  onInspectRun,
  onInspectExecution,
}: {
  section: AdminSection;
  publishingEnabled?: boolean;
  onInspectRun?: (id: string) => void;
  onInspectExecution?: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const [adminWalletScope, setAdminWalletScope] = useState<
    "monitoring" | "media_publishing"
  >("monitoring");
  const [runFilters, setRunFilters] = useState<AdminRunFilters>({
    userId: "",
    status: "",
    from: "",
    to: "",
  });
  const [auditFilters, setAuditFilters] = useState<AdminAuditFilters>({
    actorId: "",
    action: "",
    domain: "",
    from: "",
    to: "",
  });
  const needsUsers = ["operations", "audit-log"].includes(section);
  const users = trpc.admin.users.list.useQuery(undefined, {
    enabled: needsUsers,
  });
  const billingUsers = trpc.admin.billing.users.useQuery(
    { limit: 100 },
    { enabled: section === "accounts" },
  );
  const mediaBillingUsers = trpc.publisherAdmin.billing.users.useQuery(
    { limit: 100 },
    { enabled: section === "accounts" && publishingEnabled },
  );
  const bankTransfers = trpc.admin.billing.bankTransfers.useQuery(
    { limit: 100 },
    { enabled: section === "accounts" },
  );
  const mediaBankTransfers =
    trpc.publisherAdmin.billing.pendingBankReviews.useQuery(
      { limit: 100 },
      { enabled: section === "accounts" && publishingEnabled },
    );
  const models = trpc.admin.platforms.list.useQuery(undefined, {
    enabled: section === "models",
  });
  const contentRuns = trpc.admin.runs.list.useQuery(
    { limit: 100 },
    { enabled: section === "content-review" },
  );
  const operations = trpc.admin.operations.list.useInfiniteQuery(
    {
      limit: 30,
      ...(runFilters.userId ? { userId: runFilters.userId } : {}),
      ...(runFilters.status
        ? {
            status:
              runFilters.status as ApiOutputs["admin"]["operations"]["list"]["items"][number]["run"]["status"],
          }
        : {}),
      ...(runFilters.from ? { from: startOfLocalDay(runFilters.from) } : {}),
      ...(runFilters.to ? { to: endOfLocalDay(runFilters.to) } : {}),
    },
    {
      enabled: section === "operations",
      getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    },
  );
  const audit = trpc.admin.audit.list.useInfiniteQuery(
    {
      limit: ADMIN_AUDIT_PAGE_SIZE,
      ...(auditFilters.actorId ? { actorId: auditFilters.actorId } : {}),
      ...(auditFilters.action ? { action: auditFilters.action } : {}),
      ...(auditFilters.domain
        ? {
            domain: auditFilters.domain as "monitoring" | "media_publishing",
          }
        : {}),
      ...(auditFilters.from
        ? { from: startOfLocalDay(auditFilters.from) }
        : {}),
      ...(auditFilters.to ? { to: endOfLocalDay(auditFilters.to) } : {}),
    },
    {
      enabled: section === "audit-log",
      getNextPageParam: (lastPage) =>
        lastPage.length === ADMIN_AUDIT_PAGE_SIZE
          ? lastPage[lastPage.length - 1]?.id
          : undefined,
    },
  );
  const overview = trpc.admin.overview.useQuery(undefined, {
    enabled: section === "operations",
    refetchInterval: 15_000,
  });
  const adjustBalance = trpc.admin.billing.adjustBalance.useMutation();
  const adjustMediaBalance = trpc.publisherAdmin.billing.adjust.useMutation();
  const approveBankTransfer = trpc.admin.billing.approve.useMutation();
  const rejectBankTransfer = trpc.admin.billing.reject.useMutation();
  const reviewMediaBankTransfer =
    trpc.publisherAdmin.billing.reviewBankTransfer.useMutation();
  const syncModels = trpc.admin.platforms.sync.useMutation();
  const upsertModel = trpc.admin.platforms.upsert.useMutation();
  const modelRows = (models.data || []).map(mapProviderModel);
  const mediaWalletsByUserId = new Map(
    (mediaBillingUsers.data || []).map((wallet) => [wallet.id, wallet]),
  );
  const accountUsers = (billingUsers.data || []).map((source) => {
    const user = mapAdminBillingUser(source);
    const mediaWallet = mediaWalletsByUserId.get(source.id);
    return {
      ...user,
      mediaBalanceTenThousandths: mediaWallet?.availableTenThousandths ?? "0",
      mediaReservedTenThousandths: mediaWallet?.reservedTenThousandths ?? "0",
      mediaFrozenTenThousandths: mediaWallet?.frozenTenThousandths ?? "0",
      mediaSpentTenThousandths: mediaWallet?.spentTenThousandths ?? "0",
    };
  });
  const view = adminOverview(overview.data, modelRows, overview.dataUpdatedAt);
  const operationPages = operations.data?.pages || [];
  const operationRuns = operationPages.flatMap((page) =>
    page.items.map(mapAdminOperationRun),
  );
  const operationSummary = operationPages[0]?.summary;
  const loadError = [
    users.error,
    billingUsers.error,
    mediaBillingUsers.error,
    bankTransfers.error,
    mediaBankTransfers.error,
    models.error,
    contentRuns.error,
    operations.error,
    audit.error,
    overview.error,
  ].find(Boolean)?.message;
  const refresh = () =>
    Promise.all([
      utils.admin.users.list.invalidate(),
      utils.admin.billing.users.invalidate(),
      utils.publisherAdmin.billing.users.invalidate(),
      utils.admin.billing.bankTransfers.invalidate(),
      utils.publisherAdmin.billing.pendingBankReviews.invalidate(),
      utils.admin.platforms.list.invalidate(),
      utils.admin.overview.invalidate(),
      utils.admin.audit.list.invalidate(),
      utils.admin.operations.list.invalidate(),
      utils.admin.runs.list.invalidate(),
    ]);
  return (
    <AdminPage
      section={section}
      walletScope={adminWalletScope}
      mediaWalletAvailable={publishingEnabled}
      onWalletScopeChange={setAdminWalletScope}
      error={loadError ? `管理数据加载失败：${loadError}` : undefined}
      users={
        section === "accounts"
          ? accountUsers
          : (users.data || []).map(mapAdminUser)
      }
      bankTransfers={(adminWalletScope === "media_publishing"
        ? mediaBankTransfers.data || []
        : bankTransfers.data || []
      ).map(mapAdminBankTransfer)}
      bankTransfersLoading={
        adminWalletScope === "media_publishing"
          ? mediaBankTransfers.isFetching
          : bankTransfers.isFetching
      }
      models={modelRows}
      acceptancePanel={
        section === "models" ? <PlatformAcceptancePanel /> : undefined
      }
      runs={
        section === "operations"
          ? operationRuns
          : (contentRuns.data || []).map(mapAdminRun)
      }
      runFilters={runFilters}
      onRunFiltersChange={setRunFilters}
      runSummary={
        operationSummary
          ? {
              total: operationSummary.totalRuns,
              active:
                numberFromRecord(operationSummary.runsByStatus, "queued") +
                numberFromRecord(
                  operationSummary.runsByStatus,
                  "waiting_quota",
                ) +
                numberFromRecord(operationSummary.runsByStatus, "running") +
                numberFromRecord(
                  operationSummary.runsByStatus,
                  "review_required",
                ),
              completed:
                numberFromRecord(operationSummary.runsByStatus, "completed") +
                numberFromRecord(
                  operationSummary.runsByStatus,
                  "partial_completed",
                ),
              attention:
                numberFromRecord(operationSummary.runsByStatus, "failed") +
                numberFromRecord(
                  operationSummary.runsByStatus,
                  "review_required",
                ),
            }
          : undefined
      }
      runsHasMore={operations.hasNextPage === true}
      runsLoadingMore={operations.isFetchingNextPage}
      onLoadOlderRuns={async () => {
        const result = await operations.fetchNextPage();
        if (result.isError) throw result.error;
      }}
      audit={mergeUniqueAuditPages(audit.data?.pages).map(mapAudit)}
      auditFilters={auditFilters}
      onAuditFiltersChange={setAuditFilters}
      auditHasMore={audit.hasNextPage === true}
      auditLoading={audit.isPending}
      auditLoadingMore={audit.isFetchingNextPage}
      onLoadOlderAudit={async () => {
        const result = await audit.fetchNextPage();
        if (result.isError) throw result.error;
      }}
      provider={view}
      onAdjustBalance={async (
        walletScope,
        id,
        amountTenThousandths,
        reason,
        idempotencyKey,
        publicationItemId,
      ) => {
        if (walletScope === "media_publishing") {
          if (!publicationItemId) {
            throw new Error("媒体发布补偿必须关联已消费发布项目。");
          }
          await adjustMediaBalance.mutateAsync({
            userId: id,
            walletScope,
            publicationItemId,
            amountTenThousandths,
            reason,
            idempotencyKey,
          });
        } else {
          await adjustBalance.mutateAsync({
            userId: id,
            amountTenThousandths,
            reason,
            idempotencyKey,
          });
        }
        await refresh();
      }}
      onReviewBankTransfer={async (
        reviewId,
        decision,
        reason,
        providerTradeNo,
      ) => {
        if (decision === "approve" && !providerTradeNo) {
          throw new Error("批准企业转账前必须填写银行入账流水号。");
        }
        if (adminWalletScope === "media_publishing") {
          await reviewMediaBankTransfer.mutateAsync({
            reviewId,
            decision,
            reason,
            ...(providerTradeNo ? { providerTradeNo } : {}),
          });
          await refresh();
          return;
        }
        if (decision === "approve") {
          if (!providerTradeNo) {
            throw new Error("批准企业转账前必须填写银行入账流水号。");
          }
          await approveBankTransfer.mutateAsync({
            reviewId,
            reason,
            providerTradeNo,
          });
        } else {
          await rejectBankTransfer.mutateAsync({ reviewId, reason });
        }
        await refresh();
      }}
      onSyncModels={async () => {
        await syncModels.mutateAsync();
        await refresh();
      }}
      onUpdateModel={async (model) => {
        await upsertModel.mutateAsync({
          platformId: model.id,
          providerCode: model.code,
          displayName: model.name,
          clientType: model.clientType,
          enabled: model.enabled,
          verified: model.verified,
          supportsReasoning: model.capabilities.reasoning,
          supportsScreenshot: model.capabilities.screenshot,
          supportsDomesticRegion: model.capabilities.region,
          supportsOverseasRegion: model.capabilities.overseas,
        });
        await refresh();
      }}
      onInspectRun={onInspectRun}
      onInspectExecution={onInspectExecution}
    />
  );
}

function startOfLocalDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfLocalDay(value: string) {
  return new Date(`${value}T23:59:59.999`);
}

function AdminOperationRoute({ runId }: { runId: string }) {
  const query = trpc.admin.operations.get.useQuery({ runId });
  if (query.isLoading)
    return <main className="boot-state">正在读取执行详情…</main>;
  if (query.error)
    return (
      <div className="page-content">
        <div className="panel-state">
          <strong>执行详情加载失败</strong>
          <span>{query.error.message}</span>
        </div>
      </div>
    );
  if (!query.data) return null;
  return (
    <AdminOperationDetailPage
      run={{ ...mapAdminRun(query.data), userId: query.data.userId }}
      attempts={query.data.attempts.map((attempt) => ({
        id: attempt.id,
        question: attempt.question,
        platformName: attempt.providerCode,
        providerCode: attempt.providerCode,
        clientType: attempt.clientType,
        repetition: attempt.repetition,
        status: attempt.status,
        providerTaskId: attempt.providerTaskId || undefined,
        providerSubTaskId: attempt.providerSubTaskId || undefined,
        createdAt: new Date(attempt.createdAt).toISOString(),
        submittedAt: attempt.submittedAt
          ? new Date(attempt.submittedAt).toISOString()
          : undefined,
        terminalAt: attempt.terminalAt
          ? new Date(attempt.terminalAt).toISOString()
          : undefined,
        error:
          [attempt.errorCode, attempt.errorMessage]
            .filter(Boolean)
            .join("：") || undefined,
      }))}
    />
  );
}

function AdminRunAuditRoute({ runId }: { runId: string }) {
  const query = trpc.admin.runs.getAudit.useQuery({ runId });
  if (query.isLoading)
    return <main className="boot-state">正在记录访问并读取内容…</main>;
  if (query.error)
    return (
      <div className="page-content">
        <div className="panel-state">
          <strong>查阅内容加载失败</strong>
          <span>{query.error.message}</span>
        </div>
      </div>
    );
  return (
    <RunDetailPage
      run={query.data ? mapRunDetail(query.data) : undefined}
      onCancel={() => undefined}
      allowCancel={false}
      backHref="/admin/monitoring/content-review"
      backLabel="返回内容查阅"
    />
  );
}

function adminOverview(
  value: ApiOutputs["admin"]["overview"] | undefined,
  models: ProviderModel[],
  observedAt?: number,
) {
  const jobs = value?.jobs || {};
  const runs = value?.runs || {};
  return {
    executionStatus:
      value?.executionService.status === "never_seen"
        ? ("never_started" as const)
        : value?.executionService.status,
    heartbeatThresholdSeconds: value?.executionService.thresholdSeconds ?? 90,
    staleForSeconds: value?.executionService.ageSeconds ?? undefined,
    enabledModels: models.filter((model) => model.enabled && model.verified)
      .length,
    discoveredModels: models.length,
    activeRuns:
      numberFromRecord(runs, "queued") +
      numberFromRecord(runs, "waiting_quota") +
      numberFromRecord(runs, "running") +
      numberFromRecord(runs, "review_required"),
    queueDepth:
      numberFromRecord(jobs, "ready") + numberFromRecord(jobs, "retry_wait"),
    unknownSubmissions: numericProperty(value, "submissionUnknownCount"),
    mediaFailures: numericProperty(value, "mediaArchiveFailureCount"),
    providerAuthStatus: value?.providerAuthentication.status || "unknown",
    recentErrors: (value?.recentDeadJobs || []).map((job) => ({
      id: job.id,
      type: job.type,
      code: job.lastErrorCode || "UNKNOWN",
      message: job.lastErrorMessage || "未记录错误摘要",
      updatedAt: new Date(job.updatedAt).toISOString(),
    })),
    oldestReadyAt: value?.oldestReadyAt
      ? new Date(value.oldestReadyAt).toISOString()
      : undefined,
    latestHeartbeatAt: value?.executionService.lastHeartbeatAt
      ? new Date(value.executionService.lastHeartbeatAt).toISOString()
      : undefined,
    observedAt: value?.executionService.observedAt
      ? new Date(value.executionService.observedAt).toISOString()
      : observedAt
        ? new Date(observedAt).toISOString()
        : undefined,
  };
}

function numberFromRecord(value: object, key: string) {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? Number(candidate) : 0;
}
function numericProperty(value: object | null | undefined, key: string) {
  if (!value) return 0;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : 0;
}

/** Resolve the linked tenant using the existing Dashboard cookie. Authentication belongs to Dashboard. */
function LinkedMonitoringWorkspace({ questionSources }: { questionSources?: Record<string, string[]> }) {
  const [location] = useLocation();
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });
  if (!me.data)
    return (
      <div className="monitoring-module">
        <div className="panel-state" role={me.error ? "alert" : "status"}>
          <strong>
            {me.error ? "监控与发布工作区暂时无法读取" : "正在读取工作区…"}
          </strong>
          {me.error && (
            <>
              <span>{me.error.message}</span>
              <button type="button" onClick={() => void me.refetch()}>
                重新连接
              </button>
            </>
          )}
        </div>
      </div>
    );
  const session = mapSession(me.data);
  const administration = location.startsWith("/admin/monitoring");
  return (
    <ServerBackedWorkspace
      user={{
        ...session.user,
        role: administration ? session.user.role : "user",
      }}
      initialBilling={me.data.billing}
      publishingEnabled={me.data.features?.mediaPublishing === true}
      localServerBacked={false}
      questionSources={questionSources}
    />
  );
}

export default function MonitoringModule({ questionSources }: { questionSources?: Record<string, string[]> } = {}) {
  const { user } = useAuth();
  const [client] = useState(createTrpcClient);
  const queryClient = useMemo(createModuleQueryClient, [user?.id]);
  useEffect(
    () => () => {
      queryClient.clear();
    },
    [queryClient],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <LinkedMonitoringWorkspace questionSources={questionSources} />
      </trpc.Provider>
    </QueryClientProvider>
  );
}
