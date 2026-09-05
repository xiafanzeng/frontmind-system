const BASE = "https://agent-api.bigmodel.cn/api/agent/managed";
export type ZhipuRecord = Record<string, unknown>;
export class ZhipuManagedError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(`Managed Agents ${operation} failed (${code})`);
    this.name = "ZhipuManagedError";
  }
}
function record(value: unknown): ZhipuRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_RESPONSE");
  return value as ZhipuRecord;
}
export function zhipuResourceId(value: unknown): string {
  const id = record(value).id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/u.test(id))
    throw new Error("INVALID_RESOURCE_ID");
  return id;
}
export class ZhipuManagedClient {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  constructor(
    private readonly options: {
      apiKey: string;
      fetchImpl?: typeof fetch;
      requestTimeoutMs?: number;
      maxFileBytes?: number;
    },
  ) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey))
      throw new Error("INVALID_CREDENTIAL");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "zai-version": "2026-05-26",
      "zai-beta": "managed-agents-2026-05-26",
    };
  }
  private async open(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    if (
      !/^\/v1\/[a-zA-Z0-9_/?=&%.\[\]:,+-]+$/u.test(path) ||
      path.includes("..")
    )
      throw new Error("INVALID_PROVIDER_PATH");
    const mutation = method !== "GET";
    try {
      const response = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          ...this.headers,
          ...(body !== undefined && !(body instanceof FormData)
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(body !== undefined
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
        signal:
          signal ??
          AbortSignal.timeout(this.options.requestTimeoutMs ?? 60_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ZhipuManagedError(
          path,
          response.status,
          `HTTP_${response.status}`,
          mutation && (response.status >= 500 || response.status === 408),
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ZhipuManagedError) throw error;
      throw new ZhipuManagedError(path, null, "TRANSPORT_ERROR", mutation);
    }
  }
  private async bytes(
    response: Response,
    max: number,
    mutation: boolean,
    path: string,
  ) {
    try {
      if (Number(response.headers.get("content-length")) > max)
        throw new Error("RESPONSE_TOO_LARGE");
      if (!response.body) return Buffer.alloc(0);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > max) throw new Error("RESPONSE_TOO_LARGE");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return Buffer.concat(chunks);
    } catch {
      throw new ZhipuManagedError(
        path,
        response.status,
        "INVALID_RESPONSE",
        mutation,
      );
    }
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    validate?: (value: ZhipuRecord) => void,
  ): Promise<ZhipuRecord> {
    const response = await this.open(method, path, body);
    const bytes = await this.bytes(
      response,
      8 * 1024 * 1024,
      method !== "GET",
      path,
    );
    try {
      const result = bytes.length
        ? record(JSON.parse(bytes.toString("utf8")))
        : {};
      validate?.(result);
      return result;
    } catch {
      throw new ZhipuManagedError(
        path,
        response.status,
        "INVALID_RESPONSE",
        method !== "GET",
      );
    }
  }
  async create(path: string, body: ZhipuRecord) {
    return this.request("POST", path, body, zhipuResourceId);
  }
  async listAll(
    path: string,
    query: Record<string, string> = {},
    files = false,
  ): Promise<ZhipuRecord[]> {
    const results = new Map<string, ZhipuRecord>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({
        ...query,
        limit: "100",
        ...(cursor ? { [files ? "after_id" : "page"]: cursor } : {}),
      });
      const result = await this.request("GET", `${path}?${search}`);
      if (!Array.isArray(result.data))
        throw new ZhipuManagedError(path, 502, "INVALID_PAGINATION", false);
      for (const item of result.data)
        results.set(zhipuResourceId(item), record(item));
      const next = files
        ? result.has_more === true
          ? result.last_id
          : null
        : result.next_page;
      if (next === null || next === undefined || next === "")
        return [...results.values()];
      if (typeof next !== "string" || cursors.has(next))
        throw new ZhipuManagedError(path, 502, "INVALID_PAGINATION", false);
      cursors.add(next);
      cursor = next;
    }
    throw new ZhipuManagedError(path, 502, "HISTORY_LIMIT_EXCEEDED", false);
  }
  async uploadFile(input: {
    filename: string;
    bytes: Buffer;
    contentType: string;
  }) {
    if (input.bytes.length > (this.options.maxFileBytes ?? 100 * 1024 * 1024))
      throw new Error("FILE_TOO_LARGE");
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
      input.filename,
    );
    return this.request("POST", "/v1/files", form, (value) => {
      zhipuResourceId(value);
      if (
        value.filename !== input.filename ||
        value.size_bytes !== input.bytes.length
      )
        throw new Error("FILE_IDENTITY_CONFLICT");
    });
  }
  async sendMessage(sessionId: string, text: string) {
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
      (value) => {
        if (!Array.isArray(value.data) || value.data.length !== 1)
          throw new Error("INVALID_SEND_ACKNOWLEDGEMENT");
        zhipuResourceId(value.data[0]);
      },
    );
  }
  async downloadFile(fileId: string) {
    const path = `/v1/files/${encodeURIComponent(fileId)}/content`;
    const response = await this.open("GET", path);
    return {
      bytes: await this.bytes(
        response,
        this.options.maxFileBytes ?? 100 * 1024 * 1024,
        false,
        path,
      ),
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  async subscribeEvents(sessionId: string) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? 60_000,
    );
    let response: Response;
    try {
      response = await this.open(
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`,
        undefined,
        controller.signal,
      );
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    clearTimeout(timer);
    const close = () => controller.abort();
    async function* events(): AsyncGenerator<ZhipuRecord> {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          buffer += chunk.done
            ? decoder.decode()
            : decoder.decode(chunk.value, { stream: true });
          // Normalize after concatenation: CR and LF may arrive in separate
          // transport chunks. EOF may still contain one complete JSON frame.
          buffer = buffer.replace(/\r\n/g, "\n");
          if (chunk.done && buffer.trim()) buffer += "\n\n";
          if (buffer.length > 8 * 1024 * 1024)
            throw new Error("SSE_FRAME_TOO_LARGE");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data || data === "[DONE]") continue;
            const value = record(JSON.parse(data));
            // Complete events alone are durable. No reasoning/delta subscription.
            if (typeof value.id === "string") yield value;
          }
          if (chunk.done) break;
        }
      } finally {
        close();
        await reader.cancel().catch(() => undefined);
      }
    }
    return { events: events(), close };
  }
}
