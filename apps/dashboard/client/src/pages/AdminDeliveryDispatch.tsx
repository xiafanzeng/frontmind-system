import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
} from "lucide-react";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ticketTypeLabel } from "@/components/AdminDeliveryTicketWorkspace";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import { type DeliveryTicketStatus } from "@shared/delivery-ticket";

export type AdminTicketStatus = "pending" | "completed";

const TERMINAL_DELIVERY_TICKET_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

type DispatchTicket = {
  id: string;
  userId: number;
  type: "content_asset" | "website_operation" | "knowledge_base";
  title?: string | null;
  topic?: string | null;
  operation?: string | null;
  category?: string | null;
  status: DeliveryTicketStatus;
  managementStatus?: AdminTicketStatus;
  workflowDomain: DeliveryRoleType | null;
  assignedProjectAssignmentId?: string | null;
  assignedMemberId: number | null;
  createdAt?: Date | string | null;
  resolvedAt?: Date | string | null;
};

type DispatchProject = {
  id: number;
  username: string | null;
  displayName: string | null;
  managerId?: number | null;
  managerUsername?: string | null;
  managerDisplayName?: string | null;
};

type DispatchAssignment = {
  id: string;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number | null;
  engineerUsername: string | null;
  engineerDisplayName: string | null;
};

type DispatchEngineer = {
  id: number;
  username: string | null;
  displayName: string | null;
};

export type DispatchTicketEvent = {
  id: string;
  ticketId: string;
  actorRole: string;
  message: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: Date | string;
};

type DispatchOverview = {
  projects: DispatchProject[];
  assignments: DispatchAssignment[];
  engineers: DispatchEngineer[];
  tickets: DispatchTicket[];
  completedTickets: DispatchTicket[];
  terminalTickets?: DispatchTicket[];
  ticketEvents: DispatchTicketEvent[];
};

type DispatchFilters = {
  query: string;
  type: string;
  status: "all" | AdminTicketStatus;
  role: string;
  customerId: string;
  managerId: string;
};

export function toAdminTicketStatus(
  status: DeliveryTicketStatus,
): AdminTicketStatus {
  return TERMINAL_DELIVERY_TICKET_STATUSES.has(status)
    ? "completed"
    : "pending";
}

export function hasAuthoritativeProjectOwner(
  ticket: Pick<
    DispatchTicket,
    "workflowDomain" | "assignedProjectAssignmentId" | "assignedMemberId"
  >,
) {
  return (
    !ticket.workflowDomain ||
    (Boolean(ticket.assignedProjectAssignmentId) &&
      ticket.assignedMemberId != null)
  );
}

export function filterDispatchTickets(
  tickets: DispatchTicket[],
  projects: DispatchProject[],
  filters: DispatchFilters,
) {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("zh-CN");
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return tickets.filter((ticket) => {
    if (filters.type !== "all" && ticket.type !== filters.type) return false;
    if (
      filters.status !== "all" &&
      (ticket.managementStatus ?? toAdminTicketStatus(ticket.status)) !==
        filters.status
    ) {
      return false;
    }
    if (filters.role !== "all" && ticket.workflowDomain !== filters.role) {
      return false;
    }
    const project = projectById.get(ticket.userId);
    if (
      filters.customerId !== "all" &&
      String(ticket.userId) !== filters.customerId
    ) {
      return false;
    }
    if (
      filters.managerId !== "all" &&
      String(project?.managerId ?? "") !== filters.managerId
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [
      ticket.title,
      ticket.topic,
      ticket.operation,
      ticket.category,
      project?.displayName,
      project?.username,
    ].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    );
  });
}

/**
 * Build the event lookup once for the whole page. Keeping this outside each
 * ticket row avoids rescanning the complete event history for every ticket.
 */
export function groupDispatchTicketEvents(
  events: DispatchTicketEvent[],
): Map<string, DispatchTicketEvent[]> {
  const eventsByTicket = new Map<string, DispatchTicketEvent[]>();
  for (const event of events) {
    const ticketEvents = eventsByTicket.get(event.ticketId);
    if (ticketEvents) {
      ticketEvents.push(event);
    } else {
      eventsByTicket.set(event.ticketId, [event]);
    }
  }
  return eventsByTicket;
}

