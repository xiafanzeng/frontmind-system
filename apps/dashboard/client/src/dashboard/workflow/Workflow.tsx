import { useId, type ReactNode } from "react";
import "./workflow.css";

export type WorkflowChoice = {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
};
export type WorkflowAnchor =
  | { kind: "initial" }
  | { kind: "message"; messageId: string }
  | { kind: "turn"; turnId: string };

/** Fixed business guidance is UI, never a fabricated assistant message. */
export function WorkflowQuestion({
  question,
  description,
  choices,
  selected,
  onSelect,
  children,
}: {
  question: string;
  description?: string;
  choices?: WorkflowChoice[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="workflow-question" aria-labelledby={id}>
      <h2 id={id}>{question}</h2>
      {description && <p>{description}</p>}
      {choices && (
        <div className="workflow-choices" role="group" aria-label={question}>
          {choices.map((choice) => (
            <button
              type="button"
              key={choice.id}
              aria-pressed={selected === choice.id}
              disabled={choice.disabled}
              onClick={() => onSelect?.(choice.id)}
            >
              <span>{choice.label}</span>
              {choice.description && <small>{choice.description}</small>}
            </button>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

export function WorkflowSection({
  id,
  title,
  description,
  children,
  action,
}: {
  id: string;
  title?: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className="workflow-section"
      data-reading-anchor={id}
      id={`workflow-${id}`}
    >
      {(title || action) && (
        <div className="workflow-section-heading">
          <h3>{title}</h3>
          {action}
        </div>
      )}
      {description && <p className="workflow-note">{description}</p>}
      {children}
    </section>
  );
}

export function WorkflowCompleted({
  id,
  summary,
  children,
  onRevise,
}: {
  id: string;
  summary: string;
  children?: ReactNode;
  onRevise?: () => void;
}) {
  return (
    <div className="workflow-completed" data-reading-anchor={id}>
      {children ? (
        <details>
          <summary>{summary}</summary>
          <div>{children}</div>
        </details>
      ) : (
        <p>{summary}</p>
      )}
      {onRevise && (
        <button
          type="button"
          className="workflow-text-action"
          onClick={onRevise}
        >
          返回修改
        </button>
      )}
    </div>
  );
}

export function WorkflowFeedback({
  error,
  children,
  onRetry,
}: {
  error?: boolean;
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      className="workflow-feedback"
      data-error={error || undefined}
      role={error ? "alert" : "status"}
    >
      <div>{children}</div>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function WorkflowPagination({
  page,
  total,
  pageSize = 10,
  onChange,
}: {
  page: number;
  total: number;
  pageSize?: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="workflow-pagination" aria-label="结果分页">
      <span>共 {total} 项</span>
      <button
        type="button"
        disabled={page <= 0}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </button>
      <span>
        {Math.min(page + 1, pages)} / {pages}
      </span>
      <button
        type="button"
        disabled={page + 1 >= pages}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}
