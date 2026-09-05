import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Coins,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { formatWebsiteUsageTaskDate } from "@/lib/website-usage-task-date";
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

type TwentyFirstCredentialStatus = CredentialStatus & {
  revocationPending: boolean;
  nativeVisualReadiness:
    | "ready"
    | "missing_get_component"
    | "source_contract_incompatible"
    | "usage_unavailable"
    | "unverified";
  nativeTemplateReadiness:
    | "ready"
    | "plan_ineligible"
    | "catalog_unavailable"
    | "download_unavailable"
    | "compiler_unavailable"
    | "unverified";
  capabilities: {
    search: boolean;
    getComponent: boolean;
    getUsage: boolean | null;
    getTheme: boolean | null;
  };
};

type AliyunOAuthConfigurationIssue =
  | "application_id_is_secret_id"
  | "invalid_application_id"
  | "callback_mismatch";

type AliyunPlatformStatus = {
  ready: boolean;
  oauth: CredentialStatus & {
    callbackUrl: string | null;
    applicationIdTail: string | null;
    usableForAuthorization?: boolean;
    requiresReplacement?: boolean;
    configurationIssue?: AliyunOAuthConfigurationIssue | null;
  };
};

const EMPTY_STATUS: CredentialStatus = {
  configured: false,
  fingerprint: null,
  status: null,
  version: null,
  verifiedAt: null,
  updatedAt: null,
};

const EMPTY_TWENTY_FIRST_STATUS: TwentyFirstCredentialStatus = {
  ...EMPTY_STATUS,
  revocationPending: false,
  nativeVisualReadiness: "unverified",
  nativeTemplateReadiness: "unverified",
  capabilities: {
    search: false,
    getComponent: false,
    getUsage: null,
    getTheme: null,
  },
};

const EMPTY_ALIYUN_STATUS: AliyunPlatformStatus = {
  ready: false,
  oauth: {
    ...EMPTY_STATUS,
    callbackUrl: null,
    applicationIdTail: null,
    usableForAuthorization: false,
    requiresReplacement: false,
    configurationIssue: null,
  },
};

export const DEFAULT_API_KEY_USAGE_LIMIT = 230_000;
export const DEFAULT_API_KEY_WARNING_RATIO = 0.8;

export function aliyunOAuthConfigurationDisplayState(input: {
  configured: boolean;
  applicationIdTail?: string | null;
  usableForAuthorization?: boolean;
  requiresReplacement?: boolean;
  configurationIssue?: AliyunOAuthConfigurationIssue | null;
}) {
  return {
    configurationIssue: input.configurationIssue ?? null,
    requiresReplacement: input.requiresReplacement ?? false,
    usableForAuthorization: input.usableForAuthorization ?? input.configured,
  };
}

export function presalesUsageDisplayState(input: {
  keyPoolTotalUsed: number | null;
  rollingWebsiteUsed: number;
  limit: number;
}) {
  const percentage =
    input.keyPoolTotalUsed === null
      ? null
      : Math.round((input.keyPoolTotalUsed / Math.max(1, input.limit)) * 1000) /
        10;
  return {
    keyTotalLabel: input.keyPoolTotalUsed?.toLocaleString() ?? "—",
    websiteUsedLabel: input.rollingWebsiteUsed.toLocaleString(),
    percentageLabel: percentage === null ? "—" : `${percentage}%`,
    progressPercentage: percentage === null ? 0 : Math.min(100, percentage),
  };
}

