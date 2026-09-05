import { useEffect, useState } from "react";
import {
  ClipboardList,
  Loader2,
  PackageCheck,
  RefreshCw,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import DashboardSkeletonEditor from "@/components/DashboardSkeletonEditor";
import DashboardVersionHistory from "@/components/DashboardVersionHistory";
import AdminDeliveryTicketWorkspace from "@/components/AdminDeliveryTicketWorkspace";
import CustomerDashboardMirror from "@/components/CustomerDashboardMirror";
import ManagerAssignmentEditor from "@/components/ManagerAssignmentEditor";
import PortalShell, { PortalCard } from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ADMIN_WORKSPACE_TAB_IDS,
  type WorkspaceTab,
} from "@/lib/admin-workspace-tabs";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";

export { ADMIN_WORKSPACE_TAB_IDS };
export type { WorkspaceTab };

export const ADMIN_WORKSPACE_TABS = [
  { value: "service", label: "用户流程", icon: PackageCheck },
  { value: "tickets", label: "工单", icon: ClipboardList },
] as const satisfies ReadonlyArray<{
  value: WorkspaceTab;
  label: string;
  icon: typeof PackageCheck;
}>;

export function adminWorkspaceTabsForAccess() {
  return ADMIN_WORKSPACE_TABS;
}

