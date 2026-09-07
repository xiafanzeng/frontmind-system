import { useEffect, useState } from "react";
import { deliveryProjectHeaders } from "@/lib/delivery-project";

type RuntimeConfig = {
  configured: boolean;
  source: "administrator" | "task";
  upstreamEffort?: "low" | "high" | "max";
  publicProfile?: "frontmind-lite" | "frontmind-base" | "frontmind-pro";
};

export default function GeneralAgentRuntimeBadge({
  localTaskId,
  purpose,
  onProfile,
}: {
  localTaskId?: string | null;
  purpose?: "enterprise_qa" | "content_production";
  onProfile: (profile: string) => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [selected, setSelected] = useState("frontmind-base");
  useEffect(() => {
    let disposed = false;
    let requestVersion = 0;
    setRuntime(null);
    const refresh = async () => {
      const version = ++requestVersion;
      try {
        const query = localTaskId
          ? `?localTaskId=${encodeURIComponent(localTaskId)}`
          : purpose
            ? `?purpose=${encodeURIComponent(purpose)}`
            : "";
        const response = await fetch(
          `/api/frontmind/v2/runtime-config${query}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            headers: deliveryProjectHeaders(),
          },
        );
        if (!response.ok) throw new Error("RUNTIME_CONFIG_UNAVAILABLE");
        const value: RuntimeConfig = await response.json();
        if (
          value.configured &&
          (!["low", "high", "max"].includes(value.upstreamEffort ?? "") ||
            !["frontmind-lite", "frontmind-base", "frontmind-pro"].includes(
              value.publicProfile ?? "",
            ))
        )
          throw new Error("RUNTIME_CONFIG_INVALID");
        if (disposed || version !== requestVersion) return;
        setRuntime(value);
        if (value.configured && value.publicProfile && (localTaskId || purpose))
          onProfile(value.publicProfile);
      } catch {
        if (!disposed && version === requestVersion) setRuntime(null);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [localTaskId, onProfile, purpose]);

  useEffect(() => {
    if (!localTaskId && !purpose) onProfile(selected);
  }, [localTaskId, purpose, selected, onProfile]);

  // Workflow tasks still freeze the administrator's configured runtime, but
  // only the account's general agent exposes model choices and effort labels.
  if (purpose) return null;

  if (!localTaskId) return (
    <select
      aria-label="智能体推理档位"
      title="选择新会话的推理档位"
      value={selected}
      disabled={runtime?.configured === false}
      onChange={(event) => setSelected(event.target.value)}
      className="rounded-xl border border-border bg-secondary/80 px-2 py-2 text-xs font-medium"
    >
      <option value="frontmind-lite">Low</option>
      <option value="frontmind-base">High</option>
      <option value="frontmind-pro">Max</option>
    </select>
  );

  const label = runtime?.upstreamEffort
    ? { low: "Low", high: "High", max: "Max" }[runtime.upstreamEffort]
    : runtime?.configured === false
      ? "待管理员配置"
      : "管理员配置";
  return (
    <span
      aria-label="智能体推理档位"
      title={
        localTaskId
          ? "当前任务沿用启动时的推理档位"
          : "新任务使用管理员设置的推理档位"
      }
      className="rounded-xl bg-secondary/80 px-2.5 py-2 text-xs font-medium text-muted-foreground"
    >
      {label}
    </span>
  );
}
