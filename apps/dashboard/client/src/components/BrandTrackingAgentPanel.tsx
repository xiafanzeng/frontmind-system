import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  Gauge,
  History,
  Loader2,
  MessageSquareText,
  Plus,
  Radar,
  RefreshCw,
  SearchCheck,
  Send,
  Sparkles,
} from "lucide-react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
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
import { Button } from "@/components/ui/button";
import { sanitizeBrandText } from "@/lib/frontmind-api";
import { trpc } from "@/lib/trpc";
import {
  formatBrandTrackingCredits,
  isPositiveBrandTrackingAmount,
} from "@shared/brand-tracking-credits";

type BrandTrackingUsage = {
  rolling30DayCost: string;
  lifetimeCost: string;
  limit: string;
  remaining: string;
  exceededBy: string;
  windowStartedAt: string;
  windowEndsAt: string;
  pendingReconciliationCount?: number;
  hasUnknownUsage?: boolean;
};

type BrandTrackingOverview = {
  eligible: boolean;
  keyConfigured: boolean;
  blocked: boolean;
  blockReason?: string | null;
  activeSessionId: string | null;
  usage: BrandTrackingUsage;
};

type BrandTrackingSessionSummary = {
  sessionId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string | null;
};

type BrandTrackingMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "completed" | "failed" | "pending_reconciliation";
  createdAt: string;
  usageCost?: string | null;
};

