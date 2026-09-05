import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Coins,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { isSystemAdminAccount } from "@/lib/admin-access";
import PortalShell from "@/components/PortalShell";
import { getAdminNav } from "@/pages/AdminDashboard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type CredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
};

const EMPTY_STATUS: CredentialStatus = {
  configured: false,
  fingerprint: null,
  status: null,
  version: null,
  verifiedAt: null,
  updatedAt: null,
};

export const DEFAULT_API_KEY_USAGE_LIMIT = 230_000;
export const DEFAULT_API_KEY_WARNING_RATIO = 0.8;

export function presalesUsageDisplayState(input: {
  complete: boolean;
  attributionComplete: boolean;
  keyTotalUsed: number;
  websiteUsed: number;
  limit: number;
}) {
  if (!input.complete) {
    return {
      keyTotalLabel: "—",
      websiteUsedLabel: "—",
      percentageLabel: "—",
      progressPercentage: 0,
    };
  }
  const percentage =
    Math.round((input.keyTotalUsed / Math.max(1, input.limit)) * 1000) / 10;
  return {
    keyTotalLabel: input.keyTotalUsed.toLocaleString(),
    websiteUsedLabel: input.attributionComplete
      ? input.websiteUsed.toLocaleString()
      : "—",
    percentageLabel: `${percentage}%`,
    progressPercentage: Math.min(100, percentage),
  };
}

