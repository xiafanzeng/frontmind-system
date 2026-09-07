import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Send,
  Upload,
  Users,
  Loader2,
  Trash2,
  AlertTriangle,
  Download,
  ExternalLink,
  PanelRightOpen,
  RefreshCw,
  ArrowLeft,
  ClipboardList,
} from "lucide-react";
import { toast } from "sonner";

import PortalShell, { type PortalNavItem } from "@/components/PortalShell";
import CustomerDashboardMirror, {
  type CustomerDashboardMirrorSection,
} from "@/components/CustomerDashboardMirror";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import DashboardSkeletonEditor from "@/components/DashboardSkeletonEditor";
import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "@/lib/frontmind-api";
import {
  channelDistributionUrl,
  getAdminNav,
  issueMonitorUrl,
} from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import {
  BRAND_TRACKING_CREDITS_INPUT_PATTERN,
  brandTrackingAmountToCredits,
  formatBrandTrackingCredits,
} from "@shared/brand-tracking-credits";
import { keywordCategoryKey } from "@shared/keyword-categories";
const CUSTOMER_DASHBOARD_BUTTON_CLASS =
  "border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700 hover:text-white focus-visible:border-blue-600 focus-visible:ring-blue-600/30 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-700";

const QUESTION_MIRROR_GROUPS = {
  industry: {
    groupId: "ranking",
    groupTitle: "行业排名词",
    groupSubtitle: "行业入口与品牌优胜问题",
    tone: "amber",
  },
  competitor_comparison: {
    groupId: "comparison",
    groupTitle: "竞品对比词",
    groupSubtitle: "差异定位与选择依据",
    tone: "blue",
  },
  reputation: {
    groupId: "reputation",
    groupTitle: "美誉舆情词",
    groupSubtitle: "信任证据与品牌口碑",
    tone: "plum",
  },
  product_scenario: {
    groupId: "scenario",
    groupTitle: "产品场景词",
    groupSubtitle: "应用需求与决策问题",
    tone: "teal",
  },
} as const;

function readDeliveryWorkbenchRequest() {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  return {
    projectAssignmentId: params.get("projectAssignmentId")?.trim() || "",
    section: params.get("section")?.trim() || "",
    focus: params.get("focus") === "1",
  };
}

function normalizeMirrorQuestionText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function registerMirrorQuestionIdentity(
  identities: Map<string, Set<string>>,
  legacyId: string | null | undefined,
  currentId: string,
) {
  if (!legacyId) return;
  const matches = identities.get(legacyId) ?? new Set<string>();
  matches.add(currentId);
  identities.set(legacyId, matches);
}

type QuestionCategory = keyof typeof QUESTION_MIRROR_GROUPS;

type WorkbenchBrandTrackingUsage = {
  rolling30DayCost: string;
  lifetimeCost: string;
  limit: string;
  remaining: string;
  exceededBy: string;
  windowStartedAt: string;
  windowEndsAt: string;
  pendingReconciliationCount: number;
  hasUnknownUsage: boolean;
  keyConfigured: boolean;
  blocked: boolean;
  blockReason: string | null;
};

export const deliveryMemberNav: PortalNavItem[] = [
  {
    label: "客户工作台",
    href: "/",
    icon: Users,
    group: "工作台",
    activePrefixes: ["/delivery/workbench"],
  },
  {
    label: "通用智能体",
    href: "/delivery/agent",
    icon: Bot,
    group: "工具",
  },
];