export default function AdminPresales() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [twentyFirstApiKey, setTwentyFirstApiKey] = useState("");
  const [showTwentyFirstApiKey, setShowTwentyFirstApiKey] = useState(false);
  const [twentyFirstDeleteOpen, setTwentyFirstDeleteOpen] = useState(false);
  const [twentyFirstPending, setTwentyFirstPending] = useState<
    "test" | "replace" | "delete" | null
  >(null);
  const [twentyFirstConnectionState, setTwentyFirstConnectionState] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [twentyFirstLatencyMs, setTwentyFirstLatencyMs] = useState<
    number | null
  >(null);
  const [aliyunOAuthClientId, setAliyunOAuthClientId] = useState("");
  const [aliyunOAuthClientSecret, setAliyunOAuthClientSecret] = useState("");
  const [aliyunPending, setAliyunPending] = useState<"oauth" | "delete" | null>(
    null,
  );
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
  const twentyFirstStatusQuery =
    trpc.admin.presales.twentyFirst.status.useQuery(undefined, {
      enabled: isAdmin,
      retry: false,
      refetchOnWindowFocus: false,
    });
  const twentyFirstStatus = (twentyFirstStatusQuery.data ??
    EMPTY_TWENTY_FIRST_STATUS) as TwentyFirstCredentialStatus;
  const aliyunStatusQuery = trpc.admin.presales.aliyun.status.useQuery(
    undefined,
    {
      enabled: isAdmin,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const aliyunStatus = (aliyunStatusQuery.data ??
    EMPTY_ALIYUN_STATUS) as AliyunPlatformStatus;
  const {
    configurationIssue: aliyunOAuthConfigurationIssue,
    requiresReplacement: aliyunOAuthRequiresReplacement,
    usableForAuthorization: aliyunOAuthUsableForAuthorization,
  } = aliyunOAuthConfigurationDisplayState(aliyunStatus.oauth);
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
      enabled: isAdmin,
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
    await utils.admin.presales.twentyFirst.status.invalidate();
    await utils.admin.presales.aliyun.status.invalidate();
    await (utils.admin as any).apiKeyUsageAlerts.overview.invalidate();
  };

  useEffect(() => {
    setConnectionState("idle");
    setLatencyMs(null);
  }, [apiKey]);

  useEffect(() => {
    setTwentyFirstConnectionState("idle");
    setTwentyFirstLatencyMs(null);
  }, [twentyFirstApiKey]);

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

  const maskedTwentyFirstFingerprint = useMemo(() => {
    if (!twentyFirstStatus.fingerprint) return "尚未配置";
    return `•••• ${twentyFirstStatus.fingerprint.slice(-8)}`;
  }, [twentyFirstStatus.fingerprint]);

  const handleTwentyFirstSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = twentyFirstApiKey.trim();
    if (!value) {
      toast.error("请输入 21st API Key");
      return;
    }
    setTwentyFirstPending("replace");
    try {
      const credential =
        await utils.client.admin.presales.twentyFirst.replace.mutate({
          apiKey: value,
        });
      setTwentyFirstApiKey("");
      setShowTwentyFirstApiKey(false);
      setTwentyFirstConnectionState("success");
      utils.admin.presales.twentyFirst.status.setData(undefined, credential);
      toast.success(
        twentyFirstStatus.configured
          ? "21st API Key 已更换"
          : "21st API Key 已启用",
        { description: "MCP 能力验证通过，API Key 已加密保存。" },
      );
    } catch (error) {
      setTwentyFirstConnectionState("error");
      toast.error("无法保存 21st API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setTwentyFirstPending(null);
    }
  };

  const handleTwentyFirstTest = async () => {
    const value = twentyFirstApiKey.trim();
    if (!value && !twentyFirstStatus.configured) {
      toast.error("请先填写 21st API Key");
      return;
    }
    setTwentyFirstPending("test");
    setTwentyFirstConnectionState("idle");
    const startedAt = performance.now();
    try {
      const connection =
        await utils.client.admin.presales.twentyFirst.test.mutate({
          apiKey: value || undefined,
        });
      utils.admin.presales.twentyFirst.status.setData(undefined, (current) =>
        current
          ? {
              ...current,
              capabilities: connection.capabilities,
              nativeVisualReadiness: connection.nativeVisualReadiness,
              nativeTemplateReadiness: connection.nativeTemplateReadiness,
            }
          : current,
      );
      if (connection.nativeTemplateReadiness !== "ready") {
        throw new Error(
          connection.nativeTemplateReadiness === "plan_ineligible"
            ? "当前 21st 账号没有完整 Template 下载权限"
            : connection.nativeTemplateReadiness === "catalog_unavailable"
              ? "21st 完整 Template 目录暂时不可用"
              : connection.nativeTemplateReadiness === "download_unavailable"
                ? "21st 完整 Template 下载暂时不可用"
                : connection.nativeTemplateReadiness === "compiler_unavailable"
                  ? "完整 Template 构建环境尚未就绪"
                  : "21st 完整 Template 下载权限尚未通过验证",
        );
      }
      const latency = Math.max(1, Math.round(performance.now() - startedAt));
      setTwentyFirstLatencyMs(latency);
      setTwentyFirstConnectionState("success");
      toast.success("21st MCP 连接正常", { description: `${latency}ms` });
    } catch (error) {
      setTwentyFirstLatencyMs(null);
      setTwentyFirstConnectionState("error");
      toast.error("21st 连接测试失败", {
        description:
          error instanceof Error ? error.message : "请检查 API Key 后重试",
      });
    } finally {
      setTwentyFirstPending(null);
    }
  };

  const handleTwentyFirstDelete = async () => {
    setTwentyFirstPending("delete");
    try {
      const result =
        await utils.client.admin.presales.twentyFirst.delete.mutate({});
      setTwentyFirstDeleteOpen(false);
      setTwentyFirstApiKey("");
      setTwentyFirstConnectionState("idle");
      setTwentyFirstLatencyMs(null);
      await utils.admin.presales.twentyFirst.status.invalidate();
      if (result.pending) {
        toast.info("21st Key 已停止接收新任务", {
          description: "进行中任务结束后，请再次撤销以安全覆盖历史密文。",
        });
      } else {
        toast.success("21st API Key 已撤销");
      }
    } catch (error) {
      toast.error("无法撤销 21st API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setTwentyFirstPending(null);
    }
  };

  const handleAliyunOAuthSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clientId = aliyunOAuthClientId.trim();
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(clientId)) {
      toast.error("无法保存阿里云 OAuth 应用", {
        description:
          "当前填写的是应用密钥 ID，请改填 OAuth 应用基本信息中的应用 ID。",
      });
      return;
    }
    if (!/^\d{6,64}$/u.test(clientId)) {
      toast.error("无法保存阿里云 OAuth 应用", {
        description: "OAuth 应用 ID 必须填写应用基本信息中的数字型 AppId。",
      });
      return;
    }
    setAliyunPending("oauth");
    try {
      await utils.client.admin.presales.aliyun.replaceOAuth.mutate({
        clientId,
        clientSecret: aliyunOAuthClientSecret.trim(),
      });
      setAliyunOAuthClientId("");
      setAliyunOAuthClientSecret("");
      await utils.admin.presales.aliyun.status.invalidate();
      toast.success("阿里云 OAuth 应用已保存", {
        description: "首次客户授权成功后，系统会验证该应用凭据。",
      });
    } catch (error) {
      toast.error("无法保存阿里云 OAuth 应用", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setAliyunPending(null);
    }
  };

  const handleAliyunDelete = async () => {
    setAliyunPending("delete");
    try {
      await utils.client.admin.presales.aliyun.delete.mutate();
      await utils.admin.presales.aliyun.status.invalidate();
      toast.success("阿里云 OAuth 应用凭据已撤销");
    } catch (error) {
      toast.error("无法撤销域名与发布平台凭据", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setAliyunPending(null);
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) {
      toast.error("请输入售前 API Key");
      return;
    }
    try {
      if (status.configured) {
        await replaceMutation.mutateAsync({ apiKey: value });
      } else {
        await setMutation.mutateAsync({ apiKey: value });
      }
      setApiKey("");
      setShowApiKey(false);
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
              官网任务与 AI 建站页面仅对系统管理员开放。
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
  const keyPoolTotalUsed = usageQuery.data?.keyPoolTotalUsed ?? null;
  const rollingWebsiteUsed = usageQuery.data?.rollingWebsiteUsed ?? 0;
  const keyHealth = usageQuery.data?.keyHealth ?? "unconfigured";
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
    keyPoolTotalUsed,
    rollingWebsiteUsed,
    limit: usageLimit,
  });
  const usageTone =
    keyPoolTotalUsed === null
      ? "unavailable"
      : keyPoolTotalUsed >= usageLimit
        ? "critical"
        : keyPoolTotalUsed >= usageLimit * warningRatio
          ? "warning"
          : "normal";

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="官网任务与AI建站"
      navItems={getAdminNav(true)}
      toolbar={
        <Button
          variant="outline"
          className="bg-card/80"
          disabled={
            statusQuery.isFetching ||
            usageQuery.isFetching ||
            twentyFirstStatusQuery.isFetching
          }
          onClick={() => void refreshAll()}
        >
          <RefreshCw
            className={`h-4 w-4 ${statusQuery.isFetching || usageQuery.isFetching || twentyFirstStatusQuery.isFetching || aliyunStatusQuery.isFetching ? "animate-spin" : ""}`}
          />
          刷新状态
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-6xl">
        <p className="mb-6 max-w-3xl text-sm leading-7 text-[#716a80]">
          统一管理官网任务积分和 AI 建站所需的 21st MCP 凭据。所有密钥
          只在服务端验证并加密保存，21st Key 不会传给浏览器缓存、上游建站服务
          或客户网站。
        </p>

        <div className="mb-3">
          <h2 className="text-base font-semibold text-foreground">
            官网任务与积分
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            管理现有官网任务专用 Key、近 30 天真实用量和积分预警策略。
          </p>
        </div>

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
                    <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                      更换 Key 不会清空本地近 30 天滚动用量；新 Key
                      验证后会异步刷新连接状态和积分池总额。
                    </p>
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
                  官网任务按本地账本滚动累计；当前 Key
                  的上游积分池总额与连接状态单独展示。
                </p>
              </CardHeader>
              <CardContent className="p-5 sm:p-6">
                {usageQuery.isLoading ? (
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
                    {keyHealth !== "connected" && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        {keyHealth === "invalid_or_revoked"
                          ? "当前 Key 无法连接或已失效；下方官网近 30 天自用仍按本地记录展示。"
                          : keyHealth === "unconfigured"
                            ? "当前未配置 Key；下方官网近 30 天自用仍按本地记录展示。"
                            : keyHealth === "pending"
                              ? "当前 Key 正在等待刷新；下方官网近 30 天自用不受影响。"
                              : "当前 Key 同步失败；下方官网近 30 天自用仍按本地记录展示。"}
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
                        官网前台近 30 天本地已记录
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
                                    ? formatWebsiteUsageTaskDate(
                                        task.createdAt,
                                        task.businessOwnerName,
                                      )
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

        <section className="mt-9" aria-labelledby="twenty-first-heading">
          <div className="mb-3">
            <h2
              id="twenty-first-heading"
              className="flex items-center gap-2 text-base font-semibold text-foreground"
            >
              <Sparkles className="h-4 w-4 text-primary" />
              AI建站（21st）
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              21st 用于实时读取套餐内的完整官网 Template。连接验证只检查目录、
              下载权限和本地构建准备状态，不调用内容生成服务、发布或客户任务，
              也不与官网任务积分混算。
            </p>
          </div>

          {twentyFirstStatusQuery.isLoading ? (
            <Skeleton className="h-[410px] rounded-2xl" />
          ) : twentyFirstStatusQuery.error ? (
            <Card className="border-destructive/20 bg-card/85">
              <CardContent className="py-12 text-center">
                <ShieldAlert className="mx-auto mb-3 h-7 w-7 text-destructive" />
                <p className="font-medium">21st 配置加载失败</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {twentyFirstStatusQuery.error.message}
                </p>
                <Button
                  className="mt-5"
                  variant="outline"
                  onClick={() => void twentyFirstStatusQuery.refetch()}
                >
                  重新加载
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden border-border/70 bg-card/88 shadow-sm backdrop-blur-xl">
              <CardHeader className="border-b border-border/60 pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <KeyRound className="h-5 w-5 text-primary" />
                      21st MCP API Key
                    </CardTitle>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      服务端固定连接 21st 官方接口，并验证完整 Template
                      目录与下载权限； 新建站流程不再把 get_component
                      的局部组件当作完整官网。
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={
                      twentyFirstStatus.configured &&
                      twentyFirstStatus.nativeTemplateReadiness === "ready"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : twentyFirstStatus.configured ||
                            twentyFirstStatus.revocationPending
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-border bg-muted/60 text-muted-foreground"
                    }
                  >
                    {twentyFirstStatus.configured ? (
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Activity className="mr-1 h-3.5 w-3.5" />
                    )}
                    {twentyFirstStatus.configured &&
                    twentyFirstStatus.nativeTemplateReadiness === "ready"
                      ? "完整 Template 已验证"
                      : twentyFirstStatus.configured
                        ? twentyFirstStatus.nativeTemplateReadiness ===
                          "plan_ineligible"
                          ? "套餐无下载权限"
                          : twentyFirstStatus.nativeTemplateReadiness ===
                              "catalog_unavailable"
                            ? "Template 目录不可用"
                            : twentyFirstStatus.nativeTemplateReadiness ===
                                "download_unavailable"
                              ? "Template 下载不可用"
                              : twentyFirstStatus.nativeTemplateReadiness ===
                                  "compiler_unavailable"
                                ? "模板构建环境未就绪"
                                : "等待 Template 权限复验"
                        : twentyFirstStatus.revocationPending
                          ? "等待安全撤销"
                          : "等待配置"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1.05fr_0.95fr]">
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StatusTile
                      label="凭据标识"
                      value={maskedTwentyFirstFingerprint}
                      mono
                    />
                    <StatusTile
                      label="凭据版本"
                      value={
                        twentyFirstStatus.version
                          ? `Version ${twentyFirstStatus.version}`
                          : "—"
                      }
                    />
                  </div>

                  <form className="space-y-4" onSubmit={handleTwentyFirstSave}>
                    <div className="space-y-2">
                      <Label htmlFor="twenty-first-api-key">
                        {twentyFirstStatus.configured
                          ? "输入新的 21st API Key"
                          : "21st API Key"}
                      </Label>
                      <div className="relative">
                        <Input
                          id="twenty-first-api-key"
                          type={showTwentyFirstApiKey ? "text" : "password"}
                          value={twentyFirstApiKey}
                          onChange={(event) =>
                            setTwentyFirstApiKey(event.target.value)
                          }
                          placeholder={
                            twentyFirstStatus.configured
                              ? "留空不会更改当前 API Key"
                              : "粘贴 21st_sk_…"
                          }
                          autoComplete="off"
                          spellCheck={false}
                          disabled={twentyFirstPending !== null}
                          className="border-border/60 bg-muted/20 pr-11 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowTwentyFirstApiKey((value) => !value)
                          }
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                          aria-label={
                            showTwentyFirstApiKey
                              ? "隐藏 21st API Key"
                              : "显示 21st API Key"
                          }
                        >
                          {showTwentyFirstApiKey ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        常见格式为 21st_sk_…；服务端以实际 MCP 鉴权和工具能力
                        为准。更换后新任务使用新版本，进行中任务保持原版本。
                      </p>
                    </div>

                    {twentyFirstConnectionState !== "idle" && (
                      <div
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                          twentyFirstConnectionState === "success"
                            ? "border-emerald-200 bg-emerald-50/80 text-emerald-700"
                            : "border-red-200 bg-red-50/80 text-red-700"
                        }`}
                      >
                        {twentyFirstConnectionState === "success" ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <ShieldAlert className="h-4 w-4" />
                        )}
                        {twentyFirstConnectionState === "success"
                          ? `MCP 连接正常${twentyFirstLatencyMs ? ` · ${twentyFirstLatencyMs}ms` : ""}`
                          : "MCP 连接未通过，请检查 API Key。"}
                      </div>
                    )}

                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          twentyFirstPending !== null ||
                          (!twentyFirstApiKey.trim() &&
                            !twentyFirstStatus.configured)
                        }
                        onClick={() => void handleTwentyFirstTest()}
                      >
                        {twentyFirstPending === "test" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Wifi className="h-4 w-4" />
                        )}
                        测试 MCP 连接
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          twentyFirstPending !== null ||
                          !twentyFirstApiKey.trim()
                        }
                      >
                        {twentyFirstPending === "replace" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-4 w-4" />
                        )}
                        {twentyFirstStatus.configured
                          ? "验证并更换"
                          : "验证并启用"}
                      </Button>
                    </div>
                  </form>
                </div>

                <div className="space-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4 sm:p-5">
                  <div>
                    <p className="text-sm font-medium">建站能力</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      保存时只验证只读能力。可选能力未持久探测时显示“未提供”。
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <CapabilityTile
                      label="search"
                      available={twentyFirstStatus.capabilities.search}
                    />
                    <CapabilityTile
                      label="历史组件读取"
                      available={twentyFirstStatus.capabilities.getComponent}
                    />
                    <CapabilityTile
                      label="完整 Template 下载"
                      available={
                        twentyFirstStatus.nativeTemplateReadiness === "ready"
                      }
                    />
                    <CapabilityTile
                      label="get_usage"
                      available={twentyFirstStatus.capabilities.getUsage}
                    />
                    <CapabilityTile
                      label="get_theme"
                      available={twentyFirstStatus.capabilities.getTheme}
                    />
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 px-4 py-3 text-xs leading-5 text-muted-foreground">
                    21st 用量与官网任务积分分开管理。供应商未提供 get_usage
                    时，本页不会推算或显示虚假额度。
                  </div>
                  {twentyFirstStatus.status !== null && (
                    <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
                      <div>
                        <p className="text-sm font-medium">撤销 21st 连接</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          进行中的视觉检索或契约生成会阻止撤销。
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={twentyFirstPending !== null}
                        onClick={() => setTwentyFirstDeleteOpen(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                        撤销 Key
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        <section className="mt-9" aria-labelledby="aliyun-platform-heading">
          <div className="mb-3">
            <h2
              id="aliyun-platform-heading"
              className="flex items-center gap-2 text-base font-semibold text-foreground"
            >
              <Cloud className="h-4 w-4 text-primary" />
              域名与发布平台
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              配置阿里云官方 OAuth Web 应用。客户授权仅用于读取已购买域名并管理
              AliDNS；网站托管继续使用当前环境独立配置的 FrontMind ESA 身份。
            </p>
          </div>

          {aliyunStatusQuery.isLoading ? (
            <Skeleton className="h-[520px] rounded-2xl" />
          ) : aliyunStatusQuery.error ? (
            <Card className="border-destructive/20 bg-card/85">
              <CardContent className="py-12 text-center">
                <ShieldAlert className="mx-auto mb-3 h-7 w-7 text-destructive" />
                <p className="font-medium">域名与发布平台配置加载失败</p>
                <Button
                  className="mt-5"
                  variant="outline"
                  onClick={() => void aliyunStatusQuery.refetch()}
                >
                  重新加载
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden border-border/70 bg-card/88 shadow-sm backdrop-blur-xl">
              <CardHeader className="border-b border-border/60 pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ShieldCheck className="h-5 w-5 text-primary" />
                      阿里云 OAuth 与 ESA 发布
                    </CardTitle>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      OAuth scope：openid、aliuid、/acs/alidns · ESA
                      身份由当前环境管理
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={
                      aliyunStatus.ready
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-border bg-muted/60 text-muted-foreground"
                    }
                  >
                    {aliyunStatus.ready ? (
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Activity className="mr-1 h-3.5 w-3.5" />
                    )}
                    {aliyunStatus.ready
                      ? "OAuth 已验证"
                      : aliyunStatus.oauth.configured
                        ? "等待首次授权验证"
                        : "等待配置"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-6 p-5 sm:p-6">
                <form className="space-y-4" onSubmit={handleAliyunOAuthSave}>
                  <div>
                    <p className="text-sm font-medium">阿里云 OAuth Web 应用</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      请求 openid、aliuid 与 /acs/alidns，并使用 offline access
                      保存加密 refresh token。Access token 不持久化；FrontMind
                      不调用域名购买、续费、RAM 或 ROS API。
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatusTile
                      label="OAuth 应用 ID"
                      value={
                        aliyunStatus.oauth.applicationIdTail
                          ? `•••• ${aliyunStatus.oauth.applicationIdTail}`
                          : "尚未配置"
                      }
                      mono
                    />
                    <StatusTile
                      label="凭据指纹"
                      value={
                        aliyunStatus.oauth.fingerprint
                          ? `•••• ${aliyunStatus.oauth.fingerprint.slice(-8)}`
                          : "尚未配置"
                      }
                      mono
                    />
                    <StatusTile
                      label="版本"
                      value={
                        aliyunStatus.oauth.version
                          ? `Version ${aliyunStatus.oauth.version}`
                          : "—"
                      }
                    />
                  </div>
                  {aliyunOAuthRequiresReplacement && (
                    <div
                      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"
                      role="alert"
                    >
                      {aliyunOAuthConfigurationIssue ===
                      "application_id_is_secret_id"
                        ? "当前版本保存的是 AppSecretId，不能发起客户授权。请改填 OAuth 应用“基本信息”中的数字 AppId，并使用新的 AppSecretValue 替换。"
                        : aliyunOAuthConfigurationIssue === "callback_mismatch"
                          ? "当前版本保存的回调地址与本环境不一致，不能发起客户授权。请在阿里云同步下方只读回调地址后重新保存应用。"
                          : "当前 OAuth 应用 ID 不符合数字 AppId 要求，不能发起客户授权。请重新填写并保存。"}
                    </div>
                  )}
                  {!aliyunOAuthRequiresReplacement &&
                    aliyunOAuthUsableForAuthorization &&
                    aliyunStatus.oauth.fingerprint &&
                    !aliyunStatus.oauth.verifiedAt && (
                      <p className="text-xs text-amber-700">
                        应用配置已检查，等待首次客户授权验证应用密钥。
                      </p>
                    )}
                  {!aliyunOAuthRequiresReplacement &&
                    aliyunOAuthUsableForAuthorization &&
                    aliyunStatus.oauth.verifiedAt && (
                      <p className="text-xs text-emerald-700">
                        已完成真实 OAuth 授权验证。
                      </p>
                    )}
                  <div className="space-y-2">
                    <Label htmlFor="aliyun-oauth-client-id">
                      OAuth 应用 ID（Client ID）
                    </Label>
                    <Input
                      id="aliyun-oauth-client-id"
                      aria-describedby="aliyun-oauth-client-id-help"
                      inputMode="numeric"
                      value={aliyunOAuthClientId}
                      onChange={(event) =>
                        setAliyunOAuthClientId(event.target.value)
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p
                      id="aliyun-oauth-client-id-help"
                      className="text-xs leading-5 text-muted-foreground"
                    >
                      来自 OAuth 应用“基本信息”中的数字型应用 ID，不是应用密钥
                      ID。
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="aliyun-oauth-client-secret">
                      应用密钥内容（Client Secret）
                    </Label>
                    <Input
                      id="aliyun-oauth-client-secret"
                      aria-describedby="aliyun-oauth-client-secret-help"
                      type="password"
                      value={aliyunOAuthClientSecret}
                      onChange={(event) =>
                        setAliyunOAuthClientSecret(event.target.value)
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <p
                      id="aliyun-oauth-client-secret-help"
                      className="text-xs leading-5 text-muted-foreground"
                    >
                      填写创建密钥时仅显示一次的 AppSecretValue，不是
                      AppSecretId。
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="aliyun-oauth-callback">Callback URL</Label>
                    <Input
                      id="aliyun-oauth-callback"
                      value={aliyunStatus.oauth.callbackUrl ?? ""}
                      placeholder="由 FrontMind 服务端生成"
                      readOnly
                      aria-readonly="true"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      由当前 FrontMind
                      环境在服务端生成；请将此地址逐字配置到阿里云 OAuth Web
                      应用，不能在此手动修改。
                    </p>
                  </div>
                  <Button
                    type="submit"
                    disabled={
                      aliyunPending !== null ||
                      !aliyunOAuthClientId.trim() ||
                      !aliyunOAuthClientSecret.trim()
                    }
                  >
                    {aliyunPending === "oauth" && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    保存 OAuth 应用
                  </Button>
                </form>

                <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-5">
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={
                      aliyunPending !== null || !aliyunStatus.oauth.configured
                    }
                    onClick={() => void handleAliyunDelete()}
                  >
                    {aliyunPending === "delete" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    撤销 OAuth 应用凭据
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </section>
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

      <AlertDialog
        open={twentyFirstDeleteOpen}
        onOpenChange={setTwentyFirstDeleteOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销 21st API Key？</AlertDialogTitle>
            <AlertDialogDescription>
              当前凭据会被安全覆盖。进行中的视觉检索或建站契约仍依赖该版本时，服务端会拒绝撤销并保留凭据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={twentyFirstPending === "delete"}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={twentyFirstPending === "delete"}
              onClick={(event) => {
                event.preventDefault();
                void handleTwentyFirstDelete();
              }}
            >
              {twentyFirstPending === "delete" && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认撤销
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

function CapabilityTile({
  label,
  available,
}: {
  label: string;
  available: boolean | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-2.5">
      <span className="font-mono text-xs">{label}</span>
      <Badge
        variant="outline"
        className={
          available === true
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : available === false
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-border bg-muted/60 text-muted-foreground"
        }
      >
        {available === true ? "可用" : available === false ? "缺失" : "未提供"}
      </Badge>
    </div>
  );
}
