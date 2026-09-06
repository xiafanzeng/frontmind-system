import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ClipboardList,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  UserCog,
  Users,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell, {
  PortalCard,
  type PortalNavItem,
} from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  getRoleScopedPreviewAdminNav,
  previewAdminWorkspaceHref,
} from "@/lib/preview-navigation";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { formatBrandTrackingCredits } from "@shared/brand-tracking-credits";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

type ApiKeyUsageAlert = {
  id: string;
  scope: "website_frontend" | "managed_user";
  userId?: number | null;
  enterpriseName?: string | null;
  credentialFingerprint?: string | null;
  used: number;
  accountUsed: number;
  limit: number;
  warningRatio: number;
  windowDays: number;
  fetchedAt?: number | string | Date | null;
  periodStartedAt?: number | string | Date | null;
  syncStatus: "ok" | "error" | "pending" | string;
};

type ManagedKeyHealth =
  | "connected"
  | "invalid_or_revoked"
  | "sync_error"
  | "unconfigured"
  | "pending";
export type ApiUsageSyncIssueCode =
  | "CREDENTIAL_REJECTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "RESPONSE_INVALID"
  | "PAGINATION_INVALID"
  | "PAGE_DRIFT"
  | "PARTIAL_USAGE_SCAN";
type ManagedAgentProfile = "frontmind-base" | "frontmind-pro";

type AgentUsageFields = {
  provider?: "unavailable" | "zhipu";
  nativeUsage?: {
    unit: "tokens";
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    observedTasks: number;
  };
};

export function normalizeAgentUsageFields(value: unknown): AgentUsageFields {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, any>;
  if (row.provider !== "zhipu")
    return typeof row.provider === "string" ? { provider: "unavailable" } : {};
  const usage = row.nativeUsage;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  return {
    provider: "zhipu",
    ...(usage?.unit === "tokens"
      ? {
          nativeUsage: {
            unit: "tokens" as const,
            inputTokens: count(usage.inputTokens),
            outputTokens: count(usage.outputTokens),
            cacheReadInputTokens: count(usage.cacheReadInputTokens),
            observedTasks: count(usage.observedTasks),
          },
        }
      : {}),
  };
}

export function managedUsageDisplay(
  value: AgentUsageFields & { rolling30DayUsed: number },
) {
  if (value.provider === "unavailable") return "请配置智谱 Key";
  if (!value.nativeUsage?.observedTasks) return "暂无 Token 记录";
  return `${(value.nativeUsage.inputTokens + value.nativeUsage.outputTokens).toLocaleString()} Token`;
}

type AdminUsageHierarchyManager = AgentUsageFields & {
  adminId: number;
  displayName: string;
  username: string | null;
  isActive: boolean;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  keyPool: {
    fingerprint: string | null;
    credentialCount: number;
    totalUsed: number | null;
    limit: number;
    warningRatio: number;
    keyHealth: ManagedKeyHealth;
    syncIssueCode: ApiUsageSyncIssueCode | null;
    keyPoolStale: boolean;
    keyLastSuccessfulAt: number | string | Date | null;
    keyLastAttemptAt: number | string | Date | null;
    fetchedAt: number | string | Date | null;
    severity: string;
  };
  rolling30DayUsed: number;
  usageObservedAt: number | string | Date | null;
  users: Array<{
    userId: number;
    enterpriseName: string;
    username: string | null;
    rolling30DayUsed: number;
    usageObservedAt: number | string | Date | null;
    fingerprint: string | null;
    usesManagerKey: boolean;
    credentialSource: "manager" | "customer" | "unconfigured";
    keyHealth: ManagedKeyHealth;
    syncIssueCode: ApiUsageSyncIssueCode | null;
    fetchedAt: number | string | Date | null;
  }>;
};

type AdminUsageHierarchyEngineer = AgentUsageFields & {
  engineerId: number;
  displayName: string;
  username: string | null;
  isActive: boolean;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  rolling30DayUsed: number;
  usageObservedAt: number | string | Date | null;
  keyPoolTotalUsed: number | null;
  keyLastSuccessfulAt: number | string | Date | null;
  keyLastAttemptAt: number | string | Date | null;
  keyHealth: ManagedKeyHealth;
  syncIssueCode: ApiUsageSyncIssueCode | null;
  keyPoolStale: boolean;
  fingerprint: string | null;
  fetchedAt: number | string | Date | null;
};

type AdminUsageHierarchySystemAdmin = Omit<
  AdminUsageHierarchyEngineer,
  "engineerId"
> & { adminId: number };

type AdminUsageHierarchyCustomer = AgentUsageFields & {
  userId: number;
  enterpriseName: string;
  username: string | null;
  isActive: boolean;
  deliveryAdminId: number | null;
  deliveryAdminName: string | null;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  agentProfile: ManagedAgentProfile;
  usesInheritedKey: boolean;
  rolling30DayUsed: number;
  usageObservedAt: number | string | Date | null;
  keyPoolTotalUsed: number | null;
  keyLastSuccessfulAt: number | string | Date | null;
  keyLastAttemptAt: number | string | Date | null;
  keyHealth: ManagedKeyHealth;
  syncIssueCode: ApiUsageSyncIssueCode | null;
  keyPoolStale: boolean;
  fingerprint: string | null;
  fetchedAt: number | string | Date | null;
};

export function normalizeApiKeyUsageAlerts(value: unknown): ApiKeyUsageAlert[] {
  const payload =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const source = Array.isArray(value)
    ? value
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  return source.map((entry): ApiKeyUsageAlert => {
    const item =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const used = Math.max(0, Number(item.used) || 0);
    const limit = Math.max(1, Number(item.limit) || 230_000);
    const warningRatio = Math.min(
      1,
      Math.max(0, Number(item.warningRatio) || 0.8),
    );
    const scope =
      item.scope === "website_frontend" ? "website_frontend" : "managed_user";
    const id = String(
      item.id ||
        (scope === "website_frontend"
          ? "website-frontend"
          : `managed-user-${item.userId || ""}`),
    );
    return {
      id,
      scope,
      userId:
        Number.isInteger(Number(item.userId)) && Number(item.userId) > 0
          ? Number(item.userId)
          : null,
      enterpriseName: item.enterpriseName ? String(item.enterpriseName) : null,
      credentialFingerprint: item.credentialFingerprint
        ? String(item.credentialFingerprint)
        : null,
      used,
      accountUsed: Math.max(
        0,
        Number(
          item.accountUsed ?? (scope === "website_frontend" ? item.used : 0),
        ) || 0,
      ),
      limit,
      warningRatio,
      windowDays: Math.max(1, Number(item.windowDays) || 30),
      fetchedAt:
        (item.fetchedAt as number | string | Date | null | undefined) ?? null,
      periodStartedAt:
        (item.periodStartedAt as number | string | Date | null | undefined) ??
        null,
      syncStatus: String(item.syncStatus || "pending"),
    };
  });
}

function apiKeyUsageTone(
  item: Pick<
    ApiKeyUsageAlert,
    "syncStatus" | "used" | "limit" | "warningRatio"
  >,
) {
  if (item.syncStatus !== "ok") return "unavailable";
  if (item.used >= item.limit) return "critical";
  if (item.used >= item.limit * item.warningRatio) return "warning";
  return "normal";
}

export const issueMonitorUrl = "/admin/monitoring/accounts";
export const channelDistributionUrl =
  "/admin/monitoring/media-publishing/integration";

type DeliveryEngineerStatusSource = {
  engineers?: Array<{
    id: number;
    username?: string | null;
    displayName?: string | null;
    isActive?: boolean | number | null;
    engineerRoleType?: DeliveryRoleType | null;
    apiKeyConfigured?: boolean | null;
    apiKeyVersion?: number | null;
  }>;
  assignments?: Array<{
    customerUserId: number;
    engineerUserId?: number | null;
  }>;
  projects?: Array<{
    id: number;
    username?: string | null;
    displayName?: string | null;
  }>;
};

export type DeliveryEngineerStatusRow = AgentUsageFields & {
  id: number;
  username: string;
  displayName: string;
  roleType: DeliveryRoleType | null;
  projectNames: string[];
  projectCount: number;
  workStatus: "available" | "unassigned" | "disabled";
  workStatusLabel: string;
  isActive: boolean;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  rolling30DayUsed: number;
  keyPoolTotalUsed: number | null;
  keyHealth: ManagedKeyHealth;
};

export function buildDeliveryEngineerStatusRows(
  source?: DeliveryEngineerStatusSource | null,
): DeliveryEngineerStatusRow[] {
  const projectsById = new Map(
    (source?.projects ?? []).map((project) => [
      project.id,
      String(
        project.displayName || project.username || `客户 ${project.id}`,
      ).trim(),
    ]),
  );
  const assignments = source?.assignments ?? [];
  const statusPriority: Record<
    DeliveryEngineerStatusRow["workStatus"],
    number
  > = {
    available: 2,
    unassigned: 3,
    disabled: 4,
  };

  return (source?.engineers ?? [])
    .map((engineer): DeliveryEngineerStatusRow => {
      const engineerAssignments = assignments.filter(
        (assignment) => assignment.engineerUserId === engineer.id,
      );
      const projectNames = Array.from(
        new Set(
          engineerAssignments.map(
            (assignment) =>
              projectsById.get(assignment.customerUserId) ||
              `客户 ${assignment.customerUserId}`,
          ),
        ),
      );
      const isActive = Boolean(engineer.isActive);
      let workStatus: DeliveryEngineerStatusRow["workStatus"];
      let workStatusLabel: string;

      if (!isActive) {
        workStatus = "disabled";
        workStatusLabel = "账号已停用";
      } else if (projectNames.length === 0) {
        workStatus = "unassigned";
        workStatusLabel = "未分配项目";
      } else {
        workStatus = "available";
        workStatusLabel = "已分配项目";
      }

      return {
        id: engineer.id,
        username: String(engineer.username || `engineer-${engineer.id}`),
        displayName: String(
          engineer.displayName || engineer.username || `工程师 ${engineer.id}`,
        ),
        roleType: engineer.engineerRoleType ?? null,
        projectNames,
        projectCount: projectNames.length,
        workStatus,
        workStatusLabel,
        isActive,
        apiKeyConfigured: Boolean(engineer.apiKeyConfigured),
        apiKeyVersion: Math.max(0, Number(engineer.apiKeyVersion) || 0),
        rolling30DayUsed: 0,
        keyPoolTotalUsed: null,
        keyHealth: "unconfigured",
      };
    })
    .sort((left, right) => {
      const statusDifference =
        statusPriority[left.workStatus] - statusPriority[right.workStatus];
      if (statusDifference !== 0) return statusDifference;
      return left.displayName.localeCompare(right.displayName, "zh-CN");
    });
}

