import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ClipboardList,
  Send,
  Upload,
  Users,
  Loader2,
  Trash2,
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  ArrowLeft,
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
import {
  DELIVERY_OPERATION_LABELS,
  deliveryTicketActionGuidance,
} from "@/lib/delivery-workflow";
import {
  buildDeliveryCompletionPayload,
  createDeliveryCompletionDraft,
  deliveryCompletionCreatesNextStep,
  deliveryCompletionRequiresPublicUrl,
  type DeliveryCompletionDraft,
  validateDeliveryCompletionDraft,
} from "@/lib/delivery-ticket-completion";
import {
  DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
  uploadFile,
} from "@/lib/frontmind-api";
import {
  channelDistributionUrl,
  getAdminNav,
  issueMonitorUrl,
} from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryWorkflowOperation,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import {
  DELIVERY_TICKET_STATUS_LABELS,
  type DeliveryTicketStatus,
} from "@shared/delivery-ticket";

export const deliveryMemberNav: PortalNavItem[] = [
  { label: "我的工单", href: "/", icon: ClipboardList, group: "工作台" },
  {
    label: "客户工作台",
    href: "/delivery/workbench",
    icon: Users,
    group: "工作台",
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
      deliveryMemberNav[1]!,
      {
        label: "问题监控",
        href: issueMonitorUrl,
        icon: Activity,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[2]!,
    ];
  }
  if (roleType === "content_distribution_engineer") {
    return [
      deliveryMemberNav[0]!,
      deliveryMemberNav[1]!,
      {
        label: "渠道分发",
        href: channelDistributionUrl,
        icon: Send,
        group: "工具",
        external: true,
        newWindow: true,
      },
      deliveryMemberNav[2]!,
    ];
  }
  return deliveryMemberNav;
}

export const ROLE_DASHBOARD_SECTIONS: Record<
  DeliveryRoleType,
  readonly CustomerDashboardMirrorSection[]
> = {
  ai_operations_engineer: ["knowledge-build", "knowledge", "website"],
  monitoring_optimization_engineer: [
    "keywords",
    "questions",
    "monitoring",
    "report",
  ],
  content_distribution_engineer: ["content"],
};

type BusinessModuleImportDefinition = {
  module:
    | "keywords"
    | "questions"
    | "monitoring"
    | "optimization-report"
    | "response-logic"
    | "content-assets";
  label: string;
  accept: string;
};

type BusinessModuleImportIssue =
  | string
  | {
      level?: string;
      severity?: string;
      message?: string;
      sheet?: string;
      row?: number;
    };

type BusinessModuleImportPreview = {
  sourceName?: string;
  fileHash?: string;
  preflightToken?: string;
  preflightExpiresAt?: string;
  preflightTargetBatchKey?: string;
  targetBatchRequired?: boolean;
  suggestedBatchKey?: string;
  availableBatches?: Array<{
    batchKey?: string;
    sourceName?: string;
    collectedAt?: string | number;
    sampleCount?: number;
  }>;
  mode?: string;
  sampleCount?: number;
  citationCount?: number;
  questions?: Array<
    string | { id?: string; label?: string; question?: string }
  >;
  models?: Array<
    string | { key?: string; value?: string; label?: string; name?: string }
  >;
  dates?: string[];
  summary?: string[];
  recordStats?: Array<{
    label?: string;
    beforeCount?: number;
    afterCount?: number;
    added?: number;
    updated?: number;
    removed?: number;
    unchanged?: number;
  }>;
  issues?: BusinessModuleImportIssue[];
};

type PendingBusinessModuleImport = {
  definition: BusinessModuleImportDefinition;
  file: File;
  preview: BusinessModuleImportPreview;
  targetBatchKey: string;
};