export function adminTicketEventPublicMessage(event: DispatchTicketEvent) {
  const message = event.message?.trim();
  if (message) return message;

  const publicStatus = event.toStatus
    ? TERMINAL_DELIVERY_TICKET_STATUSES.has(
        event.toStatus as DeliveryTicketStatus,
      )
      ? "已完成"
      : "待处理"
    : null;
  return publicStatus ? `工单状态更新为${publicStatus}。` : "工单记录已更新。";
}

export default function AdminDeliveryDispatch() {
  const { user } = useAuth();
  const systemAdmin = isSystemAdminAccount(user);
  const overview = trpc.delivery.management.overview.useQuery();
  const [, setLocation] = useLocation();
  const data = overview.data as unknown as DispatchOverview | undefined;
  const [query, setQuery] = useState("");
  const [ticketType, setTicketType] = useState("all");
  const [ticketStatus, setTicketStatus] = useState<"all" | AdminTicketStatus>(
    "all",
  );
  const [roleType, setRoleType] = useState("all");
  const [customerId, setCustomerId] = useState("all");
  const [managerId, setManagerId] = useState("all");
  const terminalTickets = data?.terminalTickets ?? data?.completedTickets ?? [];
  const allTickets = useMemo(
    () => [...(data?.tickets ?? []), ...terminalTickets],
    [data?.tickets, terminalTickets],
  );
  const filteredTickets = useMemo(
    () =>
      filterDispatchTickets(allTickets, data?.projects ?? [], {
        query,
        type: ticketType,
        status: ticketStatus,
        role: roleType,
        customerId,
        managerId,
      }),
    [
      allTickets,
      customerId,
      data?.projects,
      managerId,
      query,
      roleType,
      ticketStatus,
      ticketType,
    ],
  );
  const eventsByTicket = useMemo(
    () => groupDispatchTicketEvents(data?.ticketEvents ?? []),
    [data?.ticketEvents],
  );
  const managerOptions = useMemo(() => {
    const managers = new Map<string, string>();
    for (const project of data?.projects ?? []) {
      if (project.managerId == null) continue;
      managers.set(
        String(project.managerId),
        project.managerDisplayName ||
          project.managerUsername ||
          `管理员 ${project.managerId}`,
      );
    }
    return [...managers.entries()];
  }, [data?.projects]);
  const activeTicketIds = useMemo(
    () => new Set((data?.tickets ?? []).map((ticket) => ticket.id)),
    [data?.tickets],
  );
  const filteredActiveTickets = filteredTickets.filter((ticket) =>
    activeTicketIds.has(ticket.id),
  );
  const filteredTerminalTickets = filteredTickets.filter(
    (ticket) => !activeTicketIds.has(ticket.id),
  );
  const openTicketDetail = (ticket: DispatchTicket) =>
    setLocation(
      `/admin/customers/${ticket.userId}/tickets?ticketId=${encodeURIComponent(ticket.id)}`,
    );

  return (
    <PortalShell
      eyebrow="交付管理 · 工单"
      title="工单"
      navItems={getAdminNav(systemAdmin)}
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
      <div className="mx-auto w-full max-w-7xl">
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {[
            ["待处理", data?.tickets?.length ?? 0],
            ["已完成", terminalTickets.length],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-xl border bg-card px-4 py-3"
            >
              <p className="text-xs font-medium text-muted-foreground">
                {label}
              </p>
              <p className="mt-1 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>

        <Card className="mb-5">
          <CardHeader>
            <CardTitle>工单筛选</CardTitle>
          </CardHeader>
          <CardContent
            className={`grid gap-3 md:grid-cols-2 ${
              systemAdmin ? "xl:grid-cols-6" : "xl:grid-cols-5"
            }`}
          >
            <label className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder="搜索企业或工单"
                aria-label="搜索工单"
              />
            </label>
            <select
              value={ticketType}
              onChange={(event) => setTicketType(event.target.value)}
              aria-label="筛选工单类型"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部类型</option>
              <option value="knowledge_base">品牌知识库</option>
              <option value="content_asset">内容资产</option>
              <option value="website_operation">官网运营</option>
            </select>
            <select
              value={ticketStatus}
              onChange={(event) =>
                setTicketStatus(event.target.value as "all" | AdminTicketStatus)
              }
              aria-label="筛选工单状态"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部状态</option>
              <option value="pending">待处理</option>
              <option value="completed">已完成</option>
            </select>
            <select
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              aria-label="筛选客户"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部客户</option>
              {(data?.projects ?? []).map((project) => (
                <option key={project.id} value={String(project.id)}>
                  {project.displayName ||
                    project.username ||
                    `客户 #${project.id}`}
                </option>
              ))}
            </select>
            <select
              value={roleType}
              onChange={(event) => setRoleType(event.target.value)}
              aria-label="筛选执行岗位"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部岗位</option>
              {Object.entries(DELIVERY_ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {systemAdmin && (
              <select
                value={managerId}
                onChange={(event) => setManagerId(event.target.value)}
                aria-label="筛选交付管理员"
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="all">全部交付管理员</option>
                {managerOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </CardContent>
        </Card>

        <div className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-sm leading-6 text-muted-foreground">
          <strong className="text-foreground">分配规则：</strong>
          {systemAdmin
            ? "工单根据客户项目团队与岗位自动分配给对应工程师；系统管理员可从工单详情进入完整处理工作台进行异常接管。"
            : "工单根据客户项目团队与岗位自动分配给对应工程师；交付管理员可查看详情、沟通和协调，但不能代替工程师完成工单。"}
        </div>
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>待处理</CardTitle>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">
                  共 {filteredActiveTickets.length} 个
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                正在读取未结束工单…
              </p>
            ) : overview.error ? (
              <p className="py-10 text-center text-sm text-destructive">
                工单暂时无法读取，请刷新后重试。
              </p>
            ) : (
              filteredActiveTickets.map((ticket) => (
                <PendingTicketRow
                  key={ticket.id}
                  ticket={ticket}
                  overview={data!}
                  events={eventsByTicket.get(ticket.id) ?? []}
                  onOpenDetail={() => openTicketDetail(ticket)}
                />
              ))
            )}
            {!overview.isLoading &&
              !overview.error &&
              !filteredActiveTickets.length && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  当前没有符合条件的待处理工单
                </p>
              )}
          </CardContent>
        </Card>
        <Card className="mt-5">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>已完成</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  筛选结果 {filteredTerminalTickets.length} 个
                </Badge>
                <Badge
                  variant="outline"
                  className="border-emerald-300 text-emerald-700"
                >
                  已完成 {terminalTickets.length} 个
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                正在读取已完成工单…
              </p>
            ) : overview.error ? (
              <p className="py-10 text-center text-sm text-destructive">
                已完成工单暂时无法读取，请刷新后重试。
              </p>
            ) : (
              filteredTerminalTickets.map((ticket) => (
                <CompletedDispatchRow
                  key={ticket.id}
                  ticket={ticket}
                  overview={data!}
                  onOpenDetail={() => openTicketDetail(ticket)}
                />
              ))
            )}
            {!overview.isLoading &&
              !overview.error &&
              !filteredTerminalTickets.length && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  当前没有符合条件的已完成工单
                </p>
              )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function PendingTicketRow({
  ticket,
  overview,
  events,
  onOpenDetail,
}: {
  ticket: DispatchTicket;
  overview: DispatchOverview;
  events: DispatchTicketEvent[];
  onOpenDetail: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const project = overview.projects.find(
    (candidate) => candidate.id === ticket.userId,
  );
  const projectAssignment = overview.assignments.find(
    (assignment) =>
      assignment.id === ticket.assignedProjectAssignmentId ||
      (assignment.customerUserId === ticket.userId &&
        assignment.roleType === ticket.workflowDomain),
  );
  const assignedEngineer =
    overview.engineers.find(
      (engineer) => engineer.id === ticket.assignedMemberId,
    ) ??
    (projectAssignment?.engineerUserId != null
      ? {
          id: projectAssignment.engineerUserId,
          username: projectAssignment.engineerUsername,
          displayName: projectAssignment.engineerDisplayName,
        }
      : undefined);
  const assignmentSynchronized = hasAuthoritativeProjectOwner(ticket);

  return (
    <div
      className={
        !assignmentSynchronized
          ? "rounded-xl border border-amber-300 bg-amber-50/30 p-4"
          : "rounded-xl border p-4"
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">
              {ticket.title ||
                ticket.operation ||
                ticket.category ||
                "交付工单"}
            </p>
            <Badge variant="outline">待处理</Badge>
            {!assignmentSynchronized && (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700"
              >
                <AlertTriangle className="mr-1 h-3 w-3" />
                岗位归属同步异常
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {project?.displayName ||
              project?.username ||
              `客户 #${ticket.userId}`}{" "}
            · {ticketTypeLabel(ticket.type)} ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain]
              : "旧版技术工单（只读）"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            交付管理员：
            {project?.managerDisplayName ||
              project?.managerUsername ||
              "待设置"}
          </p>
          {ticket.workflowDomain && assignmentSynchronized && (
            <p className="mt-2 text-xs">
              负责人：
              <span className="font-medium">
                {assignedEngineer
                  ? engineerName(assignedEngineer)
                  : "项目岗位负责人"}
              </span>
            </p>
          )}
        </div>

        <Button size="sm" variant="outline" onClick={onOpenDetail}>
          查看工单详情
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setHistoryOpen((value) => !value)}
        >
          {historyOpen ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          处理记录（{events.length}）
        </Button>
      </div>

      {historyOpen && <TicketEventHistory events={events} />}
    </div>
  );
}

function CompletedDispatchRow({
  ticket,
  overview,
  onOpenDetail,
}: {
  ticket: DispatchTicket;
  overview: DispatchOverview;
  onOpenDetail: () => void;
}) {
  const project = overview.projects.find(
    (candidate) => candidate.id === ticket.userId,
  );
  const projectAssignment = overview.assignments.find(
    (assignment) =>
      assignment.id === ticket.assignedProjectAssignmentId ||
      (assignment.customerUserId === ticket.userId &&
        assignment.roleType === ticket.workflowDomain),
  );
  const assignedEngineer =
    overview.engineers.find(
      (engineer) => engineer.id === ticket.assignedMemberId,
    ) ??
    (projectAssignment?.engineerUserId != null
      ? {
          id: projectAssignment.engineerUserId,
          username: projectAssignment.engineerUsername,
          displayName: projectAssignment.engineerDisplayName,
        }
      : undefined);

  return (
    <div className="rounded-xl border bg-muted/15 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">
              {ticket.title ||
                ticket.operation ||
                ticket.category ||
                "交付工单"}
            </p>
            <Badge
              variant="outline"
              className="border-emerald-300 text-emerald-700"
            >
              已完成
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {project?.displayName ||
              project?.username ||
              `客户 #${ticket.userId}`}{" "}
            · {ticketTypeLabel(ticket.type)} ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain]
              : "旧版技术工单"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            交付管理员：
            <span className="font-medium text-foreground">
              {project?.managerDisplayName ||
                project?.managerUsername ||
                "历史记录未保留"}
            </span>
            {" · "}
            负责人：
            <span className="font-medium text-foreground">
              {assignedEngineer
                ? engineerName(assignedEngineer)
                : "历史记录未保留负责人"}
            </span>
            {ticket.resolvedAt
              ? ` · 完成于 ${new Date(ticket.resolvedAt).toLocaleString("zh-CN")}`
              : ""}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-fit shrink-0"
          onClick={onOpenDetail}
        >
          查看工单详情
        </Button>
      </div>
    </div>
  );
}

function TicketEventHistory({ events }: { events: DispatchTicketEvent[] }) {
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-muted/35 p-3">
      {events.slice(0, 20).map((event) => (
        <div key={event.id} className="text-xs leading-5">
          <span className="text-muted-foreground">
            {new Date(event.createdAt).toLocaleString("zh-CN")} ·{" "}
            {event.actorRole}
          </span>
          <p>{adminTicketEventPublicMessage(event)}</p>
        </div>
      ))}
      {!events.length && (
        <p className="text-xs text-muted-foreground">暂无处理记录</p>
      )}
    </div>
  );
}

function engineerName(engineer: {
  id: number;
  displayName: string | null;
  username: string | null;
}) {
  return engineer.displayName || engineer.username || `工程师 ${engineer.id}`;
}
