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
        if (value.configured && value.publicProfile)
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
