import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  generalExecutionStatusText,
  generalToolStatusText,
} from "@shared/frontmind-general-execution";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";
import "./GeneralExecutionActivity.css";

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

function activityTitle(item: ActivityItem) {
  return item.kind === "tool"
    ? `${item.label} · ${activityStatusLabel(item)}`
    : activityStatusLabel(item);
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

function ThinkingBlock({
  item,
  expandedOverride,
  onToggle,
}: {
  item: ActivityItem;
  expandedOverride?: boolean;
  onToggle?: () => void;
}) {
  const details = thinkingDetails(item);
  const [localExpanded, setExpanded] = useState(false);
  const expanded = expandedOverride ?? localExpanded;
  const detailsId = useId();
  if (!details) return <ActivityLine item={item} />;
  const live = isLive(item);
  const clock = formatClock(item.timestamp);
  return (
    <section className="general-execution__thinking" aria-label="思考过程">
      <button
        type="button"
        className="general-execution__toggle"
        aria-label="思考过程"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => (onToggle ? onToggle() : setExpanded((value) => !value))}
      >
        <ChevronRight
          className="general-execution__chevron"
          aria-hidden="true"
        />
        <span className="general-execution__summary">思考过程</span>
        <span
          className="general-execution__metadata"
          aria-live={live ? "polite" : undefined}
        >
          {details.thinkingComplete === true
            ? "已完成"
            : live
              ? "思考中"
              : "过程记录"}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="general-execution__details">
          {clock && (
            <time
              className="general-execution__metadata"
              dateTime={new Date(item.timestamp).toISOString()}
            >
              {clock}
            </time>
          )}
          <p className="general-execution__thinking-text">
            {details.thinkingText}
          </p>
        </div>
      )}
    </section>
  );
}

function ActivityLine({ item }: { item: ActivityItem }) {
  const clock = formatClock(item.timestamp);
  const duration =
    item.kind === "tool"
      ? formatDuration(item.timestamp, item.finishedAt)
      : null;
  return (
    <div
      className="general-execution__line"
      data-live={isLive(item) || undefined}
    >
      <span className="general-execution__label">{activityTitle(item)}</span>
      {(duration || clock) && (
        <span className="general-execution__metadata">
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
  const detailsId = useId();
  if (items.length === 1)
    return isThinkingText(items[0]!) ? (
      <ThinkingBlock
        item={items[0]!}
        expandedOverride={expandedOverride}
        onToggle={onToggle}
      />
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
  // Only observed activity can describe the stage. A historical error remains
  // in details when a later successful terminal event supersedes it.
  const currentSummary = active ?? currentTerminal ?? lastItem!;
  const summary = activityTitle(currentSummary);
  return (
    <div className="general-execution__group">
      <button
        type="button"
        className="general-execution__toggle"
        aria-label={`执行过程：${summary}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => (onToggle ? onToggle() : setExpanded((value) => !value))}
      >
        <ChevronRight
          aria-hidden="true"
          className="general-execution__chevron"
        />
        <span
          className="general-execution__summary"
          aria-live={active ? "polite" : undefined}
        >
          {summary}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="general-execution__details">
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
    <div className="general-execution" aria-label="执行过程">
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
