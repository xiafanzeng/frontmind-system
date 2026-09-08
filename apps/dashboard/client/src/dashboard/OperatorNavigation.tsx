import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState, useEffect, useCallback, useRef, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { Bot, ChartNoAxesCombined, ChevronDown, Database, Folder, FolderOpen, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, PenLine, Plus, Send, Sparkles, Target, Trash2, Wallet, Wrench } from "lucide-react";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import { OPERATOR_MODULES, operatorViewPath, type OperatorView } from "./operator-navigation";
import "./operator-workspace.css";

export type EnterpriseProjectView = { id: string; name: string; ownerUserId: number; revision: number; isLegacyDefault?: boolean };
type ProjectDialog = "create" | "rename" | "delete";
type ProjectDialogState = { kind: ProjectDialog; project?: EnterpriseProjectView; activeProjectId?: string };

export function OperatorSidebar({ projects, activeProject, activeEntry, collapsed, onCollapse, onNavigate, onSelectProject, onCreateProject, onRenameProject, onDeleteProject, mobileOpen = false, onCloseMobile, accountName, projectsLoading = false, projectsError }: {
  projects: EnterpriseProjectView[]; projectsLoading?: boolean; projectsError?: string; activeProject?: EnterpriseProjectView; activeEntry: "project" | "agent" | "account";
  collapsed: boolean; onCollapse: () => void; onNavigate: (path: string) => void;
  mobileOpen?: boolean; onCloseMobile?: () => void; accountName?: string;
  onSelectProject: (id: string) => void; onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (name: string, project: EnterpriseProjectView) => Promise<void>;
  onDeleteProject?: (project: EnterpriseProjectView) => Promise<void>;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const closeMobile = useRef(onCloseMobile);
  closeMobile.current = onCloseMobile;
  useEffect(() => {
    if (!mobileOpen || !isMobile || !sidebarRef.current) return;
    const sidebar = sidebarRef.current;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = sidebar.closest(".app-shell")?.querySelector<HTMLElement>("main");
    const originalInert = main?.inert;
    if (main) main.inert = true;
    const controls = () => [...sidebar.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]')];
    controls()[0]?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      // A Radix popup owns its own Escape and focus containment while open.
      if (document.querySelector('[data-slot="dialog-content"], [data-slot="dropdown-menu-content"]')) return;
      if (event.key === "Escape") { event.preventDefault(); closeMobile.current?.(); }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (main) main.inert = originalInert ?? false;
      if (origin?.isConnected) origin.focus();
    };
  }, [mobileOpen, isMobile]);
  const projectMenuTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const submitting = useRef(false);
  const [expanded, setExpanded] = useState(true);
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = useCallback((kind: ProjectDialog, project = activeProject, trigger: HTMLElement | null = projectMenuTrigger.current) => {
    if (submitting.current) return;
    returnFocus.current = trigger;
    setDialog({ kind, project: project ? { ...project } : undefined, activeProjectId: activeProject?.id });
    setName(kind === "rename" ? project?.name || "" : "");
    setError("");
  }, [activeProject]);
  useEffect(() => {
    const listener = () => open("create", undefined, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    window.addEventListener("operator-create-project", listener);
    return () => window.removeEventListener("operator-create-project", listener);
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || submitting.current || (dialog.kind !== "delete" && !name.trim())) return;
    const current = projects.find(project => project.id === dialog.project?.id);
    if (dialog.kind !== "create" && (dialog.activeProjectId !== activeProject?.id || !current || current.revision !== dialog.project?.revision)) {
      setError("当前项目已切换或更新，请关闭弹窗后重新选择项目。");
      return;
    }
    if (dialog.kind === "delete" && !onDeleteProject) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      if (dialog.kind === "delete") await onDeleteProject!(dialog.project!);
      else if (dialog.kind === "rename") await onRenameProject(name.trim(), dialog.project!);
      else await onCreateProject(name.trim());
      setDialog(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : dialog.kind === "delete" ? "项目未能删除，请重试。" : "项目未能保存，请重试。");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  const closeAutoFocus = (event: Event) => {
    event.preventDefault();
    const target = returnFocus.current?.isConnected ? returnFocus.current : projectMenuTrigger.current;
    target?.focus();
  };
  return <>
    <aside ref={sidebarRef} role={mobileOpen && isMobile ? "dialog" : undefined} aria-modal={mobileOpen && isMobile ? true : undefined} id="operator-project-navigation" className="global-nav operator-sidebar" aria-label="工作区导航" data-collapsed={collapsed}>
      <div className="operator-brand">
        <div className="operator-brand-logo"><img src="/frontmind-contract-logo-white.svg" alt="FrontMind" /></div>
      </div>
      <div className={`operator-project-group ${activeEntry === "project" ? "is-active" : ""}`}>
        <div className="operator-project-heading">
          <button type="button" className={`operator-nav-entry operator-project-entry ${activeEntry === "project" ? "active" : ""}`} title="AI智能品牌优化" aria-label="AI智能品牌优化" onClick={() => { if (collapsed) onCollapse(); setExpanded(!expanded || collapsed); if (activeEntry !== "project") requestWorkspaceNavigation(() => onNavigate("/?view=knowledge")); }} aria-expanded={expanded && !collapsed} aria-controls="operator-project-list">
            <Sparkles size={20} /><span>AI智能品牌优化</span><ChevronDown size={16} className={expanded ? "is-open" : ""} />
          </button>
          <button ref={projectMenuTrigger} type="button" className="operator-project-menu-trigger" aria-label="新建企业项目" title="新建企业项目" disabled={saving} onClick={() => open("create")}><Plus size={18} /></button>
        </div>
        {expanded && !collapsed && <div id="operator-project-list" className="operator-projects" aria-label="企业项目">
          <div className="operator-projects-caption"><span>企业项目</span><span>{projectsLoading && !projects.length ? "—" : projects.length}</span></div>
          {projects.map(project => <ProjectRow key={project.id} project={project} selected={project.id === activeProject?.id} saving={saving} canDelete={Boolean(onDeleteProject)} onSelect={() => requestWorkspaceNavigation(() => onSelectProject(project.id))} onAction={(kind, trigger) => open(kind, project, trigger)} dialogOpen={Boolean(dialog)} />)}
          {!projects.length && (projectsLoading ? <p className="operator-project-hint" role="status">正在读取企业项目…</p> : projectsError ? <p className="operator-project-hint" role="alert">企业项目暂时无法读取</p> : <p className="operator-project-hint">点击上方加号新建企业项目，开始整理品牌知识。</p>)}
        </div>}
      </div>
      <div className="operator-general-nav">
        <button type="button" className={`operator-nav-entry ${activeEntry === "agent" ? "active" : ""}`} title="FrontMind通用智能体" aria-label="FrontMind通用智能体" onClick={() => requestWorkspaceNavigation(() => onNavigate("/agent"))}><Bot size={20} /><span>FrontMind通用智能体</span></button>
      </div>
      <div className="operator-sidebar-bottom">
      <div className="operator-account-nav">
        <button type="button" className={`operator-nav-entry ${activeEntry === "account" ? "active" : ""}`} title="账号与余额" aria-label="账号与余额" onClick={() => requestWorkspaceNavigation(() => onNavigate("/account"))}><Wallet size={20} /><span>账号与余额</span></button>
      </div>
      {accountName && <div className="operator-account-identity" title={accountName}><span aria-hidden="true">{Array.from(accountName).slice(0, 1).join("")}</span><strong>{accountName}</strong></div>}
      <div className="operator-sidebar-footer"><button type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}<span>收起侧边栏</span></button></div>
      </div>
    </aside>
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value && !submitting.current) setDialog(null); }}>
      <DialogContent className="operator-dialog" overlayClassName="operator-dialog-overlay" showCloseButton={!saving} onCloseAutoFocus={closeAutoFocus} onEscapeKeyDown={event => { if (submitting.current) event.preventDefault(); }} onPointerDownOutside={event => { if (submitting.current) event.preventDefault(); }}>
        <span className={`operator-dialog-symbol ${dialog?.kind === "delete" ? "is-destructive" : ""}`}>{dialog?.kind === "delete" ? <Trash2 size={22} /> : dialog?.kind === "rename" ? <Pencil size={22} /> : <FolderOpen size={22} />}</span>
        <div className="operator-dialog-heading">
          <DialogTitle>{dialog?.kind === "create" ? "新建企业项目" : dialog?.kind === "delete" ? "删除企业项目" : "重命名企业项目"}</DialogTitle>
          <DialogDescription>{dialog?.kind === "delete" ? "删除后将无法从工作区进入此项目。请确认这是要删除的企业项目。" : "每个项目独立保存知识库、优化问题与制作记录。"}</DialogDescription>
        </div>
        <form onSubmit={submit}>
          {dialog?.kind === "delete" ? <div className="operator-delete-project-name"><Folder size={18} /><strong>{dialog.project?.name}</strong></div> : <label>项目名称<input autoFocus disabled={saving} value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="输入企业或品牌名称" /></label>}
          {error && <p role="alert" className="operator-form-error">{error}</p>}
          <div className="operator-dialog-actions">
            <button type="button" className="operator-secondary-button" disabled={saving} onClick={() => setDialog(null)}>取消</button>
            <button type="submit" className={dialog?.kind === "delete" ? "operator-danger-button" : "operator-primary-button"} disabled={saving || (dialog?.kind === "delete" ? !onDeleteProject : !name.trim())}>{saving ? dialog?.kind === "delete" ? "正在删除…" : "正在保存…" : dialog?.kind === "create" ? "创建项目" : dialog?.kind === "delete" ? "删除项目" : "保存名称"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}

