import { useRef, useState } from "react";
import { Check, Clock3, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { workbenchStatus } from "./agent-workbench";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
export type WorkbenchHistoryItem = {
  id: string;
  title: string;
  updatedAt: number;
  status?: string;
};
export function WorkbenchTaskToolbar({
  tasks,
  currentId,
  onNew,
  onSelect,
  onDelete,
  disabled = false,
  legacyTasks = [],
  presentation = "toolbar",
  loading = false,
  error,
  onRetry,
  onNavigate,
  showNew = true,
}: {
  tasks: WorkbenchHistoryItem[];
  currentId?: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  disabled?: boolean;
  legacyTasks?: WorkbenchHistoryItem[];
  presentation?: "toolbar" | "sidebar" | "panel";
  showNew?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [legacy, setLegacy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const shown = (legacy ? legacyTasks : tasks).filter((task) =>
    task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const newTaskButton = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() =>
        requestWorkspaceNavigation(() => {
          onNew();
          setQuery("");
          setLegacy(false);
          onNavigate?.();
        })
      }
    >
      <Plus size={15} />
      新任务
    </Button>
  );
  const historyContent = (
    <>
      <div className="workbench-conversation__history-heading">
        <span>任务历史</span>
        {legacyTasks.length > 0 && (
          <button type="button" onClick={() => setLegacy((value) => !value)}>
            {legacy ? "当前智能体" : "旧任务"}
          </button>
        )}
      </div>
      <label className="workbench-history-search">
        <Search size={15} />
        <input
          aria-label="搜索任务"
          placeholder="搜索任务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {loading && (
        <p role="status" className="workbench-conversation__history-empty">
          正在读取任务…
        </p>
      )}
      {error && (
        <div className="workbench-task-navigation__error" role="alert">
          <p>{error}</p>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              重新读取
            </button>
          )}
        </div>
      )}
      <div
        ref={list}
        role="listbox"
        aria-label="任务历史"
        className="workbench-history-list"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const buttons = Array.from(
            list.current?.querySelectorAll<HTMLButtonElement>(
              "button[data-task-select]",
            ) ?? [],
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(
                      buttons.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  )
          ]?.focus();
        }}
      >
        {shown.map((task) => (
          <div
            key={task.id}
            role="option"
            aria-selected={task.id === currentId}
            className="workbench-conversation__history-item"
          >
            <button
              type="button"
              data-task-select
              onClick={() =>
                requestWorkspaceNavigation(() => {
                  onSelect(task.id);
                  setOpen(false);
                  onNavigate?.();
                })
              }
            >
              <span className="workbench-conversation__history-copy">
                <strong>{task.title}</strong>
                <small>
                  {new Date(task.updatedAt).toLocaleString("zh-CN", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {task.status ? ` · ${workbenchStatus(task.status)}` : ""}
                </small>
              </span>
              {task.id === currentId && <Check size={15} />}
            </button>
            {onDelete && (
              <button
                type="button"
                className="workbench-conversation__history-delete"
                aria-label={`删除任务 ${task.title}`}
                onClick={() =>
                  requestWorkspaceNavigation(() => onDelete(task.id))
                }
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {!shown.length && !loading && !error && (
          <p className="workbench-conversation__history-empty">
            {query ? "没有匹配的任务" : "暂无任务历史"}
          </p>
        )}
      </div>
    </>
  );
  if (presentation !== "toolbar") {
    return (
      <section className="workbench-task-navigation" aria-label="智能体任务">
        {showNew && (
          <div className="workbench-task-navigation__new">{newTaskButton}</div>
        )}
        {historyContent}
      </section>
    );
  }
  return (
    <>
      {newTaskButton}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm">
            <Clock3 size={15} />
            历史
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="workbench-conversation__history-popover"
        >
          {historyContent}
        </PopoverContent>
      </Popover>
    </>
  );
}
