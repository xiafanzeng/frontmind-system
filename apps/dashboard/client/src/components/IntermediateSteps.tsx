/**
 * IntermediateSteps Component
 * Displays intermediate processing steps (search, browse, code, reasoning)
 * in collapsible groups, similar to a polished agent UI.
 */
import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Globe,
  Code2,
  PenTool,
  Brain,
  Wrench,
  ChevronDown,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  StepGroup,
  IntermediateStep,
} from "@/contexts/ConversationContext";
import { getStepIconType } from "@/contexts/ConversationContext";

/**
 * Get the icon component for a step type
 */
function StepIcon({ type, className }: { type: string; className?: string }) {
  const iconType = getStepIconType(type);
  const iconClass = cn("w-3.5 h-3.5", className);

  switch (iconType) {
    case "search":
      return <Search className={iconClass} />;
    case "browse":
      return <Globe className={iconClass} />;
    case "code":
      return <Code2 className={iconClass} />;
    case "write":
      return <PenTool className={iconClass} />;
    case "reasoning":
      return <Brain className={iconClass} />;
    case "tool":
    default:
      return <Wrench className={iconClass} />;
  }
}

/**
 * Get the color scheme for a step type
 */
function getStepColor(type: string): string {
  const iconType = getStepIconType(type);
  switch (iconType) {
    case "search":
      return "text-blue-500";
    case "browse":
      return "text-green-500";
    case "code":
      return "text-orange-500";
    case "write":
      return "text-purple-500";
    case "reasoning":
      return "text-amber-500";
    case "tool":
    default:
      return "text-slate-500";
  }
}

/**
 * Single step item display
 */
function StepItem({
  step,
  isLast,
}: {
  step: IntermediateStep;
  isLast?: boolean;
}) {
  const color = getStepColor(step.type);

  return (
    <div className="flex items-start gap-2.5 py-1.5 pl-2">
      <div className={cn("flex-shrink-0 mt-0.5", color)}>
        <StepIcon type={step.type} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground/80 leading-relaxed truncate">
          {step.label}
        </p>
        {step.description && (
          <p className="text-xs text-muted-foreground/50 mt-0.5 line-clamp-2">
            {step.description}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A collapsible group of intermediate steps
 */
function StepGroupItem({
  group,
  isCompleted,
}: {
  group: StepGroup;
  isCompleted: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Determine the primary icon type from the first step
  const primaryType = group.steps[0]?.type || "tool";
  const primaryColor = getStepColor(primaryType);

  return (
    <div className="relative">
      {/* Vertical connector line */}
      <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border/40" />

      {/* Group header - clickable to expand/collapse */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 w-full text-left py-1.5 group hover:bg-muted/30 rounded-lg transition-colors relative z-10"
      >
        {/* Status dot */}
        <div
          className={cn(
            "w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 border-2 bg-background",
            isCompleted ? "border-emerald-400" : "border-blue-400",
          )}
        >
          {isCompleted ? (
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
          ) : (
            <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
          )}
        </div>

        {/* Title */}
        <span className="text-xs font-medium text-foreground/70 flex-1 truncate">
          {group.title}
        </span>

        {/* Step count and chevron */}
        <div className="flex items-center gap-1.5 pr-1">
          <span className="text-xs text-muted-foreground/50">
            {group.steps.length}
          </span>
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 text-muted-foreground/40 transition-transform duration-200",
              isOpen && "rotate-180",
            )}
          />
        </div>
      </button>

      {/* Expandable step list */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="ml-[22px] pl-2 border-l border-border/30">
              {/* Description text if available */}
              {group.description && (
                <p className="text-xs text-muted-foreground/60 py-1.5 pl-2 leading-relaxed">
                  {group.description}
                </p>
              )}

              {/* Individual steps */}
              {group.steps.map((step, i) => (
                <StepItem
                  key={step.id}
                  step={step}
                  isLast={i === group.steps.length - 1}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Main IntermediateSteps component
 * Displays all step groups for a message
 */
export default function IntermediateSteps({
  stepGroups,
  isRunning,
}: {
  stepGroups: StepGroup[];
  isRunning?: boolean;
}) {
  if (!stepGroups || stepGroups.length === 0) return null;

  return (
    <div className="space-y-1 mb-2">
      {stepGroups.map((group, i) => (
        <StepGroupItem
          key={group.id}
          group={group}
          isCompleted={!isRunning || i < stepGroups.length - 1}
        />
      ))}
    </div>
  );
}
