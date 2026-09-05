export const JENOVA_BRAND_TRACKER_AGENT = "brand-tracker";
export const DEFAULT_JENOVA_BASE_URL = "https://api.jenova.ai/v1";

export type JenovaClientErrorCode =
  | "INVALID_KEY"
  | "AGENT_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "STREAM_INTERRUPTED"
  | "INVALID_RESPONSE";

export class JenovaClientError extends Error {
  constructor(
    public readonly code: JenovaClientErrorCode,
    message: string,
    public readonly statusCode = 502,
    public readonly retryable = false,
    public readonly upstreamCode?: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "JenovaClientError";
  }
}

export type JenovaStreamEvent =
  | {
      type: "started";
      sessionId: string | null;
      runId: string | null;
      messageId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "delta";
      text: string;
      sessionId: string | null;
      runId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "progress";
      message: string;
      sessionId: string | null;
      runId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "warning";
      code: string | null;
      message: string;
      sessionId: string | null;
      runId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "error";
      code: string;
      message: string;
      usageCost: string | null;
      sessionId: string | null;
      runId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "message_completed";
      sessionId: string | null;
      runId: string | null;
      messageId: string | null;
      raw: Record<string, unknown>;
    }
  | {
      type: "ended";
      success: boolean | null;
      stopReason: string | null;
      usageCost: string | null;
      sessionId: string | null;
      runId: string | null;
      raw: Record<string, unknown>;
    };

export type JenovaKeyValidation = {
  balance: string;
  agent: Record<string, unknown>;
};

type FetchLike = typeof fetch;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

export function redactJenovaSecret(value: string, apiKey?: string) {
  let redacted = value.replace(/jnv_sk_[A-Za-z0-9._-]+/g, "[REDACTED]");
  if (apiKey) redacted = redacted.split(apiKey).join("[REDACTED]");
  return redacted;
}

export function sanitizeJenovaPayload(
  value: unknown,
  apiKey?: string,
  depth = 0,
): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactJenovaSecret(value, apiKey);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJenovaPayload(item, apiKey, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /api[_-]?key|authorization|token|secret/i.test(key)
          ? "[REDACTED]"
          : sanitizeJenovaPayload(item, apiKey, depth + 1),
      ]),
    );
  }
  return value;
}

export function normalizeJenovaDecimal(value: unknown): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isFinite(value) || value < 0))
  ) {
    throw new JenovaClientError(
      "INVALID_RESPONSE",
      "Jenova 返回了无效的积分用量数据",
      502,
    );
  }
  const raw = String(value).trim();
  const match = raw.match(/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) {
    throw new JenovaClientError(
      "INVALID_RESPONSE",
      "Jenova 返回了无效的积分用量数据",
      502,
    );
  }
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new JenovaClientError(
      "INVALID_RESPONSE",
      "Jenova 返回了无效的积分用量数据",
      502,
    );
  }
  const integerDigits = match[1]!;
  const fractionDigits = match[2] ?? "";
  const digits = `${integerDigits}${fractionDigits}`;
  const decimalPosition = integerDigits.length + exponent;
  let whole: string;
  let fraction: string;
  if (decimalPosition <= 0) {
    whole = "0";
    fraction = `${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    whole = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
    fraction = "";
  } else {
    whole = digits.slice(0, decimalPosition);
    fraction = digits.slice(decimalPosition);
  }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  if (
    whole.length > 12 ||
    (fraction.length > 8 && /[1-9]/.test(fraction.slice(8)))
  ) {
    throw new JenovaClientError(
      "INVALID_RESPONSE",
      "Jenova 返回的积分用量精度超出支持范围",
      502,
    );
  }
  return `${whole}.${fraction.slice(0, 8).padEnd(8, "0")}`;
}

function jenovaBaseUrl(value?: string) {
  return (
    value?.trim() ||
    process.env.JENOVA_API_BASE_URL?.trim() ||
    DEFAULT_JENOVA_BASE_URL
  ).replace(/\/+$/, "");
}

function assertApiKey(apiKey: string) {
  if (!apiKey.trim().startsWith("jnv_sk_")) {
    throw new JenovaClientError("INVALID_KEY", "Jenova API Key 格式错误", 400);
  }
}

async function responseError(
  response: Response,
  apiKey: string,
): Promise<JenovaClientError> {
  let upstreamCode: string | undefined;
  let details: Record<string, unknown> = {};
  let message = `Jenova 请求失败（HTTP ${response.status}）`;
  try {
    const body = asObject(await response.json());
    details = sanitizeJenovaPayload(body, apiKey) as Record<string, unknown>;
    const safeBody = details;
    const detail = asObject(safeBody.error);
    upstreamCode = optionalString(detail.code ?? safeBody.code) ?? undefined;
    message =
      optionalString(detail.message ?? safeBody.message) ??
      `Jenova 请求失败（HTTP ${response.status}）`;
  } catch {
    // A non-JSON response must not be copied into logs or user-visible errors.
  }
  const invalidKey = response.status === 401 || response.status === 403;
  return new JenovaClientError(
    invalidKey ? "INVALID_KEY" : "UPSTREAM_REJECTED",
    message,
    response.status,
    response.status === 408 ||
      response.status === 429 ||
      response.status >= 500,
    upstreamCode,
    details,
  );
}

async function requestJson(input: {
  fetchImpl: FetchLike;
  baseUrl: string;
  apiKey: string;
  path: string;
  timeoutMs: number;
}) {
  let response: Response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}${input.path}`, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Accept-Language": "zh",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw new JenovaClientError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? "Jenova 请求超时"
        : "暂时无法连接 Jenova",
      503,
      true,
    );
  }
  if (!response.ok) throw await responseError(response, input.apiKey);
  try {
    return asObject(await response.json());
  } catch {
    throw new JenovaClientError(
      "INVALID_RESPONSE",
      "Jenova 返回了无效的 JSON",
      502,
    );
  }
}

