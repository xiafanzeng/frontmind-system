import AdminAccountBalance from "@/components/AdminAccountBalance";
import { useEffect, useState } from "react";
import {
  PanelRightOpen,
  RefreshCw,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import ManagerAssignmentEditor from "@/components/ManagerAssignmentEditor";
import PortalShell, { PortalCard } from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ADMIN_WORKSPACE_TAB_IDS,
  type WorkspaceTab,
} from "@/lib/admin-workspace-tabs";
import { trpc } from "@/lib/trpc";
import {
  getAdminNav,
} from "@/pages/AdminDashboard";

export { ADMIN_WORKSPACE_TAB_IDS };
export type { WorkspaceTab };

export default function AdminWorkspace({
  initialUserId = null,
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
  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    enabled: user?.role === "admin",
    retry: false,
  });
  const selectedUser = workspaceQuery.data?.users.find(
    (item) => item.id === selectedUserId,
  );
  const isSystemAdmin = Boolean(workspaceQuery.data?.isSystemAdmin);
  useEffect(() => {
    setSelectedUserId(initialUserId);
  }, [initialUserId]);

  const assignmentMutation = trpc.admin.workspace.assignments.useMutation({
    onSuccess: (data) => {
      utils.admin.workspace.list.setData(undefined, data);
      toast.success("管理员分配已更新");
    },
  });
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

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与账户"
      title={isSystemAdmin ? "客户工作台" : "客户管理"}
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
                    setLocation(`/admin/customers/${account.id}/workspace`);
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
                      客户账号
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {account.marketEdition === "overseas"
                        ? "海外版"
                        : "国内版"}
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

              <AdminAccountBalance userId={selectedUser.id} />

              <div className="mt-6 flex flex-wrap gap-2 border-t border-[#eee8f2] pt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="operatorOutline"
                  onClick={() => { window.location.assign(`/?operatorOwnerId=${selectedUser.id}`); }}
                >
                  进入客户工作区
                  <PanelRightOpen className="h-4 w-4" />
                </Button>
              </div>
            </PortalCard>


          </div>
        )}
      </div>
    </PortalShell>
  );
}
