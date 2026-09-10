import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import type { WorkbenchModuleId } from "./agent-workbench";
import { OPERATOR_MODULES } from "./operator-navigation";
import "./operator-action-list.css";

export type OperatorActionItem = {
  id: string;
  title: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
};
export type OperatorActionListProps = {
  module: WorkbenchModuleId;
  items: OperatorActionItem[];
  selectedId?: string;
  pendingId?: string;
  onSelect: (id: string) => void;
};

/** Presentation only: each row is one keyboard-accessible business entry. */
export function OperatorActionList({
  module,
  items,
  selectedId,
  pendingId,
  onSelect,
}: OperatorActionListProps) {
  const color =
    OPERATOR_MODULES.find((item) => item.id === module)?.color ?? "#491060";
  return (
    <div
      className="operator-action-list"
      style={{ "--module-color": color } as CSSProperties}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className="operator-action-row"
          aria-pressed={selectedId === item.id}
          aria-busy={pendingId === item.id || undefined}
          disabled={item.disabled || Boolean(pendingId)}
          onClick={() => onSelect(item.id)}
        >
          <span className="operator-action-number" aria-hidden="true">
            {index + 1}
          </span>
          <span className="operator-action-copy">
            <span className="operator-action-title">
              {item.title}
              {item.badge && (
                <span className="operator-action-badge">{item.badge}</span>
              )}
            </span>
            {item.description && (
              <span className="operator-action-description">
                {item.description}
              </span>
            )}
            {item.disabled && item.disabledReason && (
              <span className="operator-action-description">
                {item.disabledReason}
              </span>
            )}
            {pendingId === item.id && (
              <span className="operator-action-description" role="status">
                处理中…
              </span>
            )}
          </span>
          <span className="operator-action-arrow" aria-hidden="true">
            <ArrowRight size={20} />
          </span>
        </button>
      ))}
    </div>
  );
}
