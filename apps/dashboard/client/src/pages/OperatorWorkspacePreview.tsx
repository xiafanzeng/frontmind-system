import { useState } from "react";
import { Menu } from "lucide-react";
import { ConversationProvider } from "@/contexts/ConversationContext";
import { OperatorSidebar, OperatorTabs, type EnterpriseProjectView } from "@/dashboard/OperatorNavigation";
import { OperatorThemeProvider } from "@/components/ui/operator-theme";
import EmbeddedKnowledgeBasePanel from "@/components/EmbeddedKnowledgeBasePanel";
import { previewKnowledgeProgress, previewKnowledgeSnapshot } from "@/lib/preview-data";
import type { OperatorView } from "@/dashboard/operator-navigation";
import "@/dashboard/dashboard-styles.css";

/** Imported exclusively by the DEV-only router. All project actions stay local. */
function OperatorPreview() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth >= 1024 && window.innerWidth < 1280);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [view, setView] = useState<OperatorView>("knowledge");
  const [projects, setProjects] = useState<EnterpriseProjectView[]>([
    { id: "design-project", name: "星辰科技 · 设计验收示例", ownerUserId: 0, revision: 1 },
    { id: "design-project-2", name: "未来教育", ownerUserId: 0, revision: 1 },
    { id: "design-project-3", name: "长名称项目：企业品牌建设与知识资料管理", ownerUserId: 0, revision: 1 },
  ]);
  const [activeId, setActiveId] = useState(projects[0]!.id);
  const active = projects.find((project) => project.id === activeId);
  return <OperatorThemeProvider enabled><div className={`user-brand-dashboard operator-mode ${collapsed ? "operator-collapsed" : ""}`}>
    <div className={`app-shell knowledge-build-app-shell ${mobileOpen ? "nav-open" : ""}`}>
      <button className="mobile-menu-btn" aria-label="打开项目导航" aria-expanded={mobileOpen} aria-controls="operator-project-navigation" onClick={() => setMobileOpen((open) => !open)}><Menu size={20} /></button>
      {mobileOpen && <div className="mobile-nav-overlay" onClick={() => setMobileOpen(false)} />}
      <OperatorSidebar projects={projects} activeProject={active} activeEntry="project" collapsed={collapsed}
        accountName="设计验收账号"
        onCollapse={() => { if (window.innerWidth >= 1024 && window.innerWidth < 1280) { setMobileOpen((open) => !open); setCollapsed(mobileOpen); } else setCollapsed((value) => !value); }} mobileOpen={mobileOpen} onCloseMobile={() => { setMobileOpen(false); if (window.innerWidth >= 1024 && window.innerWidth < 1280) setCollapsed(true); }}
        onNavigate={() => undefined} onSelectProject={(id) => { setActiveId(id); setMobileOpen(false); }}
        onCreateProject={async (name) => { const id = `design-${projects.length}`; setProjects((items) => [...items, { id, name, ownerUserId: 0, revision: 1 }]); setActiveId(id); }}
        onRenameProject={async (name, target) => setProjects((items) => items.map((item) => item.id === target.id ? { ...item, name, revision: item.revision + 1 } : item))}
        onDeleteProject={async (target) => { setProjects((items) => items.filter((item) => item.id !== target.id)); if (activeId === target.id) setActiveId(projects.find((item) => item.id !== target.id)?.id ?? ""); }} />
      <main className="dashboard-main knowledge-build-main">
        <OperatorTabs view={view} projectName={active?.name ?? "未选择项目"} onSelect={(next) => setView(next as OperatorView)} />
        <EmbeddedKnowledgeBasePanel preview previewData={{ progress: previewKnowledgeProgress, snapshot: previewKnowledgeSnapshot }} page="build" onPageChange={() => undefined} mode="workspace" />
      </main>
    </div>
  </div></OperatorThemeProvider>;
}

export default function OperatorWorkspacePreview() {
  return <ConversationProvider><OperatorPreview /></ConversationProvider>;
}