function ProjectRow({ project, selected, saving, canDelete, onSelect, onAction, dialogOpen }: {
  project: EnterpriseProjectView; selected: boolean; saving: boolean; canDelete: boolean; onSelect: () => void;
  onAction: (kind: "rename" | "delete", trigger: HTMLButtonElement | null) => void; dialogOpen: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className={`operator-project-row ${selected ? "selected" : ""}`}>
    <Tooltip>
      <TooltipTrigger asChild><button type="button" className="operator-project-select" title={project.name} aria-current={selected ? "page" : undefined} onClick={onSelect}>{selected ? <FolderOpen size={17} /> : <Folder size={17} />}<span>{project.name}</span></button></TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[min(320px,calc(100vw-24px))] break-words">{project.name}</TooltipContent>
    </Tooltip>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button ref={trigger} type="button" className="operator-project-row-menu" aria-label={`管理项目：${project.name}`} title={`管理项目：${project.name}`} disabled={saving}><MoreHorizontal size={18} /></button></DropdownMenuTrigger>
      <DropdownMenuContent className="operator-project-menu" align="start" side="right" sideOffset={8} onCloseAutoFocus={event => { if (dialogOpen) event.preventDefault(); }}>
        <DropdownMenuLabel className="operator-project-menu-current">{project.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAction("rename", trigger.current)}><Pencil />重命名项目</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={!canDelete} onSelect={() => onAction("delete", trigger.current)}><Trash2 />删除项目</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

const moduleIcons = { brand: Database, intent: Target, progress: ChartNoAxesCombined, content: PenLine, publishing: Send, extensions: Wrench };

export function OperatorTabs({ view, onSelect }: { view: OperatorView; projectName?: string; onSelect: (view: OperatorView) => void }) {
  const selectedView = view === "knowledge-display" ? "knowledge" : view;
  const activeModule = OPERATOR_MODULES.find(module => module.views.some(item => item.id === selectedView)) || OPERATOR_MODULES[0];
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const revealCurrent = () => {
      const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current) return;
      const row = nav.getBoundingClientRect(), tab = current.getBoundingClientRect();
      // Deep links and resized windows reveal the active module without moving the page.
      if (tab.left < row.left) nav.scrollLeft -= row.left - tab.left;
      else if (tab.right > row.right) nav.scrollLeft += tab.right - row.right;
    };
    revealCurrent();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealCurrent);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [activeModule.id]);
  const select = (event: MouseEvent<HTMLAnchorElement>, next: OperatorView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(next);
  };
  return <header className="operator-workspace-header" style={{ "--module-accent": activeModule.color } as CSSProperties}>
    <nav ref={tabsRef} className="operator-module-tabs" aria-label="项目板块">
      {OPERATOR_MODULES.map(module => {
        const Icon = moduleIcons[module.id];
        return <a key={module.id} href={projectWorkspaceUrl(operatorViewPath(module.views[0].id))} aria-current={module.id === activeModule.id ? "page" : undefined} className={module.id === activeModule.id ? "active" : ""} style={{ "--tab-color": module.color } as CSSProperties} onClick={event => select(event, module.views[0].id)}>
          <svg className="operator-module-tab-shape" viewBox="0 0 200 52" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path className="operator-module-tab-fill" d="M1 52V13Q1 1 13 1H174Q182 1 185 11L199 52Z" />
            <path className="operator-module-tab-edge" d="M1 52V13Q1 1 13 1H174Q182 1 185 11L199 52" vectorEffect="non-scaling-stroke" />
            <path className="operator-module-tab-accent" d="M2 12Q2 2 13 2H174Q180 2 183 8" vectorEffect="non-scaling-stroke" />
          </svg>
          <Icon className="operator-module-tab-icon" size={18} aria-hidden="true" /><span>{module.label}</span>
        </a>;
      })}
    </nav>
    {activeModule.views.length > 1 && <nav className="operator-sub-tabs" aria-label={`${activeModule.label}功能`}>
      {activeModule.views.map(item => <a href={projectWorkspaceUrl(operatorViewPath(item.id))} aria-current={item.id === selectedView ? "page" : undefined} key={item.id} onClick={event => select(event, item.id)}>{item.label}</a>)}
    </nav>}
  </header>;
}

export function OperatorEmptyProject({ onCreate }: { onCreate: () => void }) {
  return <section className="operator-empty-project"><span className="operator-empty-symbol"><FolderOpen size={30} /></span><span className="operator-eyebrow">AI智能品牌优化</span><h1>从一个企业项目开始</h1><p>构建品牌知识、梳理优化问题，连接监控、内容制作与媒体发布。</p><button type="button" className="operator-primary-button" onClick={onCreate}><Plus size={18} />新建企业项目</button></section>;
}