export function deliveryMemberNavForRole(
  roleType?: DeliveryRoleType | null,
): PortalNavItem[] {
  if (roleType === "monitoring_optimization_engineer") {
    return [
      deliveryMemberNav[0]!,
      {
        label: "问题监控",
        href: issueMonitorUrl,
        icon: Activity,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[1]!,
    ];
  }
  if (roleType === "content_distribution_engineer") {
    return [
      deliveryMemberNav[0]!,
      {
        label: "渠道分发",
        href: channelDistributionUrl,
        icon: Send,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[1]!,
    ];
  }
  return deliveryMemberNav;
}

export const ROLE_DASHBOARD_SECTIONS: Record<
  DeliveryRoleType,
  readonly CustomerDashboardMirrorSection[]
> = {
  ai_operations_engineer: [
    "knowledge-build",
    "brand-tracking",
    "knowledge",
    "website",
  ],
  monitoring_optimization_engineer: [
    "keywords",
    "questions",
    "monitoring",
    "report",
  ],
  content_distribution_engineer: ["response-logic", "content"],
};

export function deliveryDashboardSectionsForAssignment(
  roleType: DeliveryRoleType,
  marketEdition?: "domestic" | "overseas" | null,
) {
  return ROLE_DASHBOARD_SECTIONS[roleType].filter(
    (section) => section !== "brand-tracking" || marketEdition === "overseas",
  );
}

export default function DeliveryMemberDashboard({
  systemAdminMode = false,
}: {
  /** Kept so the legacy /delivery/workbench route can render this same view. */
  customerWorkbench?: boolean;
  /** Lets a system administrator open a role-scoped customer workspace. */
  systemAdminMode?: boolean;
}) {
  return <CustomerWorkbenchView systemAdminMode={systemAdminMode} />;
}

function BrandTrackingUsageEditor({
  projectAssignmentId,
  usage,
  onSaved,
}: {
  projectAssignmentId: string;
  usage: WorkbenchBrandTrackingUsage;
  onSaved: () => Promise<unknown>;
}) {
  const updateLimit = trpc.delivery.mine.updateBrandTrackingLimit.useMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    brandTrackingAmountToCredits(usage.limit) ?? "",
  );

  useEffect(() => {
    setDraft(brandTrackingAmountToCredits(usage.limit) ?? "");
    setEditing(false);
  }, [usage.limit, usage.windowStartedAt]);

  const trimmed = draft.trim();
  const invalid = !BRAND_TRACKING_CREDITS_INPUT_PATTERN.test(trimmed);

  return (
    <section className="page-shell">
      <Card data-testid="brand-tracking-usage-editor">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>品牌追踪积分</CardTitle>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              仅展示该海外客户由 FrontMind
              明确归因的品牌追踪积分消耗；不提供对话内容或凭据配置能力。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={editing ? "ghost" : "outline"}
            disabled={updateLimit.isPending}
            onClick={() => {
              if (editing) {
                setDraft(brandTrackingAmountToCredits(usage.limit) ?? "");
                setEditing(false);
              } else {
                setEditing(true);
              }
            }}
          >
            {editing ? "取消修改" : "修改额度"}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天已使用</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {formatBrandTrackingCredits(usage.rolling30DayCost)}
              </p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天上限</p>
              {editing ? (
                <Input
                  className="mt-3"
                  aria-label="品牌追踪滚动 30 天积分上限"
                  type="text"
                  inputMode="decimal"
                  value={draft}
                  placeholder="例如 10000"
                  onChange={(event) => setDraft(event.target.value)}
                />
              ) : (
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {formatBrandTrackingCredits(usage.limit)}
                </p>
              )}
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">滚动 30 天剩余</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {formatBrandTrackingCredits(usage.remaining)}
              </p>
            </div>
          </div>

          {(usage.blocked || usage.hasUnknownUsage) && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {usage.hasUnknownUsage
                ? `有 ${usage.pendingReconciliationCount} 笔积分记录待确认，未知积分不会按 0 积分处理。`
                : usage.blockReason ||
                  `当前已超出上限 ${formatBrandTrackingCredits(usage.exceededBy)}，新的消息已暂停。`}
            </div>
          )}

          {editing && (
            <div className="mt-4 flex flex-col gap-3 rounded-xl bg-muted/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p
                className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
                role={invalid ? "alert" : undefined}
              >
                {invalid
                  ? "积分上限必须是非负数，最多 15 位整数和 5 位小数。"
                  : "设置为 0 积分可暂停新的品牌追踪；保存后立即按滚动 30 天用量判断。"}
              </p>
              <Button
                type="button"
                className="shrink-0"
                disabled={updateLimit.isPending || invalid}
                onClick={async () => {
                  if (invalid) return;
                  try {
                    await updateLimit.mutateAsync({
                      projectAssignmentId,
                      limitCredits: trimmed,
                    });
                    await onSaved();
                    setEditing(false);
                    toast.success("品牌追踪积分上限已更新");
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "品牌追踪积分上限更新失败",
                    );
                  }
                }}
              >
                {updateLimit.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                保存积分上限
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function CustomerWorkbenchView({
  systemAdminMode = false,
}: {
  systemAdminMode?: boolean;
}) {
  const workbenchRequest = useMemo(readDeliveryWorkbenchRequest, []);
  const assignmentsQuery = trpc.delivery.mine.assignments.useQuery();
  const [dashboardOpen, setDashboardOpen] = useState(workbenchRequest.focus);
  const [dashboardInitialSection, setDashboardInitialSection] =
    useState<CustomerDashboardMirrorSection | null>(
      (workbenchRequest.section as CustomerDashboardMirrorSection) || null,
    );
  const [projectAssignmentId, setProjectAssignmentId] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      workbenchRequest.projectAssignmentId ||
      sessionStorage.getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY) ||
      ""
    );
  });
  const currentAssignment = assignmentsQuery.data?.find(
    (assignment) => assignment.projectAssignmentId === projectAssignmentId,
  );
  const currentAllowedSections = currentAssignment
    ? deliveryDashboardSectionsForAssignment(
        currentAssignment.roleType,
        currentAssignment.marketEdition,
      )
    : [];
  useEffect(() => {
    if (!assignmentsQuery.data) return;
    if (!assignmentsQuery.data.length) {
      sessionStorage.removeItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY);
      setProjectAssignmentId("");
      return;
    }
    if (
      !assignmentsQuery.data.some(
        (assignment) => assignment.projectAssignmentId === projectAssignmentId,
      )
    ) {
      const nextProjectAssignmentId =
        assignmentsQuery.data[0]!.projectAssignmentId;
      sessionStorage.setItem(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
        nextProjectAssignmentId,
      );
      setProjectAssignmentId(nextProjectAssignmentId);
      return;
    }
    sessionStorage.setItem(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      projectAssignmentId,
    );
  }, [assignmentsQuery.data, projectAssignmentId]);
  const workbench = trpc.delivery.mine.workbench.useQuery(
    { projectAssignmentId },
    { enabled: Boolean(currentAssignment) },
  );
  const openCustomerDashboard = () => {
    setDashboardInitialSection(currentAllowedSections[0] || "home");
    setDashboardOpen(true);
  };
  const closeCustomerDashboard = () => setDashboardOpen(false);
  const currentNav = systemAdminMode
    ? getAdminNav(true)
    : deliveryMemberNavForRole(currentAssignment?.roleType);
  const shellEyebrow = systemAdminMode
    ? "系统管理员 · 客户工作台"
    : "工程师 · 客户工作台";
  const shellTitle = systemAdminMode ? "系统管理员工作台" : "客户工作台";
  const shellToolbar = systemAdminMode ? (
    <Button asChild size="sm" variant="outline">
      <a
        href={
          currentAssignment
            ? `/admin/customers/${currentAssignment.customerUserId}/workspace`
            : "/admin/workspace"
        }
      >
        <ArrowLeft className="h-4 w-4" />
        返回客户工作台
      </a>
    </Button>
  ) : undefined;
  const projectSelector = assignmentsQuery.data?.length ? (
    <select
      aria-label="当前客户"
      className="h-10 w-full rounded-md border bg-card px-3 text-sm"
      value={projectAssignmentId}
      onChange={(event) => {
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("projectAssignmentId", event.target.value);
          url.searchParams.delete("section");
          url.searchParams.delete("focus");
          window.history.replaceState({}, "", url);
        }
        sessionStorage.setItem(
          DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
          event.target.value,
        );
        setDashboardOpen(false);
        setProjectAssignmentId(event.target.value);
      }}
    >
      {assignmentsQuery.data.map((assignment) => (
        <option
          key={assignment.projectAssignmentId}
          value={assignment.projectAssignmentId}
        >
          {assignment.customerName || assignment.customerUsername}
          {systemAdminMode
            ? ` · ${DELIVERY_ROLE_LABELS[assignment.roleType]}`
            : ""}
        </option>
      ))}
    </select>
  ) : null;

  if (assignmentsQuery.error) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <p className="mt-4 font-medium">客户项目读取失败</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {assignmentsQuery.error.message || "请检查网络连接后重试。"}
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void assignmentsQuery.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (assignmentsQuery.isLoading) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
            正在载入客户项目
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (!assignmentsQuery.isLoading && !assignmentsQuery.data?.length) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-4 font-medium">
              {systemAdminMode
                ? "当前没有可处理的客户项目"
                : "尚未分配客户项目，请联系交付管理员"}
            </p>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  if (currentAssignment && workbench.error) {
    return (
      <PortalShell
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        toolbar={shellToolbar}
        roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <p className="mt-4 font-medium">项目工作台读取失败</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {workbench.error.message || "请检查网络连接后重试。"}
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void workbench.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  const dashboardMirrorPayload = workbench.data?.dashboard?.payload ?? {
    brandName:
      currentAssignment?.customerName ||
      currentAssignment?.customerUsername ||
      "当前客户",
    headline: "客户页面尚未发布内容",
    summary: "",
    metrics: [],
    sections: [],
    keywordTables: [],
    questions: [],
    monitoringAnswers: [],
    citations: [],
    contentAssets: [],
    optimizationReport: null,
    progressReports: [],
  };
  const dashboardQuestionById = new Map(
    dashboardMirrorPayload.questions.map((question) => [question.id, question]),
  );
  const dashboardQuestionsByText = new Map<
    string,
    (typeof dashboardMirrorPayload.questions)[number][]
  >();
  for (const question of dashboardMirrorPayload.questions) {
    const identity = normalizeMirrorQuestionText(question.question);
    dashboardQuestionsByText.set(identity, [
      ...(dashboardQuestionsByText.get(identity) ?? []),
      question,
    ]);
  }
  const authoritativeQuestionRows = (
    workbench.data?.customerQuestions ?? []
  ).filter(
    (question) =>
      question.status === "selected" &&
      question.selectionApprovalStatus === "approved" &&
      Boolean(question.category),
  );
  const authoritativeIdsByText = new Map<string, string[]>();
  for (const question of authoritativeQuestionRows) {
    const identity = normalizeMirrorQuestionText(question.question);
    authoritativeIdsByText.set(identity, [
      ...(authoritativeIdsByText.get(identity) ?? []),
      question.id,
    ]);
  }
  const legacyQuestionIdentities = new Map<string, Set<string>>();
  const authoritativeQuestions = authoritativeQuestionRows.flatMap(
    (question) => {
      const category = question.category as QuestionCategory;
      const group = QUESTION_MIRROR_GROUPS[category];
      if (!group) return [];
      const normalizedText = normalizeMirrorQuestionText(question.question);
      const uniqueTextMatch =
        authoritativeIdsByText.get(normalizedText)?.length === 1 &&
        dashboardQuestionsByText.get(normalizedText)?.length === 1
          ? dashboardQuestionsByText.get(normalizedText)?.[0]
          : undefined;
      const published =
        [
          dashboardQuestionById.get(question.id),
          question.sourceQuestionId
            ? dashboardQuestionById.get(question.sourceQuestionId)
            : undefined,
          question.externalQuestionId
            ? dashboardQuestionById.get(question.externalQuestionId)
            : undefined,
        ].find(
          (candidate) =>
            candidate &&
            normalizeMirrorQuestionText(candidate.question) === normalizedText,
        ) || uniqueTextMatch;
      registerMirrorQuestionIdentity(
        legacyQuestionIdentities,
        published?.id,
        question.id,
      );
      return [
        {
          id: question.id,
          ...group,
          question: question.question,
          intent: question.intent || published?.intent || "",
          summary: question.rationale || published?.summary || "",
        },
      ];
    },
  );
  const currentQuestionIdByLegacyId = new Map(
    [...legacyQuestionIdentities.entries()].flatMap(([legacyId, currentIds]) =>
      currentIds.size === 1 ? [[legacyId, [...currentIds][0]!] as const] : [],
    ),
  );
  const authoritativeMonitoringAnswers =
    dashboardMirrorPayload.monitoringAnswers.flatMap((answer) => {
      const currentQuestionId = currentQuestionIdByLegacyId.get(
        answer.questionId,
      );
      return currentQuestionId
        ? [{ ...answer, questionId: currentQuestionId }]
        : [];
    });
  const authoritativeQuestionTextById = new Map(
    authoritativeQuestionRows.map((question) => [
      question.id,
      normalizeMirrorQuestionText(question.question),
    ]),
  );
  const authoritativeResponseLogicRecords = (
    workbench.data?.responseLogicRecords ?? []
  ).filter(
    (record) =>
      authoritativeQuestionTextById.get(record.questionId) ===
      normalizeMirrorQuestionText(record.question),
  );
  const customerMirrorPayload = {
    ...dashboardMirrorPayload,
    ...(currentAssignment?.roleType === "monitoring_optimization_engineer"
      ? {
          questions: authoritativeQuestions,
          monitoringAnswers: authoritativeMonitoringAnswers,
        }
      : {}),
  };
  const requestedSection =
    dashboardInitialSection ||
    (workbenchRequest.section as CustomerDashboardMirrorSection);
  const initialMirrorSection =
    currentAssignment && currentAllowedSections.includes(requestedSection)
      ? requestedSection
      : currentAssignment
        ? currentAllowedSections[0]
        : "home";
  if (dashboardOpen && currentAssignment) {
    return (
      <PortalShell
        mode="fullscreen"
        eyebrow={shellEyebrow}
        title={shellTitle}
        navItems={currentNav}
        roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
      >
        <DashboardSkeletonEditor
          userId={currentAssignment.customerUserId}
          projectAssignmentId={currentAssignment.projectAssignmentId}
          workspace={{
            ...workbench.data?.dashboard,
            payload: customerMirrorPayload,
          }}
          loading={workbench.isLoading}
          dashboardLayout="workspace"
          allowedSections={currentAllowedSections}
          renderSectionWorkspace={(section) =>
            section === "brand-tracking" &&
            workbench.data?.brandTrackingUsage ? (
              <BrandTrackingUsageEditor
                projectAssignmentId={currentAssignment.projectAssignmentId}
                usage={workbench.data.brandTrackingUsage}
                onSaved={() => workbench.refetch()}
              />
            ) : null
          }
          initialSection={initialMirrorSection}
          marketEdition={currentAssignment.marketEdition}
          responseLogicRecords={authoritativeResponseLogicRecords}
          servicePortal={workbench.data?.servicePortal}
          authoritativeQuestions={authoritativeQuestionRows.map((question) => ({
            ...question,
            category: question.category!,
          }))}
          onWorkspaceChanged={() => workbench.refetch()}
          onExitDashboard={closeCustomerDashboard}
          knowledgePreview={
            workbench.data?.aiOperationsPreview
              ? {
                  progress:
                    workbench.data.aiOperationsPreview.knowledgeProgress,
                  snapshot:
                    workbench.data.aiOperationsPreview.knowledgeSnapshot,
                }
              : null
          }
        />
      </PortalShell>
    );
  }

  return (
    <PortalShell
      eyebrow={shellEyebrow}
      title={shellTitle}
      navItems={currentNav}
      toolbar={shellToolbar}
      roleLabel={systemAdminMode ? "系统管理员" : "工程师"}
    >
      <div className="grid gap-5">
        <Card data-testid="current-delivery-target">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <span className="shrink-0 text-sm font-semibold">当前客户</span>
            <div className="min-w-0 flex-1">{projectSelector}</div>
            <Button
              type="button"
              className={`${CUSTOMER_DASHBOARD_BUTTON_CLASS} shrink-0`}
              onClick={() => openCustomerDashboard()}
            >
              进入客户看板
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {currentAssignment && workbench.data?.brandTrackingUsage && (
        <BrandTrackingUsageEditor
          projectAssignmentId={currentAssignment.projectAssignmentId}
          usage={workbench.data.brandTrackingUsage}
          onSaved={() => workbench.refetch()}
        />
      )}
    </PortalShell>
  );
}
