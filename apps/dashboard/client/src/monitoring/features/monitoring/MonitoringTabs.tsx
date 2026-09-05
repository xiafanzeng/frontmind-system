import type { KeyboardEvent } from "react";

import { MONITORING_TABS, type MonitoringTab } from "./types";

export default function MonitoringTabs({
  active,
  onChange,
}: {
  active: MonitoringTab;
  onChange: (tab: MonitoringTab) => void;
}) {
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (!tabs.length) return;
    event.preventDefault();
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length;
    tabs[next]?.click();
    tabs[next]?.focus();
  };

  return (
    <nav
      className="fm-tabs"
      aria-label="监控详情标签"
      role="tablist"
      onKeyDown={moveFocus}
    >
      {MONITORING_TABS.map((tab) => (
        <button
          key={tab.id}
          id={`monitor-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`monitor-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={active === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