type RawSseEvent = { event: string; data: Record<string, unknown> };

function parseSseBlock(block: string): RawSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join("\n");
  try {
    return { event, data: asObject(JSON.parse(joined)) };
  } catch {
    return { event, data: { raw: joined } };
  }
}

/** Standards-compliant enough for chunked and multi-line Jenova SSE frames. */
export async function* parseJenovaSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const boundaryOf = (value: string) => {
    const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
    return match ? { index: match.index, length: match[0].length } : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = boundaryOf(buffer);
      while (boundary) {
        const parsed = parseSseBlock(
          buffer.slice(0, boundary.index).replace(/\r\n?/g, "\n"),
        );
        buffer = buffer.slice(boundary.index + boundary.length);
        if (parsed) yield parsed;
        boundary = boundaryOf(buffer);
      }
      if (done) break;
    }
    const parsed = parseSseBlock(buffer.replace(/\r\n?/g, "\n"));
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function eventIdentity(data: Record<string, unknown>) {
  return {
    sessionId: optionalString(data.session_id),
    runId: optionalString(data.run_id),
  };
}

function normalizeStreamEvent(
  raw: RawSseEvent,
  apiKey: string,
): JenovaStreamEvent | null {
  const data = sanitizeJenovaPayload(raw.data, apiKey) as Record<
    string,
    unknown
  >;
  const identity = eventIdentity(data);
  if (raw.event === "stream_started") {
    return {
      type: "started",
      ...identity,
      messageId: optionalString(data.message_id),
      raw: data,
    };
  }
  if (raw.event === "stream_delta") {
    return {
      type: "delta",
      text: optionalString(data.chunk_content) ?? "",
      ...identity,
      raw: data,
    };
  }
  if (raw.event === "stream_progress") {
    return {
      type: "progress",
      message:
        optionalString(data.label ?? data.message ?? data.detail) ?? "处理中",
      ...identity,
      raw: data,
    };
  }
  if (raw.event === "warning" || raw.event === "stream_warning") {
    return {
      type: "warning",
      code: optionalString(data.code),
      message: optionalString(data.message ?? data.label) ?? "Jenova 返回警告",
      ...identity,
      raw: data,
    };
  }
  if (raw.event === "stream_error") {
    const nested = asObject(data.error);
    const usage = asObject(data.usage ?? nested.usage);
    return {
      type: "error",
      code: optionalString(nested.code ?? data.code) ?? "stream_error",
      message:
        optionalString(nested.message ?? data.message) ?? "Jenova 运行失败",
      usageCost:
        usage.cost === undefined || usage.cost === null
          ? null
          : normalizeJenovaDecimal(usage.cost),
      ...identity,
      raw: data,
    };
  }
  if (raw.event === "message_completed") {
    return {
      type: "message_completed",
      ...identity,
      messageId: optionalString(data.message_id),
      raw: data,
    };
  }
  if (raw.event === "stream_ended") {
    const usage = asObject(data.usage);
    const rawCost = usage.cost;
    return {
      type: "ended",
      success: typeof data.success === "boolean" ? data.success : null,
      stopReason: optionalString(data.stop_reason),
      usageCost:
        rawCost === null || rawCost === undefined
          ? null
          : normalizeJenovaDecimal(rawCost),
      ...identity,
      raw: data,
    };
  }
  return null;
}