const TICKET_MODULE_IMPORTS: Record<string, BusinessModuleImportDefinition[]> =
  {
    question_catalog: [
      {
        module: "keywords",
        label: "上传品牌词库",
        accept: ".json,application/json",
      },
      {
        module: "questions",
        label: "上传问题目录",
        accept: ".json,application/json",
      },
    ],
    initial_monitoring: [
      {
        module: "monitoring",
        label: "预检并发布监控数据",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    monitoring_import: [
      {
        module: "monitoring",
        label: "预检并发布监控数据",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    monitoring_retest: [
      {
        module: "monitoring",
        label: "上传复测结果",
        accept: ".json,.csv,.xlsx,application/json,text/csv",
      },
    ],
    stage_report: [
      {
        module: "optimization-report",
        label: "上传阶段报告",
        accept: ".json,application/json",
      },
    ],
    response_logic: [
      {
        module: "response-logic",
        label: "上传应答逻辑",
        accept: ".json,application/json",
      },
    ],
    content_asset_publish: [
      {
        module: "content-assets",
        label: "上传内容资产",
        accept: ".json,application/json",
      },
    ],
  };

function businessModulePreflightUsable(preview: BusinessModuleImportPreview) {
  if (!preview.fileHash?.trim() || !preview.preflightToken?.trim())
    return false;
  if (!preview.preflightExpiresAt) return true;
  const expiresAt = Date.parse(preview.preflightExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 5_000;
}

function businessModulePreviewHasErrors(preview: BusinessModuleImportPreview) {
  return (
    preview.mode === "invalid" ||
    preview.issues?.some(
      (issue) =>
        typeof issue !== "string" &&
        (issue.level === "error" || issue.severity === "error"),
    ) === true
  );
}

function businessModuleIssueText(issue: BusinessModuleImportIssue) {
  if (typeof issue === "string") return issue;
  const location = [
    issue.sheet?.trim(),
    Number.isFinite(issue.row) ? `第 ${issue.row} 行` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [location, issue.message?.trim()].filter(Boolean).join("：");
}

function businessModuleValueText(
  value:
    | string
    | {
        id?: string;
        key?: string;
        value?: string;
        label?: string;
        name?: string;
        question?: string;
      },
) {
  if (typeof value === "string") return value;
  return (
    value.label ||
    value.name ||
    value.question ||
    value.value ||
    value.id ||
    value.key ||
    "未命名"
  );
}

function businessModuleBatchLabel(
  batch: NonNullable<BusinessModuleImportPreview["availableBatches"]>[number],
) {
  const timestamp = batch.collectedAt
    ? new Date(batch.collectedAt).getTime()
    : Number.NaN;
  const date = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(timestamp)
    : "";
  return [
    date,
    batch.sourceName,
    Number.isFinite(batch.sampleCount) ? `${batch.sampleCount} 条答案` : "",
    batch.batchKey,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function DeliveryMemberDashboard({
  customerWorkbench = false,
  systemAdminMode = false,
}: {
  /** The old taskHistory prop was removed: /delivery/tasks now aliases /. */
  customerWorkbench?: boolean;
  /** Lets a system administrator use the full role-owned ticket workbench. */
  systemAdminMode?: boolean;
}) {
  return customerWorkbench || systemAdminMode ? (
    <CustomerWorkbenchView systemAdminMode={systemAdminMode} />
  ) : (
    <MyTicketsView />
  );
}

function CustomerWorkbenchView({
  systemAdminMode = false,
}: {
  systemAdminMode?: boolean;
}) {
  const assignmentsQuery = trpc.delivery.mine.assignments.useQuery();
  const [projectAssignmentId, setProjectAssignmentId] = useState(() => {
    if (typeof window === "undefined") return "";
    const requestedProjectAssignmentId = systemAdminMode
      ? new URLSearchParams(window.location.search)
          .get("projectAssignmentId")
          ?.trim()
      : "";
    return (
      requestedProjectAssignmentId ||
      sessionStorage.getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY) ||
      ""
    );
  });
  const currentAssignment = assignmentsQuery.data?.find(
    (assignment) => assignment.projectAssignmentId === projectAssignmentId,
  );
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
    if (systemAdminMode) {
      sessionStorage.setItem(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
        projectAssignmentId,
      );
    }
  }, [assignmentsQuery.data, projectAssignmentId, systemAdminMode]);
  const workbench = trpc.delivery.mine.workbench.useQuery(
    { projectAssignmentId },
    { enabled: Boolean(currentAssignment) },
  );
  const customerActionTickets = trpc.delivery.mine.tickets.useInfiniteQuery(
    {
      customerUserId: currentAssignment?.customerUserId ?? 1,
      projectAssignmentId: currentAssignment?.projectAssignmentId,
      statusGroup: "pending",
      limit: 50,
    },
    {
      enabled: Boolean(currentAssignment),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );
  const customerActionItems = useMemo(
    () =>
      (customerActionTickets.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter(
          (ticket) =>
            ticket.statusGroup === "pending" &&
            ticket.userId === currentAssignment?.customerUserId &&
            ticket.assignedProjectAssignmentId ===
              currentAssignment?.projectAssignmentId,
        ),
    [
      currentAssignment?.customerUserId,
      currentAssignment?.projectAssignmentId,
      customerActionTickets.data?.pages,
    ],
  );
  const refreshCustomerActionsAndPreview = async () => {
    await Promise.all([customerActionTickets.refetch(), workbench.refetch()]);
  };
  const approveQuestionSelection =
    trpc.delivery.mine.approveQuestionSelection.useMutation();
  const pendingCustomerQuestions = useMemo(
    () =>
      (workbench.data?.customerQuestions ?? []).filter(
        (question) =>
          question.status === "candidate" &&
          question.selectionApprovalStatus === "pending",
      ),
    [workbench.data?.customerQuestions],
  );
  const currentNav = systemAdminMode
    ? getAdminNav(true)
    : deliveryMemberNavForRole(currentAssignment?.roleType);
  const shellEyebrow = systemAdminMode
    ? "系统管理员 · 工单处理"
    : "工程师 · 客户工作台";
  const shellTitle = systemAdminMode
    ? "系统管理员处理工作台"
    : "我的客户工作台";
  const shellToolbar = systemAdminMode ? (
    <Button asChild size="sm" variant="outline">
      <a href="/admin/workspace">
        <ArrowLeft className="h-4 w-4" />
        返回客户工单
      </a>
    </Button>
  ) : undefined;
  const projectSelector = assignmentsQuery.data?.length ? (
    <select
      aria-label="当前客户项目"
      className="h-10 w-full rounded-md border bg-card px-3 text-sm"
      value={projectAssignmentId}
      onChange={(event) => {
        if (systemAdminMode && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("projectAssignmentId", event.target.value);
          window.history.replaceState({}, "", url);
        }
        sessionStorage.setItem(
          DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
          event.target.value,
        );
        setProjectAssignmentId(event.target.value);
      }}
    >
      {assignmentsQuery.data.map((assignment) => (
        <option
          key={assignment.projectAssignmentId}
          value={assignment.projectAssignmentId}
        >
          {assignment.customerName || assignment.customerUsername} ·{" "}
          {DELIVERY_ROLE_LABELS[assignment.roleType]}
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
        roleLabel={`${currentAssignment.customerName || currentAssignment.customerUsername} · ${DELIVERY_ROLE_LABELS[currentAssignment.roleType]}`}
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

  const customerMirrorPayload = workbench.data?.dashboard?.payload ?? {
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

  return (
    <PortalShell
      eyebrow={shellEyebrow}
      title={shellTitle}
      navItems={currentNav}
      toolbar={shellToolbar}
      roleLabel={
        currentAssignment
          ? `${currentAssignment.customerName || currentAssignment.customerUsername} · ${DELIVERY_ROLE_LABELS[currentAssignment.roleType]}`
          : undefined
      }
    >
      <div className="grid gap-5">
        <Card data-testid="current-delivery-target">
          <CardHeader className="gap-3">
            <CardTitle>当前客户</CardTitle>
            {projectSelector}
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm">
              <p className="font-medium">
                {currentAssignment?.customerName ||
                  currentAssignment?.customerUsername ||
                  "当前客户"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {systemAdminMode
                  ? "以系统管理员身份处理当前岗位工单，并预览客户最终看到的正式看板。"
                  : "在下方直接提交或修改当前岗位的交付内容，并预览客户最终看到的正式看板。"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {currentAssignment && (
        <Card
          id="customer-content-actions"
          data-testid="customer-content-actions"
          className="mt-5 scroll-mt-5"
        >
          <CardHeader>
            <CardTitle>内容提交与修改</CardTitle>
            <p className="text-sm text-muted-foreground">
              这里只提供当前客户、当前岗位可执行的内容操作；完整工单列表、筛选和处理历史统一在“我的工单”查看。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {customerActionTickets.isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />
                正在载入可操作内容
              </div>
            ) : customerActionTickets.error ? (
              <div className="py-10 text-center">
                <AlertTriangle className="mx-auto h-6 w-6 text-destructive" />
                <p className="mt-3 text-sm font-medium">内容操作读取失败</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {customerActionTickets.error.message}
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => void customerActionTickets.refetch()}
                >
                  <RefreshCw className="h-4 w-4" />
                  重试
                </Button>
              </div>
            ) : customerActionItems.length ? (
              <>
                {customerActionItems.map((ticket) => (
                  <div
                    key={ticket.id}
                    data-testid="customer-content-action"
                    className="rounded-xl border p-4"
                  >
                    <p className="font-medium">{ticket.title}</p>
                    {operationLabel(ticket.operation) && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {operationLabel(ticket.operation)}
                      </p>
                    )}
                    {ticket.operation === "knowledge_reset" &&
                      ticket.status === "submitted" &&
                      ticket.clientRequestId && (
                        <KnowledgeResetDecision
                          projectAssignmentId={
                            currentAssignment.projectAssignmentId
                          }
                          requestId={ticket.clientRequestId}
                          systemAdminMode={systemAdminMode}
                          onDone={refreshCustomerActionsAndPreview}
                        />
                      )}
                    {ticket.operation !== "knowledge_reset" &&
                      !ticket.dependencyBlockReason && (
                        <DeliveryTicketActions
                          projectAssignmentId={
                            currentAssignment.projectAssignmentId
                          }
                          ticket={ticket}
                          onDone={refreshCustomerActionsAndPreview}
                        />
                      )}
                    {ticket.dependencyBlockReason && (
                      <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                        <strong>等待前置内容</strong>
                        <p className="mt-0.5">{ticket.dependencyBlockReason}</p>
                      </div>
                    )}
                  </div>
                ))}
                {customerActionTickets.hasNextPage && (
                  <div className="pt-2 text-center">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={customerActionTickets.isFetchingNextPage}
                      onClick={() => void customerActionTickets.fetchNextPage()}
                    >
                      {customerActionTickets.isFetchingNextPage && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      加载更多可操作内容
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                当前客户的本岗位暂无可提交或修改内容
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {currentAssignment?.roleType === "monitoring_optimization_engineer" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>客户问题审核</CardTitle>
            <p className="text-sm text-muted-foreground">
              客户提交选择后在这里确认；只有“品牌词库与问题目录”工单处于解锁状态时可以通过。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingCustomerQuestions.map((question) => (
              <div
                key={question.id}
                className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{question.category}</Badge>
                    <span className="text-xs text-muted-foreground">
                      客户已提交审核
                    </span>
                  </div>
                  <p className="mt-2 font-medium leading-6">
                    {question.question}
                  </p>
                  {question.intent && (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {question.intent}
                    </p>
                  )}
                </div>
                <Button
                  className="shrink-0"
                  disabled={approveQuestionSelection.isPending}
                  onClick={async () => {
                    try {
                      await approveQuestionSelection.mutateAsync({
                        projectAssignmentId,
                        questionId: question.id,
                        expectedRevision: question.revision,
                      });
                      await refreshCustomerActionsAndPreview();
                      toast.success("客户问题已审核通过");
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "问题审核失败",
                      );
                    }
                  }}
                >
                  {approveQuestionSelection.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  审核通过
                </Button>
              </div>
            ))}
            {!pendingCustomerQuestions.length && (
              <p className="py-7 text-center text-sm text-muted-foreground">
                暂无客户提交的待审核问题
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {currentAssignment && (
        <div id="customer-delivery-preview" className="mt-5 scroll-mt-5">
          {workbench.data?.dashboard || workbench.data?.aiOperationsPreview ? (
            <CustomerDashboardMirror
              payload={customerMirrorPayload}
              websiteWorkspace={
                workbench.data?.aiOperationsPreview?.websiteWorkspace
              }
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
              allowedSections={
                ROLE_DASHBOARD_SECTIONS[currentAssignment.roleType]
              }
              initialSection={
                ROLE_DASHBOARD_SECTIONS[currentAssignment.roleType][0]
              }
              heading="客户页面内容与发布"
              description={
                workbench.data?.dashboard
                  ? `这里只展示本岗位交付后客户真正能看到或操作的正式内容，当前版本 R${workbench.data.dashboard.revision}。教程、内部流程和其他岗位模块不进入验收视图。`
                  : "这里只展示本岗位交付后客户真正能看到或操作的正式内容；教程、内部流程和其他岗位模块不进入验收视图。"
              }
              editActions={
                <a
                  href="#customer-content-actions"
                  className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium shadow-sm transition hover:bg-accent"
                >
                  提交或修改当前客户内容
                </a>
              }
            />
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                该客户尚未发布用户看板内容。
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </PortalShell>
  );
}

const TERMINAL_STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  rejected: "已拒绝",
  cancelled: "已取消",
};

function operationLabel(value: string | null | undefined) {
  if (!value) return "";
  return DELIVERY_OPERATION_LABELS[value as DeliveryWorkflowOperation] || value;
}

const KNOWLEDGE_RESET_REASON_LABELS: Record<string, string> = {
  stuck: "知识库流程卡住",
  upload_error: "上传资料有误",
  build_error: "知识库构建异常",
  enterprise_materials: "企业资料需要更换",
  other: "其他原因",
};

const KNOWLEDGE_RESET_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  approved: "已批准",
  rejected: "已拒绝",
};

function displayTaskDate(value: number | Date | null | undefined) {
  if (!value) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function MyTicketsView() {
  const assignments = trpc.delivery.mine.assignments.useQuery();
  const selectedProjectAssignmentId =
    typeof window === "undefined"
      ? ""
      : sessionStorage.getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY) || "";
  const selectedRoleType =
    assignments.data?.find(
      (assignment) =>
        assignment.projectAssignmentId === selectedProjectAssignmentId,
    )?.roleType ?? assignments.data?.[0]?.roleType;
  const [statusGroup, setStatusGroup] = useState("");
  const [customerUserId, setCustomerUserId] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      new URLSearchParams(window.location.search).get("customerUserId") || ""
    );
  });
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const tickets = trpc.delivery.mine.tickets.useInfiniteQuery(
    {
      ...(customerUserId ? { customerUserId: Number(customerUserId) } : {}),
      ...(statusGroup
        ? { statusGroup: statusGroup as "pending" | "completed" }
        : {}),
      limit: 50,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );
  const detail = trpc.delivery.mine.ticketDetail.useQuery(
    {
      ticketId: selectedTicketId || "00000000-0000-4000-8000-000000000000",
    },
    { enabled: Boolean(selectedTicketId), retry: false },
  );
  const ticketPages = tickets.data?.pages ?? [];
  const ticketSummary = ticketPages[0];
  const items = ticketPages.flatMap((page) => page.items);
  const customerOptions = ticketSummary?.filters.customers ?? [];
  const pendingItems = items.filter((item) => item.statusGroup === "pending");
  const completedItems = items.filter(
    (item) => item.statusGroup === "completed",
  );
  const nextTicket = ticketSummary?.nextPending;
  const chooseCustomer = (nextCustomerUserId: string) => {
    setCustomerUserId(nextCustomerUserId);
  };

  return (
    <PortalShell
      eyebrow="工程师 · 全部客户"
      title="我的工单"
      navItems={deliveryMemberNavForRole(selectedRoleType)}
      toolbar={
        <Button
          variant="outline"
          size="sm"
          disabled={tickets.isFetching}
          onClick={() => void tickets.refetch()}
        >
          <RefreshCw
            className={tickets.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
          刷新
        </Button>
      }
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Card className="border-primary/25 bg-primary/[0.035] sm:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-primary">现在优先处理</p>
            <p className="mt-1 font-semibold">
              {nextTicket?.title ||
                operationLabel(nextTicket?.operation) ||
                "当前没有待处理工单"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {nextTicket
                ? `${nextTicket.customerName} · ${deliveryTicketActionGuidance(nextTicket.status as DeliveryTicketStatus).description}`
                : "当前负责的全部客户都没有待处理工单。"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">待处理</p>
            <p className="mt-1 text-2xl font-semibold">
              {ticketSummary?.counts.pending ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">已完成</p>
            <p className="mt-1 text-2xl font-semibold">
              {ticketSummary?.counts.completed ?? 0}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div>
            <CardTitle>我的工单</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              默认汇总当前工程师负责的全部客户；选择客户只过滤本工单池，不影响其他客户工单的归属。
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="客户快捷筛选">
            <Button
              type="button"
              size="sm"
              variant={customerUserId ? "outline" : "default"}
              onClick={() => chooseCustomer("")}
            >
              全部客户
            </Button>
            {customerOptions.map((customer) => (
              <Button
                key={customer.id}
                type="button"
                size="sm"
                variant={
                  customerUserId === String(customer.id) ? "default" : "outline"
                }
                onClick={() => chooseCustomer(String(customer.id))}
              >
                {customer.name}
              </Button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              aria-label="按客户筛选"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={customerUserId}
              onChange={(event) => chooseCustomer(event.target.value)}
            >
              <option value="">全部客户</option>
              {customerOptions.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                  {customer.username ? ` · @${customer.username}` : ""}
                </option>
              ))}
            </select>
            <select
              aria-label="按状态筛选"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={statusGroup}
              onChange={(event) => setStatusGroup(event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="pending">待处理</option>
              <option value="completed">已完成</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {tickets.isLoading ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
              正在载入全部客户工单
            </div>
          ) : tickets.error ? (
            <div className="py-14 text-center">
              <AlertTriangle className="mx-auto h-7 w-7 text-destructive" />
              <p className="mt-3 font-medium">工单读取失败</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tickets.error.message}
              </p>
            </div>
          ) : items.length ? (
            <>
              {pendingItems.map((item) => {
                const dependencyBlockReason = item.dependencyBlockReason;
                const isNewCustomerTicket =
                  item.status === "submitted" &&
                  item.createdByUserId === item.userId;
                return (
                  <div
                    key={item.id}
                    data-new-customer-ticket={isNewCustomerTicket || undefined}
                    className={`rounded-xl border p-4 ${
                      isNewCustomerTicket
                        ? "border-red-500 bg-red-50/80 ring-2 ring-red-500/25"
                        : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{item.title}</p>
                        <p className="mt-1 text-sm text-foreground/75">
                          {item.customerName}
                          {item.customerUsername
                            ? ` · @${item.customerUsername}`
                            : ""}
                        </p>
                      </div>
                      <Badge
                        variant={
                          isNewCustomerTicket ? "destructive" : "outline"
                        }
                      >
                        {isNewCustomerTicket
                          ? "用户新提交"
                          : DELIVERY_TICKET_STATUS_LABELS[
                              item.status as DeliveryTicketStatus
                            ] || item.status}
                      </Badge>
                    </div>
                    <div className="mt-3 rounded-xl bg-muted/35 px-3 py-2 text-xs leading-5">
                      <strong>
                        {
                          deliveryTicketActionGuidance(
                            item.status as DeliveryTicketStatus,
                          ).label
                        }
                      </strong>
                      <p className="mt-0.5 text-muted-foreground">
                        {
                          deliveryTicketActionGuidance(
                            item.status as DeliveryTicketStatus,
                          ).description
                        }
                      </p>
                    </div>
                    {item.operation === "knowledge_reset" &&
                      item.status === "submitted" &&
                      item.assignedProjectAssignmentId &&
                      item.clientRequestId && (
                        <KnowledgeResetDecision
                          projectAssignmentId={item.assignedProjectAssignmentId}
                          requestId={item.clientRequestId}
                          onDone={() => tickets.refetch()}
                        />
                      )}
                    {item.operation !== "knowledge_reset" &&
                      item.assignedProjectAssignmentId &&
                      !dependencyBlockReason && (
                        <DeliveryTicketActions
                          projectAssignmentId={item.assignedProjectAssignmentId}
                          ticket={item}
                          onDone={() => tickets.refetch()}
                        />
                      )}
                    {dependencyBlockReason && (
                      <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                        <strong>等待前置工单</strong>
                        <p className="mt-0.5">{dependencyBlockReason}</p>
                      </div>
                    )}
                  </div>
                );
              })}
              {completedItems.length > 0 && (
                <div className="pt-4">
                  <p className="mb-3 text-sm font-semibold">已完成工单</p>
                  <div className="space-y-3">
                    {completedItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="w-full rounded-xl border p-4 text-left transition hover:border-primary/40 hover:bg-muted/30"
                        onClick={() => setSelectedTicketId(item.id)}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{item.title}</p>
                            <p className="mt-1 text-sm text-foreground/75">
                              {item.customerName}
                            </p>
                          </div>
                          <Badge variant="outline">
                            {TERMINAL_STATUS_LABELS[item.status] || "已完成"}
                          </Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            {operationLabel(item.operation) || "交付任务"}
                          </span>
                          <span>
                            {displayTaskDate(item.resolvedAt || item.updatedAt)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {tickets.hasNextPage && (
                <div className="pt-3 text-center">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={tickets.isFetchingNextPage}
                    onClick={() => void tickets.fetchNextPage()}
                  >
                    {tickets.isFetchingNextPage && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    加载更多工单
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="py-14 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="mx-auto mb-3 h-7 w-7" />
              当前筛选条件下暂无工单
            </div>
          )}
        </CardContent>
      </Card>

      <DeliveryHistoryDetailDialog
        open={Boolean(selectedTicketId)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTicketId(null);
          }
        }}
        detail={detail.data}
        loading={detail.isLoading}
        error={detail.error?.message}
      />
    </PortalShell>
  );
}

function DeliveryHistoryDetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: any;
  loading: boolean;
  error?: string;
}) {
  const [downloadError, setDownloadError] = useState("");
  const downloadAttachment = async (attachment: any) => {
    setDownloadError("");
    try {
      const projectAssignmentId = detail?.ticket?.assignedProjectAssignmentId;
      const response = await fetch(attachment.downloadUrl, {
        credentials: "include",
        headers: projectAssignmentId
          ? { "x-delivery-project-assignment-id": projectAssignmentId }
          : undefined,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || "附件下载失败");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadFailure) {
      setDownloadError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "附件下载失败",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail?.ticket?.title || "任务详情"}</DialogTitle>
          <DialogDescription>
            {detail?.customer
              ? `${detail.customer.name}${
                  detail.customer.username
                    ? ` · @${detail.customer.username}`
                    : ""
                }`
              : "查看任务处理记录"}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
            正在载入任务详情
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-destructive">
            {error}
          </div>
        ) : detail ? (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">处理状态</p>
                <p className="mt-1 font-medium">
                  {TERMINAL_STATUS_LABELS[detail.ticket.status] ||
                    detail.ticket.status}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">完成时间</p>
                <p className="mt-1 font-medium">
                  {displayTaskDate(
                    detail.ticket.resolvedAt || detail.ticket.updatedAt,
                  )}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">申请内容</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {detail.ticket.description || "未填写补充说明"}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">处理结论</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {detail.ticket.publicSummary ||
                    detail.ticket.internalNote ||
                    "处理已结束，详细过程见下方时间线。"}
                </p>
              </div>
            </div>

            {detail.knowledgeReset && (
              <section>
                <h3 className="font-medium">知识库重置结果</h3>
                <div className="mt-2 rounded-xl border p-4 text-sm">
                  <p>
                    申请原因：
                    {KNOWLEDGE_RESET_REASON_LABELS[
                      detail.knowledgeReset.reasonCode
                    ] || detail.knowledgeReset.reasonCode}
                    {detail.knowledgeReset.reasonNote
                      ? ` · ${detail.knowledgeReset.reasonNote}`
                      : ""}
                  </p>
                  <p className="mt-2">
                    审批结果：
                    {KNOWLEDGE_RESET_STATUS_LABELS[
                      detail.knowledgeReset.status
                    ] || detail.knowledgeReset.status}
                  </p>
                  {detail.knowledgeReset.decisionNote && (
                    <p className="mt-2 whitespace-pre-wrap">
                      审批备注：{detail.knowledgeReset.decisionNote}
                    </p>
                  )}
                  {detail.knowledgeReset.cleanupSummary && (
                    <p className="mt-2 text-muted-foreground">
                      清理结果：
                      {Object.entries(
                        detail.knowledgeReset.cleanupSummary as Record<
                          string,
                          number
                        >,
                      )
                        .map(([key, value]) => `${key} ${value}`)
                        .join("、")}
                    </p>
                  )}
                  {detail.knowledgeReset.decidedAt && (
                    <p className="mt-2 text-muted-foreground">
                      完成时间：
                      {displayTaskDate(detail.knowledgeReset.decidedAt)}
                    </p>
                  )}
                </div>
              </section>
            )}

            <section>
              <h3 className="font-medium">处理时间线</h3>
              <div className="mt-2 space-y-2">
                {detail.events.map((event: any) => (
                  <div key={event.id} className="rounded-xl border p-3 text-sm">
                    <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        {event.actorRole === "delivery_member"
                          ? "工程师"
                          : event.actorRole === "user"
                            ? "客户"
                            : "系统/管理员"}
                        {event.visibility === "internal" ? " · 内部记录" : ""}
                      </span>
                      <span>{displayTaskDate(event.createdAt)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap">
                      {event.message ||
                        `${event.fromStatus || ""} → ${event.toStatus || ""}`}
                    </p>
                  </div>
                ))}
                {!detail.events.length && (
                  <p className="text-sm text-muted-foreground">
                    暂无时间线记录
                  </p>
                )}
              </div>
            </section>

            {detail.ticket.deliveryLinks?.length > 0 && (
              <section>
                <h3 className="font-medium">交付链接</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.ticket.deliveryLinks.map((link: any) => (
                    <a
                      key={`${link.label}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm text-primary"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {link.label}
                    </a>
                  ))}
                </div>
              </section>
            )}

            {detail.attachments.length > 0 && (
              <section>
                <h3 className="font-medium">任务附件</h3>
                <div className="mt-2 space-y-2">
                  {detail.attachments.map((attachment: any) => (
                    <div
                      key={attachment.id}
                      className="flex items-center justify-between gap-3 rounded-xl border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {attachment.filename}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {attachment.kind === "deliverable"
                            ? "交付文件"
                            : "输入资料"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void downloadAttachment(attachment)}
                      >
                        <Download className="h-4 w-4" />
                        下载
                      </Button>
                    </div>
                  ))}
                </div>
                {downloadError && (
                  <p className="mt-2 text-sm text-destructive">
                    {downloadError}
                  </p>
                )}
              </section>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeliveryTicketActions({
  projectAssignmentId,
  ticket,
  onDone,
}: {
  projectAssignmentId: string;
  ticket: any;
  onDone: () => Promise<unknown>;
}) {
  const update = trpc.delivery.mine.updateTicket.useMutation();
  const publishStyleSamples =
    trpc.delivery.mine.publishWebsiteStyleSamples.useMutation();
  const operation = ticket.operation as DeliveryWorkflowOperation;
  const completionTicket = {
    operation,
    marketEdition: ticket.marketEdition,
    topic: ticket.topic,
    monitoringBatchKey: ticket.monitoringBatchKey,
    responseLogicRevision: ticket.responseLogicRevision,
    contentAssetIds: ticket.contentAssetIds,
  };
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionDraft, setCompletionDraft] =
    useState<DeliveryCompletionDraft>(() =>
      createDeliveryCompletionDraft(completionTicket),
    );
  const [informationOpen, setInformationOpen] = useState(false);
  const [informationMessage, setInformationMessage] = useState("");
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false);
  const [uploadingModule, setUploadingModule] = useState("");
  const [pendingBusinessModuleImport, setPendingBusinessModuleImport] =
    useState<PendingBusinessModuleImport | null>(null);
  const [styleFiles, setStyleFiles] = useState<File[]>([]);
  const [styleLabels, setStyleLabels] = useState([
    "风格样例一",
    "风格样例二",
    "风格样例三",
  ]);
  const [styleNote, setStyleNote] = useState("");
  const [uploadingStyles, setUploadingStyles] = useState(false);
  const moduleImports = TICKET_MODULE_IMPORTS[ticket.operation] ?? [];
  const publishStyles = async () => {
    if (styleFiles.length !== 3) {
      toast.warning("请选择恰好三张图片样例");
      return;
    }
    if (
      styleFiles.some(
        (file) =>
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size <= 0 ||
          file.size > 10 * 1024 * 1024,
      )
    ) {
      toast.warning("样例仅支持 10MB 以内的 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (styleLabels.some((label) => !label.trim())) {
      toast.warning("请为三张样例分别填写名称");
      return;
    }
    setUploadingStyles(true);
    try {
      const uploaded = await Promise.all(
        styleFiles.map(async (file, index) => {
          const result = await uploadFile(file);
          return {
            fileId: result.fileId,
            filename: result.filename,
            mimeType: file.type,
            sizeBytes: file.size,
            label: styleLabels[index]!.trim(),
          };
        }),
      );
      await publishStyleSamples.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedWorkflowRevision: ticket.websiteStyleWorkflowRevision,
        engineerNote: styleNote.trim() || undefined,
        samples: uploaded,
      });
      setStyleFiles([]);
      setStyleNote("");
      await onDone();
      toast.success("三张官网风格样例已发布", {
        description: "工单已进入等待客户选择状态。",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "风格样例发布失败");
    } finally {
      setUploadingStyles(false);
    }
  };
  const uploadKnowledgeArchive = async (file: File) => {
    setUploadingKnowledge(true);
    try {
      const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "knowledge",
          "x-maintenance-ticket-id": ticket.id,
          "x-delivery-project-assignment-id": projectAssignmentId,
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || "知识库文件上传与校验失败");
      }
      await onDone();
      toast.success("新知识库版本已上传并发布", {
        description: "现在可以完成知识库维护工单。",
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "知识库文件上传失败",
      );
    } finally {
      setUploadingKnowledge(false);
    }
  };
  const requestBusinessModuleImport = async (
    definition: BusinessModuleImportDefinition,
    file: File,
    input: {
      preview: boolean;
      targetBatchKey?: string;
      fileHash?: string;
      preflightToken?: string;
    },
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-import-mode": "dashboard",
      "x-dashboard-module": definition.module,
      "x-dashboard-revision": String(ticket.dashboardRevision),
      "x-delivery-project-assignment-id": projectAssignmentId,
      "x-delivery-ticket-id": ticket.id,
    };
    if (input.preview) headers["x-import-preview"] = "true";
    if (input.targetBatchKey) {
      headers["x-monitoring-target-batch-key"] = input.targetBatchKey;
    }
    if (input.fileHash) {
      headers[
        definition.module === "monitoring"
          ? "x-monitoring-file-hash"
          : "x-import-file-hash"
      ] = input.fileHash;
    }
    if (input.preflightToken) {
      headers["x-import-preflight-token"] = input.preflightToken;
    }
    const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
      method: "PUT",
      credentials: "include",
      headers,
      body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || "业务文件预检失败");
    }
    return payload;
  };

  const preflightBusinessModule = async (
    definition: BusinessModuleImportDefinition,
    file: File,
  ) => {
    setUploadingModule(definition.module);
    try {
      const result = await requestBusinessModuleImport(definition, file, {
        preview: true,
      });
      const preview = (result?.preview ||
        result) as BusinessModuleImportPreview;
      if (businessModulePreviewHasErrors(preview)) {
        const firstError = preview.issues
          ?.map(businessModuleIssueText)
          .find(Boolean);
        throw new Error(firstError || "文件未通过业务规则校验");
      }
      setPendingBusinessModuleImport({
        definition,
        file,
        preview,
        targetBatchKey:
          preview.preflightTargetBatchKey || preview.suggestedBatchKey || "",
      });
    } catch (error) {
      toast.error(`${definition.label}预检失败`, {
        description:
          error instanceof Error ? error.message : "请检查文件格式后重试",
      });
    } finally {
      setUploadingModule("");
    }
  };

  const publishBusinessModule = async () => {
    if (!pendingBusinessModuleImport) return;
    const { definition, file, targetBatchKey } = pendingBusinessModuleImport;
    if (
      pendingBusinessModuleImport.preview.targetBatchRequired &&
      !targetBatchKey.trim()
    ) {
      toast.warning("请选择目标监控批次", {
        description: "引用补充文件必须绑定到已有答案批次。",
      });
      return;
    }
    setUploadingModule(definition.module);
    try {
      let publishPreview = pendingBusinessModuleImport.preview;
      const normalizedTargetBatchKey = targetBatchKey.trim() || undefined;
      if (
        !businessModulePreflightUsable(publishPreview) ||
        normalizedTargetBatchKey !==
          (publishPreview.preflightTargetBatchKey || undefined)
      ) {
        const refreshed = await requestBusinessModuleImport(definition, file, {
          preview: true,
          targetBatchKey: normalizedTargetBatchKey,
        });
        publishPreview = (refreshed?.preview ||
          refreshed) as BusinessModuleImportPreview;
        setPendingBusinessModuleImport((current) =>
          current ? { ...current, preview: publishPreview } : current,
        );
      }
      if (
        businessModulePreviewHasErrors(publishPreview) ||
        !businessModulePreflightUsable(publishPreview)
      ) {
        throw new Error("文件未取得有效预检凭证，请重新选择文件预检。");
      }
      await requestBusinessModuleImport(definition, file, {
        preview: false,
        targetBatchKey: normalizedTargetBatchKey,
        fileHash: publishPreview.fileHash,
        preflightToken: publishPreview.preflightToken,
      });
      setPendingBusinessModuleImport(null);
      await onDone();
      toast.success(`${definition.label}已发布`, {
        description:
          "正式数据已经写入客户业务模块；请在下方用户验收视图核对结果后再完成工单。",
      });
    } catch (error) {
      toast.error(`${definition.label}发布失败`, {
        description:
          error instanceof Error ? error.message : "请重新预检后发布",
      });
    } finally {
      setUploadingModule("");
    }
  };
  const updateStatus = async (input: {
    status: "in_progress" | "needs_information" | "completed";
    message?: string;
    publicUrl?: string;
    handoff?: ReturnType<typeof buildDeliveryCompletionPayload>["handoff"];
  }) => {
    try {
      await update.mutateAsync({
        projectAssignmentId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        ...input,
      });
      await onDone();
      toast.success(
        input.status === "completed"
          ? "交付已完成"
          : input.status === "needs_information"
            ? "补充要求已发送给客户"
            : "工单已开始处理",
      );
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return false;
    }
  };

  const completeDelivery = async () => {
    const errors = validateDeliveryCompletionDraft(
      completionTicket,
      completionDraft,
    );
    if (errors.length) {
      toast.warning(errors[0], {
        description:
          errors.length > 1
            ? `还需处理：${errors.slice(1).join("；")}`
            : undefined,
      });
      return;
    }
    const payload = buildDeliveryCompletionPayload(
      completionTicket,
      completionDraft,
    );
    if (
      await updateStatus({
        status: "completed",
        ...payload,
      })
    ) {
      setCompletionOpen(false);
    }
  };

  const requestInformation = async () => {
    const message = informationMessage.trim();
    if (!message) {
      toast.warning("请明确填写客户需要补充的资料");
      return;
    }
    if (await updateStatus({ status: "needs_information", message })) {
      setInformationMessage("");
      setInformationOpen(false);
    }
  };

  const scrollToCustomerPreview = () => {
    setCompletionOpen(false);
    window.requestAnimationFrame(() => {
      document
        .getElementById("customer-delivery-preview")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ticket.status !== "in_progress" &&
        !(
          ticket.operation === "website_style_samples" &&
          ticket.status === "needs_information"
        ) && (
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void updateStatus({ status: "in_progress" })}
          >
            开始处理
          </Button>
        )}
      {ticket.status === "in_progress" && (
        <>
          {ticket.operation === "website_style_samples" && (
            <div className="w-full space-y-3 rounded-xl border bg-muted/20 p-4">
              <div>
                <p className="text-sm font-medium">发布官网图片风格样例</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  请选择恰好三张 PNG、JPEG 或 WebP 图片，每张不超过 10MB。
                </p>
              </div>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={uploadingStyles}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files || []);
                  if (files.length !== 3) {
                    toast.warning("每批必须选择恰好三张图片");
                    event.currentTarget.value = "";
                    setStyleFiles([]);
                    return;
                  }
                  setStyleFiles(files);
                }}
              />
              {styleFiles.length === 3 && (
                <div className="grid gap-3 md:grid-cols-3">
                  {styleFiles.map((file, index) => (
                    <label
                      key={`${file.name}:${file.lastModified}`}
                      className="space-y-2 rounded-lg border bg-background p-3"
                    >
                      <img
                        src={URL.createObjectURL(file)}
                        alt={styleLabels[index]}
                        className="aspect-video w-full rounded-md object-cover"
                        onLoad={(event) =>
                          URL.revokeObjectURL(event.currentTarget.src)
                        }
                      />
                      <Input
                        value={styleLabels[index]}
                        maxLength={160}
                        disabled={uploadingStyles}
                        onChange={(event) =>
                          setStyleLabels((current) =>
                            current.map((label, labelIndex) =>
                              labelIndex === index ? event.target.value : label,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
              <textarea
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={styleNote}
                maxLength={2000}
                disabled={uploadingStyles}
                placeholder="可选：说明三种风格的设计方向和适用场景"
                onChange={(event) => setStyleNote(event.target.value)}
              />
              <Button
                size="sm"
                disabled={
                  uploadingStyles ||
                  publishStyleSamples.isPending ||
                  styleFiles.length !== 3
                }
                onClick={() => void publishStyles()}
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadingStyles ? "正在上传并发布" : "发布三张样例"}
              </Button>
            </div>
          )}
          {ticket.operation === "knowledge_maintenance" && (
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" />
              {uploadingKnowledge ? "正在校验" : "上传并发布新版本"}
              <input
                className="hidden"
                type="file"
                accept=".zip,application/zip"
                disabled={uploadingKnowledge}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadKnowledgeArchive(file);
                }}
              />
            </label>
          )}
          {moduleImports.map((moduleImport) => (
            <label
              key={moduleImport.module}
              className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingModule === moduleImport.module
                ? "正在预检"
                : moduleImport.label}
              <input
                className="hidden"
                type="file"
                accept={moduleImport.accept}
                disabled={Boolean(uploadingModule)}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void preflightBusinessModule(moduleImport, file);
                }}
              />
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => setInformationOpen(true)}
          >
            等待用户补充
          </Button>
          {ticket.operation !== "website_style_samples" && (
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => setCompletionOpen(true)}
            >
              填写交付结果
            </Button>
          )}
        </>
      )}
      {ticket.operation === "website_style_samples" &&
        ticket.status === "needs_information" && (
          <p className="w-full text-xs text-muted-foreground">
            已发布本批三张样例，正在等待客户选择或退回重做。
          </p>
        )}

      <BusinessModuleImportDialog
        pending={pendingBusinessModuleImport}
        publishing={Boolean(uploadingModule)}
        customerName={
          ticket.customerName ||
          ticket.customerUsername ||
          `客户 #${ticket.userId}`
        }
        onTargetBatchKeyChange={(targetBatchKey) =>
          setPendingBusinessModuleImport((current) =>
            current ? { ...current, targetBatchKey } : current,
          )
        }
        onClose={() => {
          if (!uploadingModule) setPendingBusinessModuleImport(null);
        }}
        onPublish={() => void publishBusinessModule()}
      />

      <Dialog open={informationOpen} onOpenChange={setInformationOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>向客户说明需要补充的资料</DialogTitle>
            <DialogDescription>
              工单会保留并进入“等待客户补充”，客户回复后继续当前工单，不会重复创建任务。
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">补充要求</span>
            <textarea
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2"
              value={informationMessage}
              maxLength={8_000}
              placeholder="请具体说明缺少什么、接受什么格式，以及补充后将继续哪一步。"
              onChange={(event) => setInformationMessage(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInformationOpen(false)}>
              取消
            </Button>
            <Button
              disabled={update.isPending || !informationMessage.trim()}
              onClick={() => void requestInformation()}
            >
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              发送并等待客户
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeliveryCompletionDialog
        open={completionOpen}
        onOpenChange={setCompletionOpen}
        ticket={ticket}
        draft={completionDraft}
        onDraftChange={setCompletionDraft}
        submitting={update.isPending}
        onInspectPreview={scrollToCustomerPreview}
        onSubmit={() => void completeDelivery()}
      />
    </div>
  );
}

function BusinessModuleImportDialog({
  pending,
  publishing,
  customerName,
  onTargetBatchKeyChange,
  onClose,
  onPublish,
}: {
  pending: PendingBusinessModuleImport | null;
  publishing: boolean;
  customerName: string;
  onTargetBatchKeyChange: (targetBatchKey: string) => void;
  onClose: () => void;
  onPublish: () => void;
}) {
  const preview = pending?.preview;
  const errors = preview?.issues
    ?.filter(
      (issue) =>
        typeof issue !== "string" &&
        (issue.level === "error" || issue.severity === "error"),
    )
    .map(businessModuleIssueText);
  const questions = preview?.questions
    ?.map(businessModuleValueText)
    .filter(Boolean);
  const models = preview?.models?.map(businessModuleValueText).filter(Boolean);
  const targetBatchMissing = Boolean(
    preview?.targetBatchRequired && !pending?.targetBatchKey.trim(),
  );

  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open && !publishing) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>业务文件预检与发布确认</DialogTitle>
          <DialogDescription>
            预检只读取文件，不修改客户数据。确认后将以同一文件校验值发布到正式业务模块。
          </DialogDescription>
        </DialogHeader>

        {pending && preview && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <BusinessModulePreviewMetric
                label="目标客户"
                value={customerName}
              />
              <BusinessModulePreviewMetric
                label="目标模块"
                value={pending.definition.label}
              />
              <BusinessModulePreviewMetric
                label="源文件"
                value={preview.sourceName || pending.file.name}
              />
              <BusinessModulePreviewMetric
                label="文件大小"
                value={`${Math.max(1, Math.ceil(pending.file.size / 1024))} KB`}
              />
            </div>

            {(preview.sampleCount !== undefined ||
              preview.citationCount !== undefined ||
              (questions?.length ?? 0) > 0 ||
              (models?.length ?? 0) > 0) && (
              <section className="rounded-xl border bg-muted/20 p-4">
                <p className="text-sm font-medium">识别结果</p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  {preview.sampleCount !== undefined && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        答案记录
                      </dt>
                      <dd className="mt-1 font-medium">
                        {preview.sampleCount} 条
                      </dd>
                    </div>
                  )}
                  {preview.citationCount !== undefined && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        引用记录
                      </dt>
                      <dd className="mt-1 font-medium">
                        {preview.citationCount} 条
                      </dd>
                    </div>
                  )}
                  {(questions?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">问题</dt>
                      <dd className="mt-1 break-words font-medium">
                        {questions!.join("、")}
                      </dd>
                    </div>
                  )}
                  {(models?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">模型</dt>
                      <dd className="mt-1 break-words font-medium">
                        {models!.join("、")}
                      </dd>
                    </div>
                  )}
                  {(preview.dates?.length ?? 0) > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        采集日期
                      </dt>
                      <dd className="mt-1 break-words font-medium">
                        {preview.dates!.join("、")}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            {(preview.summary?.length ?? 0) > 0 && (
              <section className="rounded-xl border p-4">
                <p className="text-sm font-medium">变更摘要</p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  {preview.summary!.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            )}

            {(preview.recordStats?.length ?? 0) > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {preview.recordStats!.map((stats, index) => (
                  <section
                    key={`${stats.label || "记录"}-${index}`}
                    className="rounded-xl border p-4"
                  >
                    <p className="text-sm font-medium">
                      {stats.label || "记录变化"}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      现有 {stats.beforeCount ?? 0} 条 → 发布后{" "}
                      {stats.afterCount ?? 0} 条
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      新增 {stats.added ?? 0} · 更新 {stats.updated ?? 0} · 删除{" "}
                      {stats.removed ?? 0} · 不变 {stats.unchanged ?? 0}
                    </p>
                  </section>
                ))}
              </div>
            )}

            {preview.targetBatchRequired && (
              <label className="block space-y-2 text-sm">
                <span className="font-medium">
                  目标监控批次
                  <span className="ml-1 text-destructive">*</span>
                </span>
                {(preview.availableBatches?.length ?? 0) > 0 ? (
                  <select
                    aria-label="目标监控批次"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={pending.targetBatchKey}
                    onChange={(event) =>
                      onTargetBatchKeyChange(event.target.value)
                    }
                  >
                    <option value="">请选择已有答案批次</option>
                    {preview
                      .availableBatches!.filter((batch) =>
                        Boolean(batch.batchKey),
                      )
                      .map((batch) => (
                        <option key={batch.batchKey} value={batch.batchKey}>
                          {businessModuleBatchLabel(batch)}
                        </option>
                      ))}
                  </select>
                ) : (
                  <Input
                    aria-label="目标监控批次"
                    value={pending.targetBatchKey}
                    placeholder="填写已有答案批次标识"
                    onChange={(event) =>
                      onTargetBatchKeyChange(event.target.value)
                    }
                  />
                )}
                <span className="block text-xs leading-5 text-muted-foreground">
                  引用补充文件必须明确绑定已有答案批次，系统不会猜测或跨批次合并。
                </span>
              </label>
            )}

            {(preview.issues?.length ?? 0) > 0 && (
              <section
                className={`rounded-xl border p-4 ${
                  (errors?.length ?? 0) > 0
                    ? "border-destructive/30 bg-destructive/[0.035]"
                    : "bg-muted/20"
                }`}
              >
                <p className="text-sm font-medium">
                  {(errors?.length ?? 0) > 0 ? "必须处理的问题" : "预检提示"}
                </p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  {preview.issues!.map((issue, index) => (
                    <li key={`${businessModuleIssueText(issue)}-${index}`}>
                      {businessModuleIssueText(issue)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="rounded-xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
              确认发布后会更新客户正式数据，但不会自动完成工单。请先在用户验收视图检查结果，再填写交付摘要并完成交接。
              {preview.fileHash && (
                <span className="mt-1 block font-mono">
                  校验值：{preview.fileHash.slice(0, 16)}…
                </span>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={publishing}
                onClick={onClose}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  publishing || targetBatchMissing || (errors?.length ?? 0) > 0
                }
                onClick={onPublish}
              >
                {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
                确认发布到正式数据
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BusinessModulePreviewMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-muted/20 px-4 py-3">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <strong className="mt-1 block truncate text-sm" title={value}>
        {value}
      </strong>
    </div>
  );
}

function DeliveryCompletionDialog({
  open,
  onOpenChange,
  ticket,
  draft,
  onDraftChange,
  submitting,
  onInspectPreview,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: any;
  draft: DeliveryCompletionDraft;
  onDraftChange: (draft: DeliveryCompletionDraft) => void;
  submitting: boolean;
  onInspectPreview: () => void;
  onSubmit: () => void;
}) {
  const operation = ticket.operation as DeliveryWorkflowOperation;
  const publicUrlRequired = deliveryCompletionRequiresPublicUrl(operation);
  const patchDraft = (patch: Partial<DeliveryCompletionDraft>) =>
    onDraftChange({ ...draft, ...patch });
  const websiteContentOperation = [
    "company_facts",
    "product_case_docs",
    "industry_news",
    "company_news",
    "faq_content",
  ].includes(operation);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>完成交付并确认下游交接</DialogTitle>
          <DialogDescription>
            {operationLabel(operation)} · 客户 #{ticket.userId}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-sm leading-6">
          <p className="font-medium">完成后系统动作</p>
          <p className="mt-1 text-muted-foreground">
            {deliveryCompletionCreatesNextStep(operation)}
          </p>
        </div>

        <div className="space-y-5">
          <CompletionField
            label="交付结果摘要"
            description="写给客户和下一岗位看，说明完成了什么、结果在哪里、还需注意什么。"
            required
          >
            <textarea
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={draft.summary}
              maxLength={8_000}
              placeholder="例如：已完成首轮问题监控，共形成 20 条回答和 36 个有效信源；其中 3 个问题需要进入内容优化。"
              onChange={(event) => patchDraft({ summary: event.target.value })}
            />
          </CompletionField>

          {operation === "domain_application" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <CompletionField label="已核验域名" required>
                <Input
                  value={draft.domain}
                  placeholder="example.com"
                  onChange={(event) =>
                    patchDraft({ domain: event.target.value })
                  }
                />
              </CompletionField>
              {ticket.marketEdition === "overseas" ? (
                <div className="rounded-xl border bg-muted/25 px-4 py-3 text-sm">
                  <p className="font-medium">海外版客户</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    无需填写工信部备案服务码；域名确认后直接进入官网风格样例阶段。
                  </p>
                </div>
              ) : (
                <CompletionField
                  label="备案服务码"
                  description="返回给国内版客户办理 ICP 备案。"
                  required
                >
                  <Input
                    value={draft.icpServiceCode}
                    onChange={(event) =>
                      patchDraft({ icpServiceCode: event.target.value })
                    }
                  />
                </CompletionField>
              )}
            </div>
          )}

          {operation === "icp_filing" && (
            <div className="space-y-4">
              <CompletionField label="备案结论" required>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.icpResolution}
                  onChange={(event) =>
                    patchDraft({
                      icpResolution: event.target.value as
                        | "approved"
                        | "not_required",
                    })
                  }
                >
                  <option value="approved">备案已通过</option>
                  <option value="not_required">依法无需备案</option>
                </select>
              </CompletionField>
              {draft.icpResolution === "approved" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <CompletionField label="ICP 备案号" required>
                    <Input
                      value={draft.icpNumber}
                      onChange={(event) =>
                        patchDraft({ icpNumber: event.target.value })
                      }
                    />
                  </CompletionField>
                  <CompletionField label="备案省份">
                    <Input
                      value={draft.icpProvince}
                      placeholder="例如：浙江"
                      onChange={(event) =>
                        patchDraft({ icpProvince: event.target.value })
                      }
                    />
                  </CompletionField>
                </div>
              )}
            </div>
          )}

          {(operation === "initial_monitoring" ||
            operation === "monitoring_import" ||
            operation === "monitoring_retest") && (
            <div className="grid gap-4 sm:grid-cols-2">
              <CompletionField
                label={
                  operation === "monitoring_retest"
                    ? "本次复测的新监控批次"
                    : "正式监控批次标识"
                }
                description={
                  operation === "monitoring_retest"
                    ? "必须选择本次复测新发布的批次，不能继续沿用复测前基线。"
                    : "供下一岗位回查本次回答与信源。"
                }
                required
              >
                <Input
                  value={draft.monitoringBatchKey}
                  placeholder={
                    operation === "monitoring_retest"
                      ? `例如：retest-2026-08；原基线为 ${ticket.monitoringBatchKey || "未记录"}`
                      : "填写已经发布的正式批次标识"
                  }
                  onChange={(event) =>
                    patchDraft({ monitoringBatchKey: event.target.value })
                  }
                />
              </CompletionField>
              {operation !== "monitoring_retest" && (
                <CompletionField
                  label="需要优化的问题 ID"
                  description="多个 ID 用逗号或换行分隔；每个 ID 会生成一张应答逻辑工单。"
                >
                  <textarea
                    className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={draft.optimizationQuestionIds}
                    onChange={(event) =>
                      patchDraft({
                        optimizationQuestionIds: event.target.value,
                      })
                    }
                  />
                </CompletionField>
              )}
            </div>
          )}

          {operation === "response_logic" && (
            <CompletionField
              label="已确认应答逻辑版本"
              description="完成后，下游内容资产工单会锁定到这个版本。"
              required
            >
              <Input
                type="number"
                min={1}
                step={1}
                value={draft.responseLogicRevision}
                onChange={(event) =>
                  patchDraft({ responseLogicRevision: event.target.value })
                }
              />
            </CompletionField>
          )}

          {operation === "content_asset_publish" && (
            <div className="space-y-4">
              <CompletionField
                label="已确认内容资产 ID"
                description="多个 ID 用逗号或换行分隔；必须已经进入客户正式看板。"
                required
              >
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.contentAssetIds}
                  onChange={(event) =>
                    patchDraft({ contentAssetIds: event.target.value })
                  }
                />
              </CompletionField>
              <CompletionField
                label="下一步发布目标"
                description="系统按选择自动创建对应岗位工单。"
                required
              >
                <div className="flex flex-wrap gap-4 rounded-xl border px-4 py-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.publishMedia}
                      onChange={(event) =>
                        patchDraft({ publishMedia: event.target.checked })
                      }
                    />
                    媒体渠道分发
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.publishWebsite}
                      onChange={(event) =>
                        patchDraft({ publishWebsite: event.target.checked })
                      }
                    />
                    客户官网发布
                  </label>
                </div>
              </CompletionField>
              {draft.publishWebsite && (
                <CompletionField label="官网内容工单类型" required>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={draft.websiteOperation}
                    onChange={(event) =>
                      patchDraft({
                        websiteOperation: event.target
                          .value as DeliveryCompletionDraft["websiteOperation"],
                      })
                    }
                  >
                    <option value="company_facts">企业事实内容</option>
                    <option value="product_case_docs">产品案例内容</option>
                    <option value="industry_news">行业新闻</option>
                    <option value="company_news">企业新闻</option>
                    <option value="faq_content">FAQ 内容</option>
                  </select>
                </CompletionField>
              )}
            </div>
          )}

          {websiteContentOperation && (
            <CompletionField
              label="本页面绑定的内容资产 ID"
              description="只能填写已通过内容分发岗位工单完成发布的资产 ID。"
              required
            >
              <textarea
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={draft.contentAssetIds}
                onChange={(event) =>
                  patchDraft({ contentAssetIds: event.target.value })
                }
              />
            </CompletionField>
          )}

          {operation === "site_check" && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <CompletionField label="检查项标识" required>
                  <Input
                    value={draft.siteCheckKey}
                    onChange={(event) =>
                      patchDraft({ siteCheckKey: event.target.value })
                    }
                  />
                </CompletionField>
                <CompletionField label="检查项名称" required>
                  <Input
                    value={draft.siteCheckLabel}
                    onChange={(event) =>
                      patchDraft({ siteCheckLabel: event.target.value })
                    }
                  />
                </CompletionField>
              </div>
              <CompletionField label="检查结论" required>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.siteCheckStatus}
                  onChange={(event) =>
                    patchDraft({
                      siteCheckStatus: event.target
                        .value as DeliveryCompletionDraft["siteCheckStatus"],
                    })
                  }
                >
                  <option value="passed">通过</option>
                  <option value="warning">有风险但可继续</option>
                  <option value="failed">未通过</option>
                  <option value="not_applicable">不适用</option>
                </select>
              </CompletionField>
              <CompletionField label="检查摘要">
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.siteCheckSummary}
                  onChange={(event) =>
                    patchDraft({ siteCheckSummary: event.target.value })
                  }
                />
              </CompletionField>
              <CompletionField label="检查证据或公开地址">
                <Input
                  value={draft.siteCheckEvidence}
                  onChange={(event) =>
                    patchDraft({ siteCheckEvidence: event.target.value })
                  }
                />
              </CompletionField>
            </div>
          )}

          {operation === "stage_report" && (
            <label className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={draft.needsFurtherOptimization}
                onChange={(event) =>
                  patchDraft({
                    needsFurtherOptimization: event.target.checked,
                  })
                }
              />
              <span>
                <strong>复测仍未达到目标，需要继续优化</strong>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  勾选后沿原问题创建下一轮应答逻辑工单；未绑定来源问题时服务端会拒绝，防止错误串单。
                </span>
              </span>
            </label>
          )}

          <CompletionField
            label={`公开链接${publicUrlRequired ? "" : "（可选）"}`}
            description={
              publicUrlRequired
                ? "该工单属于公开发布，必须填写客户可访问的 http(s) 地址。"
                : "如果产生了公开页面或报告，可在这里登记。"
            }
            required={publicUrlRequired}
          >
            <Input
              type="url"
              value={draft.publicUrl}
              placeholder="https://"
              onChange={(event) =>
                patchDraft({ publicUrl: event.target.value })
              }
            />
          </CompletionField>

          <label className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.025] px-4 py-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={draft.previewVerified}
              onChange={(event) =>
                patchDraft({ previewVerified: event.target.checked })
              }
            />
            <span>
              <strong>我已完成用户侧验收</strong>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                已核对用户实际页面或可核验交付记录，展示内容、公开链接和本次摘要一致。
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={onInspectPreview}>
            查看用户实际页面
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              暂不完成
            </Button>
            <Button type="button" disabled={submitting} onClick={onSubmit}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              完成并交接
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompletionField({
  label,
  description,
  required = false,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="font-medium">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {description && (
        <span className="block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      )}
      {children}
    </label>
  );
}

function KnowledgeResetDecision({
  projectAssignmentId,
  requestId,
  systemAdminMode = false,
  onDone,
}: {
  projectAssignmentId: string;
  requestId: string;
  systemAdminMode?: boolean;
  onDone: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const preview = trpc.delivery.mine.knowledgeResetPreview.useQuery(
    { projectAssignmentId, requestId },
    { enabled: open },
  );
  const decide = trpc.delivery.mine.decideKnowledgeReset.useMutation();
  const submit = async (decision: "approve" | "reject") => {
    if (!preview.data) return;
    if (decision === "approve" && !confirmed) {
      toast.warning("请先确认已核对清理范围");
      return;
    }
    if (decision === "reject" && !decisionNote.trim()) {
      toast.warning("驳回时必须填写原因");
      return;
    }
    try {
      await decide.mutateAsync({
        projectAssignmentId,
        requestId,
        expectedRevision: preview.data.expectedRevision,
        decision,
        decisionNote: decisionNote.trim() || undefined,
      });
      await onDone();
      setOpen(false);
      toast.success(
        decision === "approve"
          ? "知识库已完成重置"
          : "重置申请已驳回，知识库锁定已解除",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    }
  };
  const cleanup = preview.data?.cleanup;
  return (
    <>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" /> 审批知识库重置
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>知识库重置审批</DialogTitle>
            <DialogDescription>
              {systemAdminMode
                ? "系统管理员正在以异常接管身份执行。批准后正文、历史快照和上传文件内容不会保留。"
                : "只有该客户当前负责的 AI 运维工程师可以执行。批准后正文、历史快照和上传文件内容不会保留。"}
            </DialogDescription>
          </DialogHeader>
          {preview.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="py-6 text-sm text-destructive">
              {preview.error.message}
            </p>
          ) : cleanup ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <CleanupCount label="构建记录" value={cleanup.builds} />
                <CleanupCount label="展示版本" value={cleanup.snapshots} />
                <CleanupCount label="专属对话" value={cleanup.conversations} />
                <CleanupCount label="附件" value={cleanup.attachments} />
                <CleanupCount
                  label="官网导入回执"
                  value={cleanup.importReceipts}
                />
              </div>
              <label className="grid gap-2 text-sm">
                审批说明（驳回时必填）
                <textarea
                  className="min-h-24 rounded-md border p-3"
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  maxLength={2_000}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对清理预览，确认本操作会永久删除该客户全部知识库内容。
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void submit("reject")}
              disabled={decide.isPending || !preview.data}
            >
              驳回并解除锁定
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submit("approve")}
              disabled={decide.isPending || !preview.data || !confirmed}
            >
              {decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              二次确认并清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CleanupCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-muted/25 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
