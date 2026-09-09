import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  Bot,
  ChartNoAxesCombined,
  ChevronDown,
  Database,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PenLine,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Target,
  Trash2,
  Wallet,
  Wrench,
} from "lucide-react";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import {
  OPERATOR_MODULES,
  operatorViewPath,
  type OperatorView,
} from "./operator-navigation";
import "./operator-workspace.css";
import "./operator-navigation.css";

export type EnterpriseProjectView = {
  id: string;
  name: string;
  ownerUserId: number;
  revision: number;
  isLegacyDefault?: boolean;
};
type ProjectDialog = "create" | "rename" | "delete";
type ProjectDialogState = {
  kind: ProjectDialog;
  project?: EnterpriseProjectView;
  activeProjectId?: string;
};

export function OperatorSidebar({
  projects,
  activeProject,
  activeEntry,
  collapsed,
  onCollapse,
  onNavigate,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  mobileOpen = false,
  onCloseMobile,
  accountName,
  view,
  onSelectView,
  projectsLoading = false,
  projectsError,
  taskNavigation,
  taskNavigationRef,
}: {
  projects: EnterpriseProjectView[];
  projectsLoading?: boolean;
  projectsError?: string;
  taskNavigation?: ReactNode;
  taskNavigationRef?: Ref<HTMLDivElement>;
  activeProject?: EnterpriseProjectView;
  activeEntry: "project" | "agent" | "account";
  collapsed: boolean;
  onCollapse: () => void;
  onNavigate: (path: string) => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  accountName?: string;
  view?: OperatorView;
  onSelectView?: (view: OperatorView) => void;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (
    name: string,
    project: EnterpriseProjectView,
  ) => Promise<void>;
  onDeleteProject?: (project: EnterpriseProjectView) => Promise<void>;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [modulesExpanded, setModulesExpanded] = useState(true);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1279px)").matches,
  );
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1023px)").matches,
  );
  const [expanded, setExpanded] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const closeMobile = useRef(onCloseMobile);
  closeMobile.current = onCloseMobile;
  useEffect(() => {
    if (!mobileOpen || !isMobile || !sidebarRef.current) return;
    const sidebar = sidebarRef.current;
    const origin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const main = sidebar
      .closest(".app-shell")
      ?.querySelector<HTMLElement>("main");
    const originalInert = main?.inert;
    if (main) main.inert = true;
    const controls = () => {
      const items = [
        ...sidebar.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
        ),
      ];
      return items.filter((item) => {
        for (
          let node: HTMLElement | null = item;
          node && node !== sidebar;
          node = node.parentElement
        ) {
          const style = window.getComputedStyle(node);
          if (
            node.hidden ||
            node.inert ||
            node.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden"
          )
            return false;
        }
        return true;
      });
    };
    (
      sidebar.querySelector<HTMLButtonElement>(".operator-project-entry") ||
      controls()[0]
    )?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      // A Radix popup owns its own Escape and focus containment while open.
      if (
        document.querySelector(
          '[data-slot="dialog-content"], [data-slot="dropdown-menu-content"]',
        )
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (expanded) {
          setExpanded(false);
          setProjectQuery("");
        } else closeMobile.current?.();
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0],
        last = items.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !sidebar.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !sidebar.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (main) main.inert = originalInert ?? false;
      if (origin?.isConnected) origin.focus();
    };
  }, [mobileOpen, isMobile, expanded]);
  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !sidebarRef.current
          ?.querySelector(".operator-project-capsule")
          ?.contains(target)
      ) {
        setExpanded(false);
        setProjectQuery("");
      }
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [expanded]);
  const projectMenuTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const submitting = useRef(false);
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = useCallback(
    (
      kind: ProjectDialog,
      project = activeProject,
      trigger: HTMLElement | null = projectMenuTrigger.current,
    ) => {
      if (submitting.current) return;
      returnFocus.current = trigger;
      setDialog({
        kind,
        project: project ? { ...project } : undefined,
        activeProjectId: activeProject?.id,
      });
      setName(kind === "rename" ? project?.name || "" : "");
      setError("");
    },
    [activeProject],
  );
  useEffect(() => {
    const listener = () =>
      open(
        "create",
        undefined,
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      );
    window.addEventListener("operator-create-project", listener);
    return () =>
      window.removeEventListener("operator-create-project", listener);
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      submitting.current ||
      (dialog.kind !== "delete" && !name.trim())
    )
      return;
    const current = projects.find(
      (project) => project.id === dialog.project?.id,
    );
    if (
      dialog.kind !== "create" &&
      (dialog.activeProjectId !== activeProject?.id ||
        !current ||
        current.revision !== dialog.project?.revision)
    ) {
      setError("当前项目已切换或更新，请关闭弹窗后重新选择项目。");
      return;
    }
    if (dialog.kind === "delete" && !onDeleteProject) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      if (dialog.kind === "delete") await onDeleteProject!(dialog.project!);
      else if (dialog.kind === "rename")
        await onRenameProject(name.trim(), dialog.project!);
      else await onCreateProject(name.trim());
      setDialog(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : dialog.kind === "delete"
            ? "项目未能删除，请重试。"
            : "项目未能保存，请重试。",
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  const closeAutoFocus = (event: Event) => {
    event.preventDefault();
    const target = returnFocus.current?.isConnected
      ? returnFocus.current
      : projectMenuTrigger.current;
    target?.focus();
  };
  const selectedView = view === "knowledge-display" ? "knowledge" : view;
  const navigateView = (next: OperatorView) =>
    requestWorkspaceNavigation(() => {
      if (onSelectView) onSelectView(next);
      else onNavigate(projectWorkspaceUrl(operatorViewPath(next)));
      onCloseMobile?.();
    });
  const visibleProjects = projectQuery.trim()
    ? projects.filter((project) =>
        project.name
          .toLocaleLowerCase()
          .includes(projectQuery.trim().toLocaleLowerCase()),
      )
    : projects;
  return (
    <>
      <aside
        ref={sidebarRef}
        role={mobileOpen && isMobile ? "dialog" : undefined}
        aria-modal={mobileOpen && isMobile ? true : undefined}
        aria-hidden={isPhone && !mobileOpen ? true : undefined}
        inert={isPhone && !mobileOpen ? true : undefined}
        id="operator-project-navigation"
        className="global-nav operator-sidebar"
        aria-label="工作区导航"
        data-collapsed={collapsed}
        data-entry={activeEntry}
      >
        <div className="operator-brand">
          <div className="operator-brand-logo">
            <img src="/assets/frontmind-wordmark.svg" alt="FrontMind" />
          </div>
        </div>
        <nav className="operator-module-nav" aria-label="项目模块">
          <h2 className="operator-module-group-label">
            <button
              type="button"
              className="operator-module-group-toggle"
              aria-label="AI 智能品牌优化"
              aria-expanded={modulesExpanded}
              aria-controls="operator-brand-modules"
              onClick={() => setModulesExpanded((value) => !value)}
            >
              <span className="operator-brand-symbol" aria-hidden="true">
                <Sparkles size={20} />
              </span>
              <span>AI 智能品牌优化</span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={modulesExpanded ? "is-open" : ""}
              />
            </button>
          </h2>
          <div
            id="operator-brand-modules"
            className="operator-brand-modules"
            hidden={!modulesExpanded}
          >
            {OPERATOR_MODULES.map((module) => {
              const Icon = moduleIcons[module.id];
              const active =
                activeEntry === "project" &&
                module.views.some((item) => item.id === selectedView);
              return (
                <button
                  key={module.id}
                  type="button"
                  className={`operator-nav-entry operator-module-entry ${active ? "active" : ""}`}
                  style={{ "--module-accent": module.color } as CSSProperties}
                  title={module.label}
                  aria-label={module.label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => navigateView(module.views[0].id)}
                >
                  <Icon size={20} />
                  <span>{module.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={`operator-nav-entry operator-module-entry operator-general-entry ${activeEntry === "agent" ? "active" : ""}`}
              style={{ "--module-accent": "#491060" } as CSSProperties}
              title="通用智能体"
              aria-label="通用智能体"
              aria-current={activeEntry === "agent" ? "page" : undefined}
              onClick={() =>
                requestWorkspaceNavigation(() => {
                  onNavigate("/agent");
                  onCloseMobile?.();
                })
              }
            >
              <Bot size={20} />
              <span>通用智能体</span>
            </button>
          </div>
        </nav>
        <div className="operator-sidebar-bottom">
          <div
            className={`operator-project-group operator-project-capsule ${activeEntry === "project" ? "is-active" : ""}`}
          >
            <div className="operator-project-heading">
              <button
                type="button"
                className={`operator-nav-entry operator-project-entry ${activeEntry === "project" ? "active" : ""}`}
                title={`项目总览${activeProject ? ` · ${activeProject.name}` : ""}`}
                aria-label="项目总览"
                onClick={() => {
                  if (collapsed) onCollapse();
                  setExpanded(!expanded || collapsed);
                }}
                aria-expanded={expanded && !collapsed}
                aria-controls="operator-project-list"
              >
                <FolderOpen size={20} />
                <span className="operator-project-capsule-label">
                  <strong>项目总览</strong>
                  <small>{activeProject?.name || "选择企业项目"}</small>
                </span>
                <ChevronDown size={16} className={expanded ? "is-open" : ""} />
              </button>
              <button
                ref={projectMenuTrigger}
                type="button"
                className="operator-project-menu-trigger"
                aria-label="新建企业项目"
                title="新建企业项目"
                disabled={saving}
                onClick={() => open("create")}
              >
                <Plus size={18} />
              </button>
            </div>
            {expanded && !collapsed && (
              <div
                id="operator-project-list"
                className="operator-projects"
                aria-label="企业项目"
              >
                <div className="operator-projects-caption">
                  <span>企业项目</span>
                  <span>
                    {projectsLoading && !projects.length
                      ? "—"
                      : projects.length}
                  </span>
                </div>
                <label className="operator-project-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    aria-label="搜索项目"
                    value={projectQuery}
                    onChange={(event) => setProjectQuery(event.target.value)}
                    placeholder="搜索项目"
                  />
                </label>
                {visibleProjects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    selected={project.id === activeProject?.id}
                    saving={saving}
                    canDelete={Boolean(onDeleteProject)}
                    onSelect={() =>
                      requestWorkspaceNavigation(() => {
                        onSelectProject(project.id);
                        setExpanded(false);
                        setProjectQuery("");
                        onCloseMobile?.();
                      })
                    }
                    onAction={(kind, trigger) => open(kind, project, trigger)}
                    dialogOpen={Boolean(dialog)}
                  />
                ))}
                {!projects.length &&
                  (projectsLoading ? (
                    <p className="operator-project-hint" role="status">
                      正在读取企业项目…
                    </p>
                  ) : projectsError ? (
                    <p className="operator-project-hint" role="alert">
                      企业项目暂时无法读取
                    </p>
                  ) : (
                    <p className="operator-project-hint">
                      点击上方加号新建企业项目，开始整理品牌知识。
                    </p>
                  ))}
                {projects.length > 0 && !visibleProjects.length && (
                  <p className="operator-project-hint">没有匹配的项目。</p>
                )}
              </div>
            )}
          </div>
          <div
            className={`operator-account-row ${activeEntry === "account" ? "is-active" : ""}`}
          >
            <button
              type="button"
              className="operator-account-identity"
              title={accountName || "账号与余额"}
              aria-label={accountName || "账号与余额"}
              onClick={() =>
                requestWorkspaceNavigation(() => onNavigate("/account"))
              }
            >
              <span aria-hidden="true">
                {Array.from(accountName || "账")
                  .slice(0, 1)
                  .join("")}
              </span>
              <strong>{accountName || "账号"}</strong>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="operator-account-settings"
                  aria-label="账号设置"
                  title="账号设置"
                >
                  <Settings size={18} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={8}
                className="operator-account-menu"
              >
                <DropdownMenuLabel>{accountName || "账号"}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    requestWorkspaceNavigation(() => onNavigate("/account"))
                  }
                >
                  <Wallet />
                  账号与余额
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="operator-sidebar-footer">
            <button
              type="button"
              onClick={onCollapse}
              aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              {collapsed ? (
                <PanelLeftOpen size={20} />
              ) : (
                <PanelLeftClose size={20} />
              )}
              <span>收起侧边栏</span>
            </button>
          </div>
        </div>
      </aside>
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(value) => {
          if (!value && !submitting.current) setDialog(null);
        }}
      >
        <DialogContent
          className="operator-dialog"
          overlayClassName="operator-dialog-overlay"
          showCloseButton={!saving}
          onCloseAutoFocus={closeAutoFocus}
          onEscapeKeyDown={(event) => {
            if (submitting.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting.current) event.preventDefault();
          }}
        >
          <span
            className={`operator-dialog-symbol ${dialog?.kind === "delete" ? "is-destructive" : ""}`}
          >
            {dialog?.kind === "delete" ? (
              <Trash2 size={22} />
            ) : dialog?.kind === "rename" ? (
              <Pencil size={22} />
            ) : (
              <FolderOpen size={22} />
            )}
          </span>
          <div className="operator-dialog-heading">
            <DialogTitle>
              {dialog?.kind === "create"
                ? "新建企业项目"
                : dialog?.kind === "delete"
                  ? "删除企业项目"
                  : "重命名企业项目"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "delete"
                ? "删除后将无法从工作区进入此项目。请确认这是要删除的企业项目。"
                : "每个项目独立保存知识库、优化问题与制作记录。"}
            </DialogDescription>
          </div>
          <form onSubmit={submit}>
            {dialog?.kind === "delete" ? (
              <div className="operator-delete-project-name">
                <Folder size={18} />
                <strong>{dialog.project?.name}</strong>
              </div>
            ) : (
              <label>
                项目名称
                <input
                  autoFocus
                  disabled={saving}
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="输入企业或品牌名称"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="operator-form-error">
                {error}
              </p>
            )}
            <div className="operator-dialog-actions">
              <button
                type="button"
                className="operator-secondary-button"
                disabled={saving}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className={
                  dialog?.kind === "delete"
                    ? "operator-danger-button"
                    : "operator-primary-button"
                }
                disabled={
                  saving ||
                  (dialog?.kind === "delete" ? !onDeleteProject : !name.trim())
                }
              >
                {saving
                  ? dialog?.kind === "delete"
                    ? "正在删除…"
                    : "正在保存…"
                  : dialog?.kind === "create"
                    ? "创建项目"
                    : dialog?.kind === "delete"
                      ? "删除项目"
                      : "保存名称"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProjectRow({
  project,
  selected,
  saving,
  canDelete,
  onSelect,
  onAction,
  dialogOpen,
}: {
  project: EnterpriseProjectView;
  selected: boolean;
  saving: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onAction: (
    kind: "rename" | "delete",
    trigger: HTMLButtonElement | null,
  ) => void;
  dialogOpen: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className={`operator-project-row ${selected ? "selected" : ""}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="operator-project-select"
            title={project.name}
            aria-current={selected ? "page" : undefined}
            onClick={onSelect}
          >
            {selected ? <FolderOpen size={17} /> : <Folder size={17} />}
            <span>{project.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={8}
          className="max-w-[min(320px,calc(100vw-24px))] break-words"
        >
          {project.name}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="operator-project-row-menu"
            aria-label={`管理项目：${project.name}`}
            title={`管理项目：${project.name}`}
            disabled={saving}
          >
            <MoreHorizontal size={18} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="operator-project-menu"
          align="start"
          side="right"
          sideOffset={8}
          onCloseAutoFocus={(event) => {
            if (dialogOpen) event.preventDefault();
          }}
        >
          <DropdownMenuLabel className="operator-project-menu-current">
            {project.name}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => onAction("rename", trigger.current)}
          >
            <Pencil />
            重命名项目
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!canDelete}
            onSelect={() => onAction("delete", trigger.current)}
          >
            <Trash2 />
            删除项目
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const moduleIcons = {
  brand: Database,
  intent: Target,
  progress: ChartNoAxesCombined,
  content: PenLine,
  publishing: Send,
  extensions: Wrench,
};

export function OperatorTabs({
  view,
  projectName,
  onSelect: _onSelect,
}: {
  view: OperatorView;
  projectName?: string;
  onSelect?: (view: OperatorView) => void;
}) {
  const selectedView = view === "knowledge-display" ? "knowledge" : view;
  const activeModule =
    OPERATOR_MODULES.find((module) =>
      module.views.some((item) => item.id === selectedView),
    ) || OPERATOR_MODULES[0];
  return (
    <header
      className="operator-workspace-header"
      style={{ "--module-accent": activeModule.color } as CSSProperties}
    >
      <div className="operator-workspace-caption">
        <span>AI智能品牌优化</span>
        <span aria-hidden="true">/</span>
        <span>{activeModule.label}</span>
        {projectName && (
          <>
            <span aria-hidden="true">/</span>
            <strong title={projectName}>{projectName}</strong>
          </>
        )}
      </div>
    </header>
  );
}

export function OperatorEmptyProject({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="operator-empty-project">
      <span className="operator-empty-symbol">
        <FolderOpen size={30} />
      </span>
      <span className="operator-eyebrow">AI智能品牌优化</span>
      <h1>从一个企业项目开始</h1>
      <p>构建品牌知识、梳理优化问题，连接监控、内容制作与媒体发布。</p>
      <button
        type="button"
        className="operator-primary-button"
        onClick={onCreate}
      >
        <Plus size={18} />
        新建企业项目
      </button>
    </section>
  );
}
