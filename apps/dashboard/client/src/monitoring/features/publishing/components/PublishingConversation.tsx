import { useRef, useState, type ReactNode } from "react";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import { usePublishingFlow } from "../PublishingFlowContext";
import {
  WorkflowQuestion,
  WorkflowSection,
  WorkflowCompleted,
} from "@/dashboard/workflow/Workflow";

/** UI choices remain scoped to the selected task and never trigger a paid action. */
export function usePublishingChoice(key: string, initial = "") {
  const flow = usePublishingFlow();
  const prefix = `${flow?.scopeKey ?? projectWorkspaceUrl("/")}:${flow?.agentId ?? "standalone"}`;
  const scope = `${prefix}:${flow?.taskId ?? "new"}`;
  const [local, setLocal] = useState<{ scope: string; value: string }>();
  const value =
    local?.scope === scope ||
    (flow?.pending && local?.scope === `${prefix}:new`)
      ? local.value
      : typeof flow?.selections?.[key] === "string"
        ? String(flow.selections[key])
        : initial;
  const current = useRef({ flow, scope });
  current.current = { flow, scope };
  const choose = (next: string) => {
    const owner = current.current;
    setLocal({ scope: owner.scope, value: next });
    void owner.flow?.saveValues?.({ [key]: next }).catch(() => undefined);
  };
  const acceptSaved = (next: string) => {
    if (current.current.scope !== scope) return;
    setLocal({ scope, value: next });
  };
  return [value, choose, acceptSaved] as const;
}

export function PublishingQuestion({
  title,
  description,
  value,
  choices,
  onChoose,
}: {
  title: string;
  description?: string;
  value: string;
  choices: Array<{
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }>;
  onChoose: (value: string) => void;
}) {
  if (value)
    return (
      <WorkflowCompleted
        id={`choice-${value}`}
        summary={`当前工作：${choices.find((choice) => choice.value === value)?.label ?? value}`}
        onRevise={() => onChoose("")}
      />
    );
  return (
    <WorkflowQuestion
      question={title}
      description={description}
      selected={value}
      onSelect={onChoose}
      choices={choices.map(({ value: id, ...choice }) => ({ id, ...choice }))}
    />
  );
}

export function PublishingStep({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <WorkflowSection id={id ?? title} title={title}>
      {children}
    </WorkflowSection>
  );
}
