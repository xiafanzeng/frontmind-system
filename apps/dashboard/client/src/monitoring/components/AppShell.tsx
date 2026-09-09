import type { ReactNode } from "react";
import { useLocation } from "wouter";
import PortalShell from "@/components/PortalShell";
import { getAdminNav } from "@/pages/AdminDashboard";
import type { ProjectSummary, SessionUser } from "../domain";

type AppShellProps = {
  embedded?: boolean;
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
  embedded = false,
  publishingEnabled,
  projects,
  activeProjectId,
  onProjectChange,
  children,
}: AppShellProps) {
  const [location] = useLocation();
  const administration = location.startsWith("/admin/monitoring");
  const publishing = location.startsWith("/publishing");
  const navItems = getAdminNav(true);
  const title =
    navItems
      .filter(
        (item) =>
          location === item.href ||
          (item.href !== "/" && location.startsWith(`${item.href}/`)),
      )
      .sort((a, b) => b.href.length - a.href.length)[0]?.label ||
    "监控与发布管理";
  const content = (
    <div
      className={`monitoring-module ${embedded ? "monitoring-conversation-shell" : ""}`}
    >
      {!embedded && !administration && !publishing && projects.length > 0 && (
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
  );
  // Customer routes are rendered inside UserBrandDashboard. Keep its navigation
  // and account drawer in place while the module owns only its business content.
  if (!administration) return content;
  return (
    <PortalShell eyebrow="FrontMind 管理中心" title={title} navItems={navItems}>
      {content}
    </PortalShell>
  );
}
