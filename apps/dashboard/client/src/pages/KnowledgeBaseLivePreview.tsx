import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  TreePine,
  Zap,
} from "lucide-react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { OutputMessage } from "@/lib/frontmind-api";
import { projectTaskOutputMessages } from "@/lib/task-output-projection";
import {
  extractKnowledgeBaseProtocolObjects,
  stripKnowledgeBaseProtocolPayloads,
} from "@shared/knowledge-base-output";

type BranchCount = {
  title: string;
  leafCount: number;
};

type LiveAnalysis = {
  runMode: "full" | "protocol_probe" | "continuation" | "replay";
  taskId: string;
  status: string;
  terminal: boolean;
  successfulTerminal?: boolean;
  protocolAccepted?: boolean;
  outputCount: number;
  imageCount?: number;
  assistantCharacterCount: number;
  visibleCharacterCount: number;
  visibleMarkdown: string;
  rawAssistantText: string;
  rawOutput?: OutputMessage[];
  confirmationCount?: number;
  knowledgeProgress?: null | {
    revision: number;
    currentLeafId: string | null;
    total: number;
    pending: number;
    confirmed: number;
    overallPercent: number;
  };
  protocolKinds: string[];
  legacySocraticStateCount: number;
  protocolObjects: Array<Record<string, unknown>>;
  diagnostics: Array<{
    kind: string;
    count: number;
    valid: boolean;
    error?: string;
    authoritative: boolean;
  }>;
  manifest: null | {
    leafCount: number;
    branchCount: number;
    branchCounts: BranchCount[];
    firstLeaf: { id: string; title: string } | null;
    lastLeaf: { id: string; title: string } | null;
    leaves: Array<{
      id: string;
      title: string;
      branchId?: string;
      branchTitle?: string;
    }>;
  };
  issues: string[];
};

type LiveResponse = {
  sessionId: string;
  analysis: LiveAnalysis;
  initialRawAssistantText?: string;
};

const LIVE_PREVIEW_STORAGE_KEY = "frontmind.knowledge-base-live-preview";

export function readPersistedLiveResponse(): LiveResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(LIVE_PREVIEW_STORAGE_KEY) || "null",
    ) as Partial<LiveResponse> | null;
    return parsed?.analysis && typeof parsed.analysis === "object"
      ? {
          sessionId: String(parsed.sessionId || ""),
          analysis: parsed.analysis as LiveAnalysis,
          initialRawAssistantText:
            typeof parsed.initialRawAssistantText === "string"
              ? parsed.initialRawAssistantText
              : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function readReplayLiveResponse(): LiveResponse | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const rawAssistantText = params.get("replay");
  if (!rawAssistantText) return null;
  const protocolObjects = extractKnowledgeBaseProtocolObjects(rawAssistantText);
  const visibleMarkdown =
    stripKnowledgeBaseProtocolPayloads(rawAssistantText).trim();
  const legacySocraticStateCount = (
    rawAssistantText.match(/<!--\s*SOCRATIC_KB_STATE\b/gi) || []
  ).length;
  return {
    sessionId: "",
    initialRawAssistantText: rawAssistantText,
    analysis: {
      runMode: "replay",
      taskId: params.get("taskId") || "replayed-real-task",
      status: "completed",
      terminal: true,
      protocolAccepted: true,
      outputCount: Number(params.get("outputCount") || 1),
      assistantCharacterCount: rawAssistantText.length,
      visibleCharacterCount: visibleMarkdown.length,
      visibleMarkdown,
      rawAssistantText,
      rawOutput: [
        {
          id: "replayed-real-output",
          type: "output_message",
          role: "assistant",
          content: [{ type: "output_text", text: rawAssistantText }],
        },
      ],
      protocolKinds: protocolObjects.map((value) => String(value.kind || "")),
      legacySocraticStateCount,
      protocolObjects,
      diagnostics: [],
      manifest: null,
      issues: protocolObjects.some(
        (value) =>
          value.kind === "frontmind.knowledge-base.manifest" ||
          value.kind === "frontmind.knowledge-base.presentation",
      )
        ? []
        : ["任务已结束，但没有找到知识树或当前节点协议"],
    },
  };
}

