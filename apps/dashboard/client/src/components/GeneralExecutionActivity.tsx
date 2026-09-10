import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  generalExecutionActivity,
  generalExecutionStatusText,
  generalToolStatusText,
} from "@shared/frontmind-general-execution";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";
import "./GeneralExecutionActivity.css";

type ActivityItem = ExecutionDisplayEntry;

function isLive(item: ActivityItem) {
  if (item.animate === false || item.isCurrent === false) return false;
  if (item.kind === "tool")
    return item.status === "running" && item.finishedAt === undefined;
  return ["thinking", "running", "rescheduling", "retrying"].includes(
    item.status,
  );
}

function safeToolLabel(item: ActivityItem) {
  if (item.kind !== "tool") return "调用工具";
  // Keep the public label allowlist at the display boundary too. Historical
  // records must never turn a raw command/argument into a customer summary.
  const safe = generalExecutionActivity({
    kind: "tool_use",
    label: item.label,
    toolKind: item.toolKind,
  });
  return item.resultOnly
    ? "工具结果"
    : safe?.kind === "tool_use"
      ? safe.label
      : "调用工具";
}

function activityTitle(item: ActivityItem) {
  if (item.kind === "tool")
    return `${safeToolLabel(item)} · ${generalToolStatusText[item.status]}`;
  return generalExecutionStatusText[item.status];
}

function callSummary(calls: ActivityItem[], live: boolean) {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = safeToolLabel(call);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 1 && counts.has("执行命令"))
    return live ? `${calls.length} 个命令` : `执行了 ${calls.length} 个命令`;
  return [...counts]
    .map(([label, count]) =>
      label === "执行命令"
        ? `执行 ${count} 个命令`
        : `${label === "搜索网页" ? "搜索" : label === "调用工具" ? "工具操作" : label} ${count} 次`,
    )
    .join(" · ");
}

function thinkingText(item: ActivityItem) {
  return item.kind === "status" &&
    item.status === "thinking" &&
    item.publicSummary?.trim()
    ? item.publicSummary
    : null;
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
  const [localExpanded, setExpanded] = useState(true);
  const expanded = expandedOverride ?? localExpanded;
  const detailsId = useId();
  const text = thinkingText(item);
  if (!text || item.kind !== "status") return null;
  const live = isLive(item);
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
          {item.thinkingComplete === true
            ? "已完成"
            : live
              ? "思考中"
              : "过程记录"}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="general-execution__details">
          <p className="general-execution__thinking-text">{text}</p>
        </div>
      )}
    </section>
  );
}

function ActivityLine({
  children,
  live = false,
}: {
  children: React.ReactNode;
  live?: boolean;
}) {
  return (
    <div
      className="general-execution__line"
      data-live={live || undefined}
      aria-live={live ? "polite" : undefined}
    >
      <span className="general-execution__label">{children}</span>
    </div>
  );
}

function TurnActivity({
  items,
  expandedGroups,
  onToggleGroup,
}: {
  items: ActivityItem[];
  expandedGroups?: ReadonlySet<string>;
  onToggleGroup?: (id: string) => void;
}) {
  const calls = [
    ...new Map(
      items
        .filter((item) => item.kind === "tool" && !item.resultOnly)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const active = [...items].reverse().find(isLive);
  const start = items.find(
    (item) => item.kind === "status" && item.status === "running",
  );
  const lastLifecycle = items.findLast(
    (item) => item.kind === "status" && item.status !== "thinking",
  );
  const summaryId =
    calls[0]?.id ??
    start?.id ??
    (active && !thinkingText(active) ? active.id : undefined);
  return (
    <>
      {items.map((item) => {
        const summary =
          item.id === summaryId && (active || calls.length > 0) ? (
            <ActivityLine key="commands" live={Boolean(active)}>
              {active
                ? `${active.kind === "status" && active.status === "retrying" ? "正在重试…" : active.kind === "status" && active.status === "rescheduling" ? "正在恢复执行…" : active.kind === "status" && active.status === "thinking" && !calls.length ? "正在分析任务…" : "正在执行…"}${calls.length ? ` · ${callSummary(calls, true)}` : ""}`
                : callSummary(calls, false)}
            </ActivityLine>
          ) : null;
        let detail: React.ReactNode = null;
        if (thinkingText(item)) {
          detail = <ThinkingBlock item={item} />;
        } else if (item.kind === "tool") {
          if (
            item.resultOnly ||
            ["failed", "unconfirmed"].includes(item.status) ||
            (item.status === "waiting" && item.isCurrent !== false)
          )
            detail = <ActivityLine>{activityTitle(item)}</ActivityLine>;
        } else if (
          item.status === "error" ||
          item.status === "cancelled" ||
          (item.status === "waiting" && item.isCurrent !== false)
        ) {
          detail = (
            <ActivityLine>
              {item.status === "error" && lastLifecycle?.id !== item.id
                ? "过程记录：执行曾遇到问题"
                : activityTitle(item)}
            </ActivityLine>
          );
        }
        // Completed tool-free turns have no activity summary. Empty analysis
        // labels and terminal completion markers add no detail.
        // Only real call records contribute to the count; a lone result cannot
        // manufacture an earlier invocation.
        return summary || detail ? (
          <div key={item.id}>
            {summary}
            {detail}
          </div>
        ) : null;
      })}
    </>
  );
}

export function GeneralExecutionActivity({
  items,
  expandedGroups,
  onToggleGroup,
  placement = "before",
}: {
  items?: ActivityItem[];
  expandedGroups?: ReadonlySet<string>;
  onToggleGroup?: (id: string) => void;
  placement?: "before" | "after";
}) {
  if (
    !items?.some(
      (item) =>
        thinkingText(item) ||
        isLive(item) ||
        item.kind === "tool" ||
        ["error", "cancelled"].includes(item.status) ||
        (item.status === "waiting" && item.isCurrent !== false),
    )
  )
    return null;
  const groups: ActivityItem[][] = [];
  for (const item of new Map(
    items.map((item) => [JSON.stringify([item.turnId, item.id]), item]),
  ).values()) {
    const last = groups.at(-1);
    if (last?.[0]?.turnId === item.turnId) last.push(item);
    else groups.push([item]);
  }
  return (
    <div
      className="general-execution"
      aria-label="执行过程"
      data-placement={placement}
    >
      {groups.map((group) => (
        <TurnActivity
          key={group[0]!.id}
          items={group}
          expandedGroups={expandedGroups}
          onToggleGroup={onToggleGroup}
        />
      ))}
    </div>
  );
}