export class JenovaBrandTrackingClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    options: {
      fetchImpl?: FetchLike;
      baseUrl?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = jenovaBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 3_600_000;
  }

  async listAgents(apiKey: string) {
    assertApiKey(apiKey);
    const result = await requestJson({
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
      apiKey: apiKey.trim(),
      path: "/agents",
      timeoutMs: Math.min(this.timeoutMs, 15_000),
    });
    return Array.isArray(result.agents)
      ? result.agents.map(asObject)
      : ([] as Record<string, unknown>[]);
  }

  async getBalance(apiKey: string) {
    assertApiKey(apiKey);
    const result = await requestJson({
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
      apiKey: apiKey.trim(),
      path: "/credits/balance",
      timeoutMs: Math.min(this.timeoutMs, 15_000),
    });
    return normalizeJenovaDecimal(result.balance);
  }

  async validateKey(apiKey: string): Promise<JenovaKeyValidation> {
    const [agents, balance] = await Promise.all([
      this.listAgents(apiKey),
      this.getBalance(apiKey),
    ]);
    const agent = agents.find(
      (entry) =>
        entry.agent === JENOVA_BRAND_TRACKER_AGENT ||
        entry.slug === JENOVA_BRAND_TRACKER_AGENT,
    );
    if (!agent) {
      throw new JenovaClientError(
        "AGENT_UNAVAILABLE",
        "当前 Jenova Key 未开通 Brand Tracker",
        422,
      );
    }
    return { balance, agent };
  }

  async getSessionRun(
    apiKey: string,
    sessionId: string,
    runId: string,
    userId: string,
  ) {
    assertApiKey(apiKey);
    return requestJson({
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
      apiKey: apiKey.trim(),
      path: `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}?user=${encodeURIComponent(userId)}`,
      timeoutMs: Math.min(this.timeoutMs, 15_000),
    });
  }

  async listSessionMessages(apiKey: string, sessionId: string, userId: string) {
    assertApiKey(apiKey);
    const messages: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ user: userId, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await requestJson({
        fetchImpl: this.fetchImpl,
        baseUrl: this.baseUrl,
        apiKey: apiKey.trim(),
        path: `/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
        timeoutMs: Math.min(this.timeoutMs, 15_000),
      });
      const items = Array.isArray(result.items)
        ? result.items
        : Array.isArray(result.messages)
          ? result.messages
          : [];
      messages.push(...items.map(asObject));
      const nextCursor = optionalString(
        result.next_cursor ?? result.nextCursor,
      );
      if (result.has_more !== true || !nextCursor || nextCursor === cursor)
        break;
      cursor = nextCursor;
    }
    return messages;
  }

  async streamMessage(input: {
    apiKey: string;
    userId: string;
    content: string;
    idempotencyKey: string;
    sessionId?: string | null;
    sessionName?: string;
    onEvent: (event: JenovaStreamEvent) => void | Promise<void>;
  }) {
    assertApiKey(input.apiKey);
    const content = input.content.trim();
    if (!content) {
      throw new JenovaClientError("UPSTREAM_REJECTED", "消息内容不能为空", 400);
    }
    const path = input.sessionId
      ? `/sessions/${encodeURIComponent(input.sessionId)}/messages`
      : "/messages";
    const payload = input.sessionId
      ? { content, user: input.userId, stream: true }
      : {
          agent: JENOVA_BRAND_TRACKER_AGENT,
          user: input.userId,
          session_name: input.sessionName ?? "品牌追踪会话",
          content,
          stream: true,
        };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}?lang=zh`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${input.apiKey.trim()}`,
          "Accept-Language": "zh",
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new JenovaClientError(
        "UPSTREAM_UNAVAILABLE",
        error instanceof Error && error.name === "TimeoutError"
          ? "Jenova 运行超时"
          : "暂时无法连接 Jenova",
        503,
        true,
      );
    }
    if (!response.ok) throw await responseError(response, input.apiKey);
    if (!response.body) {
      throw new JenovaClientError(
        "INVALID_RESPONSE",
        "Jenova 未返回事件流",
        502,
      );
    }

    let ended = false;
    for await (const raw of parseJenovaSseStream(response.body)) {
      const event = normalizeStreamEvent(raw, input.apiKey);
      if (!event) continue;
      await input.onEvent(event);
      if (event.type === "ended") ended = true;
    }
    if (!ended) {
      throw new JenovaClientError(
        "STREAM_INTERRUPTED",
        "Jenova 事件流在结算前中断",
        503,
        true,
      );
    }
  }
}

export const jenovaBrandTrackingClient = new JenovaBrandTrackingClient();
