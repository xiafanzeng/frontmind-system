import { useEffect, useState } from "react";
import {
  Activity,
  Database,
  FileClock,
  Gauge,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import PortalShell, {
  PortalCard,
  type PortalNavItem,
} from "@/components/PortalShell";

type Readiness = "checking" | "ready" | "unavailable";

const navItems: PortalNavItem[] = [
  { label: "监控总览", href: "/admin/monitoring", icon: Gauge, group: "监控运维" },
  { label: "账户与模型", href: "/admin/monitoring/accounts", icon: Database, group: "监控运维" },
  { label: "运行与队列", href: "/admin/monitoring/operations", icon: Activity, group: "监控运维" },
  { label: "审计日志", href: "/admin/monitoring/audit-log", icon: FileClock, group: "监控运维" },
  { label: "Worker 状态", href: "/admin/monitoring/worker", icon: ServerCog, group: "监控运维" },
];

export default function AdminMonitoring() {
  const [readiness, setReadiness] = useState<Readiness>("checking");

  useEffect(() => {
    let cancelled = false;
    void fetch("/readyz", { credentials: "same-origin" })
      .then((response) => {
        if (!cancelled) setReadiness(response.ok ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) setReadiness("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const readinessLabel =
    readiness === "checking"
      ? "检查中"
      : readiness === "ready"
        ? "服务就绪"
        : "暂不可用";

  return (
    <PortalShell
      eyebrow="FrontMind System / 系统管理员"
      title="问题监控运维"
      navItems={navItems}
      accountLabel="系统管理员"
      roleLabel="监控系统管理员"
    >
      <div className="grid gap-5 lg:grid-cols-3">
        <PortalCard className="p-5 lg:col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#765494]">
                Unified monitoring host
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[#251e2d]">
                Dashboard 已接管监控系统入口
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#716a80]">
                客户端使用 Dashboard 会话，监控 Worker 在服务端执行 Provider 调度；本页是系统管理员的统一运维入口。
              </p>
            </div>
            <ShieldCheck className="h-8 w-8 shrink-0 text-[#5b2a86]" />
          </div>
        </PortalCard>
        <PortalCard className="p-5">
          <p className="text-sm text-[#716a80]">API / 数据库状态</p>
          <p className="mt-2 text-2xl font-semibold text-[#251e2d]">{readinessLabel}</p>
          <p className="mt-2 text-xs text-[#8b8297]">通过统一 /readyz 检查</p>
        </PortalCard>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["账户与模型", "查看监控账户映射、平台目录和模型配置。", "/admin/monitoring/accounts"],
          ["运行与队列", "查看运行、attempt、失败重试和待处理任务。", "/admin/monitoring/operations"],
          ["Provider 成本", "查看服务端成本与结算，不向客户暴露。", "/admin/monitoring/provider-costs"],
          ["Worker 心跳", "查看调度器、轮询器和归档任务的健康状态。", "/admin/monitoring/worker"],
        ].map(([title, description, href]) => (
          <a key={href} href={href} className="block">
            <PortalCard className="h-full p-5 transition hover:-translate-y-0.5 hover:shadow-[0_22px_54px_rgba(33,19,58,.12)]">
              <h3 className="font-semibold text-[#30253b]">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#716a80]">{description}</p>
            </PortalCard>
          </a>
        ))}
      </div>
    </PortalShell>
  );
}
