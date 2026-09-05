import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  BookOpenText,
  Bot,
  ClipboardList,
  Eye,
  FilePenLine,
  House,
  Images,
  LibraryBig,
  Newspaper,
  RadioTower,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UsersRound,
  WalletCards,
} from "lucide-react";
import PortalShell, { type PortalNavItem } from "@/components/PortalShell";
import { getAdminNav } from "@/pages/AdminDashboard";
import { useAuth } from "@/_core/hooks/useAuth";
import { isSystemAdminAccount } from "@/lib/admin-access";
import type { ProjectSummary, SessionUser } from "../domain";

export const customerModuleNav: PortalNavItem[] = [
  { href: "/", label: "品牌优化看板", icon: House, group: "看板" },
  {
    href: "/knowledge-base",
    label: "知识库智能体",
    icon: BookOpenText,
    group: "看板",
  },
  {
    href: "/monitoring-system",
    label: "问题监控",
    icon: Activity,
    group: "监控与发布",
  },
  {
    href: "/publishing",
    label: "媒体发布",
    icon: Newspaper,
    group: "监控与发布",
  },
  {
    href: "/publishing/articles",
    label: "稿件",
    icon: FilePenLine,
    group: "监控与发布",
  },
  {
    href: "/publishing/media",
    label: "媒体库",
    icon: LibraryBig,
    group: "监控与发布",
  },
  {
    href: "/publishing/publications",
    label: "发布记录",
    icon: BookOpenText,
    group: "监控与发布",
  },
  {
    href: "/monitoring-system/settings",
    label: "账户余额",
    icon: WalletCards,
    group: "账户",
  },
];
export const administrationModuleNav: PortalNavItem[] = [
  { href: "/", label: "系统总览", icon: House, group: "系统管理" },
  {
    href: "/admin/workspace",
    label: "客户管理",
    icon: UsersRound,
    group: "系统管理",
  },
  {
    href: "/admin/users",
    label: "账号与权限",
    icon: ShieldCheck,
    group: "系统管理",
  },
  {
    href: "/admin/monitoring/accounts",
    label: "账号与余额",
    icon: WalletCards,
    group: "监控管理",
  },
  {
    href: "/admin/monitoring/models",
    label: "模型能力",
    icon: Bot,
    group: "监控管理",
  },
  {
    href: "/admin/monitoring/operations",
    label: "任务运行",
    icon: ClipboardList,
    group: "监控管理",
  },
  {
    href: "/admin/monitoring/content-review",
    label: "内容查阅",
    icon: Eye,
    group: "监控管理",
  },
  {
    href: "/admin/monitoring/audit-log",
    label: "操作记录",
    icon: ScrollText,
    group: "监控管理",
  },
  {
    href: "/admin/monitoring/media-publishing/integration",
    label: "发布集成",
    icon: RadioTower,
    group: "发布管理",
  },
  {
    href: "/admin/monitoring/media-publishing/catalog",
    label: "目录同步",
    icon: RefreshCw,
    group: "发布管理",
  },
  {
    href: "/admin/monitoring/media-publishing/capabilities",
    label: "图文能力",
    icon: Images,
    group: "发布管理",
  },
  {
    href: "/admin/monitoring/media-publishing/reconciliation",
    label: "异常对账",
    icon: ShieldCheck,
    group: "发布管理",
  },
  {
    href: "/monitoring-system",
    label: "问题监控",
    icon: Activity,
    group: "客户工作区",
  },
  {
    href: "/publishing",
    label: "媒体发布",
    icon: Newspaper,
    group: "客户工作区",
  },
];

type AppShellProps = {
  user: SessionUser;
  accountBalance?: string;
  walletBalances?: { monitoring?: string; mediaPublishing?: string };
  publishingEnabled?: boolean;
  projects: ProjectSummary[];
  activeProjectId?: string;
  onProjectChange?: (id: string) => void;
  onLogout?: () => void;
  legalRegistration?: { number: string; link: string };
  environmentLabel?: string;
  children: ReactNode;
};

/** Dashboard owns the shell, account menu, and logout; the module owns its business views. */
export default function AppShell({
  user,
  accountBalance,
  walletBalances,
  publishingEnabled,
  projects,
  activeProjectId,
  onProjectChange,
  children,
}: AppShellProps) {
  const [location] = useLocation();
  const { user: dashboardUser } = useAuth();
  const administration = location.startsWith("/admin/monitoring");
  const publishing = location.startsWith("/publishing");
  const navItems = administration
    ? [
        ...getAdminNav(true).filter(
          (item) => !item.href.startsWith("/admin/monitoring"),
        ),
        ...administrationModuleNav.filter((item) => item.group !== "系统管理"),
      ]
    : [
        ...customerModuleNav,
        ...(isSystemAdminAccount(dashboardUser)
          ? [
              {
                href: "/admin/monitoring/accounts",
                label: "监控与发布管理",
                icon: ShieldCheck,
                group: "系统管理",
              },
            ]
          : []),
      ];
  const title =
    navItems
      .filter(
        (item) =>
          location === item.href ||
          (item.href !== "/" && location.startsWith(`${item.href}/`)),
      )
      .sort((a, b) => b.href.length - a.href.length)[0]?.label ||
    "监控与发布管理";
  return (
    <PortalShell
      eyebrow={
        administration ? "FrontMind / 系统管理员" : "FrontMind / 工作空间"
      }
      title={title}
      navItems={navItems}
    >
      <div className="monitoring-module">
        {!administration && (
          <div className="module-toolbar">
            {!publishing && projects.length > 0 && (
              <label className="module-project-picker">
                项目
                <select
                  aria-label="选择监控项目"
                  value={activeProjectId || projects[0]?.id}
                  onChange={(event) => onProjectChange?.(event.target.value)}
                >
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Link
              href={`/monitoring-system/settings?wallet=${publishing ? "media_publishing" : "monitoring"}`}
              className="module-wallet-link"
            >
              {publishing ? "媒体发布余额" : "问题监控余额"}{" "}
              <strong>
                {publishing
                  ? walletBalances?.mediaPublishing || "¥0.00"
                  : walletBalances?.monitoring || accountBalance || "¥0.00"}
              </strong>
            </Link>
          </div>
        )}
        {!publishingEnabled && publishing ? (
          <div className="panel-state" role="status">
            <strong>媒体发布尚未启用</strong>
            <span>请联系系统管理员配置发布服务。</span>
          </div>
        ) : (
          children
        )}
        <div id="monitoring-module-portals" />
      </div>
    </PortalShell>
  );
}
