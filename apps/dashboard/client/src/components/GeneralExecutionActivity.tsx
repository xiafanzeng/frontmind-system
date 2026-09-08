import { useState } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import {
  generalExecutionStatusText,
  generalToolStatusText,
} from "@shared/frontmind-general-execution";
import type { ExecutionDisplayEntry } from "@/lib/general-execution-display";

function ActivityLine({ item }: { item: ExecutionDisplayEntry }) {
  const spinning =
    item.kind === "tool"
      ? item.status === "running"
      : ["thinking", "running", "rescheduling", "retrying"].includes(
          item.status,
        );
  const failed =
    item.kind === "tool" ? item.status === "failed" : item.status === "error";
  const Icon = spinning
    ? Loader2
    : failed
      ? TriangleAlert
      : item.kind === "tool" && item.status === "completed"
        ? Check
        : Circle;
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-xs leading-5 text-muted-foreground">
      <Icon
        aria-hidden
        className={`h-3 w-3 shrink-0 ${spinning ? "animate-spin" : ""}`}
      />
      <span>
        {item.kind === "tool"
          ? `${item.label} · ${generalToolStatusText[item.status]}`
          : generalExecutionStatusText[item.status]}
      </span>
    </div>
  );
}

function ActivityGroup({
  items,
  expandedOverride,
  onToggle,
}: {
  items: ExecutionDisplayEntry[];
  expandedOverride?: boolean;
  onToggle?: () => void;
}) {
  const [localExpanded, setExpanded] = useState(false);
  const expanded = expandedOverride ?? localExpanded;
  if (items.length === 1) return <ActivityLine item={items[0]!} />;
  const active = [...items]
    .reverse()
    .find((item) => item.kind === "tool" && item.status === "running");
  const completed = items.filter(
    (item) => item.kind === "tool" && item.status === "completed",
  ).length;
  const failed = items.filter(
    (item) => item.kind === "tool" && item.status === "failed",
  ).length;
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => (onToggle ? onToggle() : setExpanded((value) => !value))}
      >
        <ChevronRight
          aria-hidden
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span>
          {items.length} 项工具调用 · 已完成 {completed} · 失败 {failed}
          {active?.kind === "tool" ? ` · 正在${active.label}` : ""}
        </span>
      </button>
      {expanded && (
        <div className="ml-1.5 border-l border-border/60 pl-3">
          {items.map((item) => (
            <ActivityLine key={item.id} item={item} />
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
  items?: ExecutionDisplayEntry[];
  expandedGroups?: ReadonlySet<string>;
  onToggleGroup?: (id: string) => void;
}) {
  if (!items?.length) return null;
  const groups: ExecutionDisplayEntry[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (
      item.kind === "tool" &&
      !item.resultOnly &&
      last?.[0]?.kind === "tool" &&
      !last[0].resultOnly &&
      last[0].turnId === item.turnId
    )
      last.push(item);
    else groups.push([item]);
  }
  return (
    <div className="my-2 pl-1" aria-label="执行过程">
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
