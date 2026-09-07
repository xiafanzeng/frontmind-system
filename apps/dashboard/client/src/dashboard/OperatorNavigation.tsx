import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState, useEffect, useCallback, useRef, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Bot, ChevronDown, Folder, FolderOpen, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Sparkles, Trash2, Wallet } from "lucide-react";
import { OPERATOR_MODULES, type OperatorView } from "./operator-navigation";
import "./operator-workspace.css";

export type EnterpriseProjectView = { id: string; name: string; ownerUserId: number; revision: number; isLegacyDefault?: boolean };
type ProjectDialog = "create" | "rename" | "delete";

export function OperatorSidebar({ projects, activeProject, activeEntry, collapsed, onCollapse, onNavigate, onSelectProject, onCreateProject, onRenameProject, onDeleteProject }: {
  projects: EnterpriseProjectView[]; activeProject?: EnterpriseProjectView; activeEntry: "project" | "agent" | "account";
  collapsed: boolean; onCollapse: () => void; onNavigate: (path: string) => void;
  onSelectProject: (id: string) => void; onCreateProject: (name: string) => Promise<void>; onRenameProject: (name: string) => Promise<void>;
  onDeleteProject?: () => Promise<void>;
}) {
  const projectMenuTrigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const [dialogProject, setDialogProject] = useState<Pick<EnterpriseProjectView, "id" | "name"> | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = useCallback((kind: ProjectDialog) => {
    if (saving) return;
    setMenuOpen(false);
    setDialogProject(activeProject ? { id: activeProject.id, name: activeProject.name } : null);
    setDialog(kind);
    setName(kind === "rename" ? activeProject?.name || "" : "");
    setError("");
  }, [activeProject?.id, activeProject?.name, saving]);
  useEffect(() => {
    const listener = () => open("create");
    window.addEventListener("operator-create-project", listener);
    return () => window.removeEventListener("operator-create-project", listener);
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || saving || (dialog !== "delete" && !name.trim())) return;
    if (dialog !== "create" && (!dialogProject || dialogProject.id !== activeProject?.id)) {
      setError("当前项目已切换，请关闭弹窗后重新选择项目。");
      return;
    }
    if (dialog === "delete" && !onDeleteProject) return;
    setSaving(true);
    setError("");
    try {
      if (dialog === "delete") await onDeleteProject!();
      else await (dialog === "create" ? onCreateProject : onRenameProject)(name.trim());
      setDialog(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : dialog === "delete" ? "项目未能删除，请重试。" : "项目未能保存，请重试。");
    } finally {
      setSaving(false);
    }
  };
  return <>
    <aside className="global-nav operator-sidebar" data-collapsed={collapsed}>
      <div className="operator-brand">
        <div className="operator-brand-logo"><img src="/frontmind-contract-logo-white.svg" alt="FrontMind" /></div>
        <span className="operator-brand-caption">智能品牌工作台</span>
      </div>
      <div className={`operator-project-group ${activeEntry === "project" ? "is-active" : ""}`}>
        <div className="operator-project-heading">
          <button type="button" className={`operator-nav-entry operator-project-entry ${activeEntry === "project" ? "active" : ""}`} title="AI智能品牌优化" onClick={() => { if (collapsed) onCollapse(); setExpanded(!expanded || collapsed); if (activeEntry !== "project") onNavigate("/?view=knowledge"); }} aria-expanded={expanded && !collapsed}>
            <Sparkles size={18} /><span>AI智能品牌优化</span><ChevronDown size={14} className={expanded ? "is-open" : ""} />
          </button>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button ref={projectMenuTrigger} type="button" className="operator-project-menu-trigger" aria-label="项目管理" title="项目管理" disabled={saving}><MoreHorizontal size={18} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="operator-project-menu" align="start" side={collapsed ? "right" : "bottom"} sideOffset={8} onCloseAutoFocus={event => { if (dialog) event.preventDefault(); }}>
              <DropdownMenuLabel className="operator-project-menu-label">项目管理</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => open("create")}><Plus />新建企业项目</DropdownMenuItem>
              {activeProject && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="operator-project-menu-current" title={activeProject.name}>{activeProject.name}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => open("rename")}><Pencil />重命名当前项目</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" disabled={!onDeleteProject} onSelect={() => open("delete")}><Trash2 />删除当前项目</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded && !collapsed && <div className="operator-projects" aria-label="企业项目">
          <div className="operator-projects-caption"><span>企业项目</span><span>{projects.length}</span></div>
          {projects.map(project => <div className={`operator-project-row ${project.id === activeProject?.id ? "selected" : ""}`} key={project.id}>
            <button type="button" title={project.name} aria-current={project.id === activeProject?.id ? "page" : undefined} onClick={() => onSelectProject(project.id)}>{project.id === activeProject?.id ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{project.name}</span>{project.id === activeProject?.id && <i aria-hidden="true" />}</button>
          </div>)}
          {!projects.length && <p className="operator-project-hint">从项目管理中新建企业项目，开始整理品牌知识。</p>}
        </div>}
      </div>
      <div className="operator-account-nav">
        <button type="button" className={`operator-nav-entry ${activeEntry === "agent" ? "active" : ""}`} title="FrontMind通用智能体" onClick={() => onNavigate("/agent")}><Bot size={18} /><span>FrontMind通用智能体</span></button>
        <button type="button" className={`operator-nav-entry ${activeEntry === "account" ? "active" : ""}`} title="账号与余额" onClick={() => onNavigate("/account")}><Wallet size={18} /><span>账号与余额</span></button>
      </div>
      <div className="operator-sidebar-footer"><button type="button" onClick={onCollapse} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>收起侧边栏</span></button></div>
    </aside>
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value && !saving) setDialog(null); }}>
      <DialogContent className="operator-dialog" overlayClassName="operator-dialog-overlay" showCloseButton={!saving} onCloseAutoFocus={event => { event.preventDefault(); projectMenuTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
        <span className={`operator-dialog-symbol ${dialog === "delete" ? "is-destructive" : ""}`}>{dialog === "delete" ? <Trash2 size={21} /> : dialog === "rename" ? <Pencil size={21} /> : <FolderOpen size={22} />}</span>
        <div className="operator-dialog-heading">
          <DialogTitle>{dialog === "create" ? "新建企业项目" : dialog === "delete" ? "删除企业项目" : "重命名企业项目"}</DialogTitle>
          <DialogDescription>{dialog === "delete" ? "删除后将无法从工作区进入此项目。请确认这是要删除的企业项目。" : "每个项目独立保存知识库、优化问题与制作记录。"}</DialogDescription>
        </div>
        <form onSubmit={submit}>
          {dialog === "delete" ? <div className="operator-delete-project-name"><Folder size={18} /><strong>{dialogProject?.name}</strong></div> : <label>项目名称<input autoFocus disabled={saving} value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="输入企业或品牌名称" /></label>}
          {error && <p role="alert" className="operator-form-error">{error}</p>}
          <div className="operator-dialog-actions">
            <button type="button" className="operator-secondary-button" disabled={saving} onClick={() => setDialog(null)}>取消</button>
            <button type="submit" className={dialog === "delete" ? "operator-danger-button" : "operator-primary-button"} disabled={saving || (dialog === "delete" ? !onDeleteProject : !name.trim())}>{saving ? dialog === "delete" ? "正在删除…" : "正在保存…" : dialog === "create" ? "创建项目" : dialog === "delete" ? "删除项目" : "保存名称"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}

function moveTabFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus(); tabs[next]?.click();
}

export function OperatorTabs({ view, projectName, onSelect }: { view: OperatorView; projectName?: string; onSelect: (view: OperatorView) => void }) {
  const selectedView = view === "knowledge-display" ? "knowledge" : view;
  const activeModule = OPERATOR_MODULES.find(module => module.views.some(item => item.id === selectedView)) || OPERATOR_MODULES[0];
  return <header className="operator-workspace-header" style={{ "--module-accent": activeModule.color } as CSSProperties}>
    <div className="operator-workspace-caption"><span>AI智能品牌优化</span>{projectName && <><span aria-hidden="true">/</span><strong>{projectName}</strong></>}</div>
    <div className="operator-module-tabs" role="tablist" onKeyDown={moveTabFocus} aria-label="项目板块">
      {OPERATOR_MODULES.map((module, index) => <button key={module.id} type="button" role="tab" tabIndex={module.id === activeModule.id ? 0 : -1} aria-selected={module.id === activeModule.id} className={module.id === activeModule.id ? "active" : ""} style={{ "--tab-color": module.color } as CSSProperties} onClick={() => onSelect(module.views[0].id)}><span className="operator-tab-number">0{index + 1}</span>{module.label}</button>)}
    </div>
    <div className="operator-sub-tabs" role="tablist" onKeyDown={moveTabFocus} aria-label={`${activeModule.label}功能`}>
      {activeModule.views.map(item => <button type="button" role="tab" tabIndex={item.id === selectedView ? 0 : -1} aria-selected={item.id === selectedView} key={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}
      {selectedView === "knowledge" && <div className="operator-knowledge-tabs" role="group" aria-label="智能知识库视图"><button type="button" aria-pressed={view === "knowledge"} onClick={() => onSelect("knowledge")}>知识库智能体</button><button type="button" aria-pressed={view === "knowledge-display"} onClick={() => onSelect("knowledge-display")}>知识库展示</button></div>}
    </div>
  </header>;
}

export function OperatorEmptyProject({ onCreate }: { onCreate: () => void }) {
  return <section className="operator-empty-project"><span className="operator-empty-symbol"><Sparkles size={30} /></span><span className="operator-eyebrow">AI智能品牌优化</span><h1>从一个企业项目开始</h1><p>构建品牌知识、梳理优化问题，连接监控、内容制作与媒体发布。</p><button type="button" className="operator-primary-button" onClick={onCreate}><Plus size={17} />新建企业项目</button></section>;
}
