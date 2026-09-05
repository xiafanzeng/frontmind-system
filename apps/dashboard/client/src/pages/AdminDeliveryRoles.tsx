import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BriefcaseBusiness,
  CheckCircle2,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCog,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

const ROLE_TYPES = Object.keys(DELIVERY_ROLE_LABELS) as DeliveryRoleType[];

type ProjectTeamProject = {
  id: number;
  username: string | null;
  displayName: string | null;
  isActive: boolean;
  planCode: string | null;
  contractStatus: string | null;
  contractStartsAt: Date | string | number | null;
  contractEndsAt: Date | string | number | null;
  managerId: number | null;
  managerUsername: string | null;
  managerDisplayName: string | null;
  requiredRoleTypes: DeliveryRoleType[];
};

type ProjectTeamAssignment = {
  id: string;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number | null;
  revision: number;
  engineerUsername: string | null;
  engineerDisplayName: string | null;
  engineerApiKeyConfigured: boolean;
};

type ProjectTeamEngineer = {
  id: number;
  username: string | null;
  displayName: string | null;
  isActive: boolean;
  engineerRoleType: DeliveryRoleType | null;
  apiKeyConfigured: boolean;
  apiKeyManageable?: boolean;
  apiKeyManageReason?: string | null;
};

type ProjectTicket = {
  id: string;
  userId: number;
  workflowDomain: DeliveryRoleType | null;
  assignedProjectAssignmentId?: string | null;
  assignedMemberId: number | null;
};

type ProjectTeamOverview = {
  projects: ProjectTeamProject[];
  assignments: ProjectTeamAssignment[];
  engineers: ProjectTeamEngineer[];
  tickets: ProjectTicket[];
};

type TeamStatusFilter = "all" | "complete" | "incomplete";

export function getMissingProjectRoleTypes(
  project: Pick<ProjectTeamProject, "id" | "requiredRoleTypes">,
  assignments: Array<
    Pick<
      ProjectTeamAssignment,
      "customerUserId" | "roleType" | "engineerUserId"
    >
  >,
) {
  const assignedRoleTypes = new Set(
    assignments
      .filter(
        (assignment) =>
          assignment.customerUserId === project.id &&
          assignment.engineerUserId != null,
      )
      .map((assignment) => assignment.roleType),
  );
  return project.requiredRoleTypes.filter(
    (roleType) => !assignedRoleTypes.has(roleType),
  );
}

export function summarizeProjectTeams(
  projects: Array<
    Pick<ProjectTeamProject, "id" | "managerId" | "requiredRoleTypes">
  >,
  assignments: Array<
    Pick<
      ProjectTeamAssignment,
      "customerUserId" | "roleType" | "engineerUserId"
    >
  >,
  tickets: Array<Pick<ProjectTicket, "workflowDomain" | "assignedMemberId">>,
) {
  const missingByProject = projects.map((project) => ({
    managerMissing: project.managerId == null,
    roleTypes: getMissingProjectRoleTypes(project, assignments),
  }));
  return {
    projectCount: projects.length,
    incompleteProjectCount: missingByProject.filter(
      ({ managerMissing, roleTypes }) => managerMissing || roleTypes.length > 0,
    ).length,
    missingRoleCount: missingByProject.reduce(
      (total, { roleTypes }) => total + roleTypes.length,
      0,
    ),
    pendingTicketCount: tickets.filter(
      (ticket) => ticket.workflowDomain && ticket.assignedMemberId == null,
    ).length,
  };
}