export const adminNav: PortalNavItem[] = [
  { label: "API与人员管理", href: "/", icon: KeyRound, group: "运营" },
  {
    label: "官网任务与AI建站",
    href: "/admin/presales",
    icon: BriefcaseBusiness,
    group: "运营",
  },
  {
    label: "客户交付工作台",
    href: "/admin/workspace",
    icon: UserCog,
    group: "客户与服务",
    activePrefixes: ["/admin/customers", "/admin/delivery-workbench"],
  },
  {
    label: "客户项目团队",
    href: "/admin/delivery-roles",
    icon: UsersRound,
    group: "客户与服务",
  },
  {
    label: "账号与权限",
    href: "/admin/users",
    icon: Users,
    group: "系统管理",
  },
  {
    label: "问题监控",
    href: issueMonitorUrl,
    icon: Activity,
    group: "监控与发布管理",
  },
  {
    label: "媒体发布",
    href: channelDistributionUrl,
    icon: Send,
    group: "监控与发布管理",
  },
];

export function getAdminNav(systemAdmin: boolean) {
  if (systemAdmin) return adminNav;
  return [
    {
      label: "客户管理",
      href: "/admin/workspace",
      icon: UserCog,
      group: "交付管理",
      activePrefixes: ["/admin/customers"],
    },
    {
      label: "客户项目团队",
      href: "/admin/delivery-roles",
      icon: UsersRound,
      group: "交付管理",
    },
    {
      label: "FrontMind Agent",
      href: "/admin/agent",
      icon: Bot,
      group: "Agent 与资源",
    },
    {
      label: "账号与权限",
      href: "/admin/users",
      icon: Users,
      group: "交付管理",
    },
  ];
}

export function getPreviewAdminNav(systemAdmin: boolean) {
  return getRoleScopedPreviewAdminNav(
    systemAdmin ? "system_admin" : "delivery_admin",
  );
}

export function getPreviewAdminWorkspaceHref(systemAdmin: boolean, query = "") {
  const href = previewAdminWorkspaceHref(
    systemAdmin ? "system_admin" : "delivery_admin",
  );
  const normalizedQuery = query.replace(/^\?/, "").trim();
  return normalizedQuery ? `${href}?${normalizedQuery}` : href;
}

export function filterApiKeyUsageForAdmin(
  items: ApiKeyUsageAlert[],
  systemAdmin: boolean,
) {
  return systemAdmin
    ? items
    : items.filter((item) => item.scope === "managed_user");
}

export function filterPreviewApiKeyUsageForAdmin(
  items: ApiKeyUsageAlert[],
  systemAdmin: boolean,
  managedUserIds: readonly number[] = [],
) {
  const roleVisible = filterApiKeyUsageForAdmin(items, systemAdmin);
  if (systemAdmin) return roleVisible;
  const allowed = new Set(managedUserIds);
  return roleVisible.filter(
    (item) => item.userId != null && allowed.has(item.userId),
  );
}

export function groupSharedKeyUsage(items: ApiKeyUsageAlert[]) {
  const groups = new Map<
    string,
    {
      id: string;
      fingerprint: string | null;
      scope: ApiKeyUsageAlert["scope"];
      used: number;
      limit: number;
      warningRatio: number;
      fetchedAt: ApiKeyUsageAlert["fetchedAt"];
      syncStatus: ApiKeyUsageAlert["syncStatus"];
      accountCount: number;
    }
  >();
  for (const item of items) {
    const groupId =
      item.scope === "website_frontend"
        ? `website:${item.id}`
        : item.credentialFingerprint
          ? `managed:${item.credentialFingerprint}`
          : `unconfigured:${item.userId ?? item.id}`;
    const existing = groups.get(groupId);
    if (!existing) {
      groups.set(groupId, {
        id: groupId,
        fingerprint: item.credentialFingerprint ?? null,
        scope: item.scope,
        used: item.used,
        limit: item.limit,
        warningRatio: item.warningRatio,
        fetchedAt: item.fetchedAt,
        syncStatus: item.syncStatus,
        accountCount: item.scope === "managed_user" ? 1 : 0,
      });
      continue;
    }
    // A shared Key's upstream total is the same value on every account
    // snapshot. Keep one pool total instead of adding duplicate snapshots.
    existing.used = Math.max(existing.used, item.used);
    existing.accountCount += item.scope === "managed_user" ? 1 : 0;
    if (existing.syncStatus === "ok" && item.syncStatus !== "ok") {
      existing.syncStatus = item.syncStatus;
    }
  }
  return [...groups.values()];
}

export function normalizeUsageHierarchy(value: unknown): {
  period: { label: string };
  systemAdmins: AdminUsageHierarchySystemAdmin[];
  managers: AdminUsageHierarchyManager[];
  engineers: AdminUsageHierarchyEngineer[];
  customers: AdminUsageHierarchyCustomer[];
} {
  const profile = (candidate: unknown): ManagedAgentProfile =>
    candidate === "frontmind-base" ? "frontmind-base" : "frontmind-pro";
  const keyHealth = (candidate: unknown): ManagedKeyHealth =>
    [
      "connected",
      "invalid_or_revoked",
      "sync_error",
      "unconfigured",
      "pending",
    ].includes(String(candidate))
      ? (candidate as ManagedKeyHealth)
      : "unconfigured";
  const syncIssueCode = (candidate: unknown): ApiUsageSyncIssueCode | null =>
    [
      "CREDENTIAL_REJECTED",
      "RATE_LIMITED",
      "TIMEOUT",
      "UPSTREAM_UNAVAILABLE",
      "RESPONSE_INVALID",
      "PAGINATION_INVALID",
      "PAGE_DRIFT",
      "PARTIAL_USAGE_SCAN",
    ].includes(String(candidate))
      ? (candidate as ApiUsageSyncIssueCode)
      : null;
  const nullableUsage = (candidate: unknown) =>
    candidate === null || candidate === undefined
      ? null
      : Math.max(0, Number(candidate) || 0);
  const payload =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const managers = Array.isArray(payload.managers)
    ? payload.managers.map((entry: any) => ({
        adminId: Math.max(0, Number(entry?.adminId) || 0),
        displayName:
          String(entry?.displayName || "").trim() || "未命名交付管理员",
        username: entry?.username ? String(entry.username) : null,
        isActive: entry?.isActive !== false,
        apiKeyConfigured: entry?.apiKeyConfigured === true,
        ...normalizeAgentUsageFields(entry),
        apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
        keyPool: {
          fingerprint: entry?.keyPool?.fingerprint
            ? String(entry.keyPool.fingerprint)
            : null,
          credentialCount: Math.max(
            0,
            Number(entry?.keyPool?.credentialCount) ||
              (entry?.keyPool?.fingerprint ? 1 : 0),
          ),
          totalUsed: nullableUsage(entry?.keyPool?.totalUsed),
          limit: Math.max(1, Number(entry?.keyPool?.limit) || 230_000),
          warningRatio: Math.min(
            1,
            Math.max(0, Number(entry?.keyPool?.warningRatio) || 0.8),
          ),
          keyHealth: keyHealth(entry?.keyPool?.keyHealth),
          syncIssueCode: syncIssueCode(entry?.keyPool?.syncIssueCode),
          keyPoolStale: entry?.keyPool?.keyPoolStale === true,
          keyLastSuccessfulAt: entry?.keyPool?.keyLastSuccessfulAt ?? null,
          keyLastAttemptAt: entry?.keyPool?.keyLastAttemptAt ?? null,
          fetchedAt: entry?.keyPool?.fetchedAt ?? null,
          severity: String(entry?.keyPool?.severity || "unavailable"),
        },
        rolling30DayUsed: Math.max(0, Number(entry?.rolling30DayUsed) || 0),
        usageObservedAt: entry?.usageObservedAt ?? null,
        users: Array.isArray(entry?.users)
          ? entry.users.map((customer: any) => ({
              userId: Math.max(0, Number(customer?.userId) || 0),
              enterpriseName:
                String(customer?.enterpriseName || "").trim() || "未命名客户",
              username: customer?.username ? String(customer.username) : null,
              ...normalizeAgentUsageFields(customer),
              rolling30DayUsed: Math.max(
                0,
                Number(customer?.rolling30DayUsed) || 0,
              ),
              usageObservedAt: customer?.usageObservedAt ?? null,
              fingerprint: customer?.fingerprint
                ? String(customer.fingerprint)
                : null,
              usesManagerKey: customer?.usesManagerKey === true,
              credentialSource:
                customer?.credentialSource === "manager" ||
                customer?.credentialSource === "customer"
                  ? customer.credentialSource
                  : customer?.usesManagerKey === true
                    ? "manager"
                    : customer?.fingerprint
                      ? "customer"
                      : "unconfigured",
              keyHealth: keyHealth(customer?.keyHealth),
              syncIssueCode: syncIssueCode(customer?.syncIssueCode),
              fetchedAt: customer?.fetchedAt ?? null,
            }))
          : [],
      }))
    : [];
  const systemAdmins = Array.isArray(payload.systemAdmins)
    ? payload.systemAdmins.map(
        (entry: any): AdminUsageHierarchySystemAdmin => ({
          adminId: Math.max(0, Number(entry?.adminId) || 0),
          displayName:
            String(entry?.displayName || "").trim() || "未命名系统管理员",
          username: entry?.username ? String(entry.username) : null,
          isActive: entry?.isActive !== false,
          apiKeyConfigured: entry?.apiKeyConfigured === true,
          ...normalizeAgentUsageFields(entry),
          apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
          rolling30DayUsed: Math.max(0, Number(entry?.rolling30DayUsed) || 0),
          usageObservedAt: entry?.usageObservedAt ?? null,
          keyPoolTotalUsed: nullableUsage(entry?.keyPoolTotalUsed),
          keyLastSuccessfulAt: entry?.keyLastSuccessfulAt ?? null,
          keyLastAttemptAt: entry?.keyLastAttemptAt ?? null,
          keyHealth: keyHealth(entry?.keyHealth),
          syncIssueCode: syncIssueCode(entry?.syncIssueCode),
          keyPoolStale: entry?.keyPoolStale === true,
          fingerprint: entry?.fingerprint ? String(entry.fingerprint) : null,
          fetchedAt: entry?.fetchedAt ?? null,
        }),
      )
    : [];
  const engineers = Array.isArray(payload.engineers)
    ? payload.engineers.map(
        (entry: any): AdminUsageHierarchyEngineer => ({
          engineerId: Math.max(0, Number(entry?.engineerId) || 0),
          displayName:
            String(entry?.displayName || "").trim() || "未命名工程师",
          username: entry?.username ? String(entry.username) : null,
          isActive: entry?.isActive !== false,
          apiKeyConfigured: entry?.apiKeyConfigured === true,
          ...normalizeAgentUsageFields(entry),
          apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
          rolling30DayUsed: Math.max(0, Number(entry?.rolling30DayUsed) || 0),
          usageObservedAt: entry?.usageObservedAt ?? null,
          keyPoolTotalUsed: nullableUsage(entry?.keyPoolTotalUsed),
          keyLastSuccessfulAt: entry?.keyLastSuccessfulAt ?? null,
          keyLastAttemptAt: entry?.keyLastAttemptAt ?? null,
          keyHealth: keyHealth(entry?.keyHealth),
          syncIssueCode: syncIssueCode(entry?.syncIssueCode),
          keyPoolStale: entry?.keyPoolStale === true,
          fingerprint: entry?.fingerprint ? String(entry.fingerprint) : null,
          fetchedAt: entry?.fetchedAt ?? null,
        }),
      )
    : [];
  const customers = Array.isArray(payload.customers)
    ? payload.customers.map(
        (entry: any): AdminUsageHierarchyCustomer => ({
          userId: Math.max(0, Number(entry?.userId) || 0),
          enterpriseName:
            String(entry?.enterpriseName || "").trim() || "未命名客户",
          username: entry?.username ? String(entry.username) : null,
          isActive: entry?.isActive !== false,
          deliveryAdminId:
            Number.isInteger(Number(entry?.deliveryAdminId)) &&
            Number(entry.deliveryAdminId) > 0
              ? Number(entry.deliveryAdminId)
              : null,
          deliveryAdminName: entry?.deliveryAdminName
            ? String(entry.deliveryAdminName)
            : null,
          apiKeyConfigured: entry?.apiKeyConfigured === true,
          ...normalizeAgentUsageFields(entry),
          apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
          agentProfile: profile(entry?.agentProfile),
          usesInheritedKey: entry?.usesInheritedKey === true,
          rolling30DayUsed: Math.max(0, Number(entry?.rolling30DayUsed) || 0),
          usageObservedAt: entry?.usageObservedAt ?? null,
          keyPoolTotalUsed: nullableUsage(entry?.keyPoolTotalUsed),
          keyLastSuccessfulAt: entry?.keyLastSuccessfulAt ?? null,
          keyLastAttemptAt: entry?.keyLastAttemptAt ?? null,
          keyHealth: keyHealth(entry?.keyHealth),
          syncIssueCode: syncIssueCode(entry?.syncIssueCode),
          keyPoolStale: entry?.keyPoolStale === true,
          fingerprint: entry?.fingerprint ? String(entry.fingerprint) : null,
          fetchedAt: entry?.fetchedAt ?? null,
        }),
      )
    : [];
  return {
    period: {
      label: String(payload?.period?.label || "近 30 天"),
    },
    systemAdmins,
    managers,
    engineers,
    customers,
  };
}