export default function AdminPresales() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [allowIncompleteHistory, setAllowIncompleteHistory] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [policyLimit, setPolicyLimit] = useState(
    String(DEFAULT_API_KEY_USAGE_LIMIT),
  );
  const [policyWarningPercent, setPolicyWarningPercent] = useState(
    String(DEFAULT_API_KEY_WARNING_RATIO * 100),
  );
  const [policyWindowDays, setPolicyWindowDays] = useState("30");
  const utils = trpc.useUtils();

  const isAdmin = isSystemAdminAccount(user);
  const statusQuery = trpc.admin.presales.status.useQuery(undefined, {
    enabled: isAdmin,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const status = (statusQuery.data ?? EMPTY_STATUS) as CredentialStatus;
  const policyOverviewQuery = (
    trpc.admin as any
  ).apiKeyUsageAlerts.overview.useQuery(undefined, {
    enabled: isAdmin,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const websitePolicy = useMemo(() => {
    const items = Array.isArray(policyOverviewQuery.data?.items)
      ? policyOverviewQuery.data.items
      : [];
    return (
      items.find((item: any) => item?.scope === "website_frontend") ?? null
    );
  }, [policyOverviewQuery.data]);
  const usageWindowDays = 30;
  const usageQuery = trpc.admin.presales.usage.useQuery(
    { windowDays: usageWindowDays },
    {
      enabled: isAdmin && status.configured,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const setMutation = trpc.admin.presales.set.useMutation();
  const replaceMutation = trpc.admin.presales.replace.useMutation();
  const testMutation = trpc.admin.presales.test.useMutation();
  const deleteMutation = trpc.admin.presales.delete.useMutation();
  const updatePolicyMutation = (
    trpc.admin as any
  ).apiKeyUsageAlerts.updatePolicy.useMutation();
  const syncUsageMutation = (
    trpc.admin as any
  ).apiKeyUsageAlerts.sync.useMutation();
  const saving = setMutation.isPending || replaceMutation.isPending;

  const refreshAll = async () => {
    await utils.admin.presales.status.invalidate();
    await utils.admin.presales.usage.invalidate();
    await (utils.admin as any).apiKeyUsageAlerts.overview.invalidate();
  };

  useEffect(() => {
    setConnectionState("idle");
    setLatencyMs(null);
  }, [apiKey]);

  useEffect(() => {
    setAllowIncompleteHistory(false);
  }, [status.version]);

  useEffect(() => {
    if (!websitePolicy) return;
    setPolicyLimit(String(websitePolicy.limit));
    setPolicyWarningPercent(
      String(Math.round(Number(websitePolicy.warningRatio) * 100)),
    );
    setPolicyWindowDays("30");
  }, [websitePolicy]);

  const maskedFingerprint = useMemo(() => {
    if (!status.fingerprint) return "尚未配置";
    return `•••• ${status.fingerprint.slice(-8)}`;
  }, [status.fingerprint]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) {
      toast.error("请输入售前 API Key");
      return;
    }
    try {
      if (status.configured) {
        await replaceMutation.mutateAsync({
          apiKey: value,
          allowIncompleteHistory,
        });
      } else {
        await setMutation.mutateAsync({
          apiKey: value,
          allowIncompleteHistory,
        });
      }
      setApiKey("");
      setShowApiKey(false);
      setAllowIncompleteHistory(false);
      setConnectionState("success");
      await refreshAll();
      toast.success(
        status.configured ? "售前 API Key 已更换" : "售前 API Key 已启用",
        {
          description: "连接验证通过，API Key 已加密保存。",
        },
      );
    } catch (error) {
      setConnectionState("error");
      toast.error("无法保存售前 API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const handleTest = async () => {
    const value = apiKey.trim();
    if (!value && !status.configured) {
      toast.error("请先填写售前 API Key");
      return;
    }
    const startedAt = performance.now();
    setConnectionState("idle");
    try {
      await testMutation.mutateAsync({ apiKey: value || undefined });
      const latency = Math.max(1, Math.round(performance.now() - startedAt));
      setLatencyMs(latency);
      setConnectionState("success");
      toast.success("售前服务连接正常", { description: `${latency}ms` });
    } catch (error) {
      setLatencyMs(null);
      setAllowIncompleteHistory(false);
      setConnectionState("error");
      toast.error("连接测试失败", {
        description:
          error instanceof Error ? error.message : "请检查 API Key 后重试",
      });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      setDeleteOpen(false);
      setApiKey("");
      setConnectionState("idle");
      setLatencyMs(null);
      await refreshAll();
      toast.success("全部售前 API Key 已撤销");
    } catch (error) {
      toast.error("无法撤销售前 API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const handleSavePolicy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!websitePolicy?.id) {
      toast.error("官网前台 Key 的用量策略尚未就绪");
      return;
    }
    const limit = Number(policyLimit);
    const warningPercent = Number(policyWarningPercent);
    const windowDays = Number(policyWindowDays);
    if (!Number.isInteger(limit) || limit <= 0) {
      toast.error("积分上限必须是大于 0 的整数");
      return;
    }
    if (
      !Number.isFinite(warningPercent) ||
      warningPercent < 1 ||
      warningPercent > 100
    ) {
      toast.error("预警比例必须在 1% 到 100% 之间");
      return;
    }
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      toast.error("统计周期必须是 1 到 365 天");
      return;
    }
    try {
      await updatePolicyMutation.mutateAsync({
        policyId: websitePolicy.id,
        limit,
        warningRatio: warningPercent / 100,
        windowDays,
      });
      if (status.configured) {
        await syncUsageMutation.mutateAsync();
      }
      await refreshAll();
      toast.success("官网前台 Key 的积分策略已更新");
    } catch (error) {
      toast.error("积分策略更新失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  if (!isAdmin) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="text-xl font-semibold">没有访问权限</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              售前页面仅对管理员开放。
            </p>
            <Button
              className="mt-6"
              variant="outline"
              onClick={() => setLocation("/")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回工作空间
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const recentWebsiteTasks = usageQuery.data?.recentWebsiteTasks ?? [];
  const keyTotalUsed = usageQuery.data?.keyTotalUsed ?? 0;
  const websiteUsed = usageQuery.data?.websiteUsed ?? 0;
  const usageComplete = usageQuery.data?.complete !== false;
  const attributionComplete = usageQuery.data?.attributionComplete === true;
  const usageLimit = Math.max(
    1,
    Number(websitePolicy?.limit) || DEFAULT_API_KEY_USAGE_LIMIT,
  );
  const warningRatio = Math.min(
    1,
    Math.max(
      0,
      Number(websitePolicy?.warningRatio) || DEFAULT_API_KEY_WARNING_RATIO,
    ),
  );
  const usageDisplay = presalesUsageDisplayState({
    complete: usageComplete,
    attributionComplete,
    keyTotalUsed,
    websiteUsed,
    limit: usageLimit,
  });
  const usageTone = !usageComplete
    ? "unavailable"
    : keyTotalUsed >= usageLimit
      ? "critical"
      : keyTotalUsed >= usageLimit * warningRatio
        ? "warning"
        : "normal";

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="官网任务与积分"
      navItems={getAdminNav(true)}
      toolbar={
        <Button
          variant="outline"
          className="bg-card/80"
          disabled={statusQuery.isFetching || usageQuery.isFetching}
          onClick={() => void refreshAll()}
        >
          <RefreshCw
            className={`h-4 w-4 ${statusQuery.isFetching || usageQuery.isFetching ? "animate-spin" : ""}`}
          />
          刷新状态
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-6xl">
        <p className="mb-6 max-w-3xl text-sm leading-7 text-[#716a80]">
          管理官网 GEO 构建流程使用的专用前台 API Key，并核验连接、
          最近任务与真实积分消耗。密钥只在 Agent
          服务端加密保存；同一上游账号下的多个 Key 可能共享一个积分池。
        </p>

        {statusQuery.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <Skeleton className="h-[440px] rounded-2xl" />
            <Skeleton className="h-[440px] rounded-2xl" />
          </div>
        ) : statusQuery.error ? (
          <Card className="border-destructive/20 bg-card/85">
            <CardContent className="py-14 text-center">
              <ShieldAlert className="mx-auto mb-3 h-7 w-7 text-destructive" />
              <p className="font-medium">售前配置加载失败</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {statusQuery.error.message}
              </p>
              <Button
                className="mt-5"
                variant="outline"
                onClick={() => void statusQuery.refetch()}
              >
                重新加载
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <Card className="overflow-hidden border-border/70 bg-card/88 shadow-sm backdrop-blur-xl">
              <CardHeader className="border-b border-border/60 pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <KeyRound className="h-5 w-5 text-primary" />
                      官网前台 API Key
                    </CardTitle>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      与个人账号凭据分开配置，仅供官网服务端调用 Base
                      模型；上游积分池总额仍可能与同一账号下的其他 Key 共享。
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={
                      status.configured
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-border bg-muted/60 text-muted-foreground"
                    }
                  >
                    {status.configured ? (
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Activity className="mr-1 h-3.5 w-3.5" />
                    )}
                    {status.configured ? "运行就绪" : "等待配置"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-6 p-5 sm:p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <StatusTile label="凭据标识" value={maskedFingerprint} mono />
                  <StatusTile
                    label="凭据版本"
                    value={status.version ? `Version ${status.version}` : "—"}
                  />
                </div>

                <form className="space-y-4" onSubmit={handleSave}>
                  <div className="space-y-2">
                    <Label htmlFor="presales-api-key">
                      {status.configured
                        ? "输入新的售前 API Key"
                        : "官网前台 API Key"}
                    </Label>
                    <div className="relative">
                      <Input
                        id="presales-api-key"
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={
                          status.configured
                            ? "留空不会更改当前 API Key"
                            : "粘贴 FrontMind Website API Key"
                        }
                        autoComplete="off"
                        spellCheck={false}
                        disabled={saving || testMutation.isPending}
                        className="border-border/60 bg-muted/20 pr-11 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((value) => !value)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={
                          showApiKey ? "隐藏 API Key" : "显示 API Key"
                        }
                      >
                        {showApiKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      保存前会先验证连接；更换 API Key
                      后，新任务使用新版本，已有任务仍绑定原版本。
                    </p>
                  </div>

                  {status.configured && (
                    <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-xs leading-5 text-amber-950">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={allowIncompleteHistory}
                        onChange={(event) =>
                          setAllowIncompleteHistory(event.target.checked)
                        }
                        disabled={saving}
                      />
                      <span>
                        旧 Key
                        已失效时允许应急替换；未完整扫描的历史用量会显示为“不可用”，不会记为
                        0。
                      </span>
                    </label>
                  )}

                  {connectionState !== "idle" && (
                    <div
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                        connectionState === "success"
                          ? "border-emerald-200 bg-emerald-50/80 text-emerald-700"
                          : "border-red-200 bg-red-50/80 text-red-700"
                      }`}
                    >
                      {connectionState === "success" ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <ShieldAlert className="h-4 w-4" />
                      )}
                      {connectionState === "success"
                        ? `连接正常${latencyMs ? ` · ${latencyMs}ms` : ""}`
                        : "连接未通过，请检查 API Key。"}
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        saving ||
                        testMutation.isPending ||
                        (!apiKey.trim() && !status.configured)
                      }
                      onClick={() => void handleTest()}
                    >
                      {testMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Wifi className="h-4 w-4" />
                      )}
                      测试连接
                    </Button>
                    <Button
                      type="submit"
                      disabled={
                        saving || testMutation.isPending || !apiKey.trim()
                      }
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}
                      {status.configured ? "验证并更换" : "验证并启用"}
                    </Button>
                  </div>
                </form>

                {status.status !== null && (
                  <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-5">
                    <div>
                      <p className="text-sm font-medium">撤销官网前台连接</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        撤销当前及全部历史版本，已有任务和文件也将无法查询。
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      撤销全部 API Key
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-border/70 bg-card/88 shadow-sm backdrop-blur-xl">
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Coins className="h-5 w-5 text-primary" />近 {usageWindowDays}{" "}
                  天积分使用
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  统计当前凭据所属上游积分池的全部消耗，并单独归因官网任务用量。
                </p>
              </CardHeader>
              <CardContent className="p-5 sm:p-6">
                {!status.configured ? (
                  <div className="flex min-h-64 flex-col items-center justify-center text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <Coins className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-medium">尚无可用统计</p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                      验证并启用售前 API Key 后，这里会显示积分消耗和最近任务。
                    </p>
                  </div>
                ) : usageQuery.isLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-24 rounded-xl" />
                    {[0, 1, 2].map((item) => (
                      <Skeleton key={item} className="h-11 rounded-lg" />
                    ))}
                  </div>
                ) : usageQuery.error ? (
                  <div className="py-12 text-center">
                    <ShieldAlert className="mx-auto mb-3 h-6 w-6 text-destructive" />
                    <p className="text-sm font-medium">积分记录读取失败</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {usageQuery.error.message}
                    </p>
                    <Button
                      className="mt-4"
                      size="sm"
                      variant="outline"
                      onClick={() => void usageQuery.refetch()}
                    >
                      重新读取
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {!usageComplete && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        历史 Key 或任务分页未能完整读取。近 30
                        天总量与百分比已隐藏，避免把部分结果误认为准确用量。
                      </div>
                    )}
                    {usageComplete && !attributionComplete && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        上游积分池总额与百分比已完整读取，但历史任务未能全部归因到官网。官网任务用量已隐藏，避免把部分结果误认为准确值。
                      </div>
                    )}
                    <div
                      className={`rounded-2xl border p-5 ${
                        usageTone === "critical"
                          ? "border-red-200 bg-red-50/70"
                          : usageTone === "warning"
                            ? "border-amber-200 bg-amber-50/70"
                            : usageTone === "unavailable"
                              ? "border-slate-200 bg-slate-50/80"
                              : "border-primary/10 bg-primary/[0.055]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="fm-eyebrow text-muted-foreground">
                          上游积分池近 30 天总使用 / 上限
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            usageTone === "critical"
                              ? "border-red-200 bg-white text-red-700"
                              : usageTone === "warning"
                                ? "border-amber-200 bg-white text-amber-700"
                                : usageTone === "unavailable"
                                  ? "border-slate-300 bg-white text-slate-700"
                                  : "border-emerald-200 bg-white text-emerald-700"
                          }
                        >
                          {usageTone === "critical"
                            ? "严重预警"
                            : usageTone === "warning"
                              ? "用量预警"
                              : usageTone === "unavailable"
                                ? "统计不完整"
                                : "用量正常"}
                        </Badge>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-3">
                        <p className="text-3xl font-semibold tracking-tight text-primary">
                          {usageDisplay.keyTotalLabel}
                          <span className="ml-1 text-sm font-normal text-muted-foreground">
                            / {usageLimit.toLocaleString()}
                          </span>
                        </p>
                        <span className="pb-1 text-sm text-muted-foreground">
                          {usageDisplay.percentageLabel}
                        </span>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                        <div
                          className={`h-full rounded-full ${
                            usageTone === "critical"
                              ? "bg-red-600"
                              : usageTone === "warning"
                                ? "bg-amber-500"
                                : "bg-primary"
                          }`}
                          style={{
                            width: `${usageDisplay.progressPercentage}%`,
                          }}
                        />
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-background/55 px-4 py-3">
                      <p className="text-xs text-muted-foreground">
                        其中官网前台任务使用
                      </p>
                      <p className="mt-1 text-2xl font-semibold text-foreground">
                        {usageDisplay.websiteUsedLabel}
                      </p>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-medium text-muted-foreground">
                          最近官网任务
                        </p>
                        <Badge variant="outline" className="font-mono text-xs">
                          {recentWebsiteTasks.length} 条
                        </Badge>
                      </div>
                      {recentWebsiteTasks.length > 0 ? (
                        <div className="custom-scrollbar max-h-[260px] divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60 bg-background/55 px-3">
                          {recentWebsiteTasks.map((task) => (
                            <div
                              key={task.id}
                              className="flex min-w-0 items-center gap-3 py-3"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium">
                                  {task.title || "未命名任务"}
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {task.createdAt
                                    ? new Date(
                                        task.createdAt,
                                      ).toLocaleDateString("zh-CN")
                                    : task.id.slice(0, 16)}
                                </p>
                              </div>
                              <span className="shrink-0 font-mono text-xs text-primary">
                                {task.creditUsage}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                          最近 {usageWindowDays} 天暂无官网任务积分消耗
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {websitePolicy && (
                  <form
                    className="mt-6 space-y-4 border-t border-border/60 pt-5"
                    onSubmit={handleSavePolicy}
                  >
                    <div>
                      <p className="text-sm font-medium">积分预警策略</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        预警基于官网凭据所属的上游积分池总额；默认上限
                        230,000，达到 80% 时预警。
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="website-credit-limit">积分上限</Label>
                        <Input
                          id="website-credit-limit"
                          inputMode="numeric"
                          value={policyLimit}
                          onChange={(event) =>
                            setPolicyLimit(event.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="website-warning-ratio">
                          预警比例（%）
                        </Label>
                        <Input
                          id="website-warning-ratio"
                          inputMode="decimal"
                          value={policyWarningPercent}
                          onChange={(event) =>
                            setPolicyWarningPercent(event.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="website-window-days">
                          滚动周期（天）
                        </Label>
                        <Input
                          id="website-window-days"
                          inputMode="numeric"
                          value={policyWindowDays}
                          readOnly
                          disabled
                        />
                        <p className="text-xs text-muted-foreground">
                          正式用量口径固定为精确滚动 30 天。
                        </p>
                      </div>
                    </div>
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={
                        updatePolicyMutation.isPending ||
                        syncUsageMutation.isPending
                      }
                    >
                      {(updatePolicyMutation.isPending ||
                        syncUsageMutation.isPending) && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      保存积分策略
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销全部售前 API Key？</AlertDialogTitle>
            <AlertDialogDescription>
              当前及全部历史凭据版本都会被立即撤销并安全覆盖。官网将无法继续创建任务，已有任务和文件也无法再查询；此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认全部撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PortalShell>
  );
}

function StatusTile({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={`mt-1.5 truncate text-sm font-medium ${mono ? "font-mono" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
