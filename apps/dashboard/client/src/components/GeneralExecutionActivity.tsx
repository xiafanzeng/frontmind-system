import { useState } from "react";
import {
  Check,
  CheckCircle2,
  Brain,
  ChevronRight,
  Circle,
  FileText,
  Loader2,
  PauseCircle,
  PlugZap,
  Search,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import {
  generalExecutionStatusText,
  generalToolStatusText,
} from "@shared/frontmind-general-execution";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";

type ActivityItem = ExecutionDisplayEntry;

function formatClock(value: number | undefined) {
  // Fixtures and older records can use small sequence values instead of an
  // epoch. Do not render a misleading 1970 time for those records.
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1_000_000_000_000 ||
    Number.isNaN(new Date(value).getTime())
  )
    return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(start: number, end: number | undefined) {
  if (
    end === undefined ||
    !Number.isFinite(end) ||
    !Number.isFinite(start) ||
    end < start ||
    start < 1_000_000_000_000
  )
    return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 1) return "不到 1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function isLive(item: ActivityItem) {
  if (item.animate === false || item.isCurrent === false) return false;
  if (item.kind === "tool")
    return item.status === "running" && item.finishedAt === undefined;
  return ["thinking", "running", "rescheduling", "retrying"].includes(
    item.status,
  );
}

function isCurrentVisible(item: ActivityItem) {
  if (isLive(item)) return true;
  return item.status === "waiting" && item.isCurrent === true;
}

function activityStatusLabel(item: ActivityItem) {
  if (item.kind === "tool") {
    if (item.status === "running" && !isLive(item)) return "已记录执行";
    return generalToolStatusText[item.status];
  }
  const label = generalExecutionStatusText[item.status];
  if (isLive(item)) return label;
  if (item.status === "running") return "开始执行";
  if (item.status === "rescheduling") return "恢复执行";
  if (item.status === "retrying") return "重试执行";
  return label.replace(/^正在/, "").replace(/[.…]+$/, "");
}

function toolActionIcon(item: ActivityItem) {
  if (item.kind !== "tool") return Circle;
  if (item.toolKind === "mcp" || item.toolKind === "custom") return PlugZap;
  if (/搜索|检索|查找|浏览网页|读取网页/.test(item.label)) return Search;
  if (/命令|代码|执行/.test(item.label)) return Terminal;
  if (/文件|目录|写入|编辑|读取/.test(item.label)) return FileText;
  return Circle;
}

function isResultOnly(item: ActivityItem) {
  return item.kind === "tool" && item.resultOnly === true;
}

type ThinkingDetails = {
  thinkingText?: string;
  thinkingSource?: "event" | "stream";
  thinkingComplete?: boolean;
};

function thinkingDetails(item: ActivityItem): ThinkingDetails | null {
  if (item.kind !== "status" || item.status !== "thinking") return null;
  const candidate = item as ActivityItem & ThinkingDetails;
  return typeof candidate.thinkingText === "string" &&
    candidate.thinkingText.length > 0
    ? {
        thinkingText: candidate.thinkingText,
        thinkingSource: candidate.thinkingSource,
        thinkingComplete: candidate.thinkingComplete,
      }
    : null;
}

function isThinkingText(item: ActivityItem) {
  return Boolean(thinkingDetails(item));
}

function ThinkingBlock({ item }: { item: ActivityItem }) {
  const details = thinkingDetails(item);
  const [expanded, setExpanded] = useState(true);
  if (!details) return <ActivityLine item={item} />;
  const live = isLive(item);
  const clock = formatClock(item.timestamp);
  return (
    <section
      className="my-1.5 rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-2.5"
      aria-label="思考过程"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-[13px] font-medium text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label="思考过程"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Brain
          className={`h-3.5 w-3.5 shrink-0 text-primary ${live ? "animate-pulse motion-reduce:animate-none" : ""}`}
          aria-hidden
        />
        <span>思考过程</span>
        <span className="font-normal text-muted-foreground">
          {details.thinkingComplete === true
            ? "已完成"
            : live
              ? "思考中"
              : "过程记录"}
        </span>
        {clock && (
          <time
            className="ml-auto shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground/70"
            dateTime={new Date(item.timestamp).toISOString()}
          >
            {clock}
          </time>
        )}
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        />
      </button>
      {expanded && (
        <p className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/25 pl-3 text-[13px] leading-6 text-muted-foreground">
          {details.thinkingText}
        </p>
      )}
    </section>
  );
}