export function usageHierarchyNeedsPolling(value: unknown): boolean {
  const hierarchy = normalizeUsageHierarchy(value);
  return (
    hierarchy.systemAdmins.some((entry) => entry.keyHealth === "pending") ||
    hierarchy.engineers.some((entry) => entry.keyHealth === "pending") ||
    hierarchy.customers.some((entry) => entry.keyHealth === "pending") ||
    hierarchy.managers.some(
      (entry) =>
        entry.keyPool.keyHealth === "pending" ||
        entry.users.some((customer) => customer.keyHealth === "pending"),
    )
  );
}

export function resolveKeyPoolStale(input: {
  keyPoolStale?: boolean;
  keyHealth: ManagedKeyHealth;
}) {
  return input.keyPoolStale ?? input.keyHealth !== "connected";
}

export function apiUsageSyncStatusCopy(input: {
  keyHealth: ManagedKeyHealth;
  issueCode?: ApiUsageSyncIssueCode | null;
}) {
  if (input.keyHealth === "unconfigured") return "尚未配置";
  if (input.keyHealth === "pending") return "等待同步";
  switch (input.issueCode) {
    case "CREDENTIAL_REJECTED":
      return "用量读取权限异常";
    case "RATE_LIMITED":
      return "用量读取频率受限";
    case "TIMEOUT":
      return "用量读取超时";
    case "RESPONSE_INVALID":
      return "积分流水响应异常";
    case "PAGINATION_INVALID":
      return "积分流水分页异常";
    case "PAGE_DRIFT":
      return "积分流水正在变化，等待重试";
    case "PARTIAL_USAGE_SCAN":
      return "积分流水不完整";
    case "UPSTREAM_UNAVAILABLE":
      return "用量服务暂不可用";
    default:
      return input.keyHealth === "invalid_or_revoked"
        ? "Key 已失效或撤销"
        : "积分同步待恢复";
  }
}

export function formatApiUsageLastSuccess(
  value: number | string | Date | null,
) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

type OverviewApiKeyTarget = {
  kind: "customer" | "delivery_admin" | "engineer";
  userId: number;
  displayName: string;
  username: string;
  configured: boolean;
  version: number;
  agentProfile?: ManagedAgentProfile;
};

export type BrandTrackingCredentialRow = {
  userId: number;
  username: string;
  displayName: string;
  keyConfigured: boolean;
  credentialId: string | null;
  fingerprint: string | null;
  rolling30DayCost: string;
  lifetimeCost: string;
  sharedKeyAttributedCost: string;
  sharedAccountCount: number;
  balance: string | null;
  balanceSyncedAt: number | string | Date | null;
  limit: string;
  status: string;
};

function moneyString(value: unknown, fallback = "0.00000000") {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^\d+(?:\.\d{1,8})?$/.test(normalized) ? normalized : fallback;
}

export function normalizeBrandTrackingCredentialRows(
  value: unknown,
): BrandTrackingCredentialRow[] {
  const source = Array.isArray((value as any)?.users)
    ? (value as any).users
    : [];
  return source.flatMap((entry: any) => {
    const userId = Number(entry?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return [];
    return [
      {
        userId,
        username: String(entry?.username || `customer-${userId}`),
        displayName: String(
          entry?.displayName || entry?.username || `客户 ${userId}`,
        ),
        keyConfigured: entry?.keyConfigured === true,
        credentialId:
          typeof entry?.credentialId === "string" && entry.credentialId
            ? entry.credentialId
            : null,
        fingerprint:
          typeof entry?.fingerprint === "string" && entry.fingerprint
            ? entry.fingerprint
            : null,
        rolling30DayCost: moneyString(entry?.rolling30DayCost),
        lifetimeCost: moneyString(entry?.lifetimeCost),
        sharedKeyAttributedCost: moneyString(entry?.sharedKeyAttributedCost),
        sharedAccountCount: Math.max(
          0,
          Number.isSafeInteger(Number(entry?.sharedAccountCount))
            ? Number(entry.sharedAccountCount)
            : 0,
        ),
        balance:
          entry?.balance === null || entry?.balance === undefined
            ? null
            : moneyString(entry.balance),
        balanceSyncedAt: entry?.balanceSyncedAt ?? null,
        limit: moneyString(entry?.limit, "10.00000000"),
        status: String(
          entry?.status || (entry?.keyConfigured ? "active" : "unconfigured"),
        ),
      },
    ];
  });
}

export function formatAdminBrandTrackingCredits(value: string | null) {
  return formatBrandTrackingCredits(value);
}

const BRAND_TRACKING_CREDENTIAL_TYPE = ["jeno", "va_brand_tracking"].join(
  "",
) as "jenova_brand_tracking";

export type CredentialManagementDeepLink = {
  credentialType: "managed_api" | "jenova_brand_tracking";
  kind: OverviewApiKeyTarget["kind"];
  userId: number;
};

export function parseCredentialManagementDeepLink(
  search: string,
): CredentialManagementDeepLink | null {
  const params = new URLSearchParams(search);
  const userId = Number(params.get("credentialUserId"));
  const credentialType = params.get("credentialType") || "managed_api";
  const requestedKind = params.get("credentialKind");
  const kind =
    credentialType === BRAND_TRACKING_CREDENTIAL_TYPE && !requestedKind
      ? "customer"
      : requestedKind;
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !["managed_api", BRAND_TRACKING_CREDENTIAL_TYPE].includes(credentialType) ||
    !["customer", "delivery_admin", "engineer"].includes(kind || "") ||
    (credentialType === BRAND_TRACKING_CREDENTIAL_TYPE && kind !== "customer")
  ) {
    return null;
  }
  return {
    credentialType:
      credentialType as CredentialManagementDeepLink["credentialType"],
    kind: kind as OverviewApiKeyTarget["kind"],
    userId,
  };
}

export type KeyManagementRow = OverviewApiKeyTarget &
  AgentUsageFields & {
    typeLabel: string;
    scopeLabel: string;
    isActive: boolean;
    deliveryAdminId: number | null;
    inherited: boolean;
    rolling30DayUsed: number;
    keyPoolTotalUsed: number | null;
    keyHealth: ManagedKeyHealth;
    syncIssueCode: ApiUsageSyncIssueCode | null;
    keyPoolStale: boolean;
    fetchedAt: number | string | Date | null;
    fingerprint?: string | null;
    sharedKeyAccountCount?: number;
  };

export function annotateSharedKeyAccountCounts<
  T extends { fingerprint?: string | null; provider?: string },