function toDateTimeLocal(value?: number | string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toDateInput(value: number | string | Date | null | undefined) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function displayDate(value: number | string | Date | null | undefined) {
  if (!value) return "待配置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待配置";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function readImportError(response: Response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || payload?.message || "导入失败";
  } catch {
    return `导入失败 (${response.status})`;
  }
}

async function uploadWorkspaceFile(input: {
  userId: number;
  file: File;
  mode: "knowledge";
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-File-Name": encodeURIComponent(input.file.name),
    "X-Import-Mode": input.mode,
  };
  const response = await fetch(`/api/dashboard/import/${input.userId}`, {
    method: "PUT",
    credentials: "include",
    headers,
    body: input.file,
  });
  if (!response.ok) throw new Error(await readImportError(response));
  return response.json();
}

export default function AdminWorkspace({
  initialUserId = null,
  initialTab = "service",
}: {
  initialUserId?: number | null;
  initialTab?: WorkspaceTab;
}) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    initialUserId,
  );
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [servicePlan, setServicePlan] = useState<
    "basic" | "advanced" | "luxury"
  >("basic");
  const [serviceStatus, setServiceStatus] = useState<
    "pending_confirmation" | "scheduled" | "active" | "suspended" | "cancelled"
  >("active");
  const [serviceStartsAt, setServiceStartsAt] = useState(
    toDateInput(new Date()),
  );
  const [serviceSignedAt, setServiceSignedAt] = useState("");
  const [serviceSignatory, setServiceSignatory] = useState("");
  const [carryQuestionIds, setCarryQuestionIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState<"knowledge" | null>(null);

  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    enabled: user?.role === "admin",
    retry: false,
  });
  const selectedUser = workspaceQuery.data?.users.find(
    (item) => item.id === selectedUserId,
  );
  const isSystemAdmin = Boolean(workspaceQuery.data?.isSystemAdmin);
  const availableTabs = adminWorkspaceTabsForAccess();

  useEffect(() => {
    setSelectedUserId(initialUserId);
    setTab(initialTab);
  }, [initialTab, initialUserId]);

  const queryInput = { userId: selectedUserId || 1 };
  const dashboardQuery = trpc.admin.workspace.dashboard.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const knowledgeQuery = trpc.admin.workspace.knowledge.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const knowledgeProgressQuery = trpc.admin.workspace.progress.useQuery(
    queryInput,
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );
  const knowledgeActivityQuery =
    trpc.admin.workspace.knowledgeActivity.useQuery(queryInput, {
      enabled: Boolean(selectedUser),
      retry: false,
    });
  const serviceQuery = (trpc.admin.workspace as any).service.useQuery(
    queryInput,
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );
  const deliveryPreviewQuery = (
    trpc.admin.deliveryTickets as any
  ).list.useInfiniteQuery(
    { userId: selectedUserId || 1, limit: 100 },
    {
      enabled: Boolean(selectedUser),
      retry: false,
      getNextPageParam: (lastPage: any) => lastPage?.nextCursor || undefined,
    },
  );
  const deliveryPreviewPages = deliveryPreviewQuery.data?.pages ?? [];
  const deliveryPreviewMetadata = deliveryPreviewPages[0] ?? null;
  const websiteWorkspacePreview = deliveryPreviewMetadata
    ? {
        quotas: deliveryPreviewMetadata.quotas,
        contentAssetCatalog: deliveryPreviewMetadata.contentAssetCatalog ?? [],
        websiteContentCatalog:
          deliveryPreviewMetadata.websiteContentCatalog ?? [],
        marketEdition: deliveryPreviewMetadata.marketEdition ?? "domestic",
        preferredMediaOptions:
          deliveryPreviewMetadata.preferredMediaOptions ?? [],
        deliveryOwners: {
          aiOperations: true,
          monitoringOptimization: true,
          contentDistribution: true,
        },
        websiteWorkflow: deliveryPreviewMetadata.websiteWorkflow ?? null,
        tickets: deliveryPreviewPages.flatMap(
          (page: any) => page?.tickets ?? page?.items ?? [],
        ),
      }
    : null;
  const questionPortfolioQuery = (
    trpc.admin.workspace as any
  ).questionPortfolio.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const assignmentMutation = trpc.admin.workspace.assignments.useMutation({
    onSuccess: (data) => {
      utils.admin.workspace.list.setData(undefined, data);
      toast.success("管理员分配已更新");
    },
  });
  const updateServiceMutation = (
    trpc.admin.workspace as any
  ).updateService.useMutation({
    onSuccess: async () => {
      await Promise.all([
        serviceQuery.refetch(),
        questionPortfolioQuery.refetch(),
        workspaceQuery.refetch(),
      ]);
      toast.success("服务版本已更新");
    },
  });
  useEffect(() => {
    const service = serviceQuery.data?.service;
    const nextPlan = service?.planCode;
    if (
      nextPlan === "basic" ||
      nextPlan === "advanced" ||
      nextPlan === "luxury"
    ) {
      setServicePlan(nextPlan);
    } else {
      setServicePlan("basic");
    }
    const nextStatus = service?.status;
    if (
      nextStatus === "pending_confirmation" ||
      nextStatus === "scheduled" ||
      nextStatus === "active" ||
      nextStatus === "suspended" ||
      nextStatus === "cancelled"
    ) {
      setServiceStatus(nextStatus);
    } else {
      setServiceStatus("active");
    }
    setServiceStartsAt(toDateInput(service?.validFrom));
    const currentPurchase = (serviceQuery.data?.purchases ?? []).find(
      (purchase: any) => purchase.id === service?.contractId,
    );
    setServiceSignedAt(toDateTimeLocal(currentPurchase?.signedAt));
    setServiceSignatory(currentPurchase?.signatoryId ?? "");
    const activeBasicIds =
      service?.planCode === "basic"
        ? (serviceQuery.data?.purchases ?? [])
            .filter(
              (purchase: any) =>
                purchase.planCode === "basic" &&
                (purchase.status === "active" ||
                  purchase.status === "scheduled"),
            )
            .map((purchase: any) => purchase.id)
        : [];
    const sourceContractIds = activeBasicIds.length
      ? activeBasicIds
      : service?.contractId
        ? [service.contractId]
        : [];
    setCarryQuestionIds(
      (questionPortfolioQuery.data?.questions ?? [])
        .filter(
          (question: any) =>
            question.status === "selected" &&
            sourceContractIds.includes(question.contractId),
        )
        .map((question: any) => question.id),
    );
  }, [
    questionPortfolioQuery.data?.questions,
    selectedUserId,
    serviceQuery.data?.service,
  ]);

  const handleAssignment = async (
    adminIds: number[],
    usageOwnerAdminId?: number | null,
  ) => {
    if (!selectedUser || !workspaceQuery.data?.isSystemAdmin) return;
    try {
      await assignmentMutation.mutateAsync({
        userId: selectedUser.id,
        adminIds,
        usageOwnerAdminId,
      });
    } catch (error) {
      toast.error("无法更新管理员分配", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
      throw error;
    }
  };

  const handleUpload = async (file: File) => {
    if (!selectedUserId) return;
    setUploading("knowledge");
    try {
      await uploadWorkspaceFile({
        userId: selectedUserId,
        file,
        mode: "knowledge",
      });
      await Promise.all([
        dashboardQuery.refetch(),
        knowledgeQuery.refetch(),
        knowledgeProgressQuery.refetch(),
        workspaceQuery.refetch(),
      ]);
      toast.success("知识库新版本已发布", {
        description: file.name,
      });
    } catch (error) {
      toast.error("文件导入失败", {
        description: error instanceof Error ? error.message : "请检查文件格式",
      });
    } finally {
      setUploading(null);
    }
  };

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title={isSystemAdmin ? "客户交付工作台" : "客户管理"}
      navItems={getAdminNav(Boolean(workspaceQuery.data?.isSystemAdmin))}
      toolbar={
        <Button
          variant="outline"
          size="sm"
          className="border-[#e1d8e8] bg-white"
          disabled={workspaceQuery.isFetching}
          onClick={() => void workspaceQuery.refetch()}
        >
          <RefreshCw
            className={`h-4 w-4 ${workspaceQuery.isFetching ? "animate-spin" : ""}`}
          />
          刷新
        </Button>
      }
    >
      {workspaceQuery.error && (
        <PortalCard className="mb-5 border-[#ebc8d4] bg-[#fff8fa] p-5 text-sm text-[#a02652]">
          <p className="font-semibold">客户工作区暂时无法载入</p>
          <p className="mt-1 leading-6">
            {workspaceQuery.error.message || "请检查连接后重试。"}
          </p>
        </PortalCard>
      )}

      <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
        <PortalCard className="h-fit overflow-hidden">
          <div className="border-b border-[#e8e1ee] p-5">
            <div className="flex items-center gap-2">
              <UserCog className="h-5 w-5 text-[#5b2a86]" />
              <h2 className="font-semibold text-[#171321]">客户列表</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#716a80]">
              {workspaceQuery.data?.isSystemAdmin
                ? "系统管理员可查看全部客户；其他管理员仅看到被分配的客户。"
                : "仅显示已分配给你的客户。"}
            </p>
          </div>
          <div className="max-h-[680px] divide-y divide-[#eee8f2] overflow-y-auto custom-scrollbar">
            {workspaceQuery.isLoading ? (
              <div className="p-8 text-center text-sm text-[#716a80]">
                加载用户中…
              </div>
            ) : workspaceQuery.error ? (
              <div className="p-8 text-center text-sm text-[#a02652]">
                无法读取客户列表，请点击刷新重试。
              </div>
            ) : workspaceQuery.data?.users.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#716a80]">
                暂无可管理客户
              </div>
            ) : (
              workspaceQuery.data?.users.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => {
                    setSelectedUserId(account.id);
                    setLocation(`/admin/customers/${account.id}/${tab}`);
                  }}
                  className={`w-full p-4 text-left transition ${
                    selectedUserId === account.id
                      ? "bg-[#5b2a86]/8"
                      : "hover:bg-[#fbf9fd]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#221a33]">
                        {account.enterpriseName ||
                          account.displayName ||
                          account.username}
                      </p>
                      <p className="mt-1 truncate text-xs text-[#9a94a8]">
                        @{account.username}
                      </p>
                    </div>
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        account.isActive ? "bg-[#16794f]" : "bg-[#ba2454]"
                      }`}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="text-xs">
                      {account.service?.planCode === "advanced"
                        ? "进阶版"
                        : account.service?.planCode === "luxury"
                          ? "豪华版"
                          : account.service?.planCode === "basic"
                            ? "普通版"
                            : "版本待配置"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {account.marketEdition === "overseas"
                        ? "海外版"
                        : "海内版"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      管理员 {account.assignedAdmins.length}
                    </Badge>
                  </div>
                </button>
              ))
            )}
          </div>
        </PortalCard>

        {!selectedUser ? (
          <PortalCard className="grid min-h-[520px] place-items-center p-8 text-center text-sm text-[#716a80]">
            {workspaceQuery.isLoading
              ? "正在核验客户访问权限…"
              : selectedUserId
                ? "该客户不存在，或尚未分配给当前管理员。"
                : "请选择一个客户开始管理"}
          </PortalCard>
        ) : (
          <div className="min-w-0 space-y-5">
            <PortalCard className="p-5 sm:p-6">
              <div className="grid gap-5 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)] lg:items-start">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#5b2a86]">
                    客户工作空间
                  </p>
                  <h2
                    className="mt-1 truncate text-2xl font-semibold text-[#171321]"
                    title={
                      selectedUser.enterpriseName ||
                      selectedUser.displayName ||
                      selectedUser.username ||
                      undefined
                    }
                  >
                    {selectedUser.enterpriseName ||
                      selectedUser.displayName ||
                      selectedUser.username}
                  </h2>
                  <p
                    className="mt-2 truncate text-sm text-[#716a80]"
                    title={`@${selectedUser.username}`}
                  >
                    @{selectedUser.username}
                  </p>
                </div>

                <ManagerAssignmentEditor
                  key={selectedUser.id}
                  options={(workspaceQuery.data?.admins ?? []).map((admin) => ({
                    id: admin.id,
                    label:
                      admin.displayName ||
                      admin.username ||
                      `管理员 ${admin.id}`,
                    secondary: admin.username ? `@${admin.username}` : null,
                    accessLevel: admin.adminAccessLevel,
                  }))}
                  selectedIds={selectedUser.assignedAdmins.map(
                    (admin) => admin!.id,
                  )}
                  usageOwnerId={selectedUser.usageOwner?.adminId ?? null}
                  editable={Boolean(workspaceQuery.data?.isSystemAdmin)}
                  saving={assignmentMutation.isPending}
                  onSave={handleAssignment}
                />
              </div>

              <div className="mt-5 grid gap-3 border-t border-[#eee8f2] pt-5 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">套餐</p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : serviceQuery.data?.service?.planName || "版本待配置"}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    服务周期
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : `${displayDate(
                            serviceQuery.data?.service?.validFrom,
                          )} — ${displayDate(
                            serviceQuery.data?.service?.validUntil,
                          )}`}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    当期问题
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "—"
                        : `${serviceQuery.data?.purchasedQuestions?.length ?? 0} 个`}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    服务端下一步
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : serviceQuery.data?.nextAction?.label ||
                          serviceQuery.data?.nextAction?.title ||
                          "暂无待处理动作"}
                  </p>
                </div>
              </div>

              {serviceQuery.error && (
                <div className="mt-4 rounded-xl border border-[#ebc8d4] bg-[#fff8fa] px-4 py-3 text-sm text-[#a02652]">
                  套餐、配额与交付状态读取失败：
                  {serviceQuery.error.message || "请刷新后重试。"}
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-2 border-t border-[#eee8f2] pt-4">
                {availableTabs.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setTab(value);
                      setLocation(
                        `/admin/customers/${selectedUser.id}/${value}`,
                      );
                    }}
                    className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                      tab === value
                        ? "bg-[#5b2a86] text-white"
                        : "bg-[#f3eef6] text-[#716a80] hover:text-[#5b2a86]"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>
            </PortalCard>

            {tab === "service" && (
              <div className="space-y-5">
                <PortalCard className="p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <PackageCheck className="h-5 w-5 text-[#5b2a86]" />
                        <h3 className="font-semibold text-[#171321]">
                          套餐与服务周期
                        </h3>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[#716a80]">
                        当前版本：
                        <span className="font-semibold text-[#332842]">
                          {serviceQuery.isLoading
                            ? "读取中…"
                            : serviceQuery.error
                              ? "暂时无法读取"
                              : serviceQuery.data?.service?.planName ||
                                "版本待配置"}
                        </span>
                        {!serviceQuery.error && !serviceQuery.isLoading && (
                          <>
                            {" · "}
                            {displayDate(serviceQuery.data?.service?.validFrom)}
                            {" 至 "}
                            {displayDate(
                              serviceQuery.data?.service?.validUntil,
                            )}
                          </>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-[#9a94a8]">
                        {workspaceQuery.data?.isSystemAdmin
                          ? "商业权益仅系统管理员可调整；正式内容编辑只用于初始化和异常治理，正常交付由对应工程师完成。"
                          : "交付管理员查看客户正式页面并协调对应工程师；不能直接修改或发布岗位交付内容。"}
                      </p>
                    </div>
                  </div>

                  {workspaceQuery.data?.isSystemAdmin &&
                    !serviceQuery.error &&
                    !serviceQuery.isLoading && (
                      <div className="mt-6 grid gap-4 border-t border-[#eee8f2] pt-5 lg:grid-cols-3">
                        <label className="text-xs font-semibold text-[#716a80]">
                          套餐版本
                          <select
                            value={servicePlan}
                            onChange={(event) => {
                              const nextPlan = event.target.value as
                                | "basic"
                                | "advanced"
                                | "luxury";
                              setServicePlan(nextPlan);
                            }}
                            className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
                          >
                            <option value="basic">普通版 · 30 天单题</option>
                            <option value="advanced">进阶版</option>
                            <option value="luxury">豪华版</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          生效日期
                          <Input
                            type="date"
                            className="mt-2"
                            value={serviceStartsAt}
                            onChange={(event) =>
                              setServiceStartsAt(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          合同状态
                          <select
                            value={serviceStatus}
                            onChange={(event) =>
                              setServiceStatus(
                                event.target.value as typeof serviceStatus,
                              )
                            }
                            className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
                          >
                            <option value="active">生效</option>
                            <option value="scheduled">待生效</option>
                            <option value="pending_confirmation">待确认</option>
                            <option value="suspended">暂停</option>
                            <option value="cancelled">取消</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          签署主体
                          <Input
                            className="mt-2"
                            value={serviceSignatory}
                            placeholder="企业名 / 签署人 / 统一社会信用代码"
                            onChange={(event) =>
                              setServiceSignatory(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          实际签署时间
                          <Input
                            type="datetime-local"
                            className="mt-2"
                            value={serviceSignedAt}
                            onChange={(event) =>
                              setServiceSignedAt(event.target.value)
                            }
                          />
                        </label>
                        {(questionPortfolioQuery.data?.questions ?? []).some(
                          (question: any) => question.status === "selected",
                        ) && (
                          <div className="lg:col-span-3 rounded-2xl border border-[#e7dced] bg-[#fbf9fd] p-4">
                            <p className="text-sm font-semibold text-[#332842]">
                              升级后继续服务的问题
                            </p>
                            <p className="mt-1 text-xs leading-5 text-[#857e91]">
                              已勾选问题会复制到新套餐并计入对应分类额度；若超额，保存会被服务端拒绝，必须先明确保留项。
                            </p>
                            <div className="mt-3 space-y-2">
                              {(questionPortfolioQuery.data?.questions ?? [])
                                .filter(
                                  (question: any) =>
                                    question.status === "selected",
                                )
                                .map((question: any) => (
                                  <label
                                    key={question.id}
                                    className="flex items-start gap-3 rounded-xl bg-white p-3 text-sm text-[#484057]"
                                  >
                                    <input
                                      type="checkbox"
                                      className="mt-1"
                                      checked={carryQuestionIds.includes(
                                        question.id,
                                      )}
                                      onChange={(event) =>
                                        setCarryQuestionIds((current) =>
                                          event.target.checked
                                            ? [
                                                ...new Set([
                                                  ...current,
                                                  question.id,
                                                ]),
                                              ]
                                            : current.filter(
                                                (id) => id !== question.id,
                                              ),
                                        )
                                      }
                                    />
                                    <span>{question.question}</span>
                                  </label>
                                ))}
                            </div>
                          </div>
                        )}

                        <div className="lg:col-span-3 flex justify-end">
                          <Button
                            className="bg-[#5b2a86] hover:bg-[#49216c]"
                            disabled={
                              !serviceStartsAt ||
                              updateServiceMutation.isPending
                            }
                            onClick={async () => {
                              if (!selectedUserId) return;
                              const isCommerciallyActive =
                                serviceStatus === "active" ||
                                serviceStatus === "scheduled";
                              if (
                                isCommerciallyActive &&
                                (!serviceSignatory.trim() || !serviceSignedAt)
                              ) {
                                toast.error("请补全签署信息", {
                                  description:
                                    "生效或待生效合同必须填写真实签署时间与签署主体。",
                                });
                                return;
                              }
                              const startsAt = new Date(
                                `${serviceStartsAt}T00:00:00+08:00`,
                              ).getTime();
                              const currentContractId =
                                serviceQuery.data?.service?.contractId;
                              const activeBasicIds =
                                serviceQuery.data?.service?.planCode === "basic"
                                  ? (serviceQuery.data?.purchases ?? [])
                                      .filter(
                                        (purchase: any) =>
                                          purchase.planCode === "basic" &&
                                          (purchase.status === "active" ||
                                            purchase.status === "scheduled"),
                                      )
                                      .map((purchase: any) => purchase.id)
                                  : [];
                              const sourceContractIds = activeBasicIds.length
                                ? activeBasicIds
                                : currentContractId
                                  ? [currentContractId]
                                  : undefined;
                              const allowedCarryIds = new Set(
                                (questionPortfolioQuery.data?.questions ?? [])
                                  .filter(
                                    (question: any) =>
                                      question.status === "selected" &&
                                      (!sourceContractIds ||
                                        sourceContractIds.includes(
                                          question.contractId,
                                        )),
                                  )
                                  .map((question: any) => question.id),
                              );
                              try {
                                await updateServiceMutation.mutateAsync({
                                  userId: selectedUserId,
                                  expectedRevision:
                                    serviceQuery.data?.revision ?? 0,
                                  planCode: servicePlan,
                                  startsAt,
                                  status: serviceStatus,
                                  prepaidMonths:
                                    servicePlan === "basic" ? null : 3,
                                  signedAt: serviceSignedAt
                                    ? new Date(serviceSignedAt).getTime()
                                    : undefined,
                                  signatoryId:
                                    serviceSignatory.trim() || undefined,
                                  sourceContractIds,
                                  carryQuestionIds: carryQuestionIds.filter(
                                    (id) => allowedCarryIds.has(id),
                                  ),
                                });
                              } catch (error) {
                                toast.error("服务版本更新失败", {
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : "请刷新后重试",
                                });
                              }
                            }}
                          >
                            {updateServiceMutation.isPending && (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            保存服务版本
                          </Button>
                        </div>
                      </div>
                    )}
                </PortalCard>
              </div>
            )}

            {tab === "service" &&
              (dashboardQuery.error ? (
                <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
                  <p className="font-semibold">交付内容暂时无法载入</p>
                  <p className="mt-1 leading-6">
                    {dashboardQuery.error.message || "请刷新后重试。"}
                  </p>
                </PortalCard>
              ) : (
                <div className="space-y-5">
                  {isSystemAdmin ? (
                    <>
                      <DashboardSkeletonEditor
                        userId={selectedUser.id}
                        workspace={dashboardQuery.data}
                        loading={dashboardQuery.isLoading}
                        knowledgePreview={{
                          progress: knowledgeProgressQuery.data?.progress,
                          snapshot: knowledgeQuery.data?.snapshot,
                          activity: knowledgeActivityQuery.data,
                          activityLoading: knowledgeActivityQuery.isLoading,
                          activityError:
                            knowledgeActivityQuery.error?.message ?? null,
                          progressLoading: knowledgeProgressQuery.isLoading,
                          progressError:
                            knowledgeProgressQuery.error?.message ?? null,
                          snapshotLoading: knowledgeQuery.isLoading,
                          snapshotError: knowledgeQuery.error?.message ?? null,
                        }}
                        websiteWorkspace={websiteWorkspacePreview}
                        servicePortal={serviceQuery.data}
                        servicePortalLoading={serviceQuery.isLoading}
                        servicePortalError={serviceQuery.isError}
                        onRefreshServicePortal={() => serviceQuery.refetch()}
                        knowledgeUploading={uploading === "knowledge"}
                        onUploadKnowledge={handleUpload}
                        onOpenWebsiteWorkspace={() => {
                          setTab("tickets");
                          setLocation(
                            `/admin/customers/${selectedUser.id}/tickets`,
                          );
                        }}
                        authoritativeQuestions={
                          serviceQuery.data?.purchasedQuestions
                        }
                        authoritativeQuestionsLoading={serviceQuery.isLoading}
                        authoritativeQuestionsError={
                          serviceQuery.error?.message ?? null
                        }
                        onWorkspaceChanged={async () => {
                          await Promise.all([
                            dashboardQuery.refetch(),
                            workspaceQuery.refetch(),
                            serviceQuery.refetch(),
                            questionPortfolioQuery.refetch(),
                            deliveryPreviewQuery.refetch(),
                          ]);
                        }}
                      />
                      <DashboardVersionHistory
                        userId={selectedUser.id}
                        onWorkspaceChanged={async () => {
                          await Promise.all([
                            dashboardQuery.refetch(),
                            workspaceQuery.refetch(),
                          ]);
                        }}
                      />
                    </>
                  ) : dashboardQuery.isLoading ? (
                    <PortalCard className="p-8 text-center text-sm text-[#716a80]">
                      <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
                      正在读取客户正式页面…
                    </PortalCard>
                  ) : dashboardQuery.data?.payload ? (
                    <CustomerDashboardMirror
                      payload={dashboardQuery.data.payload}
                      websiteWorkspace={websiteWorkspacePreview}
                      servicePortal={serviceQuery.data}
                      servicePortalLoading={serviceQuery.isLoading}
                      servicePortalError={serviceQuery.isError}
                      onRefreshServicePortal={() => serviceQuery.refetch()}
                      knowledgePreview={{
                        progress: knowledgeProgressQuery.data?.progress,
                        snapshot: knowledgeQuery.data?.snapshot,
                        activity: knowledgeActivityQuery.data,
                        activityLoading: knowledgeActivityQuery.isLoading,
                        activityError:
                          knowledgeActivityQuery.error?.message ?? null,
                        progressLoading: knowledgeProgressQuery.isLoading,
                        progressError:
                          knowledgeProgressQuery.error?.message ?? null,
                        snapshotLoading: knowledgeQuery.isLoading,
                        snapshotError: knowledgeQuery.error?.message ?? null,
                      }}
                    />
                  ) : (
                    <PortalCard className="p-8 text-center text-sm text-[#716a80]">
                      {isSystemAdmin
                        ? "该客户尚未发布正式用户页面；请先确认项目岗位是否已配齐，也可在客户工单中进入系统管理员处理工作台接管。"
                        : "该客户尚未发布正式用户页面；请先确认项目岗位是否已配齐，并协调对应工程师处理。"}
                    </PortalCard>
                  )}
                </div>
              ))}

            {tab === "tickets" && (
              <AdminDeliveryTicketWorkspace
                userId={selectedUser.id}
                enterpriseName={
                  selectedUser.enterpriseName ||
                  selectedUser.displayName ||
                  selectedUser.username
                }
                customerUsername={selectedUser.username}
                servicePlanCode={selectedUser.service?.planCode}
                serviceStatus={selectedUser.service?.status}
                canAdjustQuota={isSystemAdmin}
                canExecuteDelivery={isSystemAdmin}
              />
            )}
          </div>
        )}
      </div>
    </PortalShell>
  );
}
