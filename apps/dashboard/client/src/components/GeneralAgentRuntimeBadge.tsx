import { useEffect, useState } from "react";
import { deliveryProjectHeaders } from "@/lib/delivery-project";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  if (!localTaskId)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="智能体推理档位"
            title="选择新会话的推理档位"
            disabled={runtime?.configured === false}
            className="general-runtime-trigger inline-flex h-11 items-center gap-1.5 rounded-lg border-0 bg-transparent px-3 text-xs font-medium text-[#303038] shadow-none outline-none hover:bg-[#f5f5f5] focus-visible:ring-2 focus-visible:ring-[#7545a0]/30 disabled:cursor-default"
          >
            <span>
              推理 ·{" "}
              {
                (
                  {
                    "frontmind-lite": "Low",
                    "frontmind-base": "High",
                    "frontmind-pro": "Max",
                  } as Record<string, string>
                )[selected]
              }
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="min-w-36 rounded-xl border-[#e4e4e8] bg-white p-1.5 shadow-lg"
        >
          <DropdownMenuRadioGroup value={selected} onValueChange={setSelected}>
            <DropdownMenuRadioItem value="frontmind-lite">
              Low
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="frontmind-base">
              High
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="frontmind-pro">
              Max
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
      className="inline-flex min-h-11 items-center rounded-lg border border-[#e4e4e8] bg-white px-3 py-1.5 text-xs font-medium text-[#525866]"
    >
      推理 · {label}
    </span>
  );
}
