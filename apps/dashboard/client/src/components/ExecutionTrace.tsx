/**
 * Text-first execution details for assistant responses.
 *
 * The collapsed state is one model supplied summary for the whole turn. The
 * expanded state exposes every group and its original labels/details without
 * introducing synthetic phases or aggregate counts.
 */
import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import "./ExecutionTrace.css";
import type {
  StepGroup,
  IntermediateStep,
} from "@/contexts/ConversationContext";

function StepDetails({ step }: { step: IntermediateStep }) {
  return (
    <li className="min-w-0 py-1 text-[13px] leading-5 text-muted-foreground">
      <p className="break-words">{step.label}</p>
      {step.description && (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground/75">
          {step.description}
        </p>
      )}
      {step.details && step.details !== step.description && (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground/75">
          {step.details}
        </p>
      )}
    </li>
  );
}

function groupSummary(group: StepGroup) {
  const latest = group.steps.at(-1);
  return latest?.label && latest.label !== group.title
    ? `${group.title} · ${latest.label}`
    : group.title;
}

function StepGroupRow({
  group,
  isCurrent,
  initialExpanded = false,
}: {
  group: StepGroup;
  isCurrent: boolean;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const summary = groupSummary(group);
  return (
    <div className="execution-trace__group min-w-0 border-b border-border/35 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `收起${summary}` : `展开${summary}`}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "execution-trace__group-summary flex min-h-8 w-full min-w-0 items-center gap-2 py-1.5 text-left",
          "text-[13px] leading-5 text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {isCurrent && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            进行中
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/65 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="pb-2 pl-1">
          {group.description && (
            <p className="mb-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground/80">
              {group.description}
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {group.steps.map((step) => (
              <StepDetails key={step.id} step={step} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ExecutionTrace({
  stepGroups,
  isRunning,
}: {
  stepGroups: StepGroup[];
  isRunning?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!stepGroups?.length) return null;
  const lastGroup = stepGroups.at(-1)!;
  const summary = groupSummary(lastGroup);

  return (
    <section className="execution-trace" aria-label="执行过程">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "收起执行过程" : `展开执行过程：${summary}`}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "execution-trace__summary flex min-h-8 w-full min-w-0 items-center gap-2 py-1.5 text-left",
          "text-[13px] leading-5 text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {isRunning && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            进行中
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/65 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="pl-1">
          {stepGroups.map((group, index) => (
            <StepGroupRow
              key={group.id}
              group={group}
              isCurrent={Boolean(isRunning && index === stepGroups.length - 1)}
              initialExpanded
            />
          ))}
        </div>
      )}
    </section>
  );
}
