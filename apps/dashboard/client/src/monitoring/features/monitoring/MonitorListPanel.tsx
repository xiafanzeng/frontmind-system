import {
  ChevronRight,
  Edit3,
  ListFilter,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RadioTower,
  Search,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { monitorStatusLabel, type MonitorSummary } from "../../domain";

type MonitorListPanelProps = {
  monitors: MonitorSummary[];
  selectedId?: string;
  deletedCount: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onOpenRecycle: () => void;
  onOpenDetails: (monitor: MonitorSummary) => void;
  onRun: (monitor: MonitorSummary) => void;
  onToggle: (monitor: MonitorSummary) => void;
  onDelete: (monitor: MonitorSummary) => void;
  onFilteredIdsChange?: (ids: string[]) => void;
};

function MonitorCard({
  monitor,
  selected,
  onSelect,
  onOpenDetails,
  onRun,
  onToggle,
  onDelete,
}: {
  monitor: MonitorSummary;
  selected: boolean;
  onSelect: () => void;
  onOpenDetails: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const progress = monitor.lastRun?.expected
    ? Math.round((monitor.lastRun.completed / monitor.lastRun.expected) * 100)
    : 0;

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (current - 1 + items.length) % items.length
            : (current + 1) % items.length;
    items[next]?.focus();
  };
  const invoke = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <article
      className={`fm-monitor-card ${selected ? "selected" : ""}`}
      aria-label={`${monitor.name}监控任务`}
    >
      <button
        type="button"
        className="fm-monitor-card-main"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="fm-monitor-card-heading">
          <strong>{monitor.name}</strong>
          <i
            className={`fm-monitor-dot ${monitor.status}`}
            aria-hidden="true"
          />
        </span>
        <span className={`fm-monitor-status ${monitor.status}`}>
          {monitorStatusLabel(monitor.status)}
        </span>
        <span className="fm-monitor-card-tags">
          <span>监控问题 {monitor.questionsCount} 个</span>
          <span>执行端 {monitor.platformsCount} 个</span>
        </span>
        <span className="fm-monitor-card-foot">
          <span>{monitor.scheduleLabel}</span>
          <span>{monitor.lastRun ? `最近运行 ${progress}%` : "尚未运行"}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </button>
      <div className="fm-monitor-menu" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="fm-icon-button icon-button"
          aria-label={`更多操作：${monitor.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={16} />
        </button>
        {open && (
          <div
            id={menuId}
            className="fm-menu-popover inline-popover"
            role="menu"
            aria-label={`${monitor.name}操作`}
            onKeyDown={moveFocus}
          >
            <button
              ref={firstItemRef}
              type="button"
              role="menuitem"
              onClick={() => invoke(onOpenDetails)}
            >
              <Edit3 size={14} /> 编辑监控
            </button>
            <button type="button" role="menuitem" onClick={() => invoke(onRun)}>
              <Play size={14} /> 立即运行
            </button>
            {monitor.status !== "draft" && (
              <button
                type="button"
                role="menuitem"
                onClick={() => invoke(onToggle)}
              >
                {monitor.status === "paused" ? (
                  <Play size={14} />
                ) : (
                  <Pause size={14} />
                )}
                {monitor.status === "paused" ? "恢复计划" : "暂停计划"}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => invoke(onDelete)}
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>
        )}
      </div>
      {Boolean(monitor.waitingQuotaOccurrences) && (
        <small className="fm-quota-note quota-waiting-note">
          {monitor.waitingQuotaOccurrences} 个历史执行点因余额不足待执行
        </small>
      )}
    </article>
  );
}

export default function MonitorListPanel({
  monitors,
  selectedId,
  deletedCount,
  collapsed,
  onCollapsedChange,
  onSelect,
  onAdd,
  onOpenRecycle,
  onOpenDetails,
  onRun,
  onToggle,
  onDelete,
  onFilteredIdsChange,
}: MonitorListPanelProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | MonitorSummary["status"]>("all");
  const [cadence, setCadence] = useState<"all" | "manual" | "daily" | "weekly">(
    "all",
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const filterId = useId();
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const filtered = useMemo(
    () =>
      monitors.filter((monitor) => {
        const cadenceMatches =
          cadence === "all" ||
          (cadence === "manual" && /手动|本次/u.test(monitor.scheduleLabel)) ||
          (cadence === "daily" && /每日/u.test(monitor.scheduleLabel)) ||
          (cadence === "weekly" && /每周/u.test(monitor.scheduleLabel));
        return (
          monitor.name.toLocaleLowerCase("zh-CN").includes(normalizedSearch) &&
          (status === "all" || monitor.status === status) &&
          cadenceMatches
        );
      }),
    [cadence, monitors, normalizedSearch, status],
  );
  const filteredIds = useMemo(
    () => filtered.map((monitor) => monitor.id),
    [filtered],
  );
  useEffect(
    () => onFilteredIdsChange?.(filteredIds),
    [filteredIds, onFilteredIdsChange],
  );
  const selected = monitors.find((monitor) => monitor.id === selectedId);

  if (collapsed) {
    return (
      <aside
        className="fm-monitor-list-panel fm-monitor-list-collapsed"
        aria-label="已折叠的监控列表"
      >
        <button
          type="button"
          className="fm-icon-button"
          aria-label="展开监控列表"
          onClick={() => onCollapsedChange(false)}
        >
          <PanelLeftOpen size={16} />
        </button>
        {selected && (
          <button
            type="button"
            className="fm-collapsed-selection"
            aria-label={`当前监控：${selected.name}`}
            title={selected.name}
            onClick={() => onCollapsedChange(false)}
          >
            <i className={`fm-monitor-dot ${selected.status}`} />
            <span>{selected.name.slice(0, 1)}</span>
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside className="fm-monitor-list-panel" aria-label="监控项目列表">
      <header className="fm-monitor-list-heading">
        <div>
          <h2>监控列表</h2>
          <span>({monitors.length})</span>
        </div>
        <div className="fm-list-heading-actions">
          <button
            type="button"
            className="fm-add-button"
            onClick={onAdd}
            aria-label="批量添加问题"
          >
            <Plus size={14} /> 添加
          </button>
          <button
            type="button"
            className="fm-icon-button"
            aria-label="折叠监控列表"
            onClick={() => onCollapsedChange(true)}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </header>
      <div className="fm-monitor-list-tools">
        <label className="fm-search search-box">
          <Search size={14} />
          <input
            aria-label="搜索监控"
            placeholder="搜索监控名称"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="fm-monitor-list-actions">
          <button
            type="button"
            className={`fm-icon-button icon-button ${filterOpen ? "active" : ""}`}
            onClick={() => setFilterOpen((value) => !value)}
            aria-label="筛选监控状态和周期"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? filterId : undefined}
          >
            <ListFilter size={15} />
          </button>
        </div>
      </div>
      {filterOpen && (
        <div
          id={filterId}
          className="fm-status-filter"
          aria-label="按状态与周期筛选"
        >
          <div role="group" aria-label="按状态筛选">
            <span>状态</span>
            {(
              [
                ["all", "全部"],
                ["active", "运行中"],
                ["paused", "已暂停"],
                ["draft", "待启动"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={status === value ? "active" : ""}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              disabled={!deletedCount}
              aria-label={
                deletedCount
                  ? `查看已删除监控（${deletedCount}）`
                  : "已删除监控为空"
              }
              onClick={onOpenRecycle}
            >
              已删除{deletedCount ? ` ${deletedCount}` : ""}
            </button>
          </div>
          <div role="group" aria-label="按周期筛选">
            <span>周期</span>
            {(
              [
                ["all", "全部"],
                ["manual", "手动"],
                ["daily", "每日"],
                ["weekly", "每周"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cadence === value ? "active" : ""}
                aria-pressed={cadence === value}
                onClick={() => setCadence(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="fm-monitor-list">
        {filtered.length ? (
          filtered.map((monitor) => (
            <MonitorCard
              key={monitor.id}
              monitor={monitor}
              selected={selectedId === monitor.id}
              onSelect={() => onSelect(monitor.id)}
              onOpenDetails={() => onOpenDetails(monitor)}
              onRun={() => onRun(monitor)}
              onToggle={() => onToggle(monitor)}
              onDelete={() => onDelete(monitor)}
            />
          ))
        ) : (
          <div className="fm-empty">
            <RadioTower size={24} />
            <strong>
              {monitors.length ? "没有匹配的监控" : "还没有问题监控"}
            </strong>
            <span>
              {monitors.length
                ? "请调整搜索词或状态、周期筛选。"
                : "添加问题与模型后开始采集。"}
            </span>
            {monitors.length > 0 && (
              <button
                type="button"
                className="fm-text-button"
                onClick={() => {
                  setSearch("");
                  setStatus("all");
                  setCadence("all");
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