function ActivityLine({ item }: { item: ActivityItem }) {
  const spinning = isLive(item);
  const failed =
    item.kind === "tool" ? item.status === "failed" : item.status === "error";
  const waiting = item.status === "waiting";
  const Icon = spinning
    ? Loader2
    : failed
      ? TriangleAlert
      : waiting
        ? PauseCircle
        : item.kind === "tool" && item.status === "completed"
          ? Check
          : item.kind === "status" && item.status === "ended"
            ? CheckCircle2
            : Circle;
  const ActionIcon = toolActionIcon(item);
  const clock = formatClock(item.timestamp);
  const duration =
    item.kind === "tool"
      ? formatDuration(item.timestamp, item.finishedAt)
      : null;
  return (
    <div className="group flex min-w-0 items-center gap-2 py-1 text-[13px] leading-5 text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
        <Icon
          className={`h-3.5 w-3.5 ${
            spinning
              ? "animate-spin motion-reduce:animate-none text-primary"
              : failed
                ? "text-destructive"
                : waiting
                  ? "text-amber-600"
                  : item.kind === "status" && item.status === "ended"
                    ? "text-emerald-600"
                    : "text-muted-foreground/80"
          }`}
        />
        {item.kind === "tool" && (
          <ActionIcon className="h-3.5 w-3.5 text-muted-foreground/60" />
        )}
      </span>
      <span className="min-w-0 truncate">
        {item.kind === "tool"
          ? `${item.label} · ${activityStatusLabel(item)}`
          : activityStatusLabel(item)}
      </span>
      {(duration || clock) && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/70">
          {duration && <span>{duration}</span>}
          {duration && clock && <span aria-hidden>·</span>}
          {clock && (
            <time dateTime={new Date(item.timestamp).toISOString()}>
              {clock}
            </time>
          )}
        </span>
      )}
    </div>
  );
}

function ActivityGroup({
  items,
  expandedOverride,
  onToggle,
}: {
  items: ActivityItem[];
  expandedOverride?: boolean;
  onToggle?: () => void;
}) {
  const [localExpanded, setExpanded] = useState(false);
  const expanded = expandedOverride ?? localExpanded;
  if (items.length === 1)
    return isThinkingText(items[0]!) ? (
      <ThinkingBlock item={items[0]!} />
    ) : (
      <ActivityLine item={items[0]!} />
    );
  const active = [...items].reverse().find((item) => isCurrentVisible(item));
  const lastItem = items.at(-1);
  const currentTerminal =
    lastItem?.kind === "status" &&
    ["ended", "cancelled", "error"].includes(lastItem.status)
      ? lastItem
      : undefined;
  const currentSummary = active ?? currentTerminal;
  const completed = items.filter(
    (item) => item.kind === "tool" && item.status === "completed",
  ).length;
  const failed = items.filter(
    (item) => item.kind === "tool" && item.status === "failed",
  ).length;
  const toolCount = items.filter((item) => item.kind === "tool").length;
  return (
    <div>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-1.5 rounded-md py-1 text-left text-xs leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={expanded}
        onClick={() => (onToggle ? onToggle() : setExpanded((value) => !value))}
      >
        <ChevronRight
          aria-hidden
          className={`mt-1 h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-[13px] font-medium text-foreground/80">
            执行过程 · {items.length} 条记录
          </span>
          {toolCount > 0 && (
            <span>
              {toolCount} 次工具调用
              {completed > 0 ? ` · 完成 ${completed}` : ""}
              {failed > 0 && (
                <span className="text-destructive"> · 失败 {failed}</span>
              )}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="ml-1.5 border-l border-border/60 pl-3">
          {items.map((item) => (
            <div key={item.id}>
              {isThinkingText(item) ? (
                <ThinkingBlock item={item} />
              ) : (
                <ActivityLine item={item} />
              )}
            </div>
          ))}
        </div>
      )}
      {!expanded && currentSummary && (
        <div className="ml-4 border-l border-primary/30 pl-3">
          <ActivityLine item={currentSummary} />
        </div>
      )}
    </div>
  );
}

export function GeneralExecutionActivity({
  items,
  expandedGroups,
  onToggleGroup,
}: {
  items?: ActivityItem[];
  expandedGroups?: ReadonlySet<string>;
  onToggleGroup?: (id: string) => void;
}) {
  if (!items?.length) return null;
  const groups: ActivityItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (
      !isResultOnly(item) &&
      !isThinkingText(item) &&
      last &&
      !isResultOnly(last[last.length - 1]!) &&
      !isThinkingText(last[last.length - 1]!) &&
      last[0]?.turnId === item.turnId
    )
      last.push(item);
    else groups.push([item]);
  }
  return (
    <div
      className="-mt-4 mb-2 border-l border-border/60 pl-3 pt-2 first:mt-0"
      aria-label="执行过程"
    >
      {groups.map((group) => (
        <ActivityGroup
          key={group[0]!.id}
          items={group}
          expandedOverride={expandedGroups?.has(group[0]!.id)}
          onToggle={
            onToggleGroup ? () => onToggleGroup(group[0]!.id) : undefined
          }
        />
      ))}
    </div>
  );
}