type BrandTrackingSession = {
  sessionId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

type QueryState<T> = {
  data?: T;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: { message?: string } | null;
  refetch: () => Promise<{ data?: T } | unknown>;
};

type BrandTrackingHooks = {
  overview: {
    useQuery: (
      input?: undefined,
      options?: Record<string, unknown>,
    ) => QueryState<BrandTrackingOverview>;
  };
  listSessions: {
    useQuery: (
      input?: undefined,
      options?: Record<string, unknown>,
    ) => QueryState<{ sessions: BrandTrackingSessionSummary[] }>;
  };
  getSession: {
    useQuery: (
      input: { sessionId: string },
      options?: Record<string, unknown>,
    ) => QueryState<{
      session: BrandTrackingSession;
      messages: BrandTrackingMessage[];
    }>;
  };
};

type NormalizedSseEvent = {
  type: string;
  payload: Record<string, unknown>;
};

class BrandTrackingHttpError extends Error {}

function createClientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${value.slice(0, 4).join("")}-${value.slice(4, 6).join("")}-${value.slice(6, 8).join("")}-${value.slice(8, 10).join("")}-${value.slice(10).join("")}`;
}

function recordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function queryData<T>(query: unknown): T | undefined {
  if (!query || typeof query !== "object" || Array.isArray(query)) return;
  const state = (query as { state?: unknown }).state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  return (state as { data?: T }).data;
}

export function brandTrackingOverviewRefetchInterval(query: unknown) {
  const data = queryData<BrandTrackingOverview>(query);
  return data?.usage.hasUnknownUsage ||
    (data?.usage.pendingReconciliationCount ?? 0) > 0
    ? 2_000
    : false;
}

export function brandTrackingSessionRefetchInterval(query: unknown) {
  const data = queryData<{
    session: BrandTrackingSession;
    messages: BrandTrackingMessage[];
  }>(query);
  return data?.messages.some(
    (message) =>
      message.status === "streaming" ||
      message.status === "pending_reconciliation",
  )
    ? 2_000
    : false;
}

async function readResponseError(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  const directMessage = recordValue(payload, "message");
  const nestedError =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error
      : undefined;
  const nestedMessage = recordValue(nestedError, "message");
  return sanitizeBrandText(
    directMessage || nestedMessage || `请求失败（HTTP ${response.status}）`,
  );
}

/** Parse a normalized SSE response, including CRLF and multi-line data frames. */
export async function consumeBrandTrackingSse(
  response: Response,
  onEvent: (event: NormalizedSseEvent) => void,
) {
  if (!response.ok) {
    throw new BrandTrackingHttpError(await readResponseError(response));
  }
  if (!response.body) {
    throw new Error("品牌追踪连接未返回可读取的数据流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const rawData = dataLines.join("\n");
    let parsed: unknown = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // Text deltas may intentionally be plain strings.
    }
    const payload =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { text: String(parsed ?? "") };
    const embeddedType = recordValue(payload, "type");
    onEvent({
      type: eventName === "message" && embeddedType ? embeddedType : eventName,
      payload,
    });
    eventName = "message";
    dataLines = [];
  };

  const consumeLine = (input: string) => {
    const line = input.endsWith("\r") ? input.slice(0, -1) : input;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value || "message";
    if (field === "data") dataLines.push(value);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      consumeLine(buffer.slice(0, lineEnd));
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  dispatch();
}

function formatDateRange(startedAt?: string, endsAt?: string) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(endsAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "滚动 30 天";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  });
  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
}

function formatSessionDate(value?: string) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function messageForBlockedOverview(overview?: BrandTrackingOverview) {
  if (!overview) return "正在读取品牌追踪权限…";
  if (!overview.eligible) return "当前账号暂不可使用品牌追踪智能体。";
  if (!overview.keyConfigured)
    return "系统管理员尚未为当前账号配置品牌追踪 Key。";
  if (overview.blocked) {
    const reason = sanitizeBrandText(overview.blockReason?.trim() || "");
    return (
      reason || "品牌追踪当前暂停，请联系负责工程师或系统管理员查看积分状态。"
    );
  }
  return null;
}

function FeatureBadge({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#e4dbe9] bg-white px-3.5 py-2 text-xs font-medium text-[#655a70] shadow-sm">
      {icon}
      {children}
    </span>
  );
}

function ConversationMessage({ message }: { message: BrandTrackingMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[#5b2a86] px-4 py-3 text-sm leading-6 text-white shadow-sm">
        {sanitizeBrandText(message.content)}
      </div>
    );
  }

  const pending = message.status === "streaming";
  return (
    <article className="flex items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#eee6f4] text-[#5b2a86]">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-[#e8e1ee] bg-white px-4 py-3 shadow-sm">
        {message.content ? (
          <MarkdownRenderer
            content={sanitizeBrandText(message.content)}
            className="brand-tracking-markdown text-sm leading-7 text-[#30273a]"
          />
        ) : pending ? (
          <p className="flex items-center gap-2 text-sm text-[#716a80]">
            <Loader2 className="h-4 w-4 animate-spin text-[#5b2a86]" />
            正在生成回答…
          </p>
        ) : (
          <p className="text-sm text-[#716a80]">本轮没有返回可展示内容。</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#82758f]">
          {pending && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              回复中
            </span>
          )}
          {message.status === "completed" && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              已完成
            </span>
          )}
          {message.status === "failed" && (
            <span className="inline-flex items-center gap-1.5 text-rose-700">
              <AlertCircle className="h-3.5 w-3.5" />
              本轮失败
            </span>
          )}
          {message.status === "pending_reconciliation" && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <Clock3 className="h-3.5 w-3.5" />
              积分与结果待确认
            </span>
          )}
          {message.usageCost && (
            <span className="ml-auto">
              本轮 {formatBrandTrackingCredits(message.usageCost)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export default function BrandTrackingAgentPanel({
  brandName,
}: {
  brandName: string;
}) {
  const brandTrackingApi = trpc.workspace
    .brandTracking as unknown as BrandTrackingHooks;
  const overviewQuery = brandTrackingApi.overview.useQuery(undefined, {
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: brandTrackingOverviewRefetchInterval,
  });
  const sessionsQuery = brandTrackingApi.listSessions.useQuery(undefined, {
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const sessionQuery = brandTrackingApi.getSession.useQuery(
    { sessionId: selectedSessionId || "" },
    {
      enabled: Boolean(selectedSessionId),
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: brandTrackingSessionRefetchInterval,
    },
  );

  const [messages, setMessages] = useState<BrandTrackingMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState<string | null>(null);
  const [streamWarnings, setStreamWarnings] = useState<string[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [reconciliationPending, setReconciliationPending] = useState(false);
  const streamActive = useRef(false);
  const streamAssistantId = useRef<string | null>(null);
  const preserveOptimisticMessages = useRef(false);
  const minimumPersistedMessageCount = useRef(0);
  const appliedPersistedSnapshot = useRef<string | null>(null);
  const mounted = useRef(true);
  const endOfConversation = useRef<HTMLDivElement>(null);

  const overview = overviewQuery.data;
  const sessions = sessionsQuery.data?.sessions || [];
  const selectedSummary = sessions.find(
    (session) => session.sessionId === selectedSessionId,
  );
  const selectedSession =
    sessionQuery.data?.session.sessionId === selectedSessionId
      ? sessionQuery.data.session
      : selectedSummary;
  const visibleBrandName = sanitizeBrandText(brandName.trim());
  const blockingMessage = messageForBlockedOverview(overview);
  const canUseAgent = Boolean(overview && !blockingMessage);
  const startBlockingMessage =
    blockingMessage ||
    (!visibleBrandName ? "请先在看板绑定有效的品牌名称。" : null);
  const canStartNewSession = canUseAgent && Boolean(visibleBrandName);
  const isArchived = selectedSession?.status === "archived";
  const hasFirstAnswer = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.status === "completed" &&
      Boolean(message.content.trim()),
  );
  const sessionHasPendingReconciliation = messages.some(
    (message) => message.status === "pending_reconciliation",
  );
  const sessionHasActiveTurn = messages.some(
    (message) =>
      message.status === "streaming" ||
      message.status === "pending_reconciliation",
  );
  const canCompose =
    canUseAgent &&
    Boolean(selectedSessionId) &&
    !isArchived &&
    hasFirstAnswer &&
    !isStreaming &&
    !reconciliationPending &&
    !sessionHasActiveTurn;
  const showComposer =
    Boolean(selectedSessionId) &&
    (hasFirstAnswer ||
      reconciliationPending ||
      sessionHasPendingReconciliation);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!overviewQuery.isSuccess || !sessionsQuery.isSuccess) return;
    if (selectedSessionId || isStreaming) return;
    const recoverableSessionId =
      overview?.activeSessionId || sessions[0]?.sessionId || null;
    if (recoverableSessionId) setSelectedSessionId(recoverableSessionId);
  }, [
    isStreaming,
    overview?.activeSessionId,
    overviewQuery.isSuccess,
    selectedSessionId,
    sessions,
    sessionsQuery.isSuccess,
  ]);

  useEffect(() => {
    const data = sessionQuery.data;
    if (isStreaming || !data || data.session.sessionId !== selectedSessionId) {
      return;
    }
    const snapshot = `${data.session.sessionId}:${data.messages
      .map(
        (message) =>
          `${message.messageId}:${message.status}:${message.content}:${message.usageCost || ""}`,
      )
      .join("|")}`;
    if (snapshot === appliedPersistedSnapshot.current) return;
    if (
      preserveOptimisticMessages.current &&
      data.messages.length < minimumPersistedMessageCount.current
    ) {
      return;
    }
    preserveOptimisticMessages.current = false;
    appliedPersistedSnapshot.current = snapshot;
    setMessages(data.messages);
    setReconciliationPending(
      data.messages.some(
        (message) => message.status === "pending_reconciliation",
      ),
    );
  }, [isStreaming, selectedSessionId, sessionQuery.data]);

  useEffect(() => {
    endOfConversation.current?.scrollIntoView?.({
      behavior: isStreaming ? "smooth" : "auto",
      block: "end",
    });
  }, [isStreaming, messages, streamProgress, streamWarnings]);

  const updateAssistant = (
    transform: (message: BrandTrackingMessage) => BrandTrackingMessage,
  ) => {
    const assistantId = streamAssistantId.current;
    if (!assistantId) return;
    setMessages((current) =>
      current.map((message) =>
        message.messageId === assistantId ? transform(message) : message,
      ),
    );
  };

  const refreshLocalData = async () => {
    await Promise.allSettled([
      overviewQuery.refetch(),
      sessionsQuery.refetch(),
      selectedSessionId ? sessionQuery.refetch() : Promise.resolve(),
    ]);
  };

  const runStream = async ({
    endpoint,
    body,
    assistantId,
  }: {
    endpoint: string;
    body: Record<string, string>;
    assistantId: string;
  }) => {
    let sawEnd = false;
    let sawStreamError = false;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      await consumeBrandTrackingSse(response, ({ type, payload }) => {
        if (!mounted.current) return;
        if (type === "session") {
          const sessionId = recordValue(payload, "sessionId");
          if (sessionId) setSelectedSessionId(sessionId);
          return;
        }
        if (type === "delta") {
          const text = recordValue(payload, "text") || "";
          if (text) {
            updateAssistant((message) => ({
              ...message,
              content: `${message.content}${text}`,
            }));
          }
          return;
        }
        if (type === "progress") {
          const message = recordValue(payload, "message");
          if (message) setStreamProgress(sanitizeBrandText(message));
          return;
        }
        if (type === "warning") {
          const message = recordValue(payload, "message");
          if (message) {
            const visible = sanitizeBrandText(message);
            setStreamWarnings((current) =>
              current.includes(visible) ? current : [...current, visible],
            );
          }
          return;
        }
        if (type === "usage") {
          const cost = recordValue(payload, "cost");
          if (cost)
            updateAssistant((message) => ({ ...message, usageCost: cost }));
          return;
        }
        if (type === "error") {
          sawStreamError = true;
          const message = sanitizeBrandText(
            recordValue(payload, "message") || "品牌追踪本轮执行失败。",
          );
          setStreamError(message);
          updateAssistant((item) => ({ ...item, status: "failed" }));
          return;
        }
        if (type === "end" || type === "done") {
          sawEnd = true;
          const status = recordValue(payload, "status");
          const cost = recordValue(payload, "cost");
          updateAssistant((message) => ({
            ...message,
            ...(cost ? { usageCost: cost } : {}),
            status:
              status === "pending_reconciliation"
                ? "pending_reconciliation"
                : status === "failed" || sawStreamError
                  ? "failed"
                  : "completed",
          }));
          if (status === "pending_reconciliation") {
            setReconciliationPending(true);
          }
        }
      });

      if (!sawEnd) {
        setReconciliationPending(true);
        setStreamWarnings((current) => [
          ...current,
          "连接已结束，服务端仍会继续核对本轮结果与积分，请稍后刷新历史会话。",
        ]);
        updateAssistant((message) => ({
          ...message,
          status: "pending_reconciliation",
        }));
      }
    } catch (error) {
      if (!mounted.current) return;
      const explicitFailure = error instanceof BrandTrackingHttpError;
      const message = sanitizeBrandText(
        error instanceof Error
          ? error.message
          : "品牌追踪连接失败，请稍后重试。",
      );
      setStreamError(
        explicitFailure
          ? message
          : `${message} 服务端可能仍在处理，请稍后刷新历史会话确认结果。`,
      );
      if (!explicitFailure) setReconciliationPending(true);
      updateAssistant((item) => ({
        ...item,
        status: explicitFailure ? "failed" : "pending_reconciliation",
      }));
    } finally {
      if (mounted.current) {
        streamActive.current = false;
        streamAssistantId.current = null;
        setIsStreaming(false);
        setStreamProgress(null);
        await refreshLocalData();
      }
    }
  };

  const startNewSession = async () => {
    if (!canStartNewSession || streamActive.current) return;
    streamActive.current = true;
    setIsStreaming(true);
    setStreamError(null);
    setStreamWarnings([]);
    setStreamProgress("正在启动品牌追踪智能体…");
    setReconciliationPending(false);
    setSelectedSessionId(null);
    const clientRequestId = createClientRequestId();
    const assistantId = `local:${clientRequestId}:assistant`;
    streamAssistantId.current = assistantId;
    preserveOptimisticMessages.current = true;
    minimumPersistedMessageCount.current = 1;
    appliedPersistedSnapshot.current = null;
    setMessages([
      {
        messageId: assistantId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    ]);
    await runStream({
      endpoint: "/api/brand-tracking/sessions",
      body: { clientRequestId },
      assistantId,
    });
  };

  const sendMessage = async () => {
    const content = composer.trim();
    if (!content || !selectedSessionId || !canCompose || streamActive.current)
      return;
    streamActive.current = true;
    setIsStreaming(true);
    setStreamError(null);
    setStreamWarnings([]);
    setStreamProgress("正在分析你的输入…");
    setReconciliationPending(false);
    setComposer("");
    const clientRequestId = createClientRequestId();
    const assistantId = `local:${clientRequestId}:assistant`;
    streamAssistantId.current = assistantId;
    preserveOptimisticMessages.current = true;
    minimumPersistedMessageCount.current = messages.length + 2;
    setMessages((current) => [
      ...current,
      {
        messageId: `local:${clientRequestId}:user`,
        role: "user",
        content,
        status: "completed",
        createdAt: new Date().toISOString(),
      },
      {
        messageId: assistantId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    ]);
    await runStream({
      endpoint: `/api/brand-tracking/sessions/${encodeURIComponent(selectedSessionId)}/messages`,
      body: { content, clientRequestId },
      assistantId,
    });
  };

  const emptyStateDescription = useMemo(() => {
    return visibleBrandName
      ? `围绕 ${visibleBrandName} 持续追踪品牌提及、舆情趋势与潜在风险，并通过多轮对话逐步补充追踪范围。`
      : "持续追踪品牌提及、舆情趋势与潜在风险，并通过多轮对话逐步补充追踪范围。";
  }, [visibleBrandName]);

  const selectSession = (sessionId: string) => {
    if (streamActive.current) return;
    setSelectedSessionId(sessionId || null);
    setMessages([]);
    setComposer("");
    setStreamError(null);
    setStreamWarnings([]);
    setStreamProgress(null);
    setReconciliationPending(false);
    preserveOptimisticMessages.current = false;
    minimumPersistedMessageCount.current = 0;
    appliedPersistedSnapshot.current = null;
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-[#e8e1ee] bg-white px-4 py-3 pl-16 sm:px-5 min-[769px]:pl-5">
        <div className="min-w-0">
          <h2 className="m-0 truncate text-base font-semibold text-[#171321]">
            品牌追踪智能体
          </h2>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {sessions.length > 0 && (
            <select
              aria-label="历史追踪会话"
              value={selectedSessionId || ""}
              disabled={isStreaming}
              onChange={(event) => selectSession(event.target.value)}
              className="h-9 w-28 max-w-56 rounded-lg border border-[#ded2e8] bg-white px-2 text-xs text-[#4b3e57] outline-none focus:border-[#8d61ad] sm:w-auto sm:px-3"
            >
              {!selectedSessionId && <option value="">选择历史会话</option>}
              {selectedSessionId &&
                !sessions.some(
                  (session) => session.sessionId === selectedSessionId,
                ) && <option value={selectedSessionId}>当前会话</option>}
              {sessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {sanitizeBrandText(session.title || "未命名追踪")} ·{" "}
                  {formatSessionDate(session.updatedAt)}
                </option>
              ))}
            </select>
          )}
          {overview?.usage && (
            <span
              className="shrink-0 rounded-full border border-[#ded2e8] bg-[#faf8fc] px-3 py-1.5 text-xs font-medium text-[#5b2a86]"
              aria-label="滚动30天品牌追踪剩余额度"
            >
              剩余 {formatBrandTrackingCredits(overview.usage.remaining)}
            </span>
          )}
        </div>
      </header>

      <div className="relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,#f7f2ec_0,#fcfbfd_35%,#fcfbfd_100%)]">
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mx-auto grid w-full max-w-4xl gap-5">
              {(overviewQuery.isLoading || sessionsQuery.isLoading) &&
              !overview ? (
                <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[#716a80]">
                  <Loader2 className="h-5 w-5 animate-spin text-[#5b2a86]" />
                  正在读取品牌追踪工作区…
                </div>
              ) : overviewQuery.isError || sessionsQuery.isError ? (
                <div className="mx-auto flex min-h-[420px] max-w-lg flex-col items-center justify-center text-center">
                  <AlertCircle className="h-9 w-9 text-rose-600" />
                  <h3 className="mt-4 font-semibold text-[#2c2137]">
                    品牌追踪工作区读取失败
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#716a80]">
                    暂时无法恢复品牌追踪会话，请重新读取。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => {
                      void overviewQuery.refetch();
                      void sessionsQuery.refetch();
                    }}
                  >
                    <RefreshCw className="h-4 w-4" />
                    重新读取
                  </Button>
                </div>
              ) : !selectedSessionId && !isStreaming ? (
                <div className="flex min-h-[460px] flex-col items-center justify-center px-4 py-10 text-center">
                  <div className="flex max-w-xl flex-col items-center">
                    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#245a4d] text-white shadow-[0_14px_32px_rgba(36,90,77,.2)]">
                      <Radar className="h-5 w-5" />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-[#29232d]">
                      品牌追踪智能体
                    </h3>
                    <p className="mt-2 max-w-lg text-sm leading-7 text-[#716a80]">
                      {emptyStateDescription}
                    </p>
                    <Button
                      type="button"
                      disabled={!canStartNewSession}
                      onClick={() => setConfirmOpen(true)}
                      className="mt-6 h-11 gap-2 rounded-xl bg-[#245a4d] px-5 shadow-sm hover:bg-[#1c493e]"
                    >
                      <Radar className="h-4 w-4" />
                      启动品牌追踪
                    </Button>
                    {startBlockingMessage && (
                      <p
                        className="mt-3 max-w-md text-xs leading-5 text-amber-700"
                        role="alert"
                      >
                        {startBlockingMessage}
                      </p>
                    )}
                    {streamError && (
                      <p
                        className="mt-3 max-w-md rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-800"
                        role="alert"
                      >
                        {streamError}
                      </p>
                    )}
                    <div className="mt-8 flex flex-wrap justify-center gap-4">
                      <FeatureBadge
                        icon={<MessageSquareText className="h-3.5 w-3.5" />}
                      >
                        持续对话
                      </FeatureBadge>
                      <FeatureBadge icon={<Sparkles className="h-3.5 w-3.5" />}>
                        趋势分析
                      </FeatureBadge>
                      <FeatureBadge
                        icon={<SearchCheck className="h-3.5 w-3.5" />}
                      >
                        信源核验
                      </FeatureBadge>
                    </div>
                  </div>
                </div>
              ) : selectedSessionId &&
                sessionQuery.isLoading &&
                messages.length === 0 ? (
                <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[#716a80]">
                  <Loader2 className="h-5 w-5 animate-spin text-[#5b2a86]" />
                  正在恢复追踪会话…
                </div>
              ) : selectedSessionId &&
                sessionQuery.isError &&
                messages.length === 0 ? (
                <div className="mx-auto flex min-h-[420px] max-w-lg flex-col items-center justify-center text-center">
                  <AlertCircle className="h-9 w-9 text-rose-600" />
                  <h3 className="mt-4 font-semibold text-[#2c2137]">
                    会话读取失败
                  </h3>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => void sessionQuery.refetch()}
                  >
                    <RefreshCw className="h-4 w-4" />
                    重新读取
                  </Button>
                </div>
              ) : (
                <>
                  {selectedSession && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e1ee] pb-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#30273a]">
                          {sanitizeBrandText(
                            selectedSession.title || "品牌追踪",
                          )}
                        </p>
                        <p className="mt-1 text-xs text-[#82758f]">
                          {selectedSession.status === "archived"
                            ? "历史会话 · 只读"
                            : "当前活动会话"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canStartNewSession || isStreaming}
                        onClick={() => setConfirmOpen(true)}
                        className="rounded-lg"
                      >
                        <Plus className="h-4 w-4" />
                        新建追踪
                      </Button>
                    </div>
                  )}
                  {messages.map((message) => (
                    <ConversationMessage
                      key={message.messageId}
                      message={message}
                    />
                  ))}
                  {streamProgress && (
                    <div
                      className="flex items-center gap-2 rounded-xl border border-[#ded2e8] bg-white/80 px-3 py-2 text-xs text-[#6a5877]"
                      aria-live="polite"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5b2a86]" />
                      {streamProgress}
                    </div>
                  )}
                  {streamWarnings.map((warning) => (
                    <div
                      key={warning}
                      className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"
                      role="status"
                    >
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {warning}
                    </div>
                  ))}
                  {streamError && (
                    <div
                      className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-800"
                      role="alert"
                    >
                      <AlertCircle className="mt-1 h-4 w-4 shrink-0" />
                      {streamError}
                    </div>
                  )}
                  <div ref={endOfConversation} />
                </>
              )}
            </div>
          </div>

          {showComposer && (
            <div className="shrink-0 border-t border-[#e8e1ee] bg-white p-4 sm:px-6">
              <form
                className="mx-auto w-full max-w-4xl"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                <div className="flex items-end gap-2 rounded-2xl border border-[#ded2e8] bg-white p-2 shadow-[0_10px_32px_rgba(42,24,66,.08)] focus-within:border-[#a98abb]">
                  <textarea
                    aria-label="品牌追踪消息"
                    value={composer}
                    rows={1}
                    disabled={!canCompose}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !(event.nativeEvent as KeyboardEvent).isComposing
                      ) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder={
                      isArchived
                        ? "历史会话为只读，请新建追踪"
                        : reconciliationPending ||
                            sessionHasPendingReconciliation
                          ? "正在核对上一轮结果与积分"
                          : !hasFirstAnswer
                            ? "首条引导完成后即可继续对话"
                            : blockingMessage ||
                              "继续补充品牌、范围、平台或关注点"
                    }
                    className="max-h-36 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-[#2c2137] outline-none placeholder:text-[#9b91a5] disabled:cursor-not-allowed disabled:opacity-65"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="发送品牌追踪消息"
                    disabled={!canCompose || !composer.trim()}
                    className="h-11 w-11 rounded-xl bg-[#5b2a86] hover:bg-[#49216c]"
                  >
                    {isStreaming ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-2 text-center text-[11px] text-[#8a8192]">
                  Enter 发送 · Shift+Enter 换行 · 每轮积分按当前账号实际用量归因
                </p>
              </form>
            </div>
          )}
        </div>

        <aside className="custom-scrollbar hidden min-h-0 overflow-y-auto border-l border-[#e8e1ee] bg-[#fbf9fd] p-4 xl:block">
          <div className="rounded-2xl border border-[#e4dbe9] bg-white p-5 shadow-[0_12px_34px_rgba(42,24,66,.05)]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#30273a]">
              <Gauge className="h-4 w-4 text-[#6b3794]" />
              滚动 30 天积分
            </div>
            {overview?.usage ? (
              <>
                <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-[#faf8fc] px-2 py-3">
                    <dt className="text-[11px] text-[#82758f]">积分上限</dt>
                    <dd className="mt-1 text-sm font-semibold text-[#30273a]">
                      {formatBrandTrackingCredits(overview.usage.limit, {
                        includeUnit: false,
                      })}
                    </dd>
                  </div>
                  <div className="rounded-xl bg-[#faf8fc] px-2 py-3">
                    <dt className="text-[11px] text-[#82758f]">已使用</dt>
                    <dd className="mt-1 text-sm font-semibold text-[#30273a]">
                      {formatBrandTrackingCredits(
                        overview.usage.rolling30DayCost,
                        { includeUnit: false },
                      )}
                    </dd>
                  </div>
                  <div className="rounded-xl bg-[#f4eff8] px-2 py-3">
                    <dt className="text-[11px] text-[#765b87]">剩余</dt>
                    <dd className="mt-1 text-sm font-semibold text-[#5b2a86]">
                      {formatBrandTrackingCredits(overview.usage.remaining, {
                        includeUnit: false,
                      })}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-center text-xs text-[#82758f]">
                  {formatDateRange(
                    overview.usage.windowStartedAt,
                    overview.usage.windowEndsAt,
                  )}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-[#eee8f2] pt-3 text-xs">
                  <span className="text-[#82758f]">账号累计积分</span>
                  <strong className="text-[#30273a]">
                    {formatBrandTrackingCredits(overview.usage.lifetimeCost)}
                  </strong>
                </div>
                {overview.blocked &&
                  isPositiveBrandTrackingAmount(overview.usage.exceededBy) && (
                    <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      已超出上限{" "}
                      {formatBrandTrackingCredits(overview.usage.exceededBy)}
                    </p>
                  )}
              </>
            ) : (
              <div className="mt-4 flex items-center gap-2 text-sm text-[#82758f]">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取积分…
              </div>
            )}
          </div>

          <div className="mt-4 rounded-2xl border border-[#e4dbe9] bg-white p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#30273a]">
                <History className="h-4 w-4 text-[#6b3794]" />
                历史会话
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="新建品牌追踪"
                disabled={!canStartNewSession || isStreaming}
                onClick={() => setConfirmOpen(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {sessions.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {sessions.map((session) => {
                  const active = session.sessionId === selectedSessionId;
                  return (
                    <button
                      key={session.sessionId}
                      type="button"
                      disabled={isStreaming}
                      onClick={() => selectSession(session.sessionId)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${active ? "border-[#bba6ca] bg-[#f4eff8]" : "border-transparent bg-[#faf8fc] hover:border-[#e4dbe9]"}`}
                    >
                      <span className="block truncate text-xs font-medium text-[#40344b]">
                        {sanitizeBrandText(session.title || "未命名追踪")}
                      </span>
                      <span className="mt-1 block text-[11px] text-[#82758f]">
                        {formatSessionDate(session.updatedAt)} ·{" "}
                        {session.status === "archived" ? "已归档" : "进行中"}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-[#82758f]">
                启动后，会话会保存在这里。
              </p>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => !isStreaming && setConfirmOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认启动新的品牌追踪？</AlertDialogTitle>
            <AlertDialogDescription>
              确认后，智能体会按以下固定设置直接开始追踪。当前活动会话将归档，历史内容仍可随时查看。
            </AlertDialogDescription>
            <dl className="grid gap-2 rounded-xl border border-[#e4dbe9] bg-[#faf8fc] p-3 text-sm">
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[#82758f]">品牌</dt>
                <dd className="break-words font-medium text-[#30273a]">
                  {visibleBrandName || "未绑定"}
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[#82758f]">名称变体</dt>
                <dd className="font-medium text-[#30273a]">
                  不确定，由 API 建议
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[#82758f]">平台</dt>
                <dd className="font-medium text-[#30273a]">全部</dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[#82758f]">时间</dt>
                <dd className="font-medium text-[#30273a]">过去 7 天</dd>
              </div>
            </dl>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStreaming}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canStartNewSession || isStreaming}
              onClick={() => {
                setConfirmOpen(false);
                void startNewSession();
              }}
              className="bg-[#245a4d] hover:bg-[#1c493e]"
            >
              {isStreaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Radar className="h-4 w-4" />
              )}
              确认启动
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