>(rows: T[]): Array<T & { sharedKeyAccountCount: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.fingerprint) continue;
    const key = `${row.provider ?? "unavailable"}:${row.fingerprint}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.map((row) => ({
    ...row,
    sharedKeyAccountCount: row.fingerprint
      ? (counts.get(`${row.provider ?? "unavailable"}:${row.fingerprint}`) ?? 1)
      : 0,
  }));
}

export type BulkApiKeyScope =
  | { kind: "all" }
  | { kind: "delivery_admin"; deliveryAdminId: number }
  | { kind: "engineers"; engineerIds: number[] };

const MAX_BULK_API_KEY_CHANGES = 200;
const MAX_BULK_API_KEY_SCOPE_SNAPSHOT = 5_000;

export function bulkApiKeyTargetsForScope(
  rows: KeyManagementRow[],
  scope: BulkApiKeyScope,
) {
  const activeRows = rows.filter((row) => row.isActive);
  if (scope.kind === "all") return activeRows;
  if (scope.kind === "delivery_admin") {
    return activeRows.filter(
      (row) =>
        (row.kind === "delivery_admin" &&
          row.userId === scope.deliveryAdminId) ||
        (row.kind === "customer" &&
          row.deliveryAdminId === scope.deliveryAdminId),
    );
  }
  const engineerIds = new Set(scope.engineerIds);
  return activeRows.filter(
    (row) => row.kind === "engineer" && engineerIds.has(row.userId),
  );
}

function AdminOverviewApiKeyDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: OverviewApiKeyTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [agentProfile, setAgentProfile] =
    useState<ManagedAgentProfile>("frontmind-pro");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const replaceTargetMutation =
    trpc.admin.apiKeyUsageAlerts.replaceTargetCredential.useMutation();
  const revokeTargetMutation =
    trpc.admin.apiKeyUsageAlerts.revokeTargetCredential.useMutation();
  const busy =
    replaceTargetMutation.isPending || revokeTargetMutation.isPending;
  const subjectLabel =
    target?.kind === "delivery_admin"
      ? "交付管理员"
      : target?.kind === "customer"
        ? "客户"
        : "工程师";

  useEffect(() => {
    if (target?.kind === "customer") {
      setAgentProfile(target.agentProfile ?? "frontmind-pro");
    }
  }, [target]);

  const close = () => {
    if (busy) return;
    setApiKey("");
    setAgentProfile("frontmind-pro");
    setRevokeOpen(false);
    setReplaceConfirmOpen(false);
    replaceTargetMutation.reset();
    revokeTargetMutation.reset();
    onOpenChange(false);
  };

  const requestSaveConfirmation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || apiKey.trim().length < 8) return;
    setReplaceConfirmOpen(true);
  };

  const save = async () => {
    if (!target || apiKey.trim().length < 8) return;
    try {
      const commonInput = {
        kind: target.kind,
        userId: target.userId,
        apiKey: apiKey.trim(),
        expectedVersion: target.version,
        reason: "API与人员管理统一入口替换账号 API Key",
        confirmation: "REPLACE_API_KEY" as const,
      };
      await replaceTargetMutation.mutateAsync(
        target.kind === "customer"
          ? { ...commonInput, kind: "customer", agentProfile }
          : target.kind === "delivery_admin"
            ? { ...commonInput, kind: "delivery_admin" }
            : { ...commonInput, kind: "engineer" },
      );
      await onSaved();
      toast.success(
        `${subjectLabel} API Key 已${target.configured ? "替换" : "配置"}`,
        { description: target.displayName },
      );
      setApiKey("");
      setRevokeOpen(false);
      setReplaceConfirmOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(`无法配置${subjectLabel} API Key`, {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const revoke = async () => {
    if (!target) return;
    try {
      await revokeTargetMutation.mutateAsync({
        kind: target.kind,
        userId: target.userId,
        expectedVersion: target.version,
        reason: "API与人员管理统一入口撤销账号 API Key",
        confirmation: "REVOKE_API_KEY",
      });
      await onSaved();
      toast.success(`${subjectLabel} API Key 已撤销`, {
        description: target.displayName,
      });
      setApiKey("");
      setRevokeOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(`无法撤销${subjectLabel} API Key`, {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <Dialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              配置{subjectLabel} API Key
            </DialogTitle>
            <DialogDescription>
              {target?.displayName} · @{target?.username}。Key
              仅在服务端加密保存，不会在页面返回明文。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={requestSaveConfirmation}>
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              当前状态：
              <span
                className={
                  target?.configured
                    ? "font-medium text-emerald-700"
                    : "font-medium text-amber-700"
                }
              >
                {target?.configured ? "已配置" : "未配置"}
              </span>
            </div>
            {target?.kind === "customer" && (
              <div className="space-y-2">
                <Label htmlFor="overview-agent-profile">客户服务模型</Label>
                <select
                  id="overview-agent-profile"
                  value={agentProfile}
                  disabled={busy}
                  onChange={(event) =>
                    setAgentProfile(event.target.value as ManagedAgentProfile)
                  }
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="frontmind-pro">Pro</option>
                  <option value="frontmind-base">Base</option>
                </select>
                <p className="text-xs leading-5 text-muted-foreground">
                  客户服务流程会将 Base/Pro 选择冻结在新的 Key 版本上。
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="overview-api-key">
                {target?.configured ? "新的智谱 API Key" : "智谱 API Key"}
              </Label>
              <Input
                placeholder="智谱 Managed Agents API Key"
                id="overview-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={busy}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                系统管理员统一维护账号 Key，交付管理员只负责岗位与项目安排。
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy || !target?.configured}
                onClick={() => setRevokeOpen(true)}
              >
                撤销 Key
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={busy || apiKey.trim().length < 8}
                >
                  {replaceTargetMutation.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  验证并{target?.configured ? "替换" : "配置"}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={replaceConfirmOpen}
        onOpenChange={(open) => !busy && setReplaceConfirmOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认{target?.configured ? "替换" : "配置"}
              {subjectLabel} API Key
            </AlertDialogTitle>
            <AlertDialogDescription>
              {
                "系统将先验证新 Key，再以版本校验原子切换。旧 Key 会保留为退役版本供已提交任务安全恢复；若状态已被其他管理员更新，迟到请求不会覆盖较新的 Key。"
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
            {target?.kind === "customer"
              ? `客户服务模型：${agentProfile === "frontmind-pro" ? "Pro" : "Base"}。`
              : "内部账号的通用智能体模型会在新任务中单独选择，不绑定到 Key。"}
            近 30 天自用按本地任务账本滚动累计，Key 轮换不会清空历史数字。
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {replaceTargetMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认验证并{target?.configured ? "替换" : "配置"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={revokeOpen}
        onOpenChange={(open) => !busy && setRevokeOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销{subjectLabel} API Key</AlertDialogTitle>
            <AlertDialogDescription>
              撤销后，{target?.displayName}
              将无法调用通用智能体，直至系统管理员重新配置有效 Key。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void revoke();
              }}
            >
              {revokeTargetMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AdminBulkApiKeyDialog({
  open,
  rows,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  rows: KeyManagementRow[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [scopeKind, setScopeKind] = useState<
    "all" | "delivery_admin" | "engineers"
  >("all");
  const [deliveryAdminId, setDeliveryAdminId] = useState("");
  const [engineerIds, setEngineerIds] = useState<number[]>([]);
  const [engineerSearch, setEngineerSearch] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agentProfile, setAgentProfile] =
    useState<ManagedAgentProfile>("frontmind-pro");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const bulkMutation =
    trpc.admin.apiKeyUsageAlerts.bulkReplaceTargetCredentials.useMutation();
  const busy = bulkMutation.isPending;
  const managers = rows.filter(
    (row) => row.isActive && row.kind === "delivery_admin",
  );
  const engineers = rows.filter(
    (row) => row.isActive && row.kind === "engineer",
  );
  const normalizedEngineerSearch = engineerSearch.trim().toLocaleLowerCase();
  const visibleEngineers = engineers.filter((engineer) =>
    `${engineer.displayName} ${engineer.username}`
      .toLocaleLowerCase()
      .includes(normalizedEngineerSearch),
  );
  const scope: BulkApiKeyScope | null =
    scopeKind === "all"
      ? { kind: "all" }
      : scopeKind === "delivery_admin"
        ? Number(deliveryAdminId) > 0
          ? {
              kind: "delivery_admin",
              deliveryAdminId: Number(deliveryAdminId),
            }
          : null
        : engineerIds.length > 0
          ? { kind: "engineers", engineerIds }
          : null;
  const targets = scope ? bulkApiKeyTargetsForScope(rows, scope) : [];
  const targetsContainCustomers = targets.some(
    (target) => target.kind === "customer",
  );
  const configuredCount = targets.filter((target) => target.configured).length;
  const unconfiguredCount = targets.length - configuredCount;
  const actionTargets = replaceExisting
    ? targets
    : targets.filter((target) => !target.configured);
  const actionCount = actionTargets.length;
  const knownActionLimitExceeded =
    !replaceExisting && actionCount > MAX_BULK_API_KEY_CHANGES;
  const scopeSnapshotLimitExceeded =
    targets.length > MAX_BULK_API_KEY_SCOPE_SNAPSHOT;
  const selectedManager =
    scopeKind === "delivery_admin"
      ? managers.find((manager) => manager.userId === Number(deliveryAdminId))
      : null;

  const reset = () => {
    setScopeKind("all");
    setDeliveryAdminId("");
    setEngineerIds([]);
    setEngineerSearch("");
    setApiKey("");
    setAgentProfile("frontmind-pro");
    setReplaceExisting(false);
    setConfirmOpen(false);
    bulkMutation.reset();
  };
  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };
  const selectScopeKind = (next: "all" | "delivery_admin" | "engineers") => {
    setScopeKind(next);
    setReplaceExisting(false);
    if (next === "delivery_admin" && !deliveryAdminId && managers[0]) {
      setDeliveryAdminId(String(managers[0].userId));
    }
  };
  const requestConfirmation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !scope ||
      knownActionLimitExceeded ||
      scopeSnapshotLimitExceeded ||
      apiKey.trim().length < 8 ||
      actionCount === 0
    )
      return;
    setConfirmOpen(true);
  };
  const save = async () => {
    if (
      !scope ||
      knownActionLimitExceeded ||
      scopeSnapshotLimitExceeded ||
      apiKey.trim().length < 8 ||
      actionCount === 0
    )
      return;
    try {
      const result = await bulkMutation.mutateAsync({
        scope,
        targets: targets.map((target) => ({
          userId: target.userId,
          expectedVersion: target.version,
        })),
        applyMode: replaceExisting ? "replace_all" : "unconfigured_only",
        apiKey: apiKey.trim(),
        ...(targetsContainCustomers ? { agentProfile } : {}),
        reason: "API与人员管理批量配置账号 API Key",
        confirmation: "BULK_REPLACE_API_KEYS",
      });
      await onSaved();
      toast.success(`已为 ${result.updatedCount} 个账号配置 API Key`, {
        description:
          result.unchangedCount > 0
            ? `${result.unchangedCount} 个账号无需变更；近 30 天自用将继续按任务账本滚动累计`
            : "近 30 天自用将继续按任务账本滚动累计",
      });
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error("无法完成批量 API Key 配置", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UsersRound className="h-5 w-5 text-primary" />
              批量配置 API Key
            </DialogTitle>
            <DialogDescription>
              输入一次
              Key，按明确范围分发给启用账号。每个账号仍独立加密保存并保留自己的版本历史。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={requestConfirmation}>
            <div className="space-y-2">
              <Label>配置范围</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ["all", "所有启用账号"],
                  ["delivery_admin", "交付管理员范围"],
                  ["engineers", "选择工程师"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={scopeKind === value}
                    disabled={busy}
                    onClick={() =>
                      selectScopeKind(
                        value as "all" | "delivery_admin" | "engineers",
                      )
                    }
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      scopeKind === value
                        ? "border-[#6f3a98] bg-[#f3edf7] text-[#5b2a86]"
                        : "border-border bg-white text-[#5f576c] hover:border-[#a98cbd]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {scopeKind === "all" && (
                <p className="text-xs leading-5 text-muted-foreground">
                  包含启用的客户、交付管理员和工程师；系统管理员与停用账号不会被配置。
                </p>
              )}
            </div>

            {scopeKind === "delivery_admin" && (
              <div className="space-y-2">
                <Label htmlFor="bulk-delivery-admin">选择交付管理员</Label>
                <select
                  id="bulk-delivery-admin"
                  value={deliveryAdminId}
                  disabled={busy || managers.length === 0}
                  onChange={(event) => {
                    setDeliveryAdminId(event.target.value);
                    setReplaceExisting(false);
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">请选择交付管理员</option>
                  {managers.map((manager) => {
                    const customerCount = rows.filter(
                      (row) =>
                        row.isActive &&
                        row.kind === "customer" &&
                        row.deliveryAdminId === manager.userId,
                    ).length;
                    return (
                      <option key={manager.userId} value={manager.userId}>
                        {manager.displayName}（本人 + {customerCount} 个客户）
                      </option>
                    );
                  })}
                </select>
                <p className="text-xs leading-5 text-muted-foreground">
                  {selectedManager
                    ? `将包含 ${selectedManager.displayName} 本人及其名下启用客户，不包含工程师。`
                    : "交付管理员范围包含管理员本人和名下启用客户，不包含工程师。"}
                </p>
              </div>
            )}

            {scopeKind === "engineers" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="bulk-engineer-search">选择工程师</Label>
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      className="text-[#6a338f] hover:underline"
                      disabled={busy || engineers.length === 0}
                      onClick={() => {
                        setEngineerIds(engineers.map((row) => row.userId));
                        setReplaceExisting(false);
                      }}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="text-[#716a80] hover:underline"
                      disabled={busy || engineerIds.length === 0}
                      onClick={() => {
                        setEngineerIds([]);
                        setReplaceExisting(false);
                      }}
                    >
                      清空
                    </button>
                  </div>
                </div>
                <Input
                  id="bulk-engineer-search"
                  value={engineerSearch}
                  disabled={busy}
                  onChange={(event) => setEngineerSearch(event.target.value)}
                  placeholder="搜索工程师"
                />
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border p-2">
                  {visibleEngineers.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">
                      没有符合条件的启用工程师。
                    </p>
                  ) : (
                    visibleEngineers.map((engineer) => (
                      <label
                        key={engineer.userId}
                        className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={engineerIds.includes(engineer.userId)}
                          disabled={busy}
                          onChange={(event) => {
                            setEngineerIds((current) =>
                              event.target.checked
                                ? [...new Set([...current, engineer.userId])]
                                : current.filter(
                                    (userId) => userId !== engineer.userId,
                                  ),
                            );
                            setReplaceExisting(false);
                          }}
                        />
                        <span className="font-medium text-[#332842]">
                          {engineer.displayName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          @{engineer.username}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="rounded-lg border border-[#e5ddea] bg-[#fbf9fd] p-3 text-sm text-[#5f576c]">
              <p className="font-medium text-[#332842]">
                当前范围：{targets.length} 个启用账号
              </p>
              <p className="mt-1 text-xs leading-5">
                首次配置 {unconfiguredCount} 个；已有 Key {configuredCount} 个。
                {replaceExisting
                  ? ` 服务器会排除已经是本次 Key 的账号，当前范围最多涉及 ${actionCount} 个账号。`
                  : ` 默认只配置 ${actionCount} 个尚未配置的账号。`}
              </p>
              {knownActionLimitExceeded && (
                <p className="mt-1 text-xs font-medium text-[#a02652]">
                  单次最多变更 {MAX_BULK_API_KEY_CHANGES}
                  个账号，请缩小范围或先使用“只配置未配置账号”。
                </p>
              )}
              {replaceExisting &&
                targets.length > MAX_BULK_API_KEY_CHANGES &&
                !scopeSnapshotLimitExceeded && (
                  <p className="mt-1 text-xs font-medium text-amber-700">
                    提交后会按本次 Key 排除无需变化的账号；若实际仍需变更超过
                    {MAX_BULK_API_KEY_CHANGES} 个，整批将停止且不会写入。
                  </p>
                )}
              {scopeSnapshotLimitExceeded && (
                <p className="mt-1 text-xs font-medium text-[#a02652]">
                  单次范围最多包含 {MAX_BULK_API_KEY_SCOPE_SNAPSHOT}
                  个账号，请缩小范围后重试。
                </p>
              )}
            </div>

            <label className="flex items-start gap-3 rounded-lg border border-border/70 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={replaceExisting}
                disabled={busy || configuredCount === 0}
                onChange={(event) => setReplaceExisting(event.target.checked)}
              />
              <span>
                <span className="font-medium text-[#332842]">
                  同时替换范围内已有 Key
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  默认关闭以避免误退役现有
                  Key。开启后，范围内账号将统一切换到本次输入的 Key。
                </span>
              </span>
            </label>

            {targetsContainCustomers && (
              <div className="space-y-2">
                <Label htmlFor="bulk-agent-profile">客户服务模型</Label>
                <select
                  id="bulk-agent-profile"
                  value={agentProfile}
                  disabled={busy}
                  onChange={(event) =>
                    setAgentProfile(event.target.value as ManagedAgentProfile)
                  }
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="frontmind-pro">Pro</option>
                  <option value="frontmind-base">Base</option>
                </select>
                <p className="text-xs leading-5 text-muted-foreground">
                  Base/Pro 只应用于当前范围内的客户；内部账号 Key 不绑定模型。
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="bulk-api-key">智谱 Managed Agents API Key</Label>
              <Input
                id="bulk-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入一次，验证后按范围加密保存"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Key 明文不会写入日志、审计记录或返回浏览器。
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={busy}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !scope ||
                  knownActionLimitExceeded ||
                  scopeSnapshotLimitExceeded ||
                  actionCount === 0 ||
                  apiKey.trim().length < 8
                }
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                继续确认
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(nextOpen) => !busy && setConfirmOpen(nextOpen)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {replaceExisting
                ? `确认在 ${targets.length} 个账号范围内统一配置 Key`
                : `确认为 ${actionCount} 个账号批量配置 Key`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              这些账号将共享同一个上游 API
              Key，但密文、版本和任务归属仍按账号独立保存。整批操作将在一个事务内完成，任一账号发生版本冲突都会全部回滚。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
            这是一次性批量分发；以后单独修改某个账号不会自动联动其他账号。共享
            Key 会扩大泄露影响范围。旧 Key 即使已失效也不会阻断轮换；近 30
            天自用继续按本地任务账本滚动累计，不会因轮换清零。
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>返回检查</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认并批量配置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AdminBrandTrackingKeyManager({
  previewMode,
  deepLink,
  restrictedUserId,
}: {
  previewMode: boolean;
  deepLink?: Pick<CredentialManagementDeepLink, "userId">;
  restrictedUserId?: number;
}) {
  const listQuery = (trpc.admin as any).brandTrackingCredentials.list.useQuery(
    undefined,
    {
      enabled: !previewMode,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const configureMutation = (
    trpc.admin as any
  ).brandTrackingCredentials.configure.useMutation();
  const bulkAssignMutation = (
    trpc.admin as any
  ).brandTrackingCredentials.bulkAssign.useMutation();
  const revokeMutation = (
    trpc.admin as any
  ).brandTrackingCredentials.revoke.useMutation();
  const refreshBalanceMutation = (
    trpc.admin as any
  ).brandTrackingCredentials.refreshBalance.useMutation();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<BrandTrackingCredentialRow | null>(null);
  const [deepLinkOpened, setDeepLinkOpened] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkApiKey, setBulkApiKey] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const allRows = normalizeBrandTrackingCredentialRows(listQuery.data);
  const rows = restrictedUserId
    ? allRows.filter((row) => row.userId === restrictedUserId)
    : allRows;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleRows = rows.filter((row) =>
    `${row.displayName} ${row.username}`
      .toLocaleLowerCase()
      .includes(normalizedSearch),
  );
  const busy =
    configureMutation.isPending ||
    bulkAssignMutation.isPending ||
    revokeMutation.isPending;

  const closeTarget = () => {
    if (busy) return;
    setTarget(null);
    setApiKey("");
  };
  const closeBulk = () => {
    if (busy) return;
    setBulkOpen(false);
    setBulkApiKey("");
    setSelectedUserIds([]);
  };
  const refresh = async () => {
    await listQuery.refetch();
  };

  useEffect(() => {
    if (previewMode || !deepLink || deepLinkOpened) return;
    const linkedTarget = rows.find((row) => row.userId === deepLink.userId);
    if (!linkedTarget) return;
    setSearch("");
    setTarget(linkedTarget);
    setDeepLinkOpened(true);
  }, [deepLink, deepLinkOpened, previewMode, rows]);

  return (
    <div data-testid="brand-tracking-key-manager">
      <div className="flex flex-col gap-3 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        {!restrictedUserId && (
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索海外客户账号或企业名称"
            aria-label="搜索品牌追踪 Key 管理账号"
            className="h-9 bg-white lg:w-80"
          />
        )}
        <div className="flex flex-wrap gap-2">
          {!restrictedUserId && (
            <Button
              type="button"
              size="sm"
              disabled={previewMode || rows.length === 0}
              onClick={() => {
                setSelectedUserIds([]);
                setBulkOpen(true);
              }}
            >
              <UsersRound className="h-4 w-4" />
              批量分配品牌追踪 Key
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              previewMode ||
              refreshBalanceMutation.isPending ||
              !rows.some((row) => row.credentialId)
            }
            onClick={async () => {
              const credentialIds = Array.from(
                new Set(
                  rows.flatMap((row) =>
                    row.credentialId ? [row.credentialId] : [],
                  ),
                ),
              );
              try {
                await Promise.all(
                  credentialIds.map((credentialId) =>
                    refreshBalanceMutation.mutateAsync({ credentialId }),
                  ),
                );
                await refresh();
                toast.success(
                  `已刷新 ${credentialIds.length} 把唯一 Key 的积分余额`,
                );
              } catch (error) {
                toast.error("品牌追踪积分余额刷新失败", {
                  description:
                    error instanceof Error ? error.message : "请稍后重试",
                });
              }
            }}
          >
            <RefreshCw
              className={`h-4 w-4 ${
                refreshBalanceMutation.isPending ? "animate-spin" : ""
              }`}
            />
            {refreshBalanceMutation.isPending
              ? "刷新中"
              : "刷新唯一 Key 积分余额"}
          </Button>
        </div>
      </div>

      {previewMode ? (
        <div className="p-6 text-sm text-[#716a80]">
          品牌追踪 Key 仅在真实系统管理员环境中配置。
        </div>
      ) : listQuery.isLoading ? (
        <div className="p-6 text-sm text-[#716a80]">
          正在读取海外客户的品牌追踪 Key 与积分…
        </div>
      ) : listQuery.error ? (
        <div className="p-6 text-sm text-[#a02652]">
          品牌追踪 Key 管理数据暂时无法读取。
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="p-6 text-sm text-[#716a80]">
          没有符合条件的海外客户账号。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[1240px]">
            <div className="grid grid-cols-[minmax(190px,1.2fr)_170px_130px_130px_150px_130px_160px] gap-4 border-b border-[#eee8f2] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6">
              <span>海外客户</span>
              <span>Key 状态</span>
              <span>近 30 天用量</span>
              <span>累计积分</span>
              <span>共享 Key 归因积分</span>
              <span>品牌追踪积分余额</span>
              <span>操作</span>
            </div>
            {visibleRows.map((row) => (
              <div
                key={row.userId}
                className="grid grid-cols-[minmax(190px,1.2fr)_170px_130px_130px_150px_130px_160px] items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#332842]">
                    {row.displayName}
                  </p>
                  <p className="mt-1 truncate text-xs text-[#857e91]">
                    @{row.username} · 上限{" "}
                    {formatAdminBrandTrackingCredits(row.limit)}
                  </p>
                </div>
                <div className="text-xs">
                  <p
                    className={
                      row.keyConfigured
                        ? "font-medium text-[#16794f]"
                        : "font-medium text-[#a02652]"
                    }
                  >
                    {row.keyConfigured
                      ? "品牌追踪 Key 已配置"
                      : "品牌追踪 Key 待配置"}
                  </p>
                  {row.keyConfigured && (
                    <p className="mt-1 text-[#857e91]">
                      {row.sharedAccountCount > 1
                        ? `同一 Key 供 ${row.sharedAccountCount} 个账号使用`
                        : "当前账号独享"}
                    </p>
                  )}
                </div>
                <p className="text-sm font-semibold tabular-nums text-[#5b2a86]">
                  {formatAdminBrandTrackingCredits(row.rolling30DayCost)}
                </p>
                <p className="text-sm font-semibold tabular-nums text-[#332842]">
                  {formatAdminBrandTrackingCredits(row.lifetimeCost)}
                </p>
                <div>
                  <p className="text-sm font-semibold tabular-nums text-[#332842]">
                    {formatAdminBrandTrackingCredits(
                      row.sharedKeyAttributedCost,
                    )}
                  </p>
                  <p className="mt-1 text-xs text-[#857e91]">
                    Dashboard 可归因积分
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold tabular-nums text-[#332842]">
                    {formatAdminBrandTrackingCredits(row.balance)}
                  </p>
                  <p className="mt-1 text-xs text-[#857e91]">
                    {row.balanceSyncedAt ? "上游已同步" : "尚未刷新"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={row.keyConfigured ? "outline" : "default"}
                    onClick={() => setTarget(row)}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    {row.keyConfigured ? "更换" : "配置"}
                  </Button>
                  {row.credentialId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`刷新 ${row.displayName} 的品牌追踪 Key 积分余额`}
                      disabled={refreshBalanceMutation.isPending}
                      onClick={async () => {
                        try {
                          await refreshBalanceMutation.mutateAsync({
                            credentialId: row.credentialId,
                          });
                          await refresh();
                        } catch (error) {
                          toast.error("品牌追踪积分余额刷新失败", {
                            description:
                              error instanceof Error
                                ? error.message
                                : "请稍后重试",
                          });
                        }
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => !open && closeTarget()}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {target?.keyConfigured ? "更换" : "配置"}品牌追踪 Key
            </DialogTitle>
            <DialogDescription>
              {target?.displayName} · @{target?.username}。系统会验证
              brand-tracker Agent 和当前积分余额，明文 Key 不会返回浏览器。
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!target || apiKey.trim().length < 8) return;
              try {
                await configureMutation.mutateAsync({
                  userId: target.userId,
                  apiKey: apiKey.trim(),
                });
                await refresh();
                toast.success("品牌追踪 Key 已配置");
                closeTarget();
              } catch (error) {
                toast.error("品牌追踪 Key 配置失败", {
                  description:
                    error instanceof Error ? error.message : "请稍后重试",
                });
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="frontmind-brand-tracking-key">
                品牌追踪 API Key
              </Label>
              <Input
                id="frontmind-brand-tracking-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入后验证并加密保存"
                disabled={busy}
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy || !target?.keyConfigured}
                onClick={async () => {
                  if (!target) return;
                  try {
                    await revokeMutation.mutateAsync({ userId: target.userId });
                    await refresh();
                    toast.success("品牌追踪 Key 分配已撤销");
                    closeTarget();
                  } catch (error) {
                    toast.error("品牌追踪 Key 撤销失败", {
                      description:
                        error instanceof Error ? error.message : "请稍后重试",
                    });
                  }
                }}
              >
                撤销分配
              </Button>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={closeTarget}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={busy || apiKey.trim().length < 8}
                >
                  {configureMutation.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  验证并保存
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={(open) => !open && closeBulk()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>批量分配品牌追踪 Key</DialogTitle>
            <DialogDescription>
              同一把物理 Key
              只保存一份，可明确分配给多个海外客户；个人积分仍按每轮实际使用分别归因。
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!selectedUserIds.length || bulkApiKey.trim().length < 8)
                return;
              try {
                await bulkAssignMutation.mutateAsync({
                  userIds: selectedUserIds,
                  apiKey: bulkApiKey.trim(),
                });
                await refresh();
                toast.success(
                  `已为 ${selectedUserIds.length} 个海外账号分配品牌追踪 Key`,
                );
                closeBulk();
              } catch (error) {
                toast.error("品牌追踪 Key 批量分配失败", {
                  description:
                    error instanceof Error ? error.message : "请稍后重试",
                });
              }
            }}
          >
            <div className="flex items-center justify-between">
              <Label>选择海外客户</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSelectedUserIds(
                    selectedUserIds.length === rows.length
                      ? []
                      : rows.map((row) => row.userId),
                  )
                }
              >
                {selectedUserIds.length === rows.length
                  ? "取消全选"
                  : "选择全部"}
              </Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border p-2">
              {rows.map((row) => (
                <label
                  key={row.userId}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedUserIds.includes(row.userId)}
                    onChange={(event) =>
                      setSelectedUserIds((current) =>
                        event.target.checked
                          ? [...current, row.userId]
                          : current.filter((userId) => userId !== row.userId),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">
                      {row.displayName}
                    </strong>
                    <small className="text-muted-foreground">
                      @{row.username}
                    </small>
                  </span>
                  <small
                    className={
                      row.keyConfigured
                        ? "text-amber-700"
                        : "text-muted-foreground"
                    }
                  >
                    {row.keyConfigured ? "将替换现有分配" : "待配置"}
                  </small>
                </label>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-frontmind-brand-tracking-key">
                品牌追踪 API Key
              </Label>
              <Input
                id="bulk-frontmind-brand-tracking-key"
                type="password"
                autoComplete="off"
                value={bulkApiKey}
                onChange={(event) => setBulkApiKey(event.target.value)}
                placeholder="同一 Key 分配给所有已选账号"
                disabled={busy}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={closeBulk}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !selectedUserIds.length ||
                  bulkApiKey.trim().length < 8
                }
              >
                {bulkAssignMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                验证并分配给 {selectedUserIds.length} 个账号
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminDashboard({
  preview = false,
  previewAccessLevel = "system_admin",
  previewFixtures,
}: {
  preview?: boolean;
  previewAccessLevel?: "delivery_admin" | "system_admin";
  previewFixtures?: {
    managedAdminId: string;
    managedUserIds: number[];
    usageAlerts: unknown[];
  };
}) {
  const previewMode = import.meta.env.DEV && preview;
  const { user } = useAuth();
  const systemAdmin = previewMode
    ? previewAccessLevel === "system_admin"
    : isSystemAdminAccount(user);
  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    enabled: !previewMode && user?.role === "admin",
    retry: false,
  });
  const usageHierarchyQuery = (
    trpc.admin as any
  ).apiKeyUsageAlerts.hierarchy.useQuery(undefined, {
    enabled: !previewMode && user?.role === "admin" && systemAdmin,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query: any) =>
      usageHierarchyNeedsPolling(query.state.data) ? 2_000 : false,
  });
  const usageSyncMutation = (
    trpc.admin as any
  ).apiKeyUsageAlerts.sync.useMutation({
    onSuccess: () => usageHierarchyQuery.refetch(),
  });
  const deliveryRoleOverviewQuery = trpc.delivery.management.overview.useQuery(
    undefined,
    {
      enabled: !previewMode && user?.role === "admin",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const [apiKeyTarget, setApiKeyTarget] = useState<OverviewApiKeyTarget | null>(
    null,
  );
  const [bulkApiKeyOpen, setBulkApiKeyOpen] = useState(false);
  const [apiKeyManagementTab, setApiKeyManagementTab] = useState<
    "general" | "brand_tracking"
  >("general");
  const [keyAccountType, setKeyAccountType] = useState<
    "all" | OverviewApiKeyTarget["kind"]
  >("all");
  const [keyAccountSearch, setKeyAccountSearch] = useState("");
  const [credentialDeepLink] = useState<CredentialManagementDeepLink | null>(
    () =>
      previewMode || typeof window === "undefined"
        ? null
        : parseCredentialManagementDeepLink(window.location.search),
  );
  const [credentialDeepLinkOpened, setCredentialDeepLinkOpened] =
    useState(false);
  const navItems = previewMode
    ? getPreviewAdminNav(systemAdmin)
    : getAdminNav(systemAdmin);
  const previewUsageHierarchy = useMemo(() => {
    const items = filterPreviewApiKeyUsageForAdmin(
      normalizeApiKeyUsageAlerts(previewFixtures?.usageAlerts ?? []),
      false,
      previewFixtures?.managedUserIds,
    );
    const pool = groupSharedKeyUsage(items)[0];
    const ownAgentMonthUsed = 12_600;
    const users = items.map((item) => ({
      userId: item.userId || 0,
      enterpriseName: item.enterpriseName || `客户 ${item.userId || ""}`,
      username: null,
      rolling30DayUsed: item.accountUsed,
      usageObservedAt: item.fetchedAt ?? null,
      fingerprint: item.credentialFingerprint || null,
      usesManagerKey:
        Boolean(pool?.fingerprint) &&
        item.credentialFingerprint === pool?.fingerprint,
      credentialSource:
        Boolean(pool?.fingerprint) &&
        item.credentialFingerprint === pool?.fingerprint
          ? ("manager" as const)
          : item.credentialFingerprint
            ? ("customer" as const)
            : ("unconfigured" as const),
      keyHealth: item.syncStatus === "ok" ? "connected" : "pending",
      syncIssueCode: null,
      fetchedAt: item.fetchedAt ?? null,
    }));
    return {
      period: { label: "近 30 天" },
      systemAdmins: [],
      engineers: [],
      customers: [],
      managers: [
        {
          adminId: Number(previewFixtures?.managedAdminId || 101),
          displayName: "交付管理员",
          username: "delivery.admin",
          isActive: true,
          apiKeyConfigured: true,
          apiKeyVersion: 1,
          keyPool: {
            fingerprint: pool?.fingerprint || "9f17b2d4a631c809",
            credentialCount: pool?.fingerprint ? 1 : 0,
            totalUsed: pool?.used || 84_200,
            limit: pool?.limit || 230_000,
            warningRatio: pool?.warningRatio || 0.8,
            keyHealth: "connected" as const,
            syncIssueCode: null,
            keyPoolStale: false,
            keyLastSuccessfulAt: pool?.fetchedAt || "2026-07-28T08:00:00+08:00",
            keyLastAttemptAt: pool?.fetchedAt || "2026-07-28T08:00:00+08:00",
            fetchedAt: pool?.fetchedAt || "2026-07-28T08:00:00+08:00",
            severity: "normal",
          },
          rolling30DayUsed: ownAgentMonthUsed,
          usageObservedAt: pool?.fetchedAt || null,
          users,
        },
      ],
    };
  }, [previewFixtures, previewMode]);
  const usageHierarchy = previewMode
    ? previewUsageHierarchy
    : normalizeUsageHierarchy(usageHierarchyQuery.data);
  const usageManagers = usageHierarchy.managers;
  const engineerUsageById = new Map(
    usageHierarchy.engineers.map((engineer) => [engineer.engineerId, engineer]),
  );
  const deliveryEngineerStatusRows = buildDeliveryEngineerStatusRows(
    deliveryRoleOverviewQuery.data,
  ).map((engineer) => {
    const usage = engineerUsageById.get(engineer.id);
    return {
      ...engineer,
      apiKeyConfigured: usage?.apiKeyConfigured ?? engineer.apiKeyConfigured,
      apiKeyVersion: usage?.apiKeyVersion ?? engineer.apiKeyVersion,
      ...normalizeAgentUsageFields(usage),
      rolling30DayUsed: usage?.rolling30DayUsed ?? 0,
      keyPoolTotalUsed: usage?.keyPoolTotalUsed ?? null,
      keyHealth: usage?.keyHealth ?? "unconfigured",
      usageSyncIssueCode: usage?.syncIssueCode ?? null,
      keyPoolStale: resolveKeyPoolStale({
        keyPoolStale: usage?.keyPoolStale,
        keyHealth: usage?.keyHealth ?? "unconfigured",
      }),
      usageFetchedAt: usage?.fetchedAt ?? null,
      usageFingerprint: usage?.fingerprint ?? null,
    };
  });
  const keyManagementRows: KeyManagementRow[] = annotateSharedKeyAccountCounts([
    ...usageManagers.map(
      (manager): KeyManagementRow => ({
        kind: "delivery_admin",
        userId: manager.adminId,
        displayName: manager.displayName,
        username: manager.username || `admin-${manager.adminId}`,
        isActive: manager.isActive,
        deliveryAdminId: manager.adminId,
        configured: manager.apiKeyConfigured,
        version: manager.apiKeyVersion,
        typeLabel: "交付管理员",
        scopeLabel: `负责 ${manager.users.length} 个客户`,
        inherited: false,
        ...normalizeAgentUsageFields(manager),
        rolling30DayUsed: manager.rolling30DayUsed,
        keyPoolTotalUsed: manager.keyPool.totalUsed,
        keyHealth: manager.keyPool.keyHealth,
        syncIssueCode: manager.keyPool.syncIssueCode,
        keyPoolStale: manager.keyPool.keyPoolStale,
        fetchedAt: manager.keyPool.fetchedAt,
        fingerprint: manager.keyPool.fingerprint,
      }),
    ),
    ...deliveryEngineerStatusRows.map(
      (engineer): KeyManagementRow => ({
        kind: "engineer",
        userId: engineer.id,
        displayName: engineer.displayName,
        username: engineer.username,
        isActive: engineer.isActive,
        deliveryAdminId: null,
        configured: engineer.apiKeyConfigured,
        version: engineer.apiKeyVersion,
        typeLabel: "工程师",
        scopeLabel: engineer.roleType
          ? `${DELIVERY_ROLE_LABELS[engineer.roleType]} · ${engineer.projectCount} 个项目`
          : `岗位未设置 · ${engineer.projectCount} 个项目`,
        inherited: false,
        ...normalizeAgentUsageFields(engineer),
        rolling30DayUsed: engineer.rolling30DayUsed,
        keyPoolTotalUsed: engineer.keyPoolTotalUsed,
        keyHealth: engineer.keyHealth,
        syncIssueCode: engineer.usageSyncIssueCode,
        keyPoolStale: engineer.keyPoolStale,
        fetchedAt: engineer.usageFetchedAt,
        fingerprint: engineer.usageFingerprint,
      }),
    ),
    ...usageHierarchy.customers.map(
      (customer): KeyManagementRow => ({
        kind: "customer",
        userId: customer.userId,
        displayName: customer.enterpriseName,
        username: customer.username || `customer-${customer.userId}`,
        isActive: customer.isActive,
        deliveryAdminId: customer.deliveryAdminId,
        configured: customer.apiKeyConfigured,
        version: customer.apiKeyVersion,
        agentProfile: customer.agentProfile,
        typeLabel: "客户",
        scopeLabel: customer.deliveryAdminName
          ? `负责人：${customer.deliveryAdminName}`
          : "负责人待分配",
        inherited: customer.usesInheritedKey,
        ...normalizeAgentUsageFields(customer),
        rolling30DayUsed: customer.rolling30DayUsed,
        keyPoolTotalUsed: customer.keyPoolTotalUsed,
        keyHealth: customer.keyHealth,
        syncIssueCode: customer.syncIssueCode,
        keyPoolStale: customer.keyPoolStale,
        fetchedAt: customer.fetchedAt,
        fingerprint: customer.fingerprint,
      }),
    ),
  ]).sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? 1 : -1;
    return left.displayName.localeCompare(right.displayName, "zh-CN");
  });
  const normalizedKeySearch = keyAccountSearch.trim().toLocaleLowerCase();
  const visibleKeyManagementRows = keyManagementRows.filter((row) => {
    if (keyAccountType !== "all" && row.kind !== keyAccountType) return false;
    if (!normalizedKeySearch) return true;
    return `${row.displayName} ${row.username} ${row.scopeLabel}`
      .toLocaleLowerCase()
      .includes(normalizedKeySearch);
  });
  const missingKeyCount = keyManagementRows.filter(
    (row) => !row.configured,
  ).length;

  useEffect(() => {
    if (
      systemAdmin &&
      credentialDeepLink?.credentialType === BRAND_TRACKING_CREDENTIAL_TYPE
    ) {
      setApiKeyManagementTab("brand_tracking");
    }
  }, [credentialDeepLink, systemAdmin]);

  useEffect(() => {
    if (
      previewMode ||
      !systemAdmin ||
      !credentialDeepLink ||
      credentialDeepLink.credentialType !== "managed_api" ||
      credentialDeepLinkOpened
    ) {
      return;
    }
    const target = keyManagementRows.find(
      (row) =>
        row.kind === credentialDeepLink.kind &&
        row.userId === credentialDeepLink.userId,
    );
    if (!target) return;
    setKeyAccountType(target.kind);
    setKeyAccountSearch("");
    setApiKeyTarget({
      kind: target.kind,
      userId: target.userId,
      displayName: target.displayName,
      username: target.username,
      configured: target.configured,
      version: target.version,
      ...(target.agentProfile ? { agentProfile: target.agentProfile } : {}),
    });
    setCredentialDeepLinkOpened(true);
  }, [
    credentialDeepLink,
    credentialDeepLinkOpened,
    keyManagementRows,
    previewMode,
    systemAdmin,
  ]);

  return (
    <PortalShell
      eyebrow="FrontMind 管理中心"
      title="API与人员管理"
      navItems={navItems}
      accountLabel={
        previewMode
          ? `${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`
          : undefined
      }
      roleLabel={
        previewMode
          ? `${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`
          : undefined
      }
    >
      <div className="space-y-5">
        {systemAdmin && (
          <PortalCard className="overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-[#eee8f2] px-5 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-5 w-5 text-[#5b2a86]" />
                  <h2 className="font-semibold text-[#171321]">
                    统一 API Key 管理
                  </h2>
                  {apiKeyManagementTab === "general" && (
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        missingKeyCount > 0
                          ? "bg-[#fff1f4] text-[#a02652]"
                          : "bg-[#eaf7f0] text-[#16794f]"
                      }`}
                    >
                      {missingKeyCount > 0
                        ? `${missingKeyCount} 个待配置`
                        : "全部已配置"}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm leading-6 text-[#716a80]">
                  {apiKeyManagementTab === "general"
                    ? "客户、交付管理员和工程师使用同一套管理入口；内部账号 Key 不绑定模型，客户服务流程保留 Base/Pro，近 30 天自用量按本地任务账本滚动累计。"
                    : "只为海外客户分配 FrontMind 品牌追踪 Key。不同客户可以共享同一 Key，个人积分仍按每轮实际用量分别归因。"}
                </p>
              </div>
              {apiKeyManagementTab === "general" &&
                (previewMode ? (
                  <span className="rounded-full border border-[#ddd4e5] bg-white px-3 py-1.5 text-xs font-medium text-[#716a80]">
                    只读验收预览 · 近 30 天
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        usageHierarchyQuery.isLoading ||
                        deliveryRoleOverviewQuery.isLoading ||
                        keyManagementRows.length === 0
                      }
                      onClick={() => setBulkApiKeyOpen(true)}
                    >
                      <UsersRound className="h-4 w-4" />
                      批量配置 Key
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        usageHierarchyQuery.isFetching ||
                        usageSyncMutation.isPending
                      }
                      onClick={() => usageSyncMutation.mutate()}
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${
                          usageHierarchyQuery.isFetching ||
                          usageSyncMutation.isPending
                            ? "animate-spin"
                            : ""
                        }`}
                      />
                      {usageHierarchyQuery.isFetching ||
                      usageSyncMutation.isPending
                        ? "同步中"
                        : "刷新用量"}
                    </Button>
                  </div>
                ))}
            </div>

            <div
              className="flex gap-2 border-b border-[#eee8f2] px-5 py-3 sm:px-6"
              role="tablist"
              aria-label="API Key 管理类型"
            >
              {[
                ["general", "通用 Agent Key"],
                ["brand_tracking", "品牌追踪 Key"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={apiKeyManagementTab === value}
                  onClick={() =>
                    setApiKeyManagementTab(
                      value as "general" | "brand_tracking",
                    )
                  }
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    apiKeyManagementTab === value
                      ? "border-[#6f3a98] bg-[#6f3a98] text-white"
                      : "border-[#ddd4e5] bg-white text-[#5f576c] hover:border-[#a98cbd]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {apiKeyManagementTab === "general" ? (
              <>
                <div className="flex flex-col gap-3 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap gap-2">
                    {[
                      ["all", "全部"],
                      ["customer", "客户"],
                      ["delivery_admin", "交付管理员"],
                      ["engineer", "工程师"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          setKeyAccountType(
                            value as "all" | OverviewApiKeyTarget["kind"],
                          )
                        }
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                          keyAccountType === value
                            ? "border-[#6f3a98] bg-[#6f3a98] text-white"
                            : "border-[#ddd4e5] bg-white text-[#5f576c] hover:border-[#a98cbd]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={keyAccountSearch}
                    onChange={(event) =>
                      setKeyAccountSearch(event.target.value)
                    }
                    placeholder="搜索账号、名称或负责人"
                    aria-label="搜索 Key 管理账号"
                    className="h-9 bg-white lg:w-72"
                  />
                </div>

                {usageHierarchyQuery.isLoading ||
                deliveryRoleOverviewQuery.isLoading ? (
                  <div className="p-6 text-sm text-[#716a80]">
                    正在读取账号 Key 与用量…
                  </div>
                ) : usageHierarchyQuery.error ||
                  deliveryRoleOverviewQuery.error ? (
                  <div className="p-6 text-sm text-[#a02652]">
                    Key 管理数据暂时无法读取。
                  </div>
                ) : visibleKeyManagementRows.length === 0 ? (
                  <div className="p-6 text-sm text-[#716a80]">
                    没有符合当前筛选条件的账号。
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <div className="min-w-[1050px]">
                      <div className="grid grid-cols-[minmax(200px,1.2fr)_110px_minmax(210px,1.2fr)_170px_130px_130px_140px] gap-4 border-b border-[#eee8f2] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6">
                        <span>账号</span>
                        <span>类型</span>
                        <span>归属范围</span>
                        <span>Key 状态</span>
                        <span>近 30 天自用量</span>
                        <span>已记录任务</span>
                        <span>操作</span>
                      </div>
                      {visibleKeyManagementRows.map((row) => (
                        <div
                          key={`${row.kind}-${row.userId}`}
                          className="grid grid-cols-[minmax(200px,1.2fr)_110px_minmax(210px,1.2fr)_170px_130px_130px_140px] items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[#332842]">
                              {row.displayName}
                            </p>
                            <p className="mt-1 truncate text-xs text-[#857e91]">
                              @{row.username}
                            </p>
                          </div>
                          <span className="w-fit rounded-full bg-[#f3edf7] px-2.5 py-1 text-xs font-medium text-[#6a338f]">
                            {row.typeLabel}
                          </span>
                          <p className="truncate text-sm text-[#5f576c]">
                            {row.scopeLabel}
                          </p>
                          <div className="text-xs">
                            <p
                              className={
                                row.configured
                                  ? "font-medium text-[#16794f]"
                                  : "font-medium text-[#a02652]"
                              }
                            >
                              {row.configured
                                ? (row.sharedKeyAccountCount ?? 0) > 1
                                  ? `共享 Key 已配置 · ${row.sharedKeyAccountCount} 个账号`
                                  : "账号 Key 已配置"
                                : row.inherited
                                  ? "使用历史共享 Key"
                                  : "Key 待配置"}
                            </p>
                            {row.configured && (
                              <p className="mt-1 text-[#716a80]">
                                {row.provider === "zhipu"
                                  ? "智谱"
                                  : "历史服务凭据"}
                              </p>
                            )}
                            {row.kind === "customer" && (
                              <p className="mt-1 text-[#716a80]">
                                {row.agentProfile === "frontmind-pro"
                                  ? "Pro"
                                  : "Base"}
                              </p>
                            )}
                            {row.inherited && (
                              <p className="mt-1 text-[#946800]">
                                建议配置独立 Key
                              </p>
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-[#5b2a86]">
                              {managedUsageDisplay(row)}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-[#332842]">
                              {row.nativeUsage?.observedTasks ?? 0} 个
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant={row.configured ? "outline" : "default"}
                            disabled={previewMode}
                            onClick={() => {
                              if (previewMode) return;
                              setApiKeyTarget({
                                kind: row.kind,
                                userId: row.userId,
                                displayName: row.displayName,
                                username: row.username,
                                configured: row.configured,
                                version: row.version,
                                ...(row.agentProfile
                                  ? { agentProfile: row.agentProfile }
                                  : {}),
                              });
                            }}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            {previewMode
                              ? "只读"
                              : row.configured
                                ? "更换 Key"
                                : "配置 Key"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <AdminBrandTrackingKeyManager
                previewMode={previewMode}
                deepLink={
                  credentialDeepLink?.credentialType ===
                  BRAND_TRACKING_CREDENTIAL_TYPE
                    ? credentialDeepLink
                    : undefined
                }
              />
            )}
          </PortalCard>
        )}
        {!previewMode && (
          <PortalCard className="overflow-hidden">
            <div className="border-b border-[#eee8f2] px-5 py-4 sm:px-6">
              <h2 className="font-semibold text-[#171321]">工程师状态</h2>
              <p className="mt-1 text-sm text-[#716a80]">
                {systemAdmin
                  ? "按人员查看岗位、项目和近 30 天用量。统一展示智谱 Token 用量。"
                  : "按人员查看专业岗位、负责项目和当前工作状态；项目岗位缺员请前往客户项目团队处理。"}
              </p>
            </div>
            {deliveryRoleOverviewQuery.isLoading ? (
              <div className="p-6 text-sm text-[#716a80]">
                正在读取工程师状态…
              </div>
            ) : deliveryRoleOverviewQuery.error ? (
              <div className="p-6 text-sm text-[#a02652]">
                工程师状态暂时无法读取。
              </div>
            ) : deliveryEngineerStatusRows.length === 0 ? (
              <div className="p-6 text-sm text-[#716a80]">
                当前权限范围内暂无工程师账号。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div
                  className={systemAdmin ? "min-w-[1040px]" : "min-w-[720px]"}
                >
                  <div
                    className={`grid gap-4 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6 ${
                      systemAdmin
                        ? "grid-cols-[minmax(160px,1.1fr)_minmax(160px,1fr)_minmax(180px,1.2fr)_140px_170px_180px]"
                        : "grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(220px,1.4fr)_150px]"
                    }`}
                  >
                    <span>工程师</span>
                    <span>专业岗位</span>
                    <span>负责项目</span>
                    <span>当前状态</span>
                    {systemAdmin && (
                      <>
                        <span>近 30 天用量</span>
                        <span>账号与 Key 状态</span>
                      </>
                    )}
                  </div>
                  {deliveryEngineerStatusRows.map((engineer) => {
                    const statusTone =
                      engineer.workStatus === "available"
                        ? "bg-[#eaf7f0] text-[#16794f]"
                        : engineer.workStatus === "disabled"
                          ? "bg-[#f2eff4] text-[#716a80]"
                          : "bg-[#fff1f4] text-[#a02652]";
                    return (
                      <div
                        key={engineer.id}
                        className={`grid items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6 ${
                          systemAdmin
                            ? "grid-cols-[minmax(160px,1.1fr)_minmax(160px,1fr)_minmax(180px,1.2fr)_140px_170px_180px]"
                            : "grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(220px,1.4fr)_150px]"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#332842]">
                            {engineer.displayName}
                          </p>
                          <p className="mt-1 truncate text-xs text-[#857e91]">
                            {engineer.username}
                          </p>
                        </div>
                        <p className="text-sm text-[#484057]">
                          {engineer.roleType
                            ? DELIVERY_ROLE_LABELS[engineer.roleType]
                            : "岗位未设置"}
                        </p>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-[#484057]">
                            {engineer.projectNames.length > 0
                              ? engineer.projectNames.join("、")
                              : "尚未负责客户项目"}
                          </p>
                          {engineer.projectCount > 1 && (
                            <p className="mt-1 text-xs text-[#857e91]">
                              共 {engineer.projectCount} 个项目
                            </p>
                          )}
                        </div>
                        <div>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone}`}
                          >
                            {engineer.workStatusLabel}
                          </span>
                        </div>
                        {systemAdmin && (
                          <>
                            <div className="space-y-1 text-xs text-[#716a80]">
                              <p>
                                自用{" "}
                                <span className="font-semibold text-[#5b2a86]">
                                  {managedUsageDisplay(engineer)}
                                </span>
                              </p>
                              <p>
                                已记录任务{" "}
                                <span className="font-semibold text-[#332842]">
                                  {engineer.nativeUsage?.observedTasks ?? 0} 个
                                </span>
                              </p>
                              {engineer.keyHealth !== "connected" && (
                                <>
                                  <p className="text-[#946800]">
                                    {apiUsageSyncStatusCopy({
                                      keyHealth: engineer.keyHealth,
                                      issueCode: engineer.usageSyncIssueCode,
                                    })}
                                  </p>
                                  {engineer.keyPoolTotalUsed !== null &&
                                    formatApiUsageLastSuccess(
                                      engineer.usageFetchedAt,
                                    ) && (
                                      <p className="text-[#857e91]">
                                        {`截至 ${formatApiUsageLastSuccess(engineer.usageFetchedAt)}，最新同步待恢复`}
                                      </p>
                                    )}
                                </>
                              )}
                            </div>
                            <div className="space-y-1 text-xs">
                              <p
                                className={
                                  engineer.isActive
                                    ? "text-[#16794f]"
                                    : "text-[#857e91]"
                                }
                              >
                                {engineer.isActive ? "账号启用" : "账号停用"}
                              </p>
                              <p
                                className={
                                  engineer.apiKeyConfigured
                                    ? "text-[#16794f]"
                                    : "text-[#a02652]"
                                }
                              >
                                {engineer.apiKeyConfigured
                                  ? "Key 已配置"
                                  : "Key 未配置"}
                              </p>
                              <p className="pt-1 text-[#857e91]">
                                在上方统一 Key 管理区操作
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </PortalCard>
        )}
      </div>
      {!previewMode && (
        <>
          <AdminOverviewApiKeyDialog
            target={apiKeyTarget}
            onOpenChange={(open) => !open && setApiKeyTarget(null)}
            onSaved={async () => {
              await Promise.all([
                deliveryRoleOverviewQuery.refetch(),
                usageHierarchyQuery.refetch(),
                workspaceQuery.refetch(),
              ]);
            }}
          />
          <AdminBulkApiKeyDialog
            open={bulkApiKeyOpen}
            rows={keyManagementRows}
            onOpenChange={setBulkApiKeyOpen}
            onSaved={async () => {
              await Promise.all([
                deliveryRoleOverviewQuery.refetch(),
                usageHierarchyQuery.refetch(),
                workspaceQuery.refetch(),
              ]);
            }}
          />
        </>
      )}
    </PortalShell>
  );
}