export function filterProjectTeams(
  projects: ProjectTeamProject[],
  assignments: ProjectTeamAssignment[],
  filters: {
    query: string;
    planCode: string;
    managerId: string;
    teamStatus: TeamStatusFilter;
  },
) {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("zh-CN");
  return projects.filter((project) => {
    if (
      normalizedQuery &&
      ![project.displayName, project.username, String(project.id)].some(
        (value) =>
          String(value ?? "")
            .toLocaleLowerCase("zh-CN")
            .includes(normalizedQuery),
      )
    ) {
      return false;
    }
    if (filters.planCode !== "all" && project.planCode !== filters.planCode) {
      return false;
    }
    if (
      filters.managerId !== "all" &&
      String(project.managerId ?? "") !== filters.managerId
    ) {
      return false;
    }
    const isComplete =
      project.managerId != null &&
      getMissingProjectRoleTypes(project, assignments).length === 0;
    if (filters.teamStatus === "complete" && !isComplete) return false;
    if (filters.teamStatus === "incomplete" && isComplete) return false;
    return true;
  });
}

function getInitialProjectSelection() {
  if (typeof window === "undefined") return null;
  const value = Number(
    new URLSearchParams(window.location.search).get("customer"),
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

export default function AdminDeliveryRoles() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const overview = trpc.delivery.management.overview.useQuery();
  const setProjectEngineer =
    trpc.delivery.management.setProjectEngineer.useMutation();
  const [query, setQuery] = useState("");
  const [planCode, setPlanCode] = useState("all");
  const [managerId, setManagerId] = useState("all");
  const [teamStatus, setTeamStatus] = useState<TeamStatusFilter>("all");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    getInitialProjectSelection,
  );

  const data = overview.data as unknown as ProjectTeamOverview | undefined;
  const projects = data?.projects ?? [];
  const assignments = data?.assignments ?? [];
  const engineers = data?.engineers ?? [];
  const tickets = data?.tickets ?? [];

  const managers = useMemo(() => {
    const unique = new Map<
      number,
      { id: number; username: string | null; displayName: string | null }
    >();
    for (const project of projects) {
      if (project.managerId == null) continue;
      unique.set(project.managerId, {
        id: project.managerId,
        username: project.managerUsername,
        displayName: project.managerDisplayName,
      });
    }
    return [...unique.values()].sort((left, right) =>
      engineerName(left).localeCompare(engineerName(right), "zh-CN"),
    );
  }, [projects]);

  const filteredProjects = useMemo(
    () =>
      filterProjectTeams(projects, assignments, {
        query,
        planCode,
        managerId,
        teamStatus,
      }),
    [assignments, managerId, planCode, projects, query, teamStatus],
  );
  const summary = useMemo(
    () => summarizeProjectTeams(projects, assignments, tickets),
    [assignments, projects, tickets],
  );
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  const firstPendingTicket = tickets.find(
    (ticket) => ticket.workflowDomain && ticket.assignedMemberId == null,
  );

  useEffect(() => {
    if (!data) return;
    if (!filteredProjects.length) {
      setSelectedProjectId(null);
      return;
    }
    if (!filteredProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(filteredProjects[0].id);
    }
  }, [data, filteredProjects, selectedProjectId]);

  const refresh = async () => {
    await utils.delivery.management.overview.invalidate();
  };

  const updateEngineer = async (input: {
    customerUserId: number;
    roleType: DeliveryRoleType;
    engineerUserId: number | null;
    expectedRevision: number;
  }) => {
    try {
      await setProjectEngineer.mutateAsync(input);
      await refresh();
      toast.success(
        input.engineerUserId == null
          ? "项目岗位已解除分配"
          : "项目工程师已更新，未结束工单已按岗位同步转交",
      );
    } catch (error) {
      await refresh();
      toast.error(error instanceof Error ? error.message : "岗位分配失败");
    }
  };

  return (
    <PortalShell
      eyebrow="交付管理 · 客户项目"
      title="客户项目团队"
      navItems={getAdminNav(isSystemAdminAccount(user))}
      toolbar={
        <Button
          variant="outline"
          onClick={() => void overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw className={overview.isFetching ? "animate-spin" : ""} />
          刷新
        </Button>
      }
    >
      <div className="mx-auto grid w-full max-w-7xl gap-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="客户项目"
            value={summary.projectCount}
            icon={<BriefcaseBusiness className="h-5 w-5" />}
          />
          <SummaryCard
            label="待完善项目"
            value={summary.incompleteProjectCount}
            tone={summary.incompleteProjectCount ? "warning" : "success"}
            icon={<ShieldAlert className="h-5 w-5" />}
          />
          <SummaryCard
            label="缺少工程师岗位"
            value={summary.missingRoleCount}
            tone={summary.missingRoleCount ? "warning" : "success"}
            icon={<UsersRound className="h-5 w-5" />}
          />
          <SummaryCard
            label="待分配工单"
            value={summary.pendingTicketCount}
            tone={summary.pendingTicketCount ? "warning" : "success"}
            icon={<AlertTriangle className="h-5 w-5" />}
            onClick={
              firstPendingTicket?.workflowDomain
                ? () => {
                    setSelectedProjectId(firstPendingTicket.userId);
                    window.setTimeout(
                      () =>
                        document
                          .getElementById("project-team-details")
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          }),
                      0,
                    );
                  }
                : undefined
            }
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>筛选客户项目</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索客户名称或账号"
              />
            </div>
            <NativeSelect
              value={planCode}
              onChange={setPlanCode}
              options={[
                { value: "all", label: "全部套餐" },
                { value: "basic", label: "普通版" },
                { value: "advanced", label: "进阶版" },
                { value: "luxury", label: "豪华版" },
              ]}
            />
            <NativeSelect
              value={managerId}
              onChange={setManagerId}
              options={[
                { value: "all", label: "全部交付管理员" },
                ...managers.map((manager) => ({
                  value: String(manager.id),
                  label: engineerName(manager),
                })),
              ]}
            />
            <NativeSelect
              value={teamStatus}
              onChange={(value) => setTeamStatus(value as TeamStatusFilter)}
              options={[
                { value: "all", label: "全部团队状态" },
                { value: "complete", label: "岗位已配齐" },
                { value: "incomplete", label: "岗位待完善" },
              ]}
            />
          </CardContent>
        </Card>

        {overview.isLoading ? (
          <Card>
            <CardContent className="py-14 text-center text-sm text-muted-foreground">
              正在读取客户项目团队…
            </CardContent>
          </Card>
        ) : overview.error ? (
          <Card className="border-destructive/30">
            <CardContent className="py-14 text-center text-sm text-destructive">
              客户项目团队暂时无法读取，请刷新后重试。
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>项目列表（{filteredProjects.length}）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {filteredProjects.map((project) => {
                  const projectAssignments = assignments.filter(
                    (assignment) => assignment.customerUserId === project.id,
                  );
                  const requiredAssignmentCount =
                    project.requiredRoleTypes.filter((roleType) =>
                      projectAssignments.some(
                        (assignment) => assignment.roleType === roleType,
                      ),
                    ).length;
                  const missing = getMissingProjectRoleTypes(
                    project,
                    assignments,
                  );
                  const managerMissing = project.managerId == null;
                  const pendingTicketRows = tickets.filter(
                    (ticket) =>
                      ticket.userId === project.id &&
                      ticket.workflowDomain &&
                      ticket.assignedMemberId == null,
                  );
                  const pendingTickets = pendingTicketRows.length;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className={cn(
                        "w-full rounded-xl border p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/25",
                        selectedProjectId === project.id &&
                          "border-primary bg-primary/[0.035]",
                      )}
                      onClick={() => {
                        setSelectedProjectId(project.id);
                        window.setTimeout(
                          () =>
                            document
                              .getElementById("project-team-details")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              }),
                          0,
                        );
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {projectName(project)}
                          </p>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {project.username || `客户 #${project.id}`}
                          </p>
                        </div>
                        <Badge
                          variant={
                            managerMissing || missing.length
                              ? "outline"
                              : "secondary"
                          }
                          className={
                            managerMissing || missing.length
                              ? "border-amber-300 text-amber-700"
                              : "text-emerald-700"
                          }
                        >
                          {managerMissing
                            ? "缺少交付管理员"
                            : missing.length
                              ? `缺少 ${missing.length} 岗`
                              : "已配齐"}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline">
                          {planLabel(project.planCode)}
                        </Badge>
                        <Badge variant="outline">
                          {contractStatusLabel(project.contractStatus)}
                        </Badge>
                        {!project.isActive && (
                          <Badge variant="destructive">账号已停用</Badge>
                        )}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="truncate">
                          交付管理员：
                          {project.managerDisplayName ||
                            project.managerUsername ||
                            "未设置"}
                        </span>
                        <span>
                          {requiredAssignmentCount}/
                          {project.requiredRoleTypes.length} 岗
                        </span>
                      </div>
                      {pendingTickets > 0 && (
                        <p className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs font-medium text-amber-700">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {pendingTickets} 个待分配工单，点击配置缺失岗位
                        </p>
                      )}
                    </button>
                  );
                })}
                {!filteredProjects.length && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    没有符合当前筛选条件的客户项目
                  </p>
                )}
              </CardContent>
            </Card>

            <Card id="project-team-details" className="scroll-mt-5">
              <CardHeader>
                <CardTitle>项目团队详情</CardTitle>
              </CardHeader>
              <CardContent>
                {selectedProject ? (
                  <ProjectDetails
                    project={selectedProject}
                    assignments={assignments}
                    engineers={engineers}
                    tickets={tickets}
                    mutationPending={setProjectEngineer.isPending}
                    onUpdateEngineer={updateEngineer}
                  />
                ) : (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    请选择一个客户项目查看团队配置
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </PortalShell>
  );
}

function ProjectDetails({
  project,
  assignments,
  engineers,
  tickets,
  mutationPending,
  onUpdateEngineer,
}: {
  project: ProjectTeamProject;
  assignments: ProjectTeamAssignment[];
  engineers: ProjectTeamEngineer[];
  tickets: ProjectTicket[];
  mutationPending: boolean;
  onUpdateEngineer: (input: {
    customerUserId: number;
    roleType: DeliveryRoleType;
    engineerUserId: number | null;
    expectedRevision: number;
  }) => Promise<void>;
}) {
  const projectAssignments = assignments.filter(
    (assignment) => assignment.customerUserId === project.id,
  );
  const missing = getMissingProjectRoleTypes(project, assignments);
  const managerMissing = project.managerId == null;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{projectName(project)}</h2>
          <Badge variant="outline">{planLabel(project.planCode)}</Badge>
          <Badge
            variant={managerMissing || missing.length ? "outline" : "secondary"}
            className={
              managerMissing || missing.length
                ? "text-amber-700"
                : "text-emerald-700"
            }
          >
            {managerMissing
              ? "待设置交付管理员"
              : missing.length
                ? `待补齐 ${missing.length} 个岗位`
                : "团队已配齐"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {project.username || `客户 #${project.id}`} · 服务期{" "}
          {formatDate(project.contractStartsAt)} 至{" "}
          {formatDate(project.contractEndsAt)}
        </p>
      </div>

      <div className="rounded-xl border bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <UserCog className="h-5 w-5 text-primary" />
          <p className="font-medium">交付管理员负责人</p>
          <Badge variant="outline">只读</Badge>
        </div>
        <p className="mt-2 text-sm">
          {project.managerDisplayName ||
            project.managerUsername ||
            "尚未设置交付管理员"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {project.managerId
            ? `账号：${project.managerUsername || `#${project.managerId}`}。工程师加入后由该管理员负责项目协调；只有跨多个交付管理员共享的工程师 Key 才由系统管理员维护。`
            : "请在客户交付工作台设置该项目的交付管理员。"}
        </p>
      </div>

      <div className="grid gap-3">
        {ROLE_TYPES.map((roleType) => {
          const assignment = projectAssignments.find(
            (row) => row.roleType === roleType,
          );
          const roleTickets = tickets.filter(
            (ticket) =>
              ticket.userId === project.id &&
              ticket.workflowDomain === roleType,
          );
          return (
            <ProjectRoleCard
              key={roleType}
              project={project}
              roleType={roleType}
              assignment={assignment}
              engineers={engineers}
              activeTicketCount={roleTickets.length}
              mutationPending={mutationPending}
              onUpdateEngineer={onUpdateEngineer}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProjectRoleCard({
  project,
  roleType,
  assignment,
  engineers,
  activeTicketCount,
  mutationPending,
  onUpdateEngineer,
}: {
  project: ProjectTeamProject;
  roleType: DeliveryRoleType;
  assignment?: ProjectTeamAssignment;
  engineers: ProjectTeamEngineer[];
  activeTicketCount: number;
  mutationPending: boolean;
  onUpdateEngineer: (input: {
    customerUserId: number;
    roleType: DeliveryRoleType;
    engineerUserId: number | null;
    expectedRevision: number;
  }) => Promise<void>;
}) {
  const enabled = project.requiredRoleTypes.includes(roleType);
  const matchingEngineers = engineers.filter(
    (engineer) => engineer.isActive && engineer.engineerRoleType === roleType,
  );
  const currentEngineer = engineers.find(
    (engineer) => engineer.id === assignment?.engineerUserId,
  );
  const apiKeyConfigured =
    assignment?.engineerApiKeyConfigured ??
    currentEngineer?.apiKeyConfigured ??
    false;
  const assigned = assignment?.engineerUserId != null;
  const disabledRoleWithAssignment = !enabled && assigned;
  const currentEngineerLabel = currentEngineer
    ? engineerName(currentEngineer)
    : assigned
      ? assignment.engineerDisplayName ||
        assignment.engineerUsername ||
        `工程师 #${assignment.engineerUserId}`
      : "";

  const handleChange = async (rawValue: string) => {
    const engineerUserId = rawValue ? Number(rawValue) : null;
    if (engineerUserId === (assignment?.engineerUserId ?? null)) return;
    if (engineerUserId == null && activeTicketCount > 0) {
      toast.error(
        `该岗位还有 ${activeTicketCount} 个未结束工单，只能更换负责人，不能解除分配。`,
      );
      return;
    }
    if (assignment) {
      const confirmed = window.confirm(
        engineerUserId == null
          ? disabledRoleWithAssignment
            ? `确认解除已停用岗位 ${DELIVERY_ROLE_LABELS[roleType]} 的遗留负责人？`
            : `确认解除 ${DELIVERY_ROLE_LABELS[roleType]}？`
          : `确认更换 ${DELIVERY_ROLE_LABELS[roleType]}？系统将同步转交 ${activeTicketCount} 个未结束工单及待处理知识库重置请求。`,
      );
      if (!confirmed) return;
    }
    await onUpdateEngineer({
      customerUserId: project.id,
      roleType,
      engineerUserId,
      expectedRevision: assignment?.revision ?? 0,
    });
  };

  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-shadow",
        !enabled && "bg-muted/25 opacity-75",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{DELIVERY_ROLE_LABELS[roleType]}</p>
            {!enabled ? (
              <>
                <Badge variant="outline">当前套餐未启用</Badge>
                {assigned && (
                  <Badge
                    variant="outline"
                    className="border-amber-300 text-amber-700"
                  >
                    遗留负责人
                  </Badge>
                )}
              </>
            ) : assigned ? (
              <Badge variant="secondary" className="text-emerald-700">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                已分配
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700"
              >
                待分配
              </Badge>
            )}
          </div>
          {(enabled || assigned) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {!enabled
                ? activeTicketCount
                  ? `该岗位有 ${activeTicketCount} 个未结束工单，需先完成后才能解除遗留负责人。`
                  : `当前负责人：${currentEngineerLabel}。该岗位已随套餐停用，可以解除遗留负责人。`
                : activeTicketCount
                  ? `${activeTicketCount} 个未结束工单将随负责人同步转交`
                  : assigned
                    ? `由${project.managerDisplayName || project.managerUsername || "项目交付管理员"}统一管理`
                    : "当前没有未结束工单"}
            </p>
          )}
        </div>
        {assigned && (
          <Badge
            variant="outline"
            className={
              apiKeyConfigured
                ? "border-emerald-300 text-emerald-700"
                : "border-amber-300 text-amber-700"
            }
          >
            {apiKeyConfigured ? "Key 已配置" : "Key 未配置"}
          </Badge>
        )}
      </div>

      {(enabled || assigned) && (
        <select
          className="mt-3 h-10 w-full rounded-md border bg-background px-3 text-sm"
          aria-label={`${DELIVERY_ROLE_LABELS[roleType]}负责人`}
          value={assigned ? String(assignment.engineerUserId) : ""}
          disabled={mutationPending || (!enabled && activeTicketCount > 0)}
          onChange={(event) => void handleChange(event.target.value)}
        >
          <option value="">
            {disabledRoleWithAssignment
              ? "解除已停用岗位"
              : assigned
                ? "解除岗位分配"
                : "选择匹配岗位的工程师"}
          </option>
          {assigned &&
            (!enabled ||
              !currentEngineer ||
              !matchingEngineers.some(
                (engineer) => engineer.id === assignment.engineerUserId,
              )) && (
              <option value={assignment.engineerUserId!}>
                {currentEngineerLabel}
                {enabled ? "（账号已停用）" : "（当前负责人）"}
              </option>
            )}
          {enabled &&
            matchingEngineers.map((engineer) => (
              <option key={engineer.id} value={engineer.id}>
                {engineerName(engineer)}
                {!engineer.apiKeyConfigured
                  ? "（Key 未配置）"
                  : engineer.apiKeyManageable === false
                    ? "（Key 由系统管理员维护）"
                    : ""}
              </option>
            ))}
        </select>
      )}
      {enabled && !matchingEngineers.length && !assigned && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          暂无可分配的同岗位工程师，请先到“账号与权限”创建工程师账号。
        </p>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  tone = "default",
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "default" | "warning" | "success";
  onClick?: () => void;
}) {
  const card = (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p
            className={cn(
              "mt-1 text-2xl font-semibold",
              tone === "warning" && "text-amber-700",
              tone === "success" && "text-emerald-700",
            )}
          >
            {value}
          </p>
        </div>
        <div
          className={cn(
            "rounded-xl bg-muted p-3 text-muted-foreground",
            tone === "warning" && "bg-amber-50 text-amber-700",
            tone === "success" && "bg-emerald-50 text-emerald-700",
          )}
        >
          {icon}
        </div>
      </CardContent>
    </Card>
  );
  return onClick ? (
    <button
      type="button"
      className="rounded-xl text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      aria-label={`${label} ${value} 个，打开首个待处理项目`}
    >
      {card}
    </button>
  ) : (
    card
  );
}

function NativeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      className="h-10 rounded-md border bg-background px-3 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function projectName(
  project: Pick<ProjectTeamProject, "id" | "displayName" | "username">,
) {
  return project.displayName || project.username || `客户 ${project.id}`;
}

function engineerName(engineer: {
  id: number;
  displayName: string | null;
  username: string | null;
}) {
  return engineer.displayName || engineer.username || `账号 ${engineer.id}`;
}

function planLabel(planCode: string | null) {
  if (planCode === "basic") return "普通版";
  if (planCode === "advanced") return "进阶版";
  if (planCode === "luxury") return "豪华版";
  return "套餐未配置";
}

function contractStatusLabel(status: string | null) {
  if (status === "pending_confirmation") return "待确认";
  if (status === "scheduled") return "待生效";
  if (status === "active") return "服务中";
  if (status === "suspended") return "已暂停";
  if (status === "expired") return "已到期";
  if (status === "cancelled") return "已取消";
  return "服务未配置";
}

function formatDate(value: Date | string | number | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}
