import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useState, useEffect, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Bot, ChevronDown, Folder, FolderOpen, Menu, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sparkles, Wallet, X } from "lucide-react";
import { OPERATOR_MODULES, type OperatorView } from "./operator-navigation";
import "./operator-workspace.css";

export type EnterpriseProjectView = { id: string; name: string; ownerUserId: number; revision: number; isLegacyDefault?: boolean };
export function OperatorSidebar({ projects, activeProject, activeEntry, collapsed, onCollapse, onNavigate, onSelectProject, onCreateProject, onRenameProject }: {
  projects: EnterpriseProjectView[]; activeProject?: EnterpriseProjectView; activeEntry: "project" | "agent" | "account";
  collapsed: boolean; onCollapse: () => void; onNavigate: (path: string) => void;
  onSelectProject: (id: string) => void; onCreateProject: (name: string) => Promise<void>; onRenameProject: (name: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = (kind: "create" | "rename") => { setDialog(kind); setName(kind === "rename" ? activeProject?.name || "" : ""); setError(""); };
  useEffect(() => {
    const listener = () => open("create");
    window.addEventListener("operator-create-project", listener);
    return () => window.removeEventListener("operator-create-project", listener);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true); setError("");
    try { await (dialog === "create" ? onCreateProject : onRenameProject)(name.trim()); setDialog(null); }
    catch (error) { setError(error instanceof Error ? error.message : "项目未能保存，请重试。"); }
    finally { setSaving(false); }
  };
  return <>
    <aside className="global-nav operator-sidebar">
      <div className="operator-brand"><img src="/assets/frontmind-mark.svg" alt="" /><strong>MindPromise<span>智诺</span></strong></div>
      <button className={`operator-nav-entry ${activeEntry === "project" ? "active" : ""}`} title="AI智能品牌优化方案" onClick={() => { if (collapsed) onCollapse(); setExpanded(!expanded || collapsed); if (activeEntry !== "project") onNavigate("/?view=knowledge"); }} aria-expanded={expanded && !collapsed}>
        <Sparkles size={18} /><span>AI智能品牌优化方案</span><ChevronDown size={15} className={expanded ? "is-open" : ""} />
      </button>
      {expanded && !collapsed && <div className="operator-projects" aria-label="企业项目">
        <button className="operator-new-project" onClick={() => open("create")}><Plus size={15} />新建企业项目</button>
        {projects.map(project => <div className={`operator-project-row ${project.id === activeProject?.id ? "selected" : ""}`} key={project.id}>
          <button title={project.name} aria-current={project.id === activeProject?.id ? "page" : undefined} onClick={() => onSelectProject(project.id)}>{project.id === activeProject?.id ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{project.name}</span></button>
          {project.id === activeProject?.id && <button aria-label="重命名当前项目" title="重命名当前项目" onClick={() => open("rename")}><Settings2 size={13} /></button>}
        </div>)}
        {!projects.length && <p className="operator-project-hint">建立企业项目，开始整理品牌知识。</p>}
      </div>}
      <button className={`operator-nav-entry ${activeEntry === "agent" ? "active" : ""}`} title="FrontMind通用智能体" onClick={() => onNavigate("/agent")}><Bot size={18} /><span>FrontMind通用智能体</span></button>
      <button className={`operator-nav-entry ${activeEntry === "account" ? "active" : ""}`} title="账号与余额" onClick={() => onNavigate("/account")}><Wallet size={18} /><span>账号与余额</span></button>
      <div className="operator-sidebar-footer"><button onClick={onCollapse} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>收起侧边栏</span></button></div>
    </aside>
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value && !saving) setDialog(null); }}>
      <DialogContent className="operator-dialog" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
        <span className="operator-eyebrow">企业项目</span><DialogTitle>{dialog === "create" ? "新建企业项目" : "重命名企业项目"}</DialogTitle>
        <DialogDescription>每个项目独立保存知识库、优化问题与制作记录。</DialogDescription>
        <form onSubmit={submit}><label>项目名称<input autoFocus value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="输入企业或品牌名称" /></label>
          {error && <p role="alert" className="operator-form-error">{error}</p>}
          <button className="operator-primary-button" disabled={saving || !name.trim()}>{saving ? "正在保存…" : dialog === "create" ? "创建项目" : "保存名称"}</button>
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
    <div className="operator-workspace-caption"><span>AI智能品牌优化方案</span>{projectName && <><span aria-hidden="true">/</span><strong>{projectName}</strong></>}</div>
    <div className="operator-module-tabs" role="tablist" onKeyDown={moveTabFocus} aria-label="项目板块">
      {OPERATOR_MODULES.map((module, index) => <button key={module.id} type="button" role="tab" aria-selected={module.id === activeModule.id} className={module.id === activeModule.id ? "active" : ""} style={{ "--tab-color": module.color } as CSSProperties} onClick={() => onSelect(module.views[0].id)}><span className="operator-tab-number">0{index + 1}</span>{module.label}</button>)}
    </div>
    <div className="operator-sub-tabs" role="tablist" onKeyDown={moveTabFocus} aria-label={`${activeModule.label}功能`}>
      {activeModule.views.map(item => <button role="tab" aria-selected={item.id === selectedView} key={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}
      {selectedView === "knowledge" && <div className="operator-knowledge-tabs" role="group" aria-label="智能知识库视图"><button aria-pressed={view === "knowledge"} onClick={() => onSelect("knowledge")}>知识库智能体</button><button aria-pressed={view === "knowledge-display"} onClick={() => onSelect("knowledge-display")}>知识库展示</button></div>}
    </div>
  </header>;
}

export function OperatorEmptyProject({ onCreate }: { onCreate: () => void }) {
  return <section className="operator-empty-project"><span className="operator-empty-symbol"><Sparkles size={30} /></span><span className="operator-eyebrow">AI智能品牌优化方案</span><h1>从一个企业项目开始</h1><p>构建品牌知识、梳理优化问题，连接监控、内容制作与媒体发布。</p><button className="operator-primary-button" onClick={onCreate}><Plus size={17} />新建企业项目</button></section>;
}