function readInitialLiveResponse() {
  return readPersistedLiveResponse() || readReplayLiveResponse();
}

function persistLiveResponse(value: LiveResponse) {
  const previous = readPersistedLiveResponse();
  const initialRawAssistantText =
    value.initialRawAssistantText ||
    (value.analysis.manifest ? value.analysis.rawAssistantText : "") ||
    previous?.initialRawAssistantText ||
    undefined;
  window.sessionStorage.setItem(
    LIVE_PREVIEW_STORAGE_KEY,
    JSON.stringify({ ...value, initialRawAssistantText }),
  );
}

function responseError(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error
  ) {
    return String(payload.error.message || fallback);
  }
  return fallback;
}

function livePreviewImageSource(src: string, sessionId: string) {
  const fileMatch = src.match(/^\/api\/frontmind\/v1\/files\/([^/?#]+)/);
  if (fileMatch?.[1] && sessionId) {
    let fileId = fileMatch[1];
    try {
      fileId = decodeURIComponent(fileId);
    } catch {
      return src;
    }
    return `/api/dev/knowledge-base-live/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`;
  }
  if (src.startsWith("/api/frontmind/proxy-download?")) {
    const externalUrl = new URL(src, window.location.origin).searchParams.get(
      "url",
    );
    if (externalUrl && /^https?:\/\//i.test(externalUrl) && sessionId) {
      return `/api/dev/knowledge-base-live/${encodeURIComponent(sessionId)}/external-image?url=${encodeURIComponent(externalUrl)}`;
    }
  }
  return src;
}

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as unknown;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export default function KnowledgeBaseLivePreview() {
  const [persistedResponse] = useState(readInitialLiveResponse);
  const [recoveryTaskId] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      new URLSearchParams(window.location.search).get("resumeTaskId") || ""
    );
  });
  const [companyName, setCompanyName] = useState("FrontMind超前智能");
  const [companyWebsite, setCompanyWebsite] = useState(
    "https://www.frontmind.net/",
  );
  const [apiKey, setApiKey] = useState("");
  const [serverCredentialConfigured, setServerCredentialConfigured] = useState<
    boolean | null
  >(null);
  const [sessionId, setSessionId] = useState(
    () => persistedResponse?.sessionId || "",
  );
  const [analysis, setAnalysis] = useState<LiveAnalysis | null>(
    () => persistedResponse?.analysis || null,
  );
  const [submittingMode, setSubmittingMode] = useState<
    "full" | "protocol_probe" | null
  >(null);
  const [polling, setPolling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/dev/knowledge-base-live/configuration")
      .then(async (response) => {
        const payload = (await readJson(response)) as {
          serverCredentialConfigured?: boolean;
        } | null;
        if (!cancelled) {
          setServerCredentialConfigured(
            Boolean(payload?.serverCredentialConfigured),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setServerCredentialConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const poll = useCallback(async (currentSessionId: string) => {
    setPolling(true);
    try {
      const response = await fetch(
        `/api/dev/knowledge-base-live/${encodeURIComponent(currentSessionId)}`,
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(responseError(payload, "读取真实任务失败"));
      }
      const live = payload as LiveResponse;
      setAnalysis(live.analysis);
      persistLiveResponse(live);
      setError("");
      return live.analysis;
    } finally {
      setPolling(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionId || analysis?.terminal) return;
    const timer = window.setTimeout(() => {
      void poll(sessionId).catch((pollError) => {
        setError(
          pollError instanceof Error ? pollError.message : String(pollError),
        );
      });
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [analysis, poll, sessionId]);

  useEffect(() => {
    if (!analysis) return;
    persistLiveResponse({ sessionId, analysis });
  }, [analysis, sessionId]);

  const start = async (mode: "full" | "protocol_probe") => {
    setSubmittingMode(mode);
    setError("");
    setAnalysis(null);
    setSessionId("");
    window.sessionStorage.removeItem(LIVE_PREVIEW_STORAGE_KEY);
    try {
      const response = await fetch("/api/dev/knowledge-base-live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          companyName,
          companyWebsite,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(responseError(payload, "创建真实任务失败"));
      }
      const live = payload as LiveResponse;
      setSessionId(live.sessionId);
      setAnalysis(live.analysis);
      persistLiveResponse(live);
      setApiKey("");
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      setSubmittingMode(null);
    }
  };

  const confirmCurrent = async () => {
    if (!analysis) return;
    setConfirming(true);
    setError("");
    try {
      const response = await fetch("/api/dev/knowledge-base-live/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          sourceTaskId: analysis.taskId,
          sourceRawAssistantText:
            readPersistedLiveResponse()?.initialRawAssistantText ||
            analysis.rawAssistantText,
          confirmationCount: analysis.confirmationCount || 0,
          sourceRevision: analysis.knowledgeProgress?.revision ?? 0,
          sourceCurrentLeafId:
            analysis.knowledgeProgress?.currentLeafId ?? null,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(responseError(payload, "确认当前节点失败"));
      }
      const live = payload as LiveResponse;
      setSessionId(live.sessionId);
      setAnalysis(live.analysis);
      persistLiveResponse(live);
      setApiKey("");
    } catch (confirmError) {
      setError(
        confirmError instanceof Error
          ? confirmError.message
          : String(confirmError),
      );
    } finally {
      setConfirming(false);
    }
  };

  const recoverTask = async () => {
    if (!recoveryTaskId) return;
    setConfirming(true);
    setError("");
    try {
      const response = await fetch("/api/dev/knowledge-base-live/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: recoveryTaskId,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(responseError(payload, "恢复真实任务失败"));
      }
      const live = payload as LiveResponse;
      setSessionId(live.sessionId);
      setAnalysis(live.analysis);
      persistLiveResponse(live);
      setApiKey("");
    } catch (recoverError) {
      setError(
        recoverError instanceof Error
          ? recoverError.message
          : String(recoverError),
      );
    } finally {
      setConfirming(false);
    }
  };

  const progress = analysis?.terminal
    ? 100
    : analysis?.manifest
      ? 90
      : analysis?.visibleCharacterCount
        ? 30
        : 3;
  const protocolAccepted =
    analysis?.protocolAccepted ??
    Boolean(
      analysis &&
        analysis.runMode !== "continuation" &&
        analysis.terminal &&
        analysis.successfulTerminal !== false &&
        analysis.issues.length === 0,
    );
  const renderedVisibleMarkdown =
    analysis && (analysis.runMode !== "continuation" || protocolAccepted)
      ? stripKnowledgeBaseProtocolPayloads(analysis.visibleMarkdown).trim()
      : "";
  const projectionTarget = useMemo(() => {
    if (!analysis || !protocolAccepted) return undefined;
    if (analysis.knowledgeProgress) {
      return {
        revision: analysis.knowledgeProgress.revision,
        leafId: analysis.knowledgeProgress.currentLeafId,
      };
    }
    const firstLeaf = analysis.manifest?.firstLeaf;
    if (firstLeaf) return { revision: 0, leafId: firstLeaf.id };
    const presentation = [...analysis.protocolObjects]
      .reverse()
      .find(
        (value) =>
          value.kind === "frontmind.knowledge-base.presentation" &&
          (value.schemaVersion === 1 || value.schemaVersion === 2) &&
          Number.isSafeInteger(value.revision) &&
          (value.leafId === null || typeof value.leafId === "string"),
      );
    if (presentation) {
      return {
        revision: Number(presentation.revision),
        leafId:
          presentation.leafId === null
            ? null
            : String(presentation.leafId).trim(),
      };
    }
    return undefined;
  }, [analysis, protocolAccepted]);
  const projectedMessages = useMemo(() => {
    if (!analysis?.rawOutput?.length || !projectionTarget) return [];
    return projectTaskOutputMessages({
      output: analysis.rawOutput,
      baselineOutputLength: 0,
      responseStartedAt: Date.now(),
      modelName: "frontmind-pro",
      knowledgeBase: true,
      knowledgeBasePresentation: projectionTarget,
    }).map((message) => ({
      ...message,
      inlineImages: message.inlineImages?.map((image) => ({
        ...image,
        src: livePreviewImageSource(image.src, sessionId),
      })),
    }));
  }, [analysis, projectionTarget, sessionId]);
  const currentLeafId =
    analysis?.knowledgeProgress?.currentLeafId ||
    (analysis?.runMode === "full" ? analysis.manifest?.firstLeaf?.id : null);
  const confirmationCount = analysis?.confirmationCount || 0;

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-8 text-slate-950">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <ShieldCheck className="h-4 w-4" />
                仅本机开发环境 · 上游协议诊断
              </div>
              <h1 className="mt-2 text-2xl font-semibold">
                FrontMind 上游协议探针
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                真实调用 FrontMind API 并检查原始协议与资源传输；此页不经过
                Dashboard 数据库、权威 reconcile
                或生产会话组件，因此不能作为上线验收通过依据。
              </p>
            </div>
            <div className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
              {serverCredentialConfigured === null
                ? "正在检查 API 配置…"
                : serverCredentialConfigured
                  ? "服务端测试密钥已配置"
                  : "需要一次性 API Key"}
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr_auto]">
            <label className="space-y-1.5 text-sm font-medium">
              企业名称
              <Input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="FrontMind超前智能"
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              企业官网
              <Input
                value={companyWebsite}
                onChange={(event) => setCompanyWebsite(event.target.value)}
                placeholder="https://www.frontmind.net/"
              />
            </label>
            <div className="flex flex-col gap-2 self-end">
              {recoveryTaskId && (
                <Button
                  disabled={confirming || !apiKey.trim()}
                  onClick={() => void recoverTask()}
                >
                  {confirming ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {analysis ? "重新恢复首轮结果" : "恢复首轮结果"}
                </Button>
              )}
              <Button
                disabled={Boolean(submittingMode) || !companyName.trim()}
                onClick={() => void start("full")}
              >
                {submittingMode === "full" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                构建知识库
              </Button>
              <Button
                variant="outline"
                disabled={Boolean(submittingMode) || !companyName.trim()}
                onClick={() => void start("protocol_probe")}
              >
                {submittingMode === "protocol_probe" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                快速协议探针
              </Button>
            </div>
          </div>

          <p className="mt-3 text-xs leading-5 text-slate-500">
            快速协议探针仍会真实调用同一 API 并上传当前
            Skill，但禁止搜索和研究，只校验 8 叶子 manifest
            契约；不会写入正式知识库。
          </p>

          {!serverCredentialConfigured && (
            <label className="mt-4 block max-w-2xl space-y-1.5 text-sm font-medium">
              <span className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                一次性 API Key
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="仅发往本机服务端并保存在当前开发进程内存"
              />
            </label>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </header>

        {analysis && (
          <>
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    <Activity className="h-5 w-5 text-blue-600" />
                    {analysis.runMode === "protocol_probe"
                      ? "真实协议探针"
                      : analysis.runMode === "replay"
                        ? "真实响应回放"
                        : analysis.runMode === "continuation"
                          ? `真实确认推进 · 已通过 ${confirmationCount}/3 次`
                          : "真实任务状态"}
                    ：{analysis.status}
                  </div>
                  <div className="mt-1 font-mono text-xs text-slate-500">
                    {analysis.taskId}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {analysis.terminal &&
                    analysis.successfulTerminal !== false &&
                    protocolAccepted &&
                    analysis.runMode !== "protocol_probe" &&
                    currentLeafId &&
                    confirmationCount < 3 && (
                      <Button
                        disabled={confirming}
                        onClick={() => void confirmCurrent()}
                      >
                        {confirming ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        确认当前节点（第 {confirmationCount + 1}/3 次）
                      </Button>
                    )}
                  {analysis.terminal &&
                    analysis.successfulTerminal !== false &&
                    analysis.runMode === "continuation" &&
                    !protocolAccepted &&
                    currentLeafId &&
                    confirmationCount < 3 && (
                      <Button
                        variant="outline"
                        disabled={confirming}
                        onClick={() => void confirmCurrent()}
                      >
                        {confirming ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        重试本次确认（节点未推进）
                      </Button>
                    )}
                  <Button
                    variant="outline"
                    disabled={polling || !sessionId}
                    onClick={() => void poll(sessionId)}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${polling ? "animate-spin" : ""}`}
                    />
                    立即刷新
                  </Button>
                </div>
              </div>
              <Progress className="mt-5" value={progress} />
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <Metric label="上游输出项" value={analysis.outputCount} />
                <Metric
                  label="本轮图片"
                  value={protocolAccepted ? (analysis.imageCount ?? 0) : 0}
                />
                <Metric
                  label="原始字符"
                  value={analysis.assistantCharacterCount}
                />
                <Metric
                  label="可见字符"
                  value={protocolAccepted ? analysis.visibleCharacterCount : 0}
                />
                <Metric
                  label="业务分支"
                  value={analysis.manifest?.branchCount ?? "等待中"}
                />
                <Metric
                  label="叶子节点"
                  value={analysis.manifest?.leafCount ?? "等待中"}
                />
              </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.55fr)]">
              <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold">客户可见渲染</h2>
                <p className="mt-1 text-xs text-slate-500">
                  此处使用正式 Markdown 渲染器；所有
                  manifest、progress、presentation 与兼容协议对象均已隐藏。
                </p>
                <div className="mt-5 min-h-40 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  {projectedMessages.length > 0 ? (
                    <div className="space-y-5">
                      {projectedMessages.map((message) => (
                        <div key={message.id} className="space-y-4">
                          {message.content.trim() && (
                            <MarkdownRenderer content={message.content} />
                          )}
                          {message.inlineImages?.length ? (
                            <div className="grid gap-4 md:grid-cols-3">
                              {message.inlineImages.map((image, index) => (
                                <figure
                                  key={`${message.id}-image-${index}`}
                                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
                                >
                                  <img
                                    src={image.src}
                                    alt={image.alt || "企业官方主 Logo"}
                                    className="h-48 w-full object-contain"
                                  />
                                </figure>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : renderedVisibleMarkdown ? (
                    <MarkdownRenderer content={renderedVisibleMarkdown} />
                  ) : analysis.terminal && !protocolAccepted ? (
                    <div className="flex items-start gap-2 text-sm leading-6 text-amber-700">
                      <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
                      本轮响应未通过协议校验，已拒绝替换当前节点正文；知识树状态没有推进。
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      等待上游返回正文…
                    </div>
                  )}
                </div>
              </section>

              <aside className="space-y-6">
                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="flex items-center gap-2 font-semibold">
                    {analysis.issues.length === 0 ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                    )}
                    结构校验
                  </h2>
                  {analysis.issues.length === 0 ? (
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      当前返回未发现结构或可见内容泄漏问题。
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2 text-sm text-amber-900">
                      {analysis.issues.map((issue) => (
                        <li key={issue}>• {issue}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 space-y-2">
                    {analysis.legacySocraticStateCount > 0 && (
                      <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                        检测到 {analysis.legacySocraticStateCount} 个旧 SOCRATIC
                        状态对象；已从客户正文隐藏，且不作为 manifest
                        参与状态推进。
                      </div>
                    )}
                    {analysis.diagnostics.map((diagnostic) => (
                      <div
                        key={diagnostic.kind}
                        className="rounded-lg bg-slate-100 px-3 py-2 text-xs"
                      >
                        <div className="font-mono">{diagnostic.kind}</div>
                        <div className="mt-1 text-slate-600">
                          {!diagnostic.authoritative
                            ? "兼容对象 · 已隐藏，不参与本轮状态推进"
                            : diagnostic.valid
                              ? `通过 · ${diagnostic.count} 个`
                              : diagnostic.error}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {analysis.manifest && (
                  <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="flex items-center gap-2 font-semibold">
                      <TreePine className="h-5 w-5 text-emerald-600" />
                      知识树
                    </h2>
                    <div className="mt-3 space-y-2 text-sm">
                      {analysis.manifest.branchCounts.map((branch) => (
                        <div
                          key={branch.title}
                          className="flex justify-between rounded-lg bg-slate-100 px-3 py-2"
                        >
                          <span>{branch.title}</span>
                          <strong>{branch.leafCount}</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </aside>
            </div>

            <details className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <summary className="cursor-pointer font-semibold">
                原始 API 文本与协议对象（仅调试）
              </summary>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
                  {analysis.rawAssistantText || "等待上游返回…"}
                </pre>
                <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
                  {JSON.stringify(analysis.protocolObjects, null, 2)}
                </pre>
              </div>
            </details>
          </>
        )}
      </div>
    </main>
  );
}
